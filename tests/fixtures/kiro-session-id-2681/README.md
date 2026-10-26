# kiro-cli 2.34.0 `/session-id` and `/title` (#2684, #2683; survey #2681 candidates 5 and 10)

Offline captures of the real 2.34.0 TUI (`--tui --agent-engine=v2 --trust-all-tools`) and V3 (`--v3 --trust-all-tools`) at 120 columns, on the TUI's own mock agent, made 2026-10-26.
- Rig: `../kiro-2.34.0-audit/rig/`. It sets `KIRO_MOCK_ACP=true` and `KIRO_TEST_MODE=1`, uses an isolated HOME under `unshare -rn` and a private tmux socket. No account was used, and the host's kiro is untouched.
- The mock agent's session id is `mock-session-id`.
- The scratch path is shortened to `/tmp/k2683/work`.
- `/session-id` was also pasted on V3 the way the daemon sends it (`tmux paste-buffer -p`): the frames were the same.

| File | What it shows |
|---|---|
| `tui-ready`, `v3-ready` | The idle composer after the trust-all prompt. |
| `tui-session-id-menu`, `v3-session-id-menu` | `/session-id` typed into the box. kiro's command menu opens below it: `/session-id    Print the current session ID`, then a divider, then ` esc to cancel · ↵ to select`. Enter runs the command. |
| `tui-session-id-alert`, `v3-session-id-alert` | 0.4 s after Enter. The box is empty again, and the alert sits right above the footer's top divider: `• Session ID: mock-session-id` and `  Resume with: kiro-cli --resume-id mock-session-id`. |
| `tui-session-id-alert-gone` | 12 s later. The alert is a transient (10 s) and is gone. |
| `tui-title-typed`, `tui-title-disabled` | `/title agend-x` (no menu for a command with an argument). Its answer is `• Terminal title is disabled — enable via /settings display`, kiro's default. |
| `v3-quoted-history` | A user turn that quotes the alert's two lines. A user row is `  › …`, indented, above blank rows, so it is not the alert. |
| `v3-draft` | A person's one-row draft in the box. |
| `v3-menu-partial` | A person's `/se`: the menu lists `/session-id`, `/sessions` and `/settings`, and its hint adds `↑↓ to navigate`. |

`tui.js-showSessionId-updateTitle.txt` holds the `showSessionId` and `updateTitle` methods, copied verbatim from live 2.34.0 `tui.js` (`sha256 fb15bdf3…019b7`, the same hash as `../kiro-2.34.0-audit/`):
- `/session-id` calls `announceSystem(r, true, 10000)`. On the TUI that is a transient alert. It is not a user or assistant message, so it never lands in the session jsonl.
- `Session ID: none` is printed when the TUI has no session. The mock always has one, so this repo's tests derive that frame from the alert frame.

Two other frames in the tests are derived from these captures rather than captured: the `none` alert, and an agent answer that ends with the alert's lines.
