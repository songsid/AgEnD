# Hub web first-run setup — design mockups

Design-only proposal for M-2687 / [#3425](https://github.com/songsid/AgEnD/issues/3425), with fictional data. No product initializer, directory driver, accounts, member, service or pilot is run. These images do not prove security or functional acceptance. Source baseline: alpha `10a695e6`, including the landed #3432 shell at `28683566`.

The renderer serves the repository's **real `src/ui/app.html`, app.js, sidebar, application modules and shared CSS** over owned loopback HTTP, with a fake protocol server. Proposed markup replaces only the real panel's content. Fleet screens retain the real second-level Settings menu with **Hub selected**; phone screens retain the real navigation/back control. Hub-admin screens now use the **landed #3432 Hub shell**: the one-line brand, dashboard side-row navigation and foot, the real PanelHeader, and a `col hub-owner` containing the Settings-like card frame. No sidebar is reproduced or replaced by the renderer. Trust confirmation uses the real `confirmDialog` component.

24 PNGs: nine states in zh-TW desktop/light and phone/dark; the directory, administrator editing and re-authentication states also in EN desktop/phone. Each capture checks real app/sidebar presence, selected Settings section where applicable, horizontal overflow, CJK-font availability, dialog text clipping and page errors. Hub captures additionally check the real PanelHeader/column, one-line desktop brand and consistent card frames. The viewport keeps its desktop/phone width and expands vertically to show the panel's complete content; this is a layout proposal, not a running setup journey.

Run `node docs/screenshots/hub-web-first-setup-a9/render.mjs` with `PW_DIR` pointing to your owned playwright-core installation, `CHROME` to its Chromium executable, and `DESIGN_FONT` to an owned Noto Sans CJK TC regular OTF. Use a short owned temporary directory. Only an owned loopback fake-protocol/static server and browser are started, and both are closed. `mockup-checks.json` records the source HTML hash and checks. No remote requests are allowed by the browser context.

Font source: [Noto CJK](https://github.com/notofonts/noto-cjk), SIL OFL. The CJK font is an external rendering input and is not copied into this branch. No system fonts are installed or modified.

## Image list

- [真實 Settings → Hub：首次設定、網路與憑證 · zh-TW · 桌機](png/01-basics-zh-TW-desktop.png)
- [真實 Settings → Hub：首次設定、網路與憑證 · zh-TW · 手機](png/02-basics-zh-TW-phone.png)
- [真實 Settings → Hub：AD 草稿與寫入專用服務密碼 · zh-TW · 桌機](png/03-directory-zh-TW-desktop.png)
- [真實 Settings → Hub：AD 草稿與寫入專用服務密碼 · zh-TW · 手機](png/04-directory-zh-TW-phone.png)
- [首次信任：先比對伺服器指紋，再取得 CA · zh-TW · 桌機](png/05-trust-zh-TW-desktop.png)
- [首次信任：先比對伺服器指紋，再取得 CA · zh-TW · 手機](png/06-trust-zh-TW-phone.png)
- [指定不可變管理員身分，完成後由本人登入 · zh-TW · 桌機](png/07-review-zh-TW-desktop.png)
- [指定不可變管理員身分，完成後由本人登入 · zh-TW · 手機](png/08-review-zh-TW-phone.png)
- [真實 Hub 管理頁：管理員可編輯 AD，儲存時重新驗證 · zh-TW · 桌機](png/09-existing-zh-TW-desktop.png)
- [真實 Hub 管理頁：管理員可編輯 AD，儲存時重新驗證 · zh-TW · 手機](png/10-existing-zh-TW-phone.png)
- [同頁重新驗證：個人密碼只到目前受信任的目錄 · zh-TW · 桌機](png/11-reauth-zh-TW-desktop.png)
- [同頁重新驗證：個人密碼只到目前受信任的目錄 · zh-TW · 手機](png/12-reauth-zh-TW-phone.png)
- [測試失敗保留原設定，沒有強行繼續 · zh-TW · 桌機](png/13-error-zh-TW-desktop.png)
- [測試失敗保留原設定，沒有強行繼續 · zh-TW · 手機](png/14-error-zh-TW-phone.png)
- [更換 CA：一個指紋確認，取消即可停止 · zh-TW · 桌機](png/15-ca-change-zh-TW-desktop.png)
- [更換 CA：一個指紋確認，取消即可停止 · zh-TW · 手機](png/16-ca-change-zh-TW-phone.png)
- [同 CA 更換主機：仍確認新主機與 leaf 指紋 · zh-TW · 桌機](png/17-server-change-zh-TW-desktop.png)
- [同 CA 更換主機：仍確認新主機與 leaf 指紋 · zh-TW · 手機](png/18-server-change-zh-TW-phone.png)
- [真實 Settings → Hub：AD 草稿與寫入專用服務密碼 · en · 桌機](png/19-directory-en-desktop.png)
- [真實 Settings → Hub：AD 草稿與寫入專用服務密碼 · en · 手機](png/20-directory-en-phone.png)
- [真實 Hub 管理頁：管理員可編輯 AD，儲存時重新驗證 · en · 桌機](png/21-existing-en-desktop.png)
- [真實 Hub 管理頁：管理員可編輯 AD，儲存時重新驗證 · en · 手機](png/22-existing-en-phone.png)
- [同頁重新驗證：個人密碼只到目前受信任的目錄 · en · 桌機](png/23-reauth-en-desktop.png)
- [同頁重新驗證：個人密碼只到目前受信任的目錄 · en · 手機](png/24-reauth-en-phone.png)

The refreshed six-screen visual sample (zh-TW desktop/phone, EN desktop/phone and host-change confirmations) has no visual findings. This is image inspection only; it does not establish reauthentication, directory behavior or settings acceptance.
