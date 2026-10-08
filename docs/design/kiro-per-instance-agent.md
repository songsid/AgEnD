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

**`includeMcpJson: true` (decided, leader 2026-10-08; the first direction said `false`).** The evidence above shows that once the workspace `mcp.json` holds no AgEnD entries, `true` already isolates instances, and it keeps what users have today:

- With `false`, every kiro instance loses the user's own MCP servers on v1/v2: those in `~/.kiro/settings/mcp.json` and in the workspace `mcp.json`. That is a regression for anyone who relies on them.
- On v3, `false` is worse than either choice: v3 still starts those servers, but hides their tools.

The isolation does not come from this flag. It comes from AgEnD's entries living only in each instance's own agent file, together with the migration below that removes the old shared entries. `false` would only add protection against stale AgEnD entries that the migration failed to remove. If we want that belt-and-braces, it can be a per-instance option later.

### (a) Resume across the switch

What is known:

- v1/v2 `--resume` is "the most recent conversation from this directory".
- v2 sessions record their agent.

What is not known offline is whether `--resume --agent agend-x` still picks a conversation saved under `kiro_default`. Classic needs a model reply to save a conversation, so this cannot be answered offline.

**The plan does not depend on the answer: a one-time handover by id.**
- **When:** the first launch of an existing instance with `--agent`, unless that launch skips resume.
- **What it passes:** `--resume-id <id>` of the conversation plain `--resume` would have taken. That is the newest conversation for the working directory in the engine's store, read the way AgEnD already reads them: v1 `conversations_v2` (`src/kiro-db-reader.ts`, newest `updated_at` for the directory's keys) and v2 `~/.kiro/sessions/cli` (`transcript-sources.ts`).
- **The record:** before launching, the handover is recorded in a small per-instance mark under `<AGEND_HOME>`, keyed by instance, working directory and credential profile. Every later launch uses plain `--resume`, so the handover happens once. A mark that cannot be recorded refuses the launch, as v3 identity does, so a failed handover is never repeated against a newer conversation.
- **Cost:** the store is read once per instance, at that one launch. It is the same indexed `updated_at` query the transcript poller uses (about 0.05 ms against a 1 GB store, #1048), not a scan.
- **No conversation found:** a fresh start, as for a new instance.
- **v3:** v3 instances already resume by their own recorded id (`kiro-v3-identity.ts`), so they get no handover.
- **Either answer from kiro is safe:**
  - If kiro's `--resume` ignores the agent, the handover resumes the same conversation `--resume` would have.
  - If it filters by agent, the handover is what keeps the conversation. If kiro then also leaves the resumed conversation tagged `kiro_default`, the next plain `--resume` would miss it; the probe below shows whether that happens. If it does, the instance's own id must be carried forward, which is #1410.

**Probe (pending the user's OK; it uses a real login).** It confirms the plan rather than gating it.
- **Setup:** an isolated HOME holding an `sqlite3 .backup` copy of the login. The leader makes the copy to a path I give; the live database is only read, and I never open it. Private tmux socket, scratch cwd, about 8 turns. The copy is deleted afterwards.
- **Seed:** `chat --legacy-ui --agent-engine=v1` with "remember AAA", then quit.
- **Switch:** `--agent agend-a --resume`, then ask what was said, and check the history.
- **Cross-agent:** `--agent agend-b --resume`, to see whether agend-a's conversation is picked.
- **Repeat** with `--tui --agent-engine=v2`.
- **v3:** `--v3 --resume-id <id> --agent agend-a` for a session made under `kiro_default`.
- **Prompt check:** ask the agent its instructions, to confirm the inline `prompt` is used. That is the one thing about the prompt I could not observe offline.

**Related existing problem: #1410.** v1/v2 `--resume` is per directory, so two kiro instances in one working directory may each resume the other's newest conversation. That is inferred from kiro's documentation, and the probe will confirm it. It predates this design. The fix is per-instance `--resume-id` with claims, as v3 already does, and #1410 tracks it, separate from this change.

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

Grok instances in one working directory share its project-level MCP config the same way. Grok has no per-agent equivalent that we have verified. `docs/` gets a known-limitation note: run Grok instances that share a repository from separate worktrees. #1411 tracks the fix.

## Tests (for the implementation PR)

- `writeConfig`:
  - writes the agent file with only this instance's servers and the inline prompt;
  - writes nothing to the shared `mcp.json` or steering;
  - migration removes own, AgEnD-wrapper and configured-sibling artefacts, and keeps user keys and files.
- `buildCommand`: `--agent agend-<name>` on all three plans; no `--agent` when the agent file could not be written (the launch fails).
- Two instances in one cwd: each agent file names only its own wrapper. A mutation that writes to the shared `mcp.json` turns the two-instance test red.
- `cleanup`: removes the agent file and its `.bak`, and nothing else.
- Handover:
  - the first `--agent` launch passes `--resume-id` of the newest conversation for the directory (v1 store and v2 store fixtures in scratch dirs), and records its mark first;
  - later launches use plain `--resume`;
  - an unrecordable mark refuses the launch;
  - `skipResume` and an empty store start fresh;
  - v3 instances are untouched.
- Stub every filesystem root to a scratch dir. Launch no kiro, fleet or tmux (bd0c88aa). The engine behaviour itself is pinned by the evidence above, not by unit tests.
