# Split view divider drag: before/after (M-3455)

These numbers come from `scripts/manual/perf/split-resize-m3455.mts`. The setup is the shared fixture (in-process
FleetManager, scratch home, loopback only, IPC-stub agents) in headless Chromium at 1600×1000 with 4× CPU throttling.

The fixture has two agents side by side, each with 200 synthetic messages: prose, lists, code blocks and a table, about
4,000 DOM nodes per pane. Each history is scrolled to its middle. The harness then drags the divider 120 px right and
back, then left and back, with one pointer move per frame (120 moves).

**Before** is `origin/release/2.3.5-alpha` 6cde6d563; **after** is this branch. The runs alternated before/after and
started only when the host's 1-minute load was under 3. Rounds 2 and 3 of each are kept; round 1 ran under load
(about 9) and was dropped.

| | before-2 | before-3 | after-2 | after-3 |
|---|---|---|---|---|
| frame p50 (ms) | 33.3 | 33.3 | 16.7 | 16.7 |
| frame p90 (ms) | 233.4 | 266.7 | 66.6 | 66.7 |
| frame p99 (ms) | 333.4 | 400 | 100 | 116.6 |
| frame max (ms) | 483 | 450 | 183 | 167 |
| frames over 50 ms | 141 | 148 | 66 | 91 |
| drag window (s) | 36.8 | 40.7 | 15.8 | 17.3 |
| style (s, main-thread self) | 11.9 | 12.9 | 0.63 | 0.72 |
| layout (s) | 6.8 | 7.4 | 2.3 | 2.4 |
| paint + prepaint + layerize (s) | 9.8 | 11.4 | 4.0 | 4.4 |
| script (s) | 3.8 | 4.1 | 3.3 | 3.6 |

The before trace showed three causes:

1. **Inherited split size.** `--ws-first`, the split size, is written on the workspace grid each frame. Because a
   custom property is inherited, every element in both histories was restyled on each frame (about 860 style
   recalcs).
   - **Fix:** `@property --ws-first { syntax: "*"; inherits: false; }`. The grid is its only reader.
   - `--thread-snap`, which is written on the thread list as its height changes, gets the same treatment.
2. **Theme-colour observer.** The installed app's title-bar colour observer (`theme.js`) reacted to every geometry
   `style` write. Each time it forced a layout and a computed-style walk, which was the largest script cost.
   - **Fix:** attribute changes on `.ws-geometry` itself are ignored. That element only carries size and drag state.
   - Everything else still updates the colour: pane and page colours, and panes added or removed.
3. **Off-screen rows.** Every width change re-laid out and repainted all 200 rows per pane, including rows off screen.
   - **Fix:** rows always carry `contain-intrinsic-size: auto 96px`. This does nothing by itself, but the browser
     records each row's last drawn size.
   - Only while the divider is dragged (`.ws-resizing`) do rows get `content-visibility: auto`. Off-screen rows are
     then skipped at their recorded size, so nothing moves.
   - On release, every row is laid out once at the final width. Normal reading never skips rows.

Unchanged in every run: each pane's scroll position and its first visible row with its offset, the two composer drafts,
and the saved split ratio. There were no page errors.
