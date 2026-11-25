# Paired Linux/macOS Runtime — design previews

These are **design previews**, not implemented Runtime support or OS acceptance. They accompany the [design note](../../design/paired-posix-runtime.md). Product source is unchanged.

The real web app and signed-in Settings shell run in an isolated scratch fixture at source cb91653ba82c8d8f1c6196ef618e39b943d95a89. The Runtime section is replaced in that browser by display-only proposal markup using the existing card/field/button/Runtime row classes and shared Dialog component. No new pairing protocol, installer, process controller or permission enforcement is exercised. Download and approval are disabled. The example domain, roster and fingerprint are synthetic; no usable pairing token is shown.

| View | Desktop EN · 1366 × 900 | Phone zh-TW · 390 × 844 |
|---|---|---|
| Connect proposal | [Open](desk-en-connect.png) | [Open](phone-zh-TW-connect.png) |
| Existing fingerprint-approval pattern, proposed Linux computer | [Open](desk-en-approval.png) | [Open](phone-zh-TW-approval.png) |

Chromium headless only. Both cases reported no CSP violation and no document horizontal overflow ([checks](checks.json)); image inspection additionally checks local text containment, since document width alone cannot detect clipped children. The phone Settings panel scrolls normally; a screenshot does not assert one-screen content. The command field scrolls within its input when the example is longer than its available width.

Source links in the note were checked for existing files and valid line bounds. These previews establish proposed copy and layout only. No live account, provider CLI, runner process, physical Linux/macOS computer, install/update, permission or reconnect campaign ran. Those are implementation acceptance gates in the slice plan. No production test rerun is claimed for this design-only change.

Evidence integrity uses path/sha256 entries in [manifest.json](manifest.json). Rollback is removal of this design note and its preview evidence; there is no runtime/configuration/data migration.
