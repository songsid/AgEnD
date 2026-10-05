# #1218 spike: live per-instance step stream

Status: **branch-only prototype** (`feat/1218-live-transcript-spike`, base main `0d88cf51`). Not for 2.1.12, no merge-PR.

## Verdict

**The approach works, and the source should be (b), the CLI's own transcript. More precisely: the `TranscriptMonitor` AgEnD already runs.** It needs no new reader, no tmux, and no backend cooperation.

The prototype streams one instance's steps to a new **Steps** tab on the Web Dashboard:
- each tool call (redacted one-line label)
- what it returned (a preview, Claude Code only)
- what the agent said

Latency is about 1–3 s: the existing 2 s transcript poll plus a 1 s batch. Repetitions and repeating cycles of up to four steps fold into one row with a count. A `git push → rejected` loop shows as **"↻ ×4 (last 2 steps)"**, not eight rows. That is the issue's "see the loop immediately" case.

## The source decision

| | (a) tmux pane | **(b) CLI transcript, via the existing TranscriptMonitor** | (c) structured events (hooks / a protocol) |
|---|---|---|---|
| Already in AgEnD | the state-detection captures | **yes**: `src/transcript-monitor.ts` + `src/transcript-sources.ts` (claude-code, codex, kiro-cli, opencode), 2 s poll, incremental offsets; feeds activity / tool-progress today | no: zero Claude Code hooks; no common protocol |
| Completeness | viewport only, ANSI, overwritten by redraws, no tool boundaries | tool name + input + (Claude) result + assistant text, structured | best, where it exists |
| Cross-backend | uniform but uniformly lossy | 4 backends; each format already normalised by its source | Claude only (PreToolUse/PostToolUse) |
| Effect on idle/busy detection | **risky**: `capturePane` is an unlocked `exec`, and every extra capture competes with the state monitor (the #1210 red line) | **none**: reads files the CLI writes, not the pane; this spike adds no read at all, it listens to events the daemon already gets | none, but needs settings injection into each CLI |
| Cost | a capture per tick per watcher | one IPC message per second at most, while the agent works | new integration per backend |

Keep (a) only as what it already is: the free-riding `getPaneActivity` coarse activity line for backends without a transcript source.

(c) adds nothing (b) lacks for the backends that have a source, and it covers fewer of them.

## What the prototype does

**Daemon (`src/daemon.ts`):**
- The existing `tool_use` / `tool_result` / `assistant_text` handlers also call a `StepBatcher` (`src/step-stream.ts`).
- Steps are one redacted line each (`redactSecrets`), capped at 240 chars. The label is the daemon's operator-facing `summarizeTool`.
- At most one IPC `instance_steps` batch per second. At most 50 steps per batch and 200 waiting; overflow folds into one "N steps skipped" step, so a runaway loop cannot grow the daemon.
- On pause/stop, what is waiting is dropped and the stream stays usable for the next CLI.

**Fleet:**
- `instance_steps` is accepted only for the IPC connection's own instance. Junk is dropped, never repaired, and a batch is capped at 100.
- Steps go into an in-memory ring of 300 per instance, keyed by daemon boot. They go out as SSE `steps`.
- `GET /ui/steps?instance=` serves a page that opens mid-turn. It sits behind the same `/ui` credential.
- Deleting an instance forgets its steps.

**Dashboard (`src/ui/dashboard.html`):**
- A **Steps** tab, built from DOM nodes. Step text is always text, never markup.
- Each row shows time, icon, line, and a count where steps repeat.

## Evidence

- **`tests/step-stream-1218.test.ts`**, 14 tests:
  - text redaction and cap;
  - result previews (string, Claude content blocks, none);
  - batching under fake timers: one batch per interval, maxBatch, overflow → "skipped", clear and dispose;
  - the fleet ring: dedup, new boot, cap, forget;
  - the fleet handler: validation, batch cap, no re-send;
  - `/ui/steps`;
  - the real page script in a VM: text-only rendering, run and cycle folding, other instances not shown, a new boot resets.
- **`tests/step-stream-from-transcript-1218.test.ts`**:
  - A real `TranscriptMonitor` over a real Claude-format JSONL feeds the batcher exactly as wired.
  - It produces tool → result → text in order, with a secret redacted and history not replayed.
  - **`child_process` is mocked and records zero calls**: no tmux, no process of any kind.
- **Mutations:** 21/21 red (redaction, cap, per-step send, unbounded queue, batch caps, dedup, boot handling, kind validation, route check, innerHTML, cycle lengths, cross-block folding, other-instance rendering).
- **Regression:** 134 related test files (daemon, transcript, web-api, dashboard, `/ui`), 2429 tests, exit 0. `typecheck:tests` and build are clean.
- **Real browser** (playwright + cached chromium, a real FleetManager health listener, no fleet started):
  - preloaded steps appear;
  - live batches append;
  - an 8-step push/reject loop renders as one "↻ ×4" block;
  - `<b>` shows as text;
  - no page errors.

## Risks, and what to fix before production

1. **A half-written line is lost (existing bug, pinned by a test).** `TranscriptMonitor` moves its offset to EOF even when the last JSONL line is incomplete. That line never parses and is never re-read. The fix is to keep the offset at the last newline. It also helps the existing activity line.
2. **Non-Claude fidelity.**
   - The codex, kiro and opencode sources return three arrays per poll (uses, results, texts), so **order within a 2 s poll is lost**.
   - Their `tool_result` carries **no output**, and opencode emits no results at all.
   - Fix: sources return one ordered event list with outputs. All three formats have them: codex `function_call_output` / `custom_tool_call_output`, kiro history, opencode parts.
3. **Backends without a source:** grok, muse, gemini, antigravity get nothing. grok's `events.jsonl` is the obvious next source.
4. **Privacy and volume gating.**
   - Results can contain file contents. Redaction is pattern-based, and the dashboard viewer holds the full-fleet credential.
   - Ship it **opt-in**, e.g. `step_stream: off | tools | full`, with result previews only at `full`.
   - Have the daemon batch only while someone is watching: the fleet tells it when a page opens or closes the tab.
5. **SSE fan-out.** Every open dashboard receives every instance's steps. Subscribe per instance instead, e.g. `/ui/events?steps=<instance>`.
6. **Claude subagent / sidechain lines.** Not seen in the current transcript layout (0 `isSidechain:true` lines in a 29 MB session, since subagents write their own files). If they appear, label them rather than mix them in.
7. **Telegram Mirror Topic:** not attempted. Edit and send rate limits would need much heavier batching. The existing `tool_progress` bubble is already the coarse Telegram form.
8. **Where it lands.** This spike is on main's dashboard. When the parked web-unification stack lands, the Steps tab moves into that shell (same SSE and history patterns).

## Effort to make it real

About **2–3 days** for one PR:
- fix (1) and (2) with tests per source;
- opt-in config and watcher gating (4);
- per-instance SSE (5);
- docs.

grok's source (3) and a Telegram form (7) would be separate follow-ups.
