# Kiro: one agent and one conversation per instance (#906, #1410)

Status: design, revision 3. It folds in the real-account probe, the leader's decisions of 2026-10-08, and Prism's reviews of revisions 1 and 2. Taken over from dev1; every fact below was re-verified as described in "Evidence".

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

### 1. A fleet-scoped agent per instance (Prism P1, R2 #3)

**Name.** `<fleet>` is the first 8 hex of SHA-256 of this fleet's resolved `AGEND_HOME`.
- An instance name in `[A-Za-z0-9._-]{1,100}` gives `agend-<instance>-<fleet>`.
- Any other name gives `agendx-<sha256(instance)[:16]>-<fleet>`.

The two forms differ at the sixth character (`-` vs `x`), so no plain name can produce a hashed one. A same-named instance in another fleet differs by `<fleet>`.

The file is `{cwd}/.kiro/agents/<name>.json`. It holds:
- `name`, `description`;
- `prompt`: the fleet instructions, inline;
- `mcpServers`: exactly this instance's servers, each under the same key as the old shared entry (`<server>-<instance>`) with its command `<this instance's dir>/mcp-wrapper-<server>.sh`;
- `tools: ["*"]`, `allowedTools: []`, `resources: []`;
- `includeMcpJson: true` (decided);
- `permissions: {rules: []}`.

**Ownership is a positive, canonical match**, checked separately for the JSON file and for the `.bak`, on every write and every removal. A file is ours only when all of these hold:
- it parses;
- its `name` is ours;
- its `mcpServers` keys are **exactly** this instance's expected keys, none missing and none extra, and an empty map is not ours;
- each command is **this instance's own** expected wrapper path. A sibling's wrapper does not count.

How the check is used:
- **Write:** a file at our path that is not ours refuses the launch with a clear error and is never overwritten.
- **Remove:** stop, delete, replace, and the delete path that rebuilds a config without a daemon all compute the expected map from this instance's directory and the configured server names, and remove only on a match.
- **A file that is not ours** is left in place and logged.

### 2. One conversation per instance (#1410; Prism P3/P4, R2 #1/#2)

Generalise `kiro-v3-identity.ts` to v1 and v2, each with its own store adapter. The claims, fresh-start marks and refusals are the same as v3's.

**Store selector, per engine (E10):**
- **v1 (`--legacy-ui --agent-engine=v1`):** read `conversations_v2` in the store the instance launches with: the credential profile's store home when it has one, else `$XDG_DATA_HOME/kiro-cli`. Read-only, and only indexed columns (`key`, `conversation_id`, `created_at`, `updated_at`; never `value`, #1048). Keys: the cwd as configured, resolved, and realpath'd. "Newest" means max `updated_at`.
- **v2 (`--tui --agent-engine=v2`):** `~/.kiro/sessions/cli/*.json` with `cwd` equal to one of those keys and `session_created_reason` other than `"subagent"`. "Newest" means max `updated_at`. This store is not isolated per credential profile.
- **v3:** unchanged.

**State** lives in `<AGEND_HOME>/kiro-identity/instances/<instance>.json`.
- It holds **one record per key** (engine, cwd, credential profile): `pending(id)`, `owned(id)` or `fresh(since, known)`, each with the ids this key has abandoned.
- Claims, `claims/<engine>/<id>`, are created exclusively and belong to whoever created them, as in v3.

| Situation | Launch | Then |
|---|---|---|
| **Adoption:** no state file at all (the first launch under this code) | Read the store. If the newest conversation for the cwd exists, claim it and record `pending(id)` **before** launching. If there is none, or the claim is already taken, record `fresh`. | — |
| **Adoption, store unreadable** | **Legacy mode, explicitly not isolated:** today's command (plain `--resume`, shared files), no state written, and a launch warning saying the instance is not isolated. The next launch tries adoption again. | — |
| `pending(id)` | `--resume-id id`, the same id on every retry. **No store read is needed, so the store's readability never matters here.** | Pane ready, which is success: `owned(id)`. The daemon's explicit fresh-start transition records `fresh`, with `id` abandoned for good. A crash keeps `pending`. |
| `owned(id)` | `--resume-id id`. No store read. | — |
| `fresh` | No resume flag, and the launch carries `--agent`. **Never** a resume of any kind, so an abandoned id cannot come back. | Take-up by evidence (created after `since`, absent from `known`, unclaimed, the only one) gives `owned`. **An unreadable store defers the take-up** (stays `fresh`). It is never guessed. |
| A **key the state file has no record for** (engine, profile or cwd changed after adoption) | **Durable `fresh`** for the new key, as v3 does today (`kiro-v3-identity.ts:143`). Never a selection of "newest". | Each key keeps its own record. Returning to the old key finds it as it was: `owned(X)` resumes X, and an abandoned X stays abandoned. |
| `skipResume` | No resume flag | Records `fresh` for this key |

Two existing instances in one cwd at the upgrade both select the same newest conversation. The first to claim it keeps it, and the second starts fresh. This is v3's known limit, and it is chosen over giving one instance the other's conversation.

### 3. Switching a resumed conversation to the instance's agent (leader, approved; R2 #4/#5)

`--agent` is ignored on resume (E6), so a conversation from before the upgrade comes back as `kiro_default`. While `agentConfirmed` is false for the current record, AgEnD switches it once.

**Before launch: the old setup, written only where it is free (§4).**
- The `mcp.json` key `<server>-<instance>` is written only if it is absent, or its command is already this instance's own wrapper.
- `.kiro/steering/agend-<instance>.md` is written only if it is absent, or carries **this fleet's** tag (§4).
- A conflict, meaning a foreign command under the key or a steering file this fleet cannot claim, is **not overwritten**. The transition goes ahead without that piece, with a launch warning. Only an instance whose conversation was already in conflict before the upgrade is affected, and the swap below still gives it its own agent.

**After the pane is ready, the swap runs under the same admission and fences as a delivery.** The whole step is bounded by **15 s on the monotonic clock**.
1. **Reading the agent** looks only at the live layout, never at history:
   - v1: the pane's current prompt row (`[<agent>] N% …`), meaning the last non-empty row, and only when it matches the backend's prompt pattern;
   - TUI/v3: the status row directly above the input row (`<agent> · …`).

   A quoted `[agend-…]` or `agend-… ·` elsewhere in the pane is not read.
2. **Before writing,** AgEnD takes a fresh capture under the delivery path's write fence: its `current()` check of spawn generation, launch fence and delivery-writes-stopping (`daemon.ts` ~2011). The swap is typed only when that same capture shows a readable, idle, input-ready prompt. Unknown, modal, busy, auth or held-dialog states, and the startup scan's "true", never admit it: the step waits and re-captures within the budget.
3. **The write and the confirmation:** type `/agent swap <agent>` once, then capture until the live layout shows `<agent>`.
4. **Fences.** After every await (capture, write, confirmation capture), the launch fence is checked again: stop, pause, respawn, launch generation and pane owner.
   - A stale frame or a superseded launch never marks the switch confirmed, never removes a file, and never lets a held delivery or replacement through.
   - The last capture before confirmation must be newer than the write.
5. **Confirmed:** record `agentConfirmed`, then remove this instance's own old setup (§4).
6. **Not confirmed within the budget:** leave the old setup, log it with a launch warning, and try again on the next launch.
7. **Every later resume** reads the live layout again. Not ours means the same step runs.

A fresh launch carries `--agent` from the start, needs no old setup, and runs no swap.

### 4. The shared files, by provenance only (Prism P2, R2 #4)

**Fleet tag.** From now on, AgEnD writes a steering file (only in the transition of §3) starting with `<!-- agend-fleet:<fleet> instance:<instance> -->`, followed by the usual instructions.

**What is removed:**
- **`mcp.json`:**
  - this instance's key, when its command is **exactly** this instance's own wrapper and the switch is confirmed;
  - any entry whose command is a wrapper under **this fleet's** instances directory, for an instance whose directory is gone.

  Nothing is removed by key name alone.
- **Steering:** only a file with **this fleet's** tag for this instance, in this instance's cwd, once the switch is confirmed. The cleanup removes it on the same terms.
- **Untagged legacy steering files, written before this change, are ambiguous.** Their header names an instance and a cwd but no fleet (`instructions.ts:132`), so two fleets with a same-named instance on one cwd cannot tell theirs apart. They are **kept**. A one-time launch warning names the file and says it can be deleted by hand once every fleet using that directory has upgraded. This is the one gap in steering isolation, and it is listed in the docs.

**Failure handling:** a malformed or unreadable shared file, or a failed removal, is never repaired and never reported as isolated. A launch warning names the file, and the next launch tries again. Writes happen only when something changed, atomically, keeping the rest of the file as is.

**When a removal takes effect.** Removal takes effect for a running session no later than that session's next launch. Kiro has config hot reload since 2.10, which may apply it sooner, but that is not relied on: it was not probed on 2.21/2.28. So isolation in a cwd is complete once every kiro instance there has confirmed its switch, its old setup was removed successfully, **and it has started again since**. These are two stages: the switch at the first start after the upgrade, then the next start. Untagged legacy steering files (above) stay a recorded gap until someone deletes them by hand.

**Known limit: two fleets on one cwd.** Their read-modify-writes of the shared `mcp.json` can race, and one can bring back an entry the other just removed. This can remain even after both have upgraded, until that instance's next launch removes it again. No cross-fleet locking is added.

### 5. Capability gates

- The compatibility probe already parses `chat --help` for the `--agent-engine` values. It now also records `--agent` and `--resume-id`.
- A binary without both flags behaves exactly as today and gets a one-time warning that same-directory isolation needs a newer kiro-cli.
- v3's identity path is unchanged.

### 6. Cleanup (stop, delete, replace)

- The agent file and its `.bak`, each only on a positive match (§1).
- This instance's own `mcp.json` key and tagged steering file, each only on a positive match (§4).
- Delete and replace also drop the identity state and release this instance's claims. Conversations stay in kiro's store.
- Directories are left in place.

## Grok (documentation only)

Grok instances in one working directory share its project-level MCP config the same way. `docs/` gets the known limitation: run Grok instances that share a repository from separate worktrees. #1411 tracks the fix.

## Tests (implementation PR)

All filesystem roots are scratch dirs. No kiro, fleet or tmux is launched (bd0c88aa). The kiro behaviour itself is pinned by E1–E12, not by unit tests.

- **Agent identity:**
  - two `AGEND_HOME`s with a same-named instance in one cwd get different files;
  - the plain and hashed forms never collide (`中文` vs an instance named `sha256(中文)[:16]`, mixed-form control);
  - files that are **not ours**, so refused on write and kept on removal:
    - an empty `mcpServers`;
    - a sibling's wrapper;
    - an extra or missing key;
    - a user file;
    - a `.bak` that does not match;
  - cleanup through the delete path that rebuilds a config without a daemon removes only our files;
  - a file rewritten by another owner survives our stop.
- **Selector:**
  - v1/v2 fixtures: newest by `updated_at`, the other cwd's and subagent rows ignored;
  - an empty store is fresh;
  - the credential profile chooses the v1 store only.
- **State machine:**
  - `pending` and `owned` resume the exact id while the store is unreadable;
  - `fresh` never resumes, and its take-up is deferred while the store is unreadable;
  - adoption with an unreadable store is legacy mode, not isolated, with no state and a warning;
  - pending survives a crash and a failed launch, and the retry uses the same id;
  - the fresh-start transition abandons the id for good;
  - **round trip:** X abandoned, then engine, profile or cwd changed, then back again: X is never claimed or resumed;
  - a new key after adoption is durable fresh;
  - the claim race;
  - take-up only on full evidence.
- **Switch:**
  - the old setup is written only where it is free;
  - a foreign `mcp.json` key or an unclaimable steering file is not overwritten, and gives a warning;
  - two `AGEND_HOME`s with a same-named instance in one cwd: neither removes or overwrites the other's steering;
  - the reader ignores a quoted `[agend-…]` or `agend-… ·` in history;
  - an unreadable, modal or busy capture never admits the write;
  - a confirmation capture older than the write never confirms;
  - stop, pause or respawn while a capture, the write or the confirmation is awaited never confirms, never removes, and never releases a held delivery;
  - the 15 s monotonic budget times out to "keep the old setup and warn";
  - confirmation removes only this instance's tagged and own-wrapper files.
- **Provenance:**
  - user `mcp.json` keys (including an `agend-*` key run with `npx`) are kept;
  - another fleet's wrappers are kept;
  - a gone instance's wrapper is removed;
  - untagged legacy steering is kept with a one-time warning;
  - a malformed `mcp.json` or a failed unlink warns and is never reported as isolated.
- **Capability:** help without `--agent` or `--resume-id` gives today's command and one warning.
