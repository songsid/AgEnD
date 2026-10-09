# #1510 turn-end recordings: codex 0.162.0, muse 1.4.4

Real CLIs, recorded 2026-10-10. Everything ran in isolated homes on a private tmux socket, with no account and no live fleet. The JSONL files keep only the records that matter for turn boundaries, trimmed to a few fields. Paths are replaced with `/home/user/project`.

## codex 0.162.0 (`codex-0.162.0/`)

- **Setup:** AgEnD's production `writeConfig` + `buildCommand` (`scripts/manual/codex-version-audit/gen-cmd.ts`). Turns went to a local mock of the Responses API. Its `tool` mode returns one `exec_command` call (`sleep 20; echo tool-done`, `yield_time_ms: 30000`), then the message once the output comes back.
- **`rollout.jsonl` turns, in order:**
  1. a plain turn;
  2. a tool call refused for bad arguments;
  3. the same turn again (the mock looked at the history);
  4. a 20 s tool run;
  5. a slow turn interrupted with Esc (`turn_aborted`, `reason: interrupted`);
  6. a tool run with a steer typed 4 s in. The steer is injected after the tool output, inside the same turn, followed by a second 20 s tool run and one `task_complete`;
  7. a 500 and a capacity error (`task_complete` with `last_agent_message: null`);
  8. a slow turn with a second message typed while streaming. It is folded into the same turn, with one `task_complete`.
- **Signal:** every turn is exactly one `task_started` (with `turn_id`) followed by one `task_complete` (same `turn_id`) or `turn_aborted`. Nothing ends a turn early while a tool runs.
- **`frames/`:** the pane during the 20 s tool run, classified by the production CodexBackend predicates. `tool-start`, `tool-mid` and `tool-last-busy` read BUSY; `tool-idle` (written with `task_complete`) reads idle.

## muse 1.4.4 (`muse-1.4.4/`)

- **Setup:** the real binary, run directly (never the launcher), `--provider echo --echo-delay-ms 15000 --disable-approval --trust-workspace`. The Meta provider's endpoints (`/muse-code/config`, `/muse-code/models`) are private, so a tool call could not be scripted offline.
- **Format:** compact JSON, like muse's own logs. AgEnD's cwd match reads `"cwd":"…"` without a space. Kept: `route_facts` (cwd only), the `user_intent.accepted` text (`intent_id`, `surface`, `model_messages`), the `user_intent.materialized` target run (`outcome.kind`, `outcome.run_id`), and the run events.
- **`session.jsonl` (main session only):** run 1 (`started`, prompt "long echo one"). A second message was typed 4 s in: `user_intent.accepted` / `materialized` at once, but no run. Run 1 ends with `terminal {reason: null}`, and run 2 (`started`, prompt "") begins about 90 ms later and ends 15 s after that. The end-of-turn "reminder observer" runs write to their own session directories, which are not included here.
- **`session-cancel.jsonl`:** from the 1.4.4 audit. A cancelled run ends with `terminal {reason: "cancelled during end-of-turn reminder wait"}`.
- **`frames/`:** `between-runs-idle` is the single idle frame (~150 ms) between run 1 and run 2. A pane-only turn end would fire there; the session log shows run 2 starting. Then come `run2-busy` and `run2-idle`.
