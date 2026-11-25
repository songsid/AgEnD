# Office packs: WebP pictures, drawn for real (#4463)

These are captures of the real Office UI and of an Office share page, taken in headless Chromium with the smoke fixture. The pack and the agents are synthetic (Alpha … Echo); nothing here has a real name.

- **Pack.** Two pictures, both encoded by Chromium itself with `canvas.toDataURL("image/webp", 0.9)`: real, decodable WebP files (`RIFF…WEBP`, a `VP8X` chunk), not a PNG with a WebP header. The background is 5120×2880 (the new side cap; 135,940 bytes), on a 5120×2880 canvas; the character sheet is 64×48 (858 bytes). A yellow square marks each corner of the scene, so a capture shows whether the whole scene is in view.
- **Upload.** Through the Office editor's own picker (Edit offices → Upload a skin pack): `manifest.json`, `bg.webp` and `sheet.webp` picked together. The host answered 200 and kept both files under their `.webp` names.
- **Share.** The real share service and gateway on loopback; only the quick tunnel is stubbed (no cloudflared, no network), as `smoke-2715-office-look` does.
- **Commit:** `e18874d8` plus this folder's commit, which also changes the editor's upload lead (below).
- **Script:** `capture.mts`. Copy it to `scripts/manual/smoke/` and run it with `REPO=<checkout> PW_DIR=<dir with playwright-core> OUT=<dir>`.

| File | What it shows |
|---|---|
| `1-editor-uploaded-desk-en.png` | Right after the upload: the toast, the pack in the list, and the lead "Pick a pack's manifest.json and all its PNG or WebP files together (or its folder)." |
| `1-editor-uploaded-desk-zh-TW.png` | The editor in zh-TW, HQ now in the pack's style: 「請把外觀包的 manifest.json 和所有 PNG 或 WebP 檔一起選取（或選整個資料夾）。」 |
| `2-office-desk-{en,zh-TW}.png` | The Office, desktop 1366×900, Fit at 22%: all four corners |
| `2-office-phone-{en,zh-TW}.png` | The Office, phone 390×844, Fit at 8%: all four corners |
| `3-share-desk-{en,zh-TW}.png` | The share page, desktop, no sign-in |
| `3-share-phone-{en,zh-TW}.png` | The share page, phone 390×844 |

**In every run** (Office and share page, both devices, both languages), each pack picture the page asked for answered 200 with `Content-Type: image/webp`, and the browser decoded it at its full size (5120×2880 and 64×48). The Office pages had no page errors or CSP violations.

**One thing not from this PR.** Each share page logs a 404 for `/assets/office-dialogue.css`: that stylesheet is not in the share page's asset list (`SHARE_ASSETS` in `src/office-share-page.ts`). This PR does not change that file; the 404 does not touch the pack pictures; it only leaves the dialogue box unstyled on a share page.
