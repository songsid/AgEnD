# M-2909 evidence (#3691) — not for merge

This evidence branch (`evidence/m2909-classic-room-account`) has as its parent #3691's head `bf804876b` (the review fixes).

**Source:** `scripts/manual/smoke/smoke-classic-room-account-2909.mts` at that head. It runs on the shared smoke fixture with a scratch HOME and AGEND_HOME, a mock `claude` (version and auth status only), guard binaries for tmux, codex and kiro-cli, and loopback only. The command was:

    PLAYWRIGHT_BROWSERS_PATH=<cache> PW_DIR=<playwright-core> REPO=$PWD OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-classic-room-account-2909.mts

**Capture pins**
- `before` serves `src/ui/settings-dialogs.js` and `src/ui/accounts-view.js` from `origin/release/2.3.5-alpha` (0a05d405 at capture) in place of this branch's. Everything else, server included, is the head's. So it is a two-module compatibility control (an open tab holding those two older modules), not an entire old client and server.
- `after` is the head as is.
- Fixture: the room 「鬥破企劃」 (claude-code) and two seeded Claude profiles, `work` and `team` (fake tokens).

**Receipts:** `result.json` has 12/12 checks PASS: for zh-TW and en, before and after, the room picker, Move with rooms, and no page errors or CSP reports. `run.log` is the script's last lines.

**Pictures:** `<lang>-<before|after>-1-room-runtime.png`, `<lang>-after-1b-room-picked.png` (`work` chosen) and `<lang>-<before|after>-2-move-dialog.png`.
