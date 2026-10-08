# Kiro: one agent and one conversation per instance (#906, #1410)

Status: design, revision 2. It folds in the real-account probe, the leader's decisions of 2026-10-08, and Prism's review of revision 1. Taken over from dev1; every fact below was re-verified as described in "Evidence".

## Problem

Two kiro instances that share a working directory see each other in two ways.

**1. Configuration.** AgEnD writes every instance's AgEnD MCP server into the shared `{cwd}/.kiro/settings/mcp.json`, and every instance's fleet instructions into the shared `{cwd}/.kiro/steering/agend-<instance>.md`. It then launches without `--agent`, so kiro's built-in `kiro_default` agent loads both. Instance A's kiro therefore starts B's MCP server (with B's socket and name) and reads B's instructions.

**2. Conversation.** v1/v2 instances resume with plain `--resume`, which takes the directory's newest conversation. A resumed conversation also brings back the agent it was saved under (probe, below). So B can come back as A: with A's conversation, A's agent, and A's MCP server. This was #1410; the probe confirmed it, and it is now part of this design (leader, 2026-10-08).

## Evidence

**Offline:** kiro-cli **2.28.0**, and **2.21.0** (`KIRO_SUPPORTED_MIN`) where marked. Isolated HOME (`env -i`, scratch `HOME`/`XDG_*`), `unshare -rn`, a dummy social token, and a private tmux socket. Fake MCP servers write a marker file when started. Classic reaches its prompt offline when given `--model`.

**Real account (probe, approved by the user):** 2.28.0, isolated HOME holding an `sqlite3 .backup` snapshot of the login. It ran 7 model turns, finished before the copied token's expiry, and the copy and the snapshot were deleted afterwards.

| # | Fact | How |
|---|---|---|
| E1 | `--agent <A>` with `includeMcpJson:false` starts only A's servers on v1/v2; `true` adds the workspace and global `mcp.json` servers. Without `--agent`: workspace + global. | offline, 2.28.0; v1/v2 also 2.21.0 |
| E2 | Another workspace agent's servers are never started, on any engine. | offline |
| E3 | v3 always starts the workspace and global servers; `includeMcpJson` only filters which tools the agent gets (`acp-server.js`). | offline + source |
| E4 | `.kiro/steering/**/*.md` is loaded for every agent, including a custom agent with `resources: []`. | offline `/context show`, 2.28.0 + 2.21.0 |
| E5 | `--agent <missing>` falls back to `kiro_default`: v1 prints "no agent with name…", v2/v3 are silent. | offline |
| E6 | **On every resume, `--resume` or `--resume-id`, `--agent` is ignored on v1, v2 and v3: the conversation's saved agent comes back.** | probe |
| E7 | **`/agent swap <A>` switches agent inside a resumed conversation on v1, v2 and v3. The history is kept, A's inline `prompt` takes effect, and the swap is saved with the conversation, so later resumes come back as A.** | probe (v2 session JSON `session_state.agent_name: "agend-a"`) |
| E8 | After a swap, kiro starts A's own MCP servers. | offline, v1 + v2 (v3 cannot reach its prompt offline) |
| E9 | **v1/v2 plain `--resume` takes the directory's newest conversation regardless of `--agent`, and restores that conversation's agent.** | probe |
| E10 | Stores: v1 keeps conversations in `conversations_v2` (`<store>/data.sqlite3`; key = the cwd; `conversation_id`, `created_at`, `updated_at` in ms). v2 keeps them only in `~/.kiro/sessions/cli/<id>.json` (`session_id`, `cwd`, `created_at`/`updated_at` RFC 3339, `session_created_reason`, `session_state.agent_name`), not in sqlite. | probe (a v1 row for the scratch cwd, a v2 file for the other scratch cwd, no v2 row) |
| E11 | v3 with `chat.enableAutoAgentUpgrade` rewrites the agent JSON (adding `permissions`) and leaves `.bak`. The non-blocking `/upgrade-agent` hint shows anyway. | offline |
| E12 | `--agent` is listed by `chat --help` on 2.21.0 and 2.28.0; `--resume-id` since 2.0.0. | help |

## Design

### 1. A fleet-scoped agent per instance (Prism P1)

**Name.** `agend-<instance>-<fleet>`, where `<fleet>` is the first 8 hex of SHA-256 of this fleet's resolved `AGEND_HOME`. An instance name outside `[A-Za-z0-9._-]` is replaced by a 16-hex hash of it. Two fleets on one cwd, or two instances named alike, never share a file. The file is `{cwd}/.kiro/agents/<name>.json`, holding:
- `name`, `description`;
- `prompt`: the fleet instructions, inline;
- `mcpServers`: this instance's wrapper under the **same key as the old shared entry** (`<server>-<instance>`), so during the transition kiro's "overridden configs" rule keeps one, not two;
- `tools: ["*"]`, `allowedTools: []`, `resources: []`;
- `includeMcpJson: true` (decided);
- `permissions: {rules: []}`.

**Ownership is evidence, checked on every write and every removal.** A file is ours only when it parses, its `name` is ours, and every `mcpServers` command is one of this fleet's wrapper scripts, i.e. `<this fleet's instances dir>/<instance>/mcp-wrapper-*.sh`.
- **Write:** if a file exists at our path and is not ours, refuse the launch with a clear error. Never overwrite it.
- **Remove:** on stop, delete, replace and cleanup, remove the file only if it is ours, and the `.bak` only if its content is ours too. A file that is not ours is left in place and logged.

### 2. One conversation per instance (#1410, Prism P3/P4)

Generalise `kiro-v3-identity.ts` to v1 and v2, each with its own store adapter. The claims, fresh-start marks and refusals are the same as v3's.

**Store selector (P4), per engine (E10):**
- **v1 (`--legacy-ui --agent-engine=v1`):** read `conversations_v2` in the store the instance launches with: the credential profile's store home when it has one, else `$XDG_DATA_HOME/kiro-cli`. Read-only, and only indexed columns (`key`, `conversation_id`, `created_at`, `updated_at`; never `value`, #1048). Keys: the cwd as configured, resolved, and realpath'd. "Newest" means max `updated_at`.
- **v2 (`--tui --agent-engine=v2`):** `~/.kiro/sessions/cli/*.json` with `cwd` equal to one of those keys and `session_created_reason` other than `"subagent"`. "Newest" means max `updated_at`. Kiro does not isolate this store per credential profile (E10), so the profile is recorded in the instance's state but does not choose the store.
- **v3:** unchanged (`kiro-kas-store.ts`).
- **Empty vs unreadable:**
  - **Empty** (no row or file for the cwd) is a fresh start.
  - **Unreadable** (missing permission, a locked or corrupt database, an unreadable directory) records nothing. This launch behaves as today (plain `--resume`, no agent switch), a launch warning says why, and the next launch tries again. An unreadable store is never read as "no conversation".

**State** lives in `<AGEND_HOME>/kiro-identity/instances/<instance>.json`. Claims, `claims/<engine>/<id>`, are created exclusively, as in v3. The state is keyed by engine, cwd and credential profile; a mismatch on any of them is a first launch for the new key.

| State | Launch | Then |
|---|---|---|
| none: first launch under this code | Select the newest conversation for the cwd. If one exists, claim it, record `pending(id)` **before** launching, and resume it. A claim already taken (a sibling got it), or no conversation at all, records `fresh`. | — |
| `pending(id)` | `--resume-id id`, the **same id on every retry** (the daemon's second resume attempt included) | The pane becomes ready, which is success: `owned(id)`. The daemon's explicit fresh-start transition after resume failures records `fresh` with the id abandoned (never taken back), as v3 does. A crash keeps `pending`, so the same id is tried next time. |
| `owned(id)` | `--resume-id id` | — |
| `fresh(since, known)` | No resume flag. The launch carries `--agent`. | The new conversation is taken up by evidence (created after `since`, absent from `known`, unclaimed, the only such one) as `owned`. Anything less certain stays `fresh`. |
| a `skipResume` launch | No resume flag | Records `fresh` |

Two existing instances in one cwd at the upgrade both select the same newest conversation. The first to claim it keeps it; the second starts fresh, which is the same known limit v3 has. That is chosen over giving one instance the other's conversation.

### 3. Switching a resumed conversation to the instance's agent (leader, approved)

`--agent` is ignored on resume (E6), so a conversation from before the upgrade comes back as `kiro_default`. After the first resume, AgEnD switches it once:

1. **Before launch,** while `agentConfirmed` is false for the owned or pending id, `writeConfig` writes the agent file and **keeps this instance's old shared entry and steering file**. Until the switch is confirmed, the resumed `kiro_default` conversation gets its MCP server from there, so the instance is never without one.
2. **After the pane is ready,** before any message is delivered:
   - AgEnD reads the active agent from the screen: v1's prompt row `[<agent>] N% …`, or the TUI and v3 status bar `<agent> · …`.
   - If the agent is not ours, AgEnD types `/agent swap <agent>` once, then waits a bounded time (15 s) for the screen to show it.
3. **Confirmed:** record `agentConfirmed`, then remove this instance's own old shared entry and steering file (§4).
4. **Not confirmed in time:** leave the old setup in place, log it with a launch warning, and try again on the next launch. Never remove the old entry without a confirmed switch.
5. **Every later resume checks the screen again.** It is cheap, and it repairs a manual `/agent swap` too.

A fresh launch carries `--agent` from the start, so it needs no shared files and no swap.

### 4. Leaving the shared files, by provenance only (Prism P2)

AgEnD stops adding to the shared `mcp.json` and steering, except for an instance still waiting for its confirmed switch (§3).

What is removed, and when:
- **`mcp.json` entries:** only an entry whose `command` is one of **this fleet's** wrapper scripts. A key name alone never counts.
  - This instance's own entry is removed after its switch is confirmed.
  - An entry whose wrapper belongs to an instance this fleet no longer has (its instance directory is gone) is removed at any time.
  - Nothing else is touched: no "own key" without command evidence, no `agend-*` name sweep, no bare `agend` key.
- **Steering files:** only `agend-<instance>.md` in **this instance's own** cwd, whose content starts with AgEnD's header for **that** instance and **that** cwd (`# AgEnD Fleet Context` / `You are **<instance>**` / `Your working directory is \`<cwd>\``, the header since 2026-04).
  - This instance's own file is removed after its switch is confirmed.
  - A file whose header names a different instance or cwd, or that has no header, is kept.
  - There is no fleet-wide name sweep.
- **Malformed or unreadable shared file, or a failed removal:** never repaired, and never reported as isolated. A launch warning names the file, and the next launch tries again.
- **Writes:** only when something changed, atomic, and the rest of the file is kept as is.

**Known limits** (go in the docs):
- **Transition window.** An instance still waiting for its switch keeps its shared entry, and v1/v2 agents load the workspace `mcp.json` (`includeMcpJson: true`). So isolation in a cwd is complete once every kiro instance there has confirmed its switch, normally at its first launch after the upgrade.
- **Two fleets on one cwd.** Two fleets' read-modify-writes of the shared `mcp.json` can race, and one can bring back an entry the other just removed. **This can remain even after both have upgraded**, until that instance's next launch removes it again.

### 5. Capability gates (P4)

- **Flags:** the compatibility probe already parses `chat --help` for the `--agent-engine` values. It now also records `--agent` and `--resume-id`.
- **Binary without both flags:** the instance behaves exactly as today (shared files, plain `--resume`) and gets a one-time launch warning that same-directory isolation needs a newer kiro-cli.
- **v3:** its identity path is unchanged.

### 6. Cleanup (stop, delete, replace)

- Remove the agent file and its `.bak`, if ours (§1).
- Remove this instance's old shared entry and steering file, if ours (§4).
- On delete and replace, also drop the identity state and release this instance's claims. The conversation itself stays in kiro's store.
- Directories are left in place.

## Grok (documentation only)

Grok instances in one working directory share its project-level MCP config the same way. `docs/` gets the known limitation: run Grok instances that share a repository from separate worktrees. #1411 tracks the fix.

## Tests (implementation PR)

All filesystem roots are scratch dirs. No kiro, fleet or tmux is launched (bd0c88aa). The kiro behaviour itself is pinned by E1–E12, not by unit tests.

- **Agent identity:**
  - two `AGEND_HOME`s with a same-named instance in one cwd get different files;
  - an existing foreign or user file at our path refuses the launch and is never overwritten;
  - cleanup removes only our file and our `.bak`;
  - a file rewritten by another owner survives our stop.
- **Selector:**
  - v1 fixture `conversations_v2` and v2 fixture `sessions/cli`: newest by `updated_at`, the other cwd's and subagent rows ignored;
  - an empty store is fresh;
  - unreadable or corrupt stores give today's behaviour plus a warning, and no state is written;
  - the credential profile chooses the v1 store, not the v2 store.
- **State machine:**
  - `pending` survives a crash and a failed launch, and the retry uses the same id;
  - the daemon's fresh-start transition abandons the id for good;
  - `skipResume` records fresh;
  - a change of engine, profile or cwd starts a first launch;
  - the claim race: the second instance starts fresh;
  - take-up after a fresh launch only on full evidence.
- **Switch:**
  - the old entry is written while unconfirmed;
  - the screen shows ours: no swap typed;
  - not ours: one `/agent swap` typed, and confirmation clears the old setup;
  - timeout keeps the old setup, warns, and retries next launch;
  - a fresh launch carries `--agent` and writes no shared files.
- **Provenance:**
  - user `mcp.json` keys (including an `agend-*` key run with `npx`) are kept;
  - another fleet's wrappers are kept;
  - a gone instance's wrapper is removed;
  - a steering file with another instance's header, another cwd's header, or none is kept;
  - a malformed `mcp.json` or a failed unlink warns and is never reported as isolated.
- **Capability:** help without `--agent` or `--resume-id` gives today's command and one warning.
