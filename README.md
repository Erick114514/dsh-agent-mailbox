# dsh-agent-hub

A DeepSeek Harness host plugin that registers Agent Hub mailbox tools process-wide,
so every DSH agent session can talk to other agents through one shared file mailbox:

- `deepseek` (this harness)
- `claude-code`
- `codex`
- `openclaw` (reserved, optional)

## Files

| File | Purpose |
| --- | --- |
| `agent-hub.plugin.mjs` | Host plugin (ESM Cordis plugin row) registering `agent_hub_send` / `agent_hub_check` / `agent_hub_status` / `agent_hub_bootstrap`. |
| `cordis.patch.yml.example` | Install row for the `web` profile user layer. |

## Install

1. Copy the plugin into your DSH web profile:

   ```text
   <DSH_HOME>/profiles/web/agent-hub.plugin.mjs
   ```

   On Windows the default DSH home is `C:\Users\<you>\.dsh`, so the destination is
   `C:\Users\<you>\.dsh\profiles\web\agent-hub.plugin.mjs`.

2. Append the insert row from `cordis.patch.yml.example` to
   `<DSH_HOME>/profiles/web/cordis.patch.yml`.

3. Make sure `<DSH_HOME>/profiles/web/package.json` declares a `"version"`. DSH's
   `dsh_plugin_packages` request extension reads the owning package manifest of active
   plugins; without `version`, every model request fails with `REQUEST_EXTENSION`.

4. Restart DeepSeek Harness.

5. In a new DSH session, confirm all four tools are visible, then run
   `agent_hub_bootstrap` once so the mailbox root contains `hub.mjs`, `hub.json`,
   `protocol.json`, `README.md`, and the per-agent guides.

## Tool behavior

- `agent_hub_status` reports the mailbox root, registered agents, delivered counts,
  and read cursors.
- `agent_hub_check` reads new messages for `deepseek` by default; `mark: false` keeps
  the cursor unchanged.
- `agent_hub_send` writes one message file into the recipient inbox.
- `agent_hub_bootstrap` refreshes the bootstrap files idempotently and never resets
  inbox history or seen cursors.

The default hub root is `<home>/.agent-hub` (on Windows, `<USERPROFILE>\.agent-hub`);
set `config.hubRoot` to use another location.

## Uninstall

Remove the `agent-hub` insert block from `cordis.patch.yml`, delete
`agent-hub.plugin.mjs`, and restart DeepSeek Harness.
