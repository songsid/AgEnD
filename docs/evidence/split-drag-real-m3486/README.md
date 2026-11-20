# Split view divider drag on real-shaped chats: before/after (M-3486)

The harness is `scripts/manual/perf/split-drag-real-m3486.mts`. It runs the shared fixture (in-process FleetManager,
scratch home, loopback only, IPC-stub agents) in headless Chromium.

Each of two agents has 200 messages, about 14,000 DOM nodes per pane:

- long Markdown with headings, lists, links and a quote;
- 70-line code blocks;
- tables;
- 80 served images in four sizes;
- `.html` file cards, and `html` blocks with one preview frame running;
- reactions, reply quotes and status lines;
- the live activity block (a turn of 14 tool steps, the last one running).

The picture `fixture-1366.png` shows the drag's starting state. The drag moves the divider 120 px right and back, then
left and back, one pointer move per frame (120 moves).

**Before** is `origin/release/2.3.5-alpha` 1889715bf, which already has #4277; **after** is this branch. The runs
alternated before/after and started only when the host's 1-minute load was under 3.

| width, CPU | | frame p50 | p90 | p99 | max | frames > 50 ms | drag window | layout | layouts | paint | script |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1366, 4× | before | 33.3 | 183.4 | 316.7 | 467 | 145 | 32.1 s | 12.0 s | 5,214 | 7.0 s | 5.9 s |
| 1366, 4× | after | 16.7 | 83.4 | 133.3 | 383 | 125 | 20.9 s | 3.1 s | 627 | 6.8 s | 3.6 s |
| 1920, 4× | before | 33.3 | 116.6 | 216.6 | 333 | 112 | 23.3 s | 5.1 s | 1,969 | 6.0 s | 4.9 s |
| 1920, 4× | after | 16.7 | 50 | 83.3 | 233 | 44 | 14.7 s | 1.3 s | 363 | 4.7 s | 2.8 s |
| 1366, 1× | before | 16.7 | 16.8 | 33.4 | 83 | 1 | 7.2 s | 1.7 s | 5,171 | 1.3 s | 1.0 s |
| 1366, 1× | after | 16.7 | 16.7 | 33.3 | 33 | 0 | 6.2 s | 0.6 s | 609 | 1.2 s | 0.8 s |
| 1920, 1× | before | 16.7 | 16.7 | 16.8 | 50 | 0 | 5.6 s | 0.7 s | 1,940 | 0.9 s | 0.8 s |
| 1920, 1× | after | 16.7 | 16.7 | 33.2 | 33 | 0 | 5.4 s | 0.3 s | 351 | 0.9 s | 0.7 s |

## What dominated

**Forced layouts from status lines.** The thread's ResizeObserver callback (`chat-thread.js` `resized`) runs
`fitStatus()`, which reads `clientWidth`/`scrollWidth` on each folded status line.

- During a drag, #4277 gives rows `content-visibility: auto`, so off-screen rows are skipped. A size read inside a
  skipped row lays that row out on its own and then locks it again.
- The trace's stacks (`STACKS=1`) attribute 4,560 of one drag's 5,214 layouts to `fitStatus` (chat-thread.js:772).
  That's one per status line per pane per frame.
- #4277's synthetic fixture had no status lines, so it never showed this.

## Fixes

1. `fitStatus()` doesn't measure a line whose contents are skipped (`checkVisibility({ contentVisibilityAuto: true })`
   on its first row).
   - The line keeps its last answer.
   - It's measured again on the resize after the drag, when every row is laid out again.
2. `theme.js`'s colour observer also ignores `style` writes on a `TEXTAREA`. The composer's auto-height wrote one each
   time it measured, and each write re-read the header colours: 148 → 9 updates per drag at 1366/4×.

#4277's drag-only `content-visibility` stays. Without it, the same 1366/4× drag on this fixture took a 63 s window
(layout 22 s, prepaint 16 s), against 21 s with it.

## Left as is

These smaller costs are inherent to a live-width drag:

- the per-move re-render of the two panes (about 15 ms per move at 4×);
- paint at the new width;
- the browser's own intersection checks for skipped rows.

Unchanged in every run: each pane's scroll position and its first visible row with its offset, both drafts, the split
ratio, and the running preview. The one page error in every run, before and after, is the sandboxed preview page's own
`localStorage` read. It comes from that page, not from this change.
