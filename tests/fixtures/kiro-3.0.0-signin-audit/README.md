# kiro-cli 3.0.0 sign-in, auth-error and V3-onboarding captures (2026-11-05, upstream audit vs 2.36.0)

Real Linux x86_64 release, the same build as `../kiro-3.0.0-audit`:
- binary SHA256 `7473674c41fbf124574ea6fcaadfabdea2bf94828a03a33c80a9a19b459d8d8c`;
- release tar `2ebb8688b84765e4baf46d6e28b3e79780e7724e198591c22d0528d03a88a282`.

**How they were captured.** Each capture ran offline:
- `unshare --user --map-current-user --net`, so there is no network and the user is the ordinary uid;
- a scratch HOME and XDG dirs, with that one version's `bin` on PATH and core dumps off;
- a private tmux socket, with the session's cwd in the scratch home.

No account was used, and nothing was answered. Where a token was needed, it was a never-valid dummy social token
written into the scratch `data.sqlite3`: `expires_at` 2099 for "valid", 2020 for "expired".

| file | command | shows |
|---|---|---|
| `login-menu-{120,80}` | `kiro-cli login` | "Select login method" with the four labels the structured sign-in reads, unchanged from 2.x |
| `expired-tui-{120,80}` | `kiro-cli chat --tui --agent-engine=v2 --trust-all-tools` (AgEnD's TUI launch on 3.0), expired token | "You are not logged in. Login now?" / Yes / No |
| `expired-v3-{120,80}` | `kiro-cli chat --v3 --trust-all-tools` (AgEnD's V3 launch), expired token | the same screen |
| `tui-banner-{120,80}` | the TUI launch, valid token | "Kiro CLI V3 is here. This version will no longer receive feature updates." banner, then the trust-all-tools confirmation |
| `v3-choice-{120,80}` | plain `kiro-cli chat` in that same home, after its V2 launch | "Kiro CLI 3.0 is here." with "Continue with V3 / Stay on V2, remind me later / Stay on V2, don't ask again" |

A plain `kiro-cli chat` in a fresh home goes straight to V3 (welcome screen, then "Trust this workspace?"). The
three-choice menu is shown only to a home that has used V2. AgEnD always launches with explicit flags.

**`kiro-cli whoami --format json`** (the auth check that confirms an auth error, and the one the structured sign-in
uses) behaves as in 2.36.0:
- expired token: `{"account":null}`, exit 1;
- valid: `{"accountType":"SocialGoogle","provider":"Google","email":null}`, exit 0;
- no token: `{"account":null}`, exit 1.

**From the binary's strings** (not reachable offline):
- **Successful login:** 3.0 has no "Logged in successfully". It has "Logged in with Builder ID", "Logged in with External
  IdP", a `Logged in with {}` format, and "Authenticated with API key", all matched by the success pattern. A login
  that exits 0 is also a success in every AgEnD login path (web terminal, login window, and the structured sign-in
  through `whoami`).
- **"no device registration found for token"** was printed by 2.x's separate `kiro-cli` launcher (`q_cli`), which 3.0
  folds into its single binary. 3.0's refresh errors ("Unable to refresh token: No registered client was found",
  "not logged in - no valid token found") were already in 2.36.0. An expired token ends at the login-required screen
  above.
- **Retired dialogs.** The V2-format agent-config prompt ("Enable auto-upgrade" / "Not now") is gone. 3.0 upgrades V2
  agent configs to a universal format both engines load on V3 launches (setting `chat.enableAutoAgentUpgrade`,
  default on, `.json.bak` kept). When that is off, it prints a notice that needs no answer.
