// DeepSeek Harness host plugin: Agent Hub mailbox (deepseek / claude-code / codex / openclaw).
//
// Mounted as a user composition row in the `web` profile:
//   <DSH_HOME>/profiles/web/cordis.patch.yml  ->  insert agent-hub row (name: ./agent-hub.plugin.mjs)
//
// Design contract (agreed with Codex, conversation agent-hub-persistence):
//   - no service rewriting / service publishing; the patch row declares the
//     loader deps `fs` and `tools` so Cordis starts apply only after both exist;
//   - apply is non-fatal (everything caught, only console.error on failure);
//   - tool registration is re-entrant and each apply collects disposers released via ctx.effect;
//   - hubRoot defaults to <home>/.agent-hub (config.hubRoot overrides);
//   - ensure is idempotent: merges hub.json agents only, never resets inbox/seen history or cursors;
//   - registration happens host-wide, so every DSH agent session gets the tools after profile load.
//
// Failure model: syntax/import errors happen before apply and surface as loader row errors
// (mitigate with `node --check` before patching + keep the cordis.patch.yml backup);
// runtime failures inside apply/execute are caught and reported as 'ERROR: ...' tool text.

import { defineTool } from '@deepseek-ai/dsh-tools'

const PLUGIN_NAME = 'agent-hub'
const defaultHubRoot = () => {
  const home = process.env.USERPROFILE || process.env.HOME || '.'
  const sep = home.indexOf('\\') >= 0 ? '\\' : '/'
  return home.replace(/[\\/]+$/, '') + sep + '.agent-hub'
}
const DEFAULT_HUB_ROOT = defaultHubRoot()

export default {
  name: PLUGIN_NAME,

  apply(ctx, config = {}) {
    try {
      const fs = ctx.get('fs')
      const tools = ctx.get('tools')
      if (!fs || !tools) {
        console.error(`[${PLUGIN_NAME}] fs/tools services unavailable; plugin disabled`)
        return
      }

      // ---------- per-apply state ----------
      const state = {
        hubRoot: null,
        ensurePromise: null,
        policyBase: null,
        initNotes: [],
      }
      const configuredRoot =
        config && typeof config.hubRoot === 'string' && config.hubRoot.trim().length > 0
          ? config.hubRoot.trim()
          : DEFAULT_HUB_ROOT

      // ---------- tiny path/io helpers (no node:path available) ----------
      const join2 = (...segs) => {
        const first = segs.length ? String(segs[0]) : ''
        const sep = first.indexOf('\\') >= 0 ? '\\' : '/'
        const parts = []
        for (const s of segs) {
          const clean = String(s).replace(/^[\\/]+|[\\/]+$/g, '')
          if (clean) parts.push(clean)
        }
        return parts.join(sep)
      }
      const pad = (n) => String(n).padStart(10, '0')
      const makeId = () => 'm' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)

      const writeText = async (p, content) => {
        const policy = state.policyBase
          ? { mode: 'danger-full-access', workspaceRoot: state.policyBase }
          : undefined
        await fs.writeText(await fs.resolve(p), content, undefined, undefined, policy)
      }
      const readText = async (p) => { try { return await fs.readText(await fs.resolve(p)) } catch (e) { return null } }
      const readJson = async (p) => {
        const s = await readText(p)
        if (!s) return null
        try { return JSON.parse(s) } catch (e) { return null }
      }
      const writeJson = async (p, v) => { await writeText(p, JSON.stringify(v, null, 2)) }
      const listJsonFiles = async (dirAbs) => {
        try {
          const es = await fs.listDir(await fs.resolve(dirAbs))
          return es.filter((e) => e.type === 'file' && e.name.endsWith('.json')).map((e) => e.name).sort()
        } catch (e) { return [] }
      }

      const readCursor = async (root, agent) => {
        const c = await readJson(join2(root, 'seen', agent + '.json'))
        return c && typeof c.seq === 'number' ? c.seq : 0
      }
      const writeCursor = async (root, agent, seq) => {
        await writeJson(join2(root, 'seen', agent + '.json'), { agent, seq, ts: new Date().toISOString() })
      }
      const nextSeq = async (root, recip) => {
        const dir = join2(root, 'inbox', recip)
        let max = 0
        for (const name of await listJsonFiles(dir)) {
          const v = parseInt(name, 10)
          if (!isNaN(v) && v > max) max = v
        }
        let s = max + 1
        while ((await listJsonFiles(dir)).indexOf(pad(s) + '.json') >= 0) s = s + 1
        return s
      }

      const DEFAULT_AGENTS = {
        'deepseek': { display: 'DeepSeek Harness', kind: 'dsh' },
        'claude-code': { display: 'Claude Code', kind: 'claude' },
        'codex': { display: 'Codex', kind: 'codex' },
      }

      // ---------- bootstrap file contents (kept in sync with hub.mjs/protocol) ----------
      const MJS_LINES = [
        "import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'",
        "import { join, dirname } from 'node:path'",
        "import { fileURLToPath } from 'node:url'",
        'const ROOT = dirname(fileURLToPath(import.meta.url))',
        "const pad = (n) => String(n).padStart(10, '0')",
        "const makeId = () => 'm' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)",
        "function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')) } catch (e) { return null } }",
        "function writeJson(p, v) { writeFileSync(p, JSON.stringify(v, null, 2), 'utf8') }",
        'function readHub() {',
        "  const h = readJson(join(ROOT, 'hub.json'))",
        '  if (h && h.agents) return h',
        "  return { schema: 1, agents: { 'deepseek': { display: 'DeepSeek Harness' }, 'claude-code': { display: 'Claude Code' }, 'codex': { display: 'Codex' } } }",
        '}',
        'const agentIds = (hub) => Object.keys(hub.agents || {})',
        "const inboxDir = (id) => join(ROOT, 'inbox', id)",
        "function readCursor(id) { const c = readJson(join(ROOT, 'seen', id + '.json')); return c && c.seq ? c.seq : 0 }",
        "function writeCursor(id, seq) { mkdirSync(join(ROOT, 'seen'), { recursive: true }); writeJson(join(ROOT, 'seen', id + '.json'), { agent: id, seq, ts: new Date().toISOString() }) }",
        'function nextSeq(id) {',
        '  const dir = inboxDir(id)',
        '  let max = 0',
        '  try { for (const n of readdirSync(dir)) { const v = parseInt(n, 10); if (!isNaN(v) && v > max) max = v } } catch (e) {}',
        '  let s = max + 1',
        "  while (existsSync(join(dir, pad(s) + '.json'))) s = s + 1",
        '  return s',
        '}',
        'function opt(argv, k) { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null }',
        'function printMsg(f) {',
        '  const m = readJson(f) || {}',
        "  console.log('')",
        "  console.log('seq=' + String(m.seq) + ' id=' + (m.id || '') + ' from=' + (m.from || '') + ' ts=' + (m.ts || ''))",
        "  if (m.subject) console.log('subject: ' + m.subject)",
        "  if (m.conversation) console.log('conversation: ' + m.conversation)",
        "  console.log(String(m.body || ''))",
        "  if (m.inReplyTo) console.log('(in reply to ' + m.inReplyTo + ')')",
        '}',
        'function cmdCheck(argv) {',
        "  const id = opt(argv, '--agent') || 'deepseek'",
        "  const mark = argv.indexOf('--no-mark') < 0",
        '  const cur = readCursor(id)',
        '  const dir = inboxDir(id)',
        '  let files = []',
        "  try { files = readdirSync(dir).filter((n) => n.endsWith('.json')).sort() } catch (e) {}",
        '  const fresh = files.filter((n) => parseInt(n, 10) > cur)',
        '  const last = fresh.length ? parseInt(fresh[fresh.length - 1], 10) : cur',
        "  console.log('Agent Hub check (' + id + '): ' + fresh.length + ' new message(s), cursor ' + cur + ' -> ' + last)",
        '  for (const f of fresh) printMsg(join(dir, f))',
        '  if (mark && fresh.length) writeCursor(id, last)',
        '}',
        'function cmdSend(argv) {',
        '  const hub = readHub(), list = agentIds(hub)',
        "  const from = opt(argv, '--agent'), to = opt(argv, '--to'), body = opt(argv, '--body')",
        "  if (!from || list.indexOf(from) < 0) throw new Error('unknown --agent ' + from + '; known ids: ' + list.join(', '))",
        "  if (!body) throw new Error('missing --body')",
        "  if (to !== 'all' && list.indexOf(to) < 0) throw new Error('unknown --to ' + to + '; use one of ' + list.join(', ') + ' or all')",
        "  const recips = to === 'all' ? list.filter((a) => a !== from) : [to]",
        "  const msg = { schema: 1, id: makeId(), kind: 'message', from, to, ts: new Date().toISOString(), body }",
        "  const subject = opt(argv, '--subject'), conv = opt(argv, '--conversation'), reply = opt(argv, '--in-reply-to')",
        '  if (subject) msg.subject = subject',
        '  if (conv) msg.conversation = conv',
        '  if (reply) msg.inReplyTo = reply',
        '  for (const r of recips) {',
        '    const seq = nextSeq(r)',
        '    mkdirSync(inboxDir(r), { recursive: true })',
        "    writeJson(join(inboxDir(r), pad(seq) + '.json'), Object.assign({}, msg, { seq }))",
        "    console.log('delivered ' + msg.id + ' -> ' + r + ' (seq ' + seq + ')')",
        '  }',
        '}',
        'function cmdStatus() {',
        '  const hub = readHub()',
        "  console.log('Agent Hub root: ' + ROOT)",
        '  for (const id of agentIds(hub)) {',
        '    const dir = inboxDir(id)',
        '    let total = 0',
        "    try { total = readdirSync(dir).filter((n) => n.endsWith('.json')).length } catch (e) {}",
        '    const cur = readCursor(id)',
        "    console.log('- ' + id + ' (' + String(hub.agents[id].display || '') + '): ' + total + ' total, cursor ' + cur)",
        '  }',
        '}',
        "const argv = process.argv.slice(2)",
        "const cmd = argv[0] || 'status'",
        'try {',
        "  if (cmd === 'check') cmdCheck(argv.slice(1))",
        "  else if (cmd === 'send') cmdSend(argv.slice(1))",
        "  else if (cmd === 'status') cmdStatus()",
        "  else { console.error('usage: node hub.mjs <check|send|status> [options]'); process.exitCode = 2 }",
        "} catch (e) { console.error('error: ' + (e && e.message ? e.message : String(e))); process.exitCode = 1 }",
      ]

      const README_LINES = [
        '# Agent Hub — 多 Agent 互通邮箱（DeepSeek Harness / Claude Code / Codex）',
        '',
        '本目录是一个共享消息枢纽：给某个 agent 发消息，就是把一条 JSON 消息文件写入对方收件箱目录 inbox/<agentId>/。任何能读写本目录的 agent 都可以参与，无需常驻服务。',
        '',
        '## 参与者 id',
        '- deepseek — DeepSeek Harness（宿主插件）；在 DSH 会话中用 agent_hub_send / agent_hub_check / agent_hub_status / agent_hub_bootstrap 工具',
        '- claude-code — Claude Code；接入说明见 agents/claude-code.md',
        '- codex — Codex；接入说明见 agents/codex.md',
        '- openclaw — 已注册槽位（未运行），接入后即可收发',
        '- --to all 表示广播给除自己外的所有已注册节点',
        '',
        '## 目录结构',
        '- inbox/<agentId>/<10位序号>.json — 投递给该 agent 的消息（文件名序号即投递顺序）',
        '- seen/<agentId>.json — 各 agent 的已读游标 {agent, seq, ts}',
        '- hub.json — 节点注册表 {schema, root, agents}',
        '- hub.mjs — 命令行收发工具：node hub.mjs <check|send|status>',
        '- protocol.json — 机器可读协议说明',
        '- agents/*.md — 各外部 agent 的接入说明',
        '',
        '## 消息文件格式（每条消息一个 JSON 文件）',
        '{',
        '  "schema": 1,',
        '  "id": "消息唯一 id（如 mxxxx-yyy）",',
        '  "kind": "message",',
        '  "from": "发送方 id",',
        '  "to": "接收方 id 或 all",',
        '  "seq": 12,',
        '  "ts": "ISO 时间",',
        '  "subject": "可选主题",',
        '  "conversation": "可选会话名，同会话可串联",',
        '  "inReplyTo": "可选：回复的目标消息 id",',
        '  "body": "正文"',
        '}',
        '',
        '## 外部 CLI 接入（Claude Code / Codex）',
        '需要本机可执行 node。收信：',
        '  node "%%HUB_MJS%%" check --agent <你的id>',
        '发信：',
        '  node "%%HUB_MJS%%" send --agent <你的id> --to <对方id|all> --subject "主题" --body "正文"',
        '回复：追加 --in-reply-to <消息id>。查看状态：node "%%HUB_MJS%%" status',
        '',
        '## 接入新 agent（如 openclaw）',
        '在 hub.json 的 agents 中增加一项（键为该 agent 的 id），之后即可向它发消息，--to all 广播也会包含它。新 agent 只需实现：',
        '1. 收信：读 inbox/<自身id>/ 下序号大于 seen/<自身id>.json 中 seq 的 .json 文件；',
        '2. 发信：把同样格式的消息写入目标 inbox/ 目录，文件名用递增序号；',
        '3. 更新自己的 seen 游标。',
        '',
        '## 说明与限制',
        '- 序号在同一收件箱内自增，先写先得；并发写同一收件箱极端情况下可能撞号，发送方会探测已占用序号并顺延。',
        '- seen 游标按 agent 独立维护；同一 agent 若多个会话同时收信，后标记者会覆盖游标。',
        '- 不要直接删除或改动他人的消息文件。',
      ]

      const PROTOCOL_OBJ = {
        schemaVersion: 1,
        kind: 'agent-hub-mailbox',
        layout: {
          'inbox/<agentId>/*.json': 'messages delivered to that agent; padded-seq filename defines order',
          'seen/<agentId>.json': 'read cursor per agent: { agent, seq, ts }',
          'hub.json': 'registry: { schema, root, agents: { <id>: { display, kind, added } } }',
          'hub.mjs': 'node CLI for external agents: check | send | status',
          'protocol.json': 'this machine-readable spec',
        },
        message: {
          schema: 1,
          fields: {
            id: 'string, unique message id',
            kind: 'message',
            from: 'sender agent id',
            to: 'recipient agent id or all',
            seq: 'number, per-recipient delivery order',
            ts: 'ISO-8601 timestamp',
            subject: 'optional short subject',
            conversation: 'optional thread name',
            inReplyTo: 'optional message id this replies to',
            body: 'plain text body',
          },
        },
        send: 'write one message file into inbox/<recipient>/ with the next free padded seq',
        poll: 'list inbox/<agentId>/, read files whose seq exceeds seen/<agentId>.json seq, then update the cursor',
        broadcast: 'to = all writes one copy into every registered recipient inbox (sender excluded)',
      }

      const agentDoc = (id, display) => [
        '# Agent Hub：' + display + ' 接入指南',
        '',
        '你在一个 Agent Hub 多 agent 互通网络中，你的参与者 id 是 ' + id + '。',
        '节点名单：deepseek（DeepSeek Harness）、claude-code（Claude Code）、codex（Codex）——另有已注册的 openclaw 槽位（未运行）。',
        '--to all 表示广播给除自己外的全部节点。',
        '',
        '## 每轮任务开始时先收信',
        '  node "%%HUB_MJS%%" check --agent ' + id,
        '输出会列出每个未读消息的 seq / id / from / subject / 正文，并默认把本次看到的最大序号标记为已读。',
        '只想看不改已读位：追加 --no-mark。',
        '',
        '## 给其他 agent 发消息',
        '  node "%%HUB_MJS%%" send --agent ' + id + ' --to deepseek --subject "主题" --body "正文"',
        '可选：--conversation 会话名；--in-reply-to <消息id> 表示回复某条消息。',
        '',
        '## 交流规范',
        '- body 保持单行、UTF-8；长内容先给要点，细节按需追问。',
        '- 收到发给你的消息后，先读完整再回复；需要对方立即行动时在正文明确说明。',
        '- 只读自己的收件箱；不要改动他人的消息文件或 seen 游标文件。',
        '- 消息格式与目录说明见 hub 根目录 README.md 与 protocol.json。',
      ]

      async function writeBootstrap(root) {
        const now = new Date().toISOString()
        await writeText(join2(root, 'README.md'), replaceTokens(README_LINES.join('\n'), root))
        await writeText(join2(root, 'hub.mjs'), MJS_LINES.join('\n'))
        const proto = Object.assign({}, PROTOCOL_OBJ, { root, generatedAt: now })
        await writeText(join2(root, 'protocol.json'), JSON.stringify(proto, null, 2))
        await writeText(join2(root, 'agents', 'claude-code.md'), replaceTokens(agentDoc('claude-code', 'Claude Code').join('\n'), root))
        await writeText(join2(root, 'agents', 'codex.md'), replaceTokens(agentDoc('codex', 'Codex').join('\n'), root))
      }

      const replaceTokens = (s, root) => s
        .split('%%HUB_MJS%%').join(join2(root, 'hub.mjs'))
        .split('%%HUB_ROOT%%').join(root)

      async function materializeAt(root) {
        state.hubRoot = root
        const hubFile = join2(root, 'hub.json')
        const existing = await readJson(hubFile)
        const agents = {}
        const now = new Date().toISOString()
        if (existing && existing.agents) {
          for (const k of Object.keys(existing.agents)) agents[k] = existing.agents[k]
        }
        for (const k of Object.keys(DEFAULT_AGENTS)) {
          if (!agents[k]) agents[k] = Object.assign({ added: now }, DEFAULT_AGENTS[k])
        }
        await writeJson(hubFile, { schema: 1, root, agents })
        await writeBootstrap(root)
        return root
      }

      async function doEnsure() {
        const fallback = await fs.processPath(await fs.resolve('.'))
        state.policyBase = fallback
        const candidates = [configuredRoot]
        const fallbackHub = join2(fallback, '.agent-hub')
        if (fallbackHub !== configuredRoot) candidates.push(fallbackHub)
        let lastError = null
        for (const root of candidates) {
          try {
            await materializeAt(root)
            state.initNotes.push('hub materialized at ' + root)
            return state.hubRoot
          } catch (e) {
            lastError = e
            const msg = (e && e.message ? e.message : String(e))
            state.initNotes.push('candidate ' + root + ' failed: ' + msg)
            console.warn(`[${PLUGIN_NAME}] materialize at ${root} failed: ${msg}`)
          }
        }
        throw lastError || new Error('no usable hub root')
      }

      const ensureHub = () => {
        if (state.hubRoot) return Promise.resolve(state.hubRoot)
        if (!state.ensurePromise) {
          state.ensurePromise = doEnsure().catch((e) => {
            state.ensurePromise = null
            throw e
          })
        }
        return state.ensurePromise
      }

      // ---------- send / check / status / bootstrap ----------
      async function hubSend(args) {
        await ensureHub()
        const hub = await readJson(join2(state.hubRoot, 'hub.json'))
        const list = Object.keys(hub.agents)
        const from = 'deepseek'
        const to = String(args.to || '').trim()
        const body = String(args.body || '').trim()
        if (!to) throw new Error('missing recipient (to)')
        if (!body) throw new Error('missing body')
        let recips
        if (to === 'all') recips = list.filter((a) => a !== from)
        else if (list.indexOf(to) >= 0) recips = [to]
        else throw new Error('unknown recipient "' + to + '"; known ids: ' + list.join(', ') + ' or all')
        if (!recips.length) throw new Error('no recipients (only you are registered)')
        const msg = {
          schema: 1, id: makeId(), kind: 'message', from, to,
          ts: new Date().toISOString(), body,
        }
        if (args.subject) msg.subject = String(args.subject).slice(0, 200)
        if (args.conversation) msg.conversation = String(args.conversation).slice(0, 64)
        if (args.inReplyTo) msg.inReplyTo = String(args.inReplyTo).slice(0, 80)
        const out = []
        for (const r of recips) {
          const seq = await nextSeq(state.hubRoot, r)
          const p = join2(state.hubRoot, 'inbox', r, pad(seq) + '.json')
          await writeText(p, JSON.stringify(Object.assign({}, msg, { seq }), null, 2))
          out.push(r + ' #' + seq)
        }
        return 'Delivered message ' + msg.id + ' from ' + from + ' to ' + (to === 'all' ? 'all (' + out.join(', ') + ')' : to)
          + '\nSubject: ' + (msg.subject || '(none)') + '\nBody: ' + body
      }

      async function hubCheck(args) {
        await ensureHub()
        const agent = String(args.agent || 'deepseek')
        const mark = args.mark !== false
        const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
        const dir = join2(state.hubRoot, 'inbox', agent)
        const cur = await readCursor(state.hubRoot, agent)
        const files = await listJsonFiles(dir)
        const fresh = files.filter((n) => parseInt(n, 10) > cur)
        const last = fresh.length ? parseInt(fresh[fresh.length - 1], 10) : cur
        const lines = []
        if (!fresh.length) {
          lines.push('Agent Hub: no new messages for ' + agent + ' (cursor ' + cur + ')')
        } else {
          lines.push('Agent Hub: ' + fresh.length + ' new message(s) for ' + agent + ' (cursor ' + cur + ' -> ' + last + ')')
          const shown = fresh.slice(0, limit)
          for (const name of shown) {
            const m = await readJson(join2(dir, name))
            if (!m) continue
            lines.push('')
            lines.push('[#' + m.seq + '] id=' + m.id + ' from=' + (m.from || '?') + ' ts=' + (m.ts || '')
              + (m.conversation ? ' conversation=' + m.conversation : ''))
            if (m.subject) lines.push('subject: ' + m.subject)
            lines.push(String(m.body || ''))
            if (m.inReplyTo) lines.push('(in reply to ' + m.inReplyTo + ')')
          }
          if (fresh.length > shown.length) lines.push('... ' + (fresh.length - shown.length) + ' more (raise limit)')
          if (mark) await writeCursor(state.hubRoot, agent, last)
        }
        return lines.join('\n')
      }

      async function hubStatus() {
        await ensureHub()
        const hub = await readJson(join2(state.hubRoot, 'hub.json'))
        const lines = []
        lines.push('Agent Hub root: ' + state.hubRoot)
        lines.push('Registry file: ' + join2(state.hubRoot, 'hub.json'))
        lines.push('CLI for external agents: node "' + join2(state.hubRoot, 'hub.mjs') + '" <check|send|status>')
        lines.push('')
        lines.push('Agents:')
        for (const id of Object.keys(hub.agents)) {
          const dir = join2(state.hubRoot, 'inbox', id)
          const files = await listJsonFiles(dir)
          const cur = await readCursor(state.hubRoot, id)
          const unread = files.filter((n) => parseInt(n, 10) > cur).length
          const a = hub.agents[id]
          lines.push('- ' + id + ' (' + (a && a.display ? a.display : '') + (a && a.kind ? ', ' + a.kind : '') + '): ' + files.length
            + ' delivered, ' + unread + ' unread (cursor ' + cur + ')')
        }
        if (state.initNotes.length) {
          lines.push('')
          lines.push('Init notes:')
          for (const n of state.initNotes) lines.push('- ' + n)
        }
        lines.push('')
        lines.push('Bootstrap / integration files:')
        lines.push('- ' + join2(state.hubRoot, 'README.md'))
        lines.push('- ' + join2(state.hubRoot, 'protocol.json'))
        lines.push('- ' + join2(state.hubRoot, 'agents', 'claude-code.md') + '  -> import into CLAUDE.md')
        lines.push('- ' + join2(state.hubRoot, 'agents', 'codex.md') + '  -> import into AGENTS.md')
        return lines.join('\n')
      }

      async function hubBootstrap() {
        const root = await ensureHub()
        return 'Agent Hub bootstrap refreshed at ' + root + '\n\n' + await hubStatus()
      }

      // ---------- register four tools (re-entrant; disposed on unload) ----------
      const disposers = []
      const reg = (def) => {
        try {
          disposers.push(tools.register(defineTool(def)))
        } catch (e) {
          console.error(`[${PLUGIN_NAME}] failed to register tool ${def.name}: ${e && e.message ? e.message : String(e)}`)
        }
      }

      reg({
        name: 'agent_hub_send',
        description: '通过 Agent Hub 邮箱给其他 agent 发送消息（互通网络：deepseek/claude-code/codex/openclaw）。写入对方收件箱即送达，对方稍后收信。',
        parameters: {
          to: { type: 'string', required: true, description: '收件人 agent id：claude-code、codex、openclaw，或 all（广播给除自己外所有已注册节点）' },
          body: { type: 'string', required: true, description: '消息正文（纯文本，单段；过长可先给要点）' },
          subject: { type: 'string', description: '可选：简短主题（≤200 字符）' },
          conversation: { type: 'string', description: '可选：会话名，用于把同一主题的往来消息串联' },
          inReplyTo: { type: 'string', description: '可选：要回复的那条消息的 id（对方 check 输出里可见）' },
        },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
        async execute(args) {
          try { return await hubSend(args) } catch (e) { return 'ERROR: ' + (e && e.message ? e.message : String(e)) }
        },
      })

      reg({
        name: 'agent_hub_check',
        description: '检查 Agent Hub 里发给 deepseek（本会话）的未读消息；默认把读到的最新序号标记为已读。互通网络中其他 agent 发来的消息都会出现在这里。',
        parameters: {
          agent: { type: 'string', description: '收件箱 agent id，默认 deepseek' },
          mark: { type: 'boolean', description: '是否把本次读到的最新序号标记为已读，默认 true；设 false 则只看不标记' },
          limit: { type: 'number', description: '最多显示多少条，默认 20' },
        },
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
        async execute(args) {
          try { return await hubCheck(args) } catch (e) { return 'ERROR: ' + (e && e.message ? e.message : String(e)) }
        },
      })

      reg({
        name: 'agent_hub_status',
        description: '查看 Agent Hub 枢纽状态：hub 目录位置、已注册节点、各节点未读数量，以及给 Claude Code/Codex 生成的接入文件路径。',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
        async execute() {
          try { return await hubStatus() } catch (e) { return 'ERROR: ' + (e && e.message ? e.message : String(e)) }
        },
      })

      reg({
        name: 'agent_hub_bootstrap',
        description: '（重新）生成/刷新 Agent Hub 的接入文件：hub.json、hub.mjs CLI、README.md、protocol.json，以及给 Claude Code 和 Codex 的接入说明，并报告位置。',
        parameters: {},
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] },
        async execute() {
          try { return await hubBootstrap() } catch (e) { return 'ERROR: ' + (e && e.message ? e.message : String(e)) }
        },
      })

      // Release all registrations when this apply instance is unloaded (stop / patch reload).
      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try { dispose() } catch (e) { /* ignore dispose errors */ }
        }
      })

      console.log(`[${PLUGIN_NAME}] host row applied (hubRoot=${configuredRoot}); tools registered: ${disposers.length}`)
    } catch (e) {
      // Non-fatal by design: never let apply crash composition activation.
      console.error(`[${PLUGIN_NAME}] apply failed (non-fatal): ${e && e.stack ? e.stack : String(e)}`)
    }
  },
}
