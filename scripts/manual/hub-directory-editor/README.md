# AD editor verification

From this checkout, with installed dependencies:

```sh
npx vitest run tests/hub-directory-editor-ui.test.ts tests/hub-shared-modules-a.test.ts tests/i18n-ui-literals-2390.test.ts tests/hub-directory-settings-control.test.ts tests/hub-directory-host-notices.test.ts
npx vitest run tests/hub-compose.test.ts -t 'authorizes the configured administrator before lazily|composes S1'
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.test.json
```

The focused UI harness mounts the production component; replies there are explicit doubles. The browser rig below uses actual production public routes and no API reply stubs. It creates its own scratch home and fake people/LDAPS certificates, prepares initial state through the existing public D3 initializer, and never starts or reconciles a fleet, agent, CLI or OS service. Chromium uses its rendering-only certificate exception for the generated Hub leaf; a separate Node request verifies that real Hub HTTPS certificate. The LDAP path uses verified TLS and its production pin checks.

```sh
export REPO="$PWD"
export PW_DIR=/your/owned/playwright/node_modules
export CHROME=/your/owned/chromium/chrome
export FONTCONFIG_FILE=/your/owned/fontconfig-with-CJK.conf
OUT="$PWD/.artifacts/editor-browser" MATRIX=full npx tsx scripts/manual/hub-directory-editor/accept.mts
OUT="$PWD/.artifacts/editor-recovery" RECOVERY=1 npx tsx scripts/manual/hub-directory-editor/accept.mts
```

Full is desktop/phone × light/dark × EN/zh-TW, each with both the real Settings secondary Hub navigation and Hub Administration. It saves a changed host through the displayed fingerprint dialog, checks no early epoch change, preserved identity/certificate, cleared write-only secret, session rotation and health. Form, lower-action and trust screenshots are separate so a long form is not mistaken for a single viewport. Phone checks include 44px controls, text fitting inside dialog buttons, and the footer inside the viewport. Screenshots wait for fonts and settled frames.

Recovery closes the old AD peer before the local page opens. It covers anonymous CA refusal → service-only pinned fetch → same-dialog derived CA confirmation → Save. It then closes the active AD peer and uses the actual existing local **Run this Hub** switch to Stop, reads and saves while off, tests without effects, saves same-host without a dialog and starts the Hub through that switch. No setup or AD sign-in code is sent to a live system.

For static-version skew, use `SKEW=old-modules` or `old-shell` with `MATRIX=quick`. Old modules are the actual approved pre-editor `31a973af` blobs. Old shell strips only the display mark. For an actual earlier server, set `REPO` to your own checkout of that revision, `CANDIDATE` to this checkout, and `SKEW=old-server`; the rig substitutes candidate static modules only. `BEFORE=1` on that earlier server captures the genuine before screens. Every context, listener, directory control, browser and scratch directory is closed by the rig.

`python3 scripts/manual/hub-directory-editor/verify.py` reverses one guard at a time and requires an assertion failure, restoring every source byte. Optional names select only those guards. Never run it beside tests, browser work, typechecks or source edits. The committed receipt combines 25 caught first-pass reversals with the targeted `late-life` rerun after adding held-CA-preparation Stop coverage; it does not claim a second full mutation run. The original Stop-during-Save control remains as separate ambiguous-result coverage.
