# Installed-app colors (M-3214 / #4033)

The shell already generated a manifest and two OS-qualified theme-color tags. Those tags followed the OS rather than the person's selected page theme. The shared theme script now publishes one unqualified color from the rendered top surface and follows theme, route, stylesheet and appearance changes. The Hub also advertised manifest/icon URLs without serving them; its listener now serves the existing branding handler.

Runtime source is unchanged since `5cf6cf075`. The manifest keeps the existing name, icons, root start/scope and standalone display; explicit `id: "/"` preserves that identity. Its dark launch colors are fallbacks; the live meta follows the page. CSP is unchanged. No service worker or Window Controls Overlay was added.

## Verification

- Six new cases were assertion-red before the change. Final focused run: four files, 73 passing (`web-pwa-theme-m3214`, `web-app-icon-2308`, `web-chat-1307`, `web-icons-1557`). Source and test TypeScript programs exit 0.
- Three selected reversals were caught: ignoring the painted header, ignoring appearance mutations, and omitting the Hub branding routes. Restored afterward. Outcome summaries are beside this note; full local logs stay under `.artifacts/m3214`.
- [Headless receipt](headless/receipt.json): Chromium 156 inside WSL, 30 checks and nine original PNGs. Local Fleet, named HTTPS Fleet and signed-in Hub each pass live light/dark/custom colors with the emulated OS kept light; one unqualified meta, parsed standalone manifest, loaded icons and production CSP. Browser, listeners and private home are cleaned up. Test-only TLS trust is scoped to the browser context; no OS trust or user settings change.
- [Headless runner](../../../scripts/manual/pwa-titlebar/README.md) has no Windows launcher or headed mode. These page captures do not prove native OS chrome.

## Earlier native evidence and stop

Two supplementary [native originals](native-before-stop/receipt.json) were acquired with Windows Chrome 157 before the leader's stop instruction at approximately 05:13Z on 2026-11-16. They show a genuinely registered app window, with standalone mode confirmed, light/dark native caption checks and a live custom meta check. The fixture manifest had only a unique cosmetic name so its shortcuts could not collide with a user's AgEnD app. No user profile, live Fleet or provider account was used.

All tagged Windows Chrome/node processes were stopped immediately after the instruction; the post-stop query reported zero remaining. No later Windows browser was launched. The isolated test registration/profile is preserved pending a leader-approved cleanup slot; uninstall completion is **not** claimed. Named-link/Hub native installation is **not** claimed. Further native-window work requires the leader to obtain the user's approval and a time slot.

Both native originals were visually inspected: title bars and Windows controls are included, themes match, no clipping or private user content. All nine final headless originals were also visually inspected: complete Fleet/Hub pages, matching light/dark/custom headers, no clipping or private user content.

Rollback: revert the shared meta update and Hub branding route. No stored user data or migration is introduced.
