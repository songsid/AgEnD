# M-3541: background subagents in the web chat

Captured with `scripts/manual/smoke/smoke-subagent-steps-m3541.mts` (`MATRIX=desk-light-en,desk-dark-zh-TW`):

- the production dashboard in Chromium on the smoke fixture;
- one instance's transcript is the scrubbed Claude Code 2.1.330 session in `tests/fixtures/subagents-m3541`;
- the clock is moved so that the second subagent is working (7 s after it started);
- nothing is started: no CLI, no tmux, no account.

| Picture | What it shows |
|---|---|
| `*-before.png` (dev 23c4ff248) | No Subagents row. The two Agent steps have no mark. |
| `*-after.png` (#4358) | The Subagents row shows "Describe second screenshot", running. Both Agent steps read "started in the background" (zh-TW 已在背景啟動). |

The "failed · 57 ms" row is a real failed tool call in the recorded session; its input is scrubbed.
