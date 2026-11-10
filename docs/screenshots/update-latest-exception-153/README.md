# Update to the audited release on Windows (OpenCode) and the named "latest, not audited" exception (Antigravity) — #3521, #3539 follow-up

What each capture is:

- **host**: a real, throwaway AgEnD (isolated HOME, `AGEND_WSL=0`) with fake CLIs on its PATH (`agy` 1.5.3, `grok` 1.0.70, `opencode` 1.18.34, `claude` 2.1.319). The page, the routes, the held change, the install window and the binary probe are the real ones.
  The **flow** pictures (`after-flow-1…3`) are that same fleet really running `agy update` in its install window: idle → running → finished (the fake `agy` moves itself from 1.5.3 to 1.6.0). `POST /ui/host-update {"backend":"antigravity"}` was the only request (nothing else in its body).
- **runtime**: the real Settings → Runtime page of the same build, but the **data is synthetic**: the page's two reads (`/ui/runtimes` and `…/remote-setup`) are answered by the script with one paired Windows computer that has Claude Code 2.1.319, Codex 0.167.0, Antigravity 1.5.3 and OpenCode 1.18.34 installed (no Windows computer was involved).
  `after-flow-4-runtime-confirm-*` is the confirmation the page asks before it sends anything.
- **before** = `7198c63dd` (the alpha tip after #3539), **after** = the head this PR carries. Chromium (Playwright headless shell build 1248); desktop 1180 wide and phone 390 wide; light and dark; English and zh-TW.
- What to look for: on the host, Antigravity gets **Update to latest (not audited by AgEnD)** / 更新到最新版（未經盤點）; on the Windows page OpenCode gets **Update to 1.19.5** (before: "not updated from here") and Antigravity gets the same latest/not-audited button. Grok and the other CLIs are unchanged.

| Page | Device | Theme | Language | Before | After |
| --- | --- | --- | --- | --- | --- |
| host | desk | light | en | [before](before-host-desk-light-en.png) | [after](after-host-desk-light-en.png) |
| host | desk | light | zh-TW | [before](before-host-desk-light-zh-TW.png) | [after](after-host-desk-light-zh-TW.png) |
| host | desk | dark | en | [before](before-host-desk-dark-en.png) | [after](after-host-desk-dark-en.png) |
| host | desk | dark | zh-TW | [before](before-host-desk-dark-zh-TW.png) | [after](after-host-desk-dark-zh-TW.png) |
| host | phone | light | en | [before](before-host-phone-light-en.png) | [after](after-host-phone-light-en.png) |
| host | phone | light | zh-TW | [before](before-host-phone-light-zh-TW.png) | [after](after-host-phone-light-zh-TW.png) |
| host | phone | dark | en | [before](before-host-phone-dark-en.png) | [after](after-host-phone-dark-en.png) |
| host | phone | dark | zh-TW | [before](before-host-phone-dark-zh-TW.png) | [after](after-host-phone-dark-zh-TW.png) |
| runtime | desk | light | en | [before](before-runtime-desk-light-en.png) | [after](after-runtime-desk-light-en.png) |
| runtime | desk | light | zh-TW | [before](before-runtime-desk-light-zh-TW.png) | [after](after-runtime-desk-light-zh-TW.png) |
| runtime | desk | dark | en | [before](before-runtime-desk-dark-en.png) | [after](after-runtime-desk-dark-en.png) |
| runtime | desk | dark | zh-TW | [before](before-runtime-desk-dark-zh-TW.png) | [after](after-runtime-desk-dark-zh-TW.png) |
| runtime | phone | light | en | [before](before-runtime-phone-light-en.png) | [after](after-runtime-phone-light-en.png) |
| runtime | phone | light | zh-TW | [before](before-runtime-phone-light-zh-TW.png) | [after](after-runtime-phone-light-zh-TW.png) |
| runtime | phone | dark | en | [before](before-runtime-phone-dark-en.png) | [after](after-runtime-phone-dark-en.png) |
| runtime | phone | dark | zh-TW | [before](before-runtime-phone-dark-zh-TW.png) | [after](after-runtime-phone-dark-zh-TW.png) |

Flow (after, desktop, light): Antigravity idle [en](after-flow-1-idle-en.png) / [zh-TW](after-flow-1-idle-zh-TW.png) · running [en](after-flow-2-running-en.png) / [zh-TW](after-flow-2-running-zh-TW.png) · finished [en](after-flow-3-done-en.png) / [zh-TW](after-flow-3-done-zh-TW.png) · Runtime page confirmation [en](after-flow-4-runtime-confirm-en.png) / [zh-TW](after-flow-4-runtime-confirm-zh-TW.png).

Not shown / not verified: a real Windows computer (the Runtime's manifest read, download, sha512 and Authenticode checks are covered by tests with a fake PowerShell, and the vendor's manifest was read from the real address on 2026-11-10); a real `agy update` against Google.
