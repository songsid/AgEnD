---
section: Security
---
- **三個網頁面板共用同一條導覽列與 Session 選單，`/` 直接開 dashboard。** `/ui`、`/view`、`/settings` 都有相同的「Dashboard · View · Settings」連結與 Session 按鈕：顯示目前以哪個瀏覽器登入、session 何時結束、其他已登入的裝置（各自可登出）以及「全部登出」。只是一支小 script 與樣式表（`/assets/shell.js`、`/assets/shell.css`），不是重寫面板。
