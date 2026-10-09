# #1218: what the agent is doing, step by step

Status: design for review. Nothing here is implemented yet.
Issue: [#1218](https://github.com/songsid/AgEnD/issues/1218).

## 1. Goal

While an agent works, show its steps as they happen, the way Claude Code or multica do: reading a file, running a command, editing a file, waiting for permission. The web chat gets the full view. Discord and Telegram get a compact one.

Today the web chat shows only "web-dev is working… 0:42". That is the `WorkBar` from #1307, fed by the pane state machine. Discord and Telegram can show a tool list in the progress bubble (`tool_progress`), but it is off by default.

The issue's motives stand: watching a loop happen ("commit, push, commit, push") instead of finding it afterwards in a 31 MB transcript, and live review by a leader or reviewer.

Not a goal: a raw transcript dump. Volume is the issue's main worry, so the stream is **structured, labelled, redacted and bounded**.

## 2. What exists (survey of `main` at 39f682ee)

| Piece | What it does today |
|---|---|
| `TranscriptMonitor` (`src/transcript-monitor.ts`) | One per daemon. Polls the backend's transcript every 2 s with an overlap guard, and emits `tool_use(name, input)`, `tool_result(id)` and `assistant_text`. |
| `src/transcript-sources.ts` | One source per backend; see §3. The same three event types for every backend. |
| `tool_progress` (`src/tool-progress.ts`) | `summarizeProgress()` labels a `tool_use`: `📄 讀取檔案：…/a/b/c`, `✏️ 編輯檔案`, `⚙️ 執行指令：<prog>`, `🔌 server:tool`. Low-signal tools, TodoWrite and agend MCP tools are skipped. `ProgressAccumulator` keeps 8 lines. |
| The progress bubble (fleet) | The cancel-button message, edited in place: at most one IPC every 3 s (daemon) and one edit every 4 s (fleet). Its single-line detail comes from a second labeller, `Daemon.summarizeTool`, capped at 48 characters by `sanitizeActivity`. |
| `WorkBar` (`src/ui/panel-chat.js`) | Working / looks stuck / stopping / awaiting input, plus elapsed time from the page's clock. No step detail. |
| Web transport | `/ui/events` (SSE) sends a `status` frame every 10 s; `/ui/poll` returns status, messages, deliveries, prompts, needs and reply_buttons. The public link is poll-only. The rule: anything stream-only must also be in the poll answer (#1386, #1500). New recurring reads must be passive (#1374). |
| Redaction | `redactSecrets()` (JWTs, sk-/gh*_/xox*/AKIA keys, Telegram bot tokens, Bearer/Basic, `key=value` secrets, URL userinfo). `shellCommandLabel()` keeps the program plus a bare subcommand and never the arguments. |
| Claude Code hooks | None. AgEnD installs only a `statusLine` script that writes `statusline.json`, whose `transcript_path` is how the claude-code source finds its JSONL. |
| Mirror topic | Mirrors cross-instance messages only; no tool activity. |

So the pipeline already exists, from transcript to labelled steps. The web cannot see it, the labels are flattened to text before they leave the daemon, and two of its reads are unbounded (§3.3).

## 3. Data sources

### 3.1 Per backend

| Backend | Source (already read) | Step events available | Latency | Notes |
|---|---|---|---|---|
| claude-code | JSONL at `statusline.json`'s `transcript_path` | `tool_use` with name and full input; `tool_result` by `tool_use_id`; assistant text | 0–2 s poll + the CLI's own flush | Claude writes the assistant message, with its `tool_use`, before running the tool, and the `tool_result` after it. So "running" and "done" are both observable, and a duration can be measured. |
| codex | rollout JSONL under `$CODEX_HOME/sessions` (session owned by cwd) | `function_call` / `custom_tool_call` (e.g. `exec`) / `local_shell_call`, and each `*_output` | 0–2 s | The call item precedes its output item. A sampled rollout was 322 MB, so the bound in §3.3 is not optional. |
| kiro-cli (DB) | `data.sqlite3` `conversations_v2`, read in a worker (15 s budget) | `ToolUse.tool_uses[]` (name + args), with results mapped by id | coarse: the row is rewritten as the conversation advances; P2 measures it | The signature check (`updated_at:length`) avoids re-parsing an unchanged row, but a change re-parses the whole value in the worker. |
| kiro-cli (v2 files) | `~/.kiro/sessions/cli/<id>.jsonl` (+ `.json`) | `AssistantMessage` content with tool use; `ToolResults` keyed by tool-use id | near-live (appended per message) | Already the fallback in `collectKiroEvents`. |
| kiro TUI | pane only | `(using tool: X)`, `Purpose:` (`KiroBackend.getPaneActivity`) | pane capture cadence | Name and purpose only: inferred, so marked as such. |
| opencode | `opencode.db` `part` rows (synchronous `node:sqlite`, `LIMIT 100`) | tool name + `state.input` | 0–2 s | The synchronous read runs on the fleet loop today: a known exception. |
| muse | `~/.local/share/muse/sessions/…/<uuid>/session.jsonl` | **none parsed yet** (`createTranscriptSource` returns null). Entries carry `payload_type` and `recorded_at` (µs). | — | P2 adds a source, reusing the bounded readers that already identify the session (65 536-character head, 1 MB tail). Its payload types must be checked on a real session first, from a redacted fixture. |

**Only from the pane, every backend:**
- waiting for a permission answer;
- waiting for the person's input (`interaction_summary`);
- looks stuck (the #1235 stall monitor);
- rate-limited;
- "thinking", meaning working with no new step.

These are states, not steps. The step list shows them as the current line ("Waiting for permission: Bash"), never as fabricated tool calls.

### 3.2 Hooks: not in v1

Claude Code `PreToolUse`/`PostToolUse` hooks would give sub-second, exact events. They would also change `claude-settings.json`, spawn a process per tool call, and exist for one backend only. Transcript latency (≤ 2 s) is enough for a human watching. Hooks stay an option (P4) if measurement shows otherwise.

### 3.3 Bounds and the event loop

The activity view adds **no new reads**. It consumes the events `TranscriptMonitor` already produces for the bubble: one reader per instance, two consumers.

That makes the existing reads matter more, so **P0 bounds them**:
- Claude and codex `readNewLines` read the whole delta since the offset in one buffer. P0 caps each look the way `TranscriptDeltaReader` (#1379) does: at most 1 MiB and 250 ms per look, lines over 256 KiB skipped by length with the offset still advancing, and the remainder read on the next poll.
- The codex 64 KiB synchronous head read moves to the async path.
- The opencode synchronous `node:sqlite` read keeps its `LIMIT 100` and is attributed with `measureSyncWork`. Moving it into a worker is noted, not required.

Nothing reads a transcript on a web request. Pages get steps from memory (§5).

## 4. The step model and privacy

```ts
interface ActivityStep {
  seq: number;               // per instance, monotonic for this process; a page asks for "after seq"
  turn: number;              // the turn the step belongs to (a new delivery starts one)
  ts: number;                // when the fleet saw it (wall clock, for display)
  kind: "read" | "search" | "edit" | "write" | "run" | "test" | "web" | "mcp" | "agent" | "plan" | "other";
  label: string;             // human text, already redacted (≤ 120 chars)
  tool: string;              // the CLI's tool name ("Bash", "exec", "fs_read"), for icons and loop detection
  status: "running" | "done" | "failed";
  durationMs?: number;       // when both the call and its result were seen
  inferred?: true;           // from the pane (kiro TUI), not a transcript
}
```

The fleet keeps, per instance, a ring buffer of the last **100 steps across the current and previous turn**, in memory only. A restart loses it: the transcript stays the record, and this is a live view.

The turn boundary comes from what the bubble already uses: a new delivery, and the idle edge.

**Labels, one labeller.**
- `summarizeProgress()` grows a structured variant that returns `{ kind, label }`. The bubble keeps its exact text (a parity test pins it), and the web uses `kind` for icons.
- The terse `summarizeTool` path stays separate, as `tool-progress.ts` already requires.

**Privacy: what a step may contain (default).**
- **Shell commands:** the program plus one bare-word subcommand (`shellCommandLabel`), never the arguments. `git push`, not `git push https://user:token@…`.
- **File paths:** relative to the working directory when inside it, with home shown as `~`. The path passes through `redactSecrets`. A path under the AgEnD state directory is shown as `<agend state>`.
- **Search patterns, URLs and queries:** the domain or the first 40 characters, through `redactSecrets`.
- **MCP tools:** `server:tool` only, never arguments. Agend's own tools are shown as "Messaging" or "Fleet", as the bubble already hides them.
- **Never shown:**
  - tool results or output;
  - file contents, diffs and edit strings;
  - the assistant's thinking text;
  - environment values;
  - any input field that is not listed above.
- **Verbose** (a per-instance opt-in, the same switch as `tool_progress: verbose`): adds a 48-character command preview, through `redactSecrets`. Off by default.

The rule is an **allowlist of fields per tool kind**, not a denylist: an unknown tool shows its name and nothing else.

**Who sees steps:** whoever can open that instance's chat. That means a web session, or the public link, which is an admin surface (#1367) with the same redaction. Decision Q1 asks whether the public link should get steps at all.

## 5. Surfaces

### 5.1 Web chat (P1)

- **The working line becomes a live step.** "web-dev is working… 0:42 · ✏️ Editing `src/app.ts`" shows the current step, or "Waiting for permission: Bash" from the pane state.
- **Expand: the turn's steps.** A disclosure under the working line lists this turn's steps in a steps-flow style: icon by `kind`, label, a running spinner or ✓ / ✗, and duration. It keeps the last 30 (the buffer keeps more for P3).
  - Long runs collapse consecutive identical labels into "×N", which is also the cheapest loop signal.
  - It is a plain list with `role="log"`, and it never moves the reader's scroll: the #1269 pin rules apply.
- **When the turn ends**, the working line goes. P3 attaches the turn's summary ("12 steps · 3 m 10 s") to the reply it produced, collapsed.
- **#1307 / WorkBar** is the host; no new chrome.
- **#1481 side panel:** P3 can add an "Activity" view to the same panel (the full timeline for the open instance) once the panel hosts more than previews. The step model does not change for it.

### 5.2 Fleet / Org chart (P3)

The current step as a one-line subtitle on a working instance's card ("✏️ Editing src/app.ts"), from the same data.

### 5.3 Discord and Telegram

The compact version **already exists**: the `tool_progress` bubble, one edited message per turn, rate-limited (≤ 1 edit / 4 s), already redacted. The design keeps it and only:
- feeds it from the structured labeller (identical text, pinned by a parity test);
- leaves the default `off`. Turning it on by default is decision Q2, because it adds edits to every channel.

No new message types, no threads, and no per-step messages: platform rate limits and channel noise rule those out.

## 6. Transport and cost

- **Push** works without SSE, as #1262 requires.
  - `/ui/poll` gains `activity`: for each working instance, the steps after the page's `activity_after` cursor (`<boot>-<seq>`), at most 30 per instance and per answer, plus the current-state line. It is part of the existing passive poll, not a new GET (#1374).
  - Poll clients (the public link, or an SSE outage) see steps within one 5 s poll.
  - SSE clients also get a coalesced `activity_steps` event (at most one per instance per second) for sub-second latency. It is an accelerator only: the poll answer always carries the same data.
- **Size:** a step is about 150–200 bytes of JSON. With 5 working instances × 30 steps, an answer is at most about 30 KB, and only while steps are new. An idle fleet adds `activity: {}`.
- **CPU:** labelling is string work on events that already exist. There is no read on the request path.
- **Memory:** 100 steps × about 200 bytes × instances, roughly 20 KB per instance.
- **Daemon → fleet:** the existing `instance_progress` IPC (≤ 1 every 3 s) carries the structured steps instead of text. The coalescing stays, so a burst of 50 tool calls in 3 s becomes one IPC with the newest 30.
- **Reads:** unchanged — 2 s per working instance, bounded per §3.3.

## 7. Phased plan

| Phase | Content | Size |
|---|---|---|
| **P0** | Bound the claude/codex delta reads (1 MiB / 250 ms per look, long-line skip, async codex head). The structured labeller `{kind, label}`, with a parity test against today's bubble text. Real redacted fixtures per backend. | S (≈ 1 day) |
| **P1** | The fleet `ActivityStore` (ring buffer, turn boundaries); structured `instance_progress`; `/ui/poll` `activity` and the SSE accelerator; the web working line with the current step and the expandable turn list. Tests: the allowlist redaction table (secrets in args never reach a step), the poll cursor, the SSE ≡ poll parity, and the ×N collapse. Plus a real-browser smoke. | M (≈ 2–3 days) |
| **P2** | A muse source (session.jsonl payload types, verified on a real session, redacted fixture); kiro TUI pane steps marked `inferred`; pane-only waiting states as the current line; measure kiro DB latency and prefer the v2 JSONL when it is fresher. | M (≈ 2 days) |
| **P3** | The turn summary on the reply; the Fleet/Org chart current-step line; the side-panel Activity view; repeated-step highlighting as a loop hint. | S–M (≈ 2 days) |
| P4 (only if needed) | Claude Code hooks for sub-second steps, behind a setting. | decide later |

Each phase is one PR, merged into `main` in order. P1 depends on P0.

## 8. Decisions for the user

1. **Public link:** show steps there (same redaction), or only on signed-in local sessions? *Proposal: show them; it is an admin surface.*
2. **Discord/Telegram default:** keep `tool_progress` off by default, or turn on `standard`? *Proposal: keep it off; the web view covers watching.*
3. **Retention:** in memory only (lost on restart) or persisted per turn? *Proposal: memory only; the transcript is the record.*
4. **Verbose on the web:** may the per-instance verbose switch add the command preview on the web too? *Proposal: yes, the same switch as the bubble.*

## 9. Risks

- **A transcript format changes in a CLI update:** the source yields fewer steps, never wrong ones (unknown means name only). Fixtures per version catch it (the #1239/#1308 audit practice).
- **Redaction misses a secret** in a field that is allowed. The allowlist keeps the allowed fields few (program, subcommand, path, domain), and `redactSecrets` runs on each. Command arguments, the main secret carrier, are never shown by default.
- **Volume:** bounded at every hop: read budget, 30-step IPC, a 100-step buffer, 30 steps per poll answer.
