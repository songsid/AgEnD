# Sidebar activity: one time again (M-3707)

The user asked for this after M-3674 (#4430). #4430 split each sidebar row's time into a labelled pair, "Person 33d · Agent 2m" / 「人 33 天 · Agent 2 分」. Rows now show one time again, with no label: the most recent response, whether a reply to a person or a turn another agent started.

| | Before (`release/2.3.5-alpha` 9cf845147) | After (3fb15910's source) |
|---|---|---|
| Time on the row | Both times, labelled (one-line desk: the newer, labelled) | The newer one, unlabelled, worded like a reply time (`2 min ago`, 「2 分鐘前」) |
| Tooltip | Each kind with its full time | The same, newest first |
| Highlight (`.replied`, `--reply-a`) | Only a reply to a person | Unchanged. The time text is marked `.fresh` only when the time shown is that reply |
| "Recent replies" sort | Only a reply to a person | Unchanged |
| `agend ls`, `list_instances`, `describe_instance` | `last_agent_turn` beside the reply | Unchanged |

## Captures

These are the real dashboard in headless Chromium, using the smoke fixture. There are no real names. M-3674's three agents are reused, and the agent side is supplied as the fleet reads it (`lastAgentTurnOf`):

| Agent | Last reply to a person | Last turn another agent started | After: the row |
|---|---|---|---|
| Busy helper | 33 days ago | 2 min ago | `2 min ago` / 「2 分鐘前」, not highlighted |
| Chat helper | 5 min ago | — | `5 min ago` / 「5 分鐘前」, highlighted |
| Relay helper | — | 3 h ago | `3 h ago` / 「3 小時前」, not highlighted |

**What the captures were taken from.** "Before" is a clean detached checkout of `9cf845147` (`src/` tree `5018d8f8`). "After" is commit `6576902ac`, taken before it was squashed into this PR's `3fb15910`. Its `src/` tree, `38159c49`, is the same as `3fb15910`'s. Each checkout had no tracked change; the only untracked files were the capture script and the `node_modules` link. Both runs used the pinned Playwright image (Chromium). The `source` field in each report records this binding.

There are six cases: desk compact and detailed, in light EN and dark zh-TW, plus phone light EN and dark zh-TW with the drawer opened via `#sbOpen`.

In every case, each row's text, tooltip and highlight state (`replied`, `glow`, `fresh`) is recorded in `before-report.json` and `after-report.json`. No name is cut, and every time fits its row. No run had page errors or CSP violations. `capture.mts` reproduces the captures: copy it into `scripts/manual/smoke/`, then run it with `REPO`, `OUT` and `LABEL=before|after`.

Tests:
- `tests/sidebar-one-time-m3707.test.ts` (a mounted sidebar) covers the single unlabelled time, the newest-first tooltip, the highlight on a person's reply only, and an agent turn never moving a row in "Recent replies".
- `tests/activity-split-m3674.test.ts` covers `activityText`.
- The text cases fail on the base. The sort case pins behaviour that is already correct.
