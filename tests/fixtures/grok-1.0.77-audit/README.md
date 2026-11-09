# grok 1.0.77 audit against 1.0.70 (2026-11-06, upstream watch)

The baseline is 1.0.70 (`tests/fixtures/grok-1.0.70-audit`). The host grok 1.0.70 was not touched. No upstream release notes exist for 1.0.71–1.0.77. The docker image `grok-audit-160` is not on this host; captures ran host-isolated: private `tmux -L grokaudit1077`, scratch HOME, isolated binaries, local mock on 127.0.0.1:18080 (bd0c88aa).

**Result: one code change.** Ready, busy, 429, the weekly-limit picker, login, and the boxed `❯` reader (#3221) match 1.0.70 on AgEnD's launch path. After Esc moves focus to the scrollback, 1.0.77 unbinds Shift+x (1.0.70 still dismissed with X on this same host). Space returns to the picker — the scrollback legend already names `Tab/Space:question` — and the next scan types X.

## Artifacts (`versions.txt`)

| | 1.0.70 | 1.0.77 |
|---|---|---|
| `grok-<ver>` sha256 | `22d281c5964c5444147328096ba2a221f3f0874c6858e27c825656a80f6e58e9` | `b702950aa5827d855e493278ab6215a4e0f5bceb5bba6c6243a9f55cdd143b0a` |
| `grok --version` | `grok 1.0.70 (f50904eaee6c) [alpha]` | `grok 1.0.77 (50ca579fa996) [alpha]` |

## Static precheck (`precheck-1.0.70-1.0.77.txt`)

**MAJOR, hard=2, hinted=4.** None of the flagged strings is a new TUI on AgEnD's path except the weekly-limit scrollback key, which is a behaviour change rather than new copy:

- **"rate limit exceeded; sleeping"** — AWS SDK (smithy) internal, same class as 1.0.70. Never painted.
- **"rate limit for your plan. Rate limited"** — HTTP status-name table. A main-turn 429 still paints `Retry failed: rate_limit_error: …` (`*/07-err-429*`).
- **"usage limit (needs Grok"** — new `grok usage` help: `Session ID. Omit for your plan's usage limit (needs Grok's background service)`. Not a TUI modal; AgEnD never runs `grok usage`. Neighbour of `grok login` in the string pool.
- **Counts:** `Grok Build` 83→81, `rate_limit` 75→73, `grok login` 74→75. String-pool churn.
- **"No, and tell Grok what to do differently" / "Yes, allow all edits during this session"** — other permission variants in the binary. The tool-approval card AgEnD can hit without `--always-approve` is unchanged (`1.0.77-approval/20-approval`).

`grok --help`: `--always-approve`, `--resume`, `--model`, `--reasoning-effort` still listed. `--no-auto-update` still hidden and accepted. `grok login --help` is the same device-code / `--oauth` surface.

## Live

**The rig** (`rig/`): host-isolated. `lib.sh` starts a private tmux socket, a fresh HOME, dummy `XAI_API_KEY`, API base URLs at the mock. Launch line `grok --no-auto-update [--always-approve]`.

**Surfaces:**

- Idle / busy / cancel / boxed draft: `1.0.77-120/02-ready`, `03-busy-a`, `06-after-cancel`. `readGrokInputBox` reads the empty box on ready/busy and `stall forever b` after cancel. Trust and the weekly modal have no box.
- Rate limit: `07-err-429` / `07-err-429-text` — `┃  Retry failed: rate_limit_error: …` → `rate_limit`.
- Weekly limit: `07-err-402` and `1.0.77-weekly-limit/`. Shift+x from the picker dismisses with no request (5→5). Esc then X leaves the modal up (1.0.77). Esc then Space restores `Shift+x:dismiss`; X then dismisses.
- Login: TUI without a key paints `Waiting for approval...` (startup hold, empty keys). `grok login` / `grok login --device-auth` paint the device URL + code and `Waiting for authorization...`. `LOGIN_FLOWS.grok.loginScreenPattern` (`Run \`grok login\``) is still in the binary (`Not logged in. Run \`grok login\`.`). OAuth still talks to `accounts.x.ai`; the flow was not completed.
- Approval without `--always-approve`: same four options as 1.0.70. AgEnD's default launch passes `--always-approve`.

Cosmetic: the welcome card now shows changelog bullets; Resume session still sits above New worktree.

## Unchanged gaps (already on #1792)

- Grok's own 401 text has no status code (`07-err-401`).
- The 500 retry line uses ASCII `...` and does not read busy (`07-err-500`).
- A 403 "usage limit" body is not classified (`07-err-403-usage`).
- The runtime "Yes, always" net still does not match the approval card.
