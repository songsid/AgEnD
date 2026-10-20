---
section: Changed
---
- **Signing in the AI backends from the Windows installer needs no console skills.** Each login page opens in your Windows browser by itself, and each backend signs in through its own login command, which ends once you're signed in: `kiro-cli login`, `claude auth login` and `codex login`, the same ones the fleet's `/login` uses. Antigravity, which has none, is closed with its own `/quit` once its credential file is written, `agy models` works and it is ready. It is never closed mid-login and never killed. A backend already signed in is skipped; one that didn't finish can be tried again or skipped for later.
