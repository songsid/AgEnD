---
section: Fixed
---
- **網頁 app：狀態 emoji 編輯器裡的 Discord 自訂 emoji 重新顯示（#1520）。** 在「設定 → 連線 → Discord → 狀態 emoji」中，所有伺服器 emoji 都顯示成破圖，原因是頁面的安全政策擋掉了 Discord 的 emoji CDN。現在面板只允許載入 `https://cdn.discordapp.com/emojis/` 底下的圖片，Discord 其他來源仍然擋住。
