# Kiro: one agent per instance (#906)

Status: design, for review. Taken over from dev1; every fact below was re-verified as described in "Evidence".

## Problem

Two kiro instances that share a working directory see each other. Today AgEnD:

- writes every instance's AgEnD MCP server into the shared workspace file `{cwd}/.kiro/settings/mcp.json` (as `<server>-<instance>`);
- writes every instance's fleet instructions into the shared `{cwd}/.kiro/steering/agend-<instance>.md`;
- launches `kiro-cli chat` without `--agent`, so kiro uses its built-in `kiro_default` agent, which loads both.

So instance A's kiro starts B's AgEnD MCP server (with B's socket and name) and reads B's instructions as its own. Kiro reads `mcp.json` only at startup, and `_KIRO_HOME` does not move the workspace files, so neither timing nor environment separates them.

## Evidence

All runs used kiro-cli **2.28.0** (current stable) and, where marked, **2.21.0** (AgEnD's `KIRO_SUPPORTED_MIN`). They ran in an isolated HOME (`env -i`, scratch `HOME`/`XDG_*`), offline under `unshare -rn`, with a dummy social token in the scratch `data.sqlite3`, in a private tmux socket. Nothing touched the user's `~/.kiro` or live `data.sqlite3`.

The test used three fake MCP servers that each write a marker file when kiro starts them:

- `ws`, in the workspace `mcp.json`;
- `global`, in `~/.kiro/settings/mcp.json`;
- `own-a`, in the agent file `{cwd}/.kiro/agents/agend-a.json`.

A second agent file, `agend-b.json`, declares `own-b`.

Which servers kiro starts:

| Launch | v1 (`--legacy-ui --agent-engine=v1`) | v2 (`--tui --agent-engine=v2`) | v3 (`--v3`) |
|---|---|---|---|
| no `--agent` (today) | ws, global | ws, global | ws, global |
| `--agent agend-a`, `includeMcpJson: false` | **own-a only** | **own-a only** | own-a, ws, global |
| `--agent agend-a`, `includeMcpJson: true` | — | own-a, ws, global | — |
| `--agent agend-missing` | ws, global ("Error: no agent with name … Falling back to user specified default") | ws, global (silent) | ws, global (silent) |

- **`own-b` never starts** under `--agent agend-a`, on any engine. Another workspace agent's servers are not loaded.
- **2.21.0 matches 2.28.0:** v2 rows identical, and v1 with the agent starts own-a only.
- **v3 ignores `includeMcpJson` for spawning.** Its `acp-server.js` uses `includeMcpJson` only to *filter which tools the agent is given* (`YF(...)`), not which servers start. So in v3 the workspace and global servers still start, but their tools are hidden from the agent when the flag is false.
- **Steering is loaded for every agent.** `/context show` in an offline classic session (2.28.0 and 2.21.0), with `--agent agend-a` and `resources: []`, lists `{cwd}/.kiro/steering/**/*.md`, including `agend-b.md`. A custom agent does **not** stop the workspace steering files from loading. The default resources (AmazonQ.md, AGENTS.md, README.md, skills) are listed too.
- **Discovery and validation:** `kiro-cli agent list` run in the cwd shows `agend-a` as a *Workspace* agent. `--agent` exists in 2.21.0 and 2.28.0.
- **v3 and the "2.0 format":**
  - v3 prints a non-blocking hint: "Upgrade your V2 agent configurations to V3 with /upgrade-agent".
  - If the user has enabled `chat.enableAutoAgentUpgrade`, v3 rewrites the JSON (adding `"permissions": {"rules": []}`) and leaves `agend-a.json.bak` beside it.
  - A file already carrying `permissions` still gets the hint.
- **Sessions:**
  - A v2 session file records `session_state.agent_name`.
  - `--list-sessions` is not filtered by `--agent`, and does not show the agent.
  - Classic saves a conversation only after a model reply, so offline I could not create one to resume.

## Design

At launch, per instance:

1. **Agent file.** `writeConfig` writes `{cwd}/.kiro/agents/agend-<instance>.json` atomically. It contains:
   ```json
   {
     "name": "agend-<instance>",
     "description": "AgEnD fleet instance <instance>",
     "prompt": "<the fleet instructions, inline>",
     "mcpServers": { "<server>-<instance>": { "command": "<instanceDir>/mcp-wrapper-<server>.sh", "args": [] } },
     "tools": ["*"],
     "allowedTools": [],
     "resources": [],
     "includeMcpJson": true,
     "permissions": { "rules": [] }
   }
   ```
   - The wrapper script is unchanged; it is still how the env reaches the server.
   - `permissions` is v3's own addition, so an auto-upgrading v3 has nothing to rewrite.
2. **Launch.** `buildCommand` adds `--agent agend-<instance>`, for every engine plan (legacy, tui, v3).
3. **Shared files.** AgEnD stops writing to the shared files:
   - no more entries in `{cwd}/.kiro/settings/mcp.json`;
   - no more `{cwd}/.kiro/steering/agend-<instance>.md`.

**`includeMcpJson` (needs a decision; I recommend `true`).** The approved direction said `false`. The evidence above shows that once the workspace `mcp.json` holds no AgEnD entries, `true` already isolates instances, and it keeps what users have today:

- With `false`, every kiro instance loses the user's own MCP servers on v1/v2: those in `~/.kiro/settings/mcp.json` and in the workspace `mcp.json`. That is a regression for anyone who relies on them.
- On v3, `false` is worse than either choice: v3 still starts those servers, but hides their tools.

The isolation does not come from this flag. It comes from AgEnD's entries living only in each instance's own agent file, together with the migration below that removes the old shared entries. `false` would only add protection against stale AgEnD entries that the migration failed to remove. If we want that belt-and-braces, it can be a per-instance option later.

### (a) Resume across the switch: open, needs one real-account probe

What is known:

- v1/v2 `--resume` is "the most recent conversation from this directory".
- v2 sessions record their agent.

What is not known offline is whether `--resume --agent agend-x` still picks a conversation saved under `kiro_default`. If it does not, an existing instance's first launch after the upgrade would start fresh, one time. Classic needs a model reply to save a conversation, so this cannot be answered offline.

**Probe (needs the leader's OK; it uses a real login):**
- **Setup:** an isolated HOME holding only a copy of the login. The copy is made by the user or leader, and the live `data.sqlite3` is never opened by me. Use a private tmux socket and a scratch cwd.
- **Seed:** `chat --legacy-ui --agent-engine=v1` with "remember AAA", then quit.
- **Switch:** `--agent agend-a --resume`, then ask what was said, and check the history.
- **Cross-agent:** `--agent agend-b --resume`, to see whether agend-a's conversation is picked.
- **Repeat** with `--tui --agent-engine=v2`.
- **v3:** `--v3 --resume-id <id> --agent agend-a` for a session made under `kiro_default`.
- **Prompt check:** ask the agent its instructions, to confirm the inline `prompt` is used. That is the one thing about the prompt I could not observe offline.

What each outcome means:

| Probe result | Consequence | Plan |
|---|---|---|
| `--resume` ignores the agent | No change at the switch | Ship as designed. Note that this also means two instances in one cwd already resume each other's newest conversation today. That is a separate, pre-existing identity bug, and its fix is per-instance `--resume-id` for v1/v2 like `kiro-v3-identity.ts` (follow-up issue). |
| `--resume` filters by agent | One fresh start per existing instance at the upgrade | One-time handover: the first `--agent` launch passes `--resume-id` of the session plain `--resume` would have taken, and is recorded so it is never taken again. Same claim/ledger rules as v3 identity. This also removes the cross-instance resume above. |
| `--resume-id` + a different `--agent` refuses or forks | v3 instances lose their session at the switch | Keep v3 instances on their recorded agent until the next fresh start, or hand over by conversion. Decided by what the probe shows. |

### (b) Engines

- `--agent` is accepted on v1, v2 and v3, at 2.21.0 and 2.28.0. All three of AgEnD's launch plans just append it.
- v1/v2 honour `includeMcpJson` for spawning; v3 only for tool exposure. With the recommended `true` and no AgEnD entries in the shared files, all three behave the same.
- The `--agent-engine` pinning (#1109) is unchanged.

### (c) Migration off the shared files, without disturbing other instances

Ownership is decided by evidence, not by name shape:

- **Workspace `mcp.json`.** An instance's own launch removes:
  - its own `<server>-<instance>` keys;
  - any key whose `command` is an `mcp-wrapper-*.sh` inside **this fleet's** instances directory, i.e. an AgEnD wrapper.
  
  It leaves every other key (the user's servers) untouched. The existing "wrapper no longer exists" sweep stays. It writes only if something changed, atomically, and keeps the file's other content as is.
- **Steering.** Same split between an instance's own launch and the fleet sweep:
  - An instance's own launch deletes its own `agend-<instance>.md`.
  - The fleet, once at startup, deletes `agend-<name>.md` in a kiro instance's working directory only when `<name>` is a configured instance of this fleet. A stopped sibling's old instructions then stop leaking into running instances before that sibling next starts.
  - A file that does not match a configured instance is left alone, because it may be the user's.
- **Running siblings are not disturbed.** Kiro reads both files only at startup, so removing a sibling's old entry or steering file does not touch a running sibling's session. After the upgrade, every instance of the fleet runs the same AgEnD code and needs neither file.
- **Edge case: two different fleets (two AGEND_HOMEs) on one cwd.** The wrapper-path evidence keeps one fleet from removing the other's entries. The other fleet's instructions still leak until it upgrades too. This goes in the docs as a known limit.

### (d) Cleanup

- **`cleanup()` (stop):** removes `.kiro/agents/agend-<instance>.json`, plus v3's `agend-<instance>.json.bak` if present. It also keeps today's removal of this instance's `mcp.json` key and steering file, for anything an older version left. The agent file is rewritten on every start.
- **Delete / replace:** the same cleanup. Directories (`.kiro/agents/` and the rest) are left in place, as `.kiro/settings/` and `.kiro/steering/` are today.
- **A missing agent file at launch** makes kiro fall back to `kiro_default` silently on v2/v3, which would leave the instance with no AgEnD MCP server. So `writeConfig` failing to write the agent file fails the launch, as an unwritable config does today. `buildCommand` adds `--agent` only for a file this launch wrote, and the existing fleet MCP startup watch reports a missing AgEnD server.

## Grok (documentation only)

Grok instances in one working directory share its project-level MCP config the same way. Grok has no per-agent equivalent that we have verified. `docs/` gets a known-limitation note: run Grok instances that share a repository from separate worktrees. A separate issue tracks the fix.

## Tests (for the implementation PR)

- `writeConfig`:
  - writes the agent file with only this instance's servers and the inline prompt;
  - writes nothing to the shared `mcp.json` or steering;
  - migration removes own, AgEnD-wrapper and configured-sibling artefacts, and keeps user keys and files.
- `buildCommand`: `--agent agend-<name>` on all three plans; no `--agent` when the agent file could not be written (the launch fails).
- Two instances in one cwd: each agent file names only its own wrapper. A mutation that writes to the shared `mcp.json` turns the two-instance test red.
- `cleanup`: removes the agent file and its `.bak`, and nothing else.
- Stub every filesystem root to a scratch dir. Launch no kiro, fleet or tmux (bd0c88aa). The engine behaviour itself is pinned by the evidence above, not by unit tests.
