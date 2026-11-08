# Hub web first-run setup — design mockups

Static fake-data UI designs for M-2687. No product behavior, accounts, AD requests, initializer, member or service is run. These are not acceptance screenshots. Source baseline: `9b06e6bd`.

The renderer loads the repository’s actual shared `tokens.css`, `app.css`, and Inter font, then follows the shared PageHead / Settings card / field / button markup. Additional CSS is presentation-only.

18 PNGs: zh-TW desktop/light and phone/dark for seven states; EN desktop/phone for the main directory and reconfigure states. Every render checks horizontal overflow and CJK-font availability.

Run `node docs/screenshots/hub-web-first-setup-a9/render.mjs` with `PW_DIR` pointing to your owned playwright-core installation, `CHROME` to its Chromium executable, and `DESIGN_FONT` to an owned Noto Sans CJK TC regular OTF. Use a short owned temporary directory. The renderer starts only a loopback static-file server and closes it and the browser.

Font source: [Noto CJK](https://github.com/notofonts/noto-cjk), SIL OFL. The CJK font is an external rendering input and is not copied into this branch. No system fonts are installed or modified.

## Image list

- [主機擁有者的首次設定：基本資料、網路與憑證 · zh-TW · 桌機](png/01-basics-zh-TW-desktop.png)
- [主機擁有者的首次設定：基本資料、網路與憑證 · zh-TW · 手機](png/02-basics-zh-TW-phone.png)
- [AD 草稿：寫入專用密碼與連線檢查 · zh-TW · 桌機](png/03-directory-zh-TW-desktop.png)
- [AD 草稿：寫入專用密碼與連線檢查 · zh-TW · 手機](png/04-directory-zh-TW-phone.png)
- [未知 CA：先確認指紋，沒有略過驗證 · zh-TW · 桌機](png/05-trust-zh-TW-desktop.png)
- [未知 CA：先確認指紋，沒有略過驗證 · zh-TW · 手機](png/06-trust-zh-TW-phone.png)
- [指定目錄中的管理員，完成後由本人登入 · zh-TW · 桌機](png/07-review-zh-TW-desktop.png)
- [指定目錄中的管理員，完成後由本人登入 · zh-TW · 手機](png/08-review-zh-TW-phone.png)
- [本機擁有者修改 AD：測試後整批儲存 · zh-TW · 桌機](png/09-existing-zh-TW-desktop.png)
- [本機擁有者修改 AD：測試後整批儲存 · zh-TW · 手機](png/10-existing-zh-TW-phone.png)
- [Hub 管理員看 AD 狀態，不取得主機寫入權限 · zh-TW · 桌機](png/11-readonly-zh-TW-desktop.png)
- [Hub 管理員看 AD 狀態，不取得主機寫入權限 · zh-TW · 手機](png/12-readonly-zh-TW-phone.png)
- [憑證檢查失敗：原設定不變，沒有強行繼續 · zh-TW · 桌機](png/13-error-zh-TW-desktop.png)
- [憑證檢查失敗：原設定不變，沒有強行繼續 · zh-TW · 手機](png/14-error-zh-TW-phone.png)
- [AD 草稿：寫入專用密碼與連線檢查 · en · 桌機](png/15-directory-en-desktop.png)
- [AD 草稿：寫入專用密碼與連線檢查 · en · 手機](png/16-directory-en-phone.png)
- [本機擁有者修改 AD：測試後整批儲存 · en · 桌機](png/17-existing-en-desktop.png)
- [本機擁有者修改 AD：測試後整批儲存 · en · 手機](png/18-existing-en-phone.png)
