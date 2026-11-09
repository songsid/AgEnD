# Kiro3 compatibility proof (#3047)

Use only disposable **network-none** containers, uid1000, scratch HOME/XDG/AGEND_HOME, private tmux. No real login,
no provider turn, no fleet or systemd. Do not mount a real provider home or change the installed Kiro. The capture
recipe follows tests/fixtures/kiro-2.34.0-audit/rig. Supply the separately downloaded3.0 binary read-only.

1. Build this exact source (`npm run build`). Record `git rev-parse HEAD` and ensure tracked sources are clean.
2. Give a node22 + tmux + python image these container mounts/env (resource limits:2GiB RAM/swap,1CPU,512PIDs):
   - source/dependencies read-only at their normal paths; workdir this checkout;
   - downloaded Kiro bin dir read-only at `/kiro`, `KIRO_BINARY=/kiro/kiro-cli`;
   - a fresh owned output directory at `/scratch`, `PROOF_ROOT=/scratch`;
   - `HOME=/scratch/home`, `AGEND_HOME=/scratch/agend`, XDG config/data/cache under that HOME;
   - `PROOF_SOURCE_HEAD=<exact SHA>`, `KIRO_NO_AUTO_UPDATE=1`.
3. Override the entrypoint with `bash -c` (no init/systemd/binfmt), create the scratch HOME/AGEND_HOME and run:

   ```sh
   python3 scripts/manual/kiro3-compatibility/capture.py
   node scripts/manual/kiro3-compatibility/acceptance.mjs
   ```

The capture program refuses root or a routed network. It seeds only a never-valid dummy login in the new scratch
SQLite file. It captures Classic120/80, saved-V2's notice, and saved-V2 plus explicit TUI pin reaching the normal
trust prompt. It answers no choice and always closes its private tmux server. The Node replay probes the actual
binary's version/help and drives the real pre-spawn admission, interaction observer and Needs-you collector;
all pane/lifecycle writes are forbidden. It preserves pin/history sentinels. This is **not** a whole-fleet or
real-account acceptance claim. Retain the text/JSON receipts, remove only these owned scratch profiles, and remove
the disposable container (no process can escape its PID namespace).

## Browser smoke

`browser-smoke.mjs` serves fixture data, not a fleet. In a network-none Playwright1.64.1 Chromium container, install
that tooling separately under `.artifacts/browser-smoke` (not a runtime dependency), mount this source read-only
and an owned output directory writable, and run the script. It keeps an old Needs-you tab open while its fixture
server upgrades, then checks the new item in that old tab and fresh EN/zh-TW tabs. Only links are offered; no
migration or menu-answer command runs. Source old assets with `SMOKE_BASE` or pre-stage them under `SMOKE_BASE_DIR`
(using `git show <base>:<file>`); `SMOKE_SOURCE_HEAD` binds the receipt when git metadata is not mounted.

## Audit limits

The six2.x literals missing from3.0 are deliberately retained for2.x compatibility.3.0's new login menu and
surviving/new login-success alternatives are covered; no real sign-in was performed. The precheck manifest
tracks the new menu literals and new login matcher. Startup-only proof does not raise KIRO_TESTED_MAX or enable
new steering versions. The owner-confirmed2.x migration/3.0 upgrade design is separate plan C, not this change.
