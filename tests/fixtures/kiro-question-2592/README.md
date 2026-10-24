# kiro V3's agent Question card (#2592)

**Capture setup.** Captured live and offline, with the same isolated rig and TUI test harness as `../kiro-2.34.0-audit/` (see its README and `rig/`):
- `KIRO_MOCK_ACP=true`;
- the test IPC socket's `MOCK_SESSION_UPDATE` injects the agent's `question_request` during a turn (`qscen.sh`).

What is painted is kiro's own `Question` component (`A0` in `tui.js`). It is identical in 2.33.1 and 2.34.0.

| step | what |
|---|---|
| `40-question` | `Question`, the question, `❯ 1. main / 2. release / Type a different answer…`, `esc to cancel · ↑↓ to navigate · ↵ to submit` |
| `41-question-paste` | what a delivery's paste does: the card turns into a free answer, `❯ hello from agend` |
| `42-question-paste-enter` | its Enter: the question closes with the message as the user's answer |
| `43-after-turn` | the turn completed: composer idle |
| `50-question-rich` | `(recommended)`, a description row, an option with sub-options |
| `51-question-suboptions` | Enter on it: `[✓] api / [✓] web`, `esc to go back · ↑↓ to navigate · space to toggle · ↵ to submit` |
| `52-question-suboptions-back` | Esc: back to the options |
| `53-question-esc` | Esc again: `Cancelled` |
| `59-end` | composer idle |

Coverage:
- 2.34.0: 120 and 80 columns, each with `-e`.
- 2.33.1: 120 columns.
- Scratch paths are shortened to `/tmp/k234`.
