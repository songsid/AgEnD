---
section: Added
---
- **可以在設定 → Runtime 替已配對的 Windows 電腦安裝 Antigravity（#3521）。** Antigravity 沒有 npm 套件，所以 AgEnD 用**一個固定的下載檔**安裝：確切的檔案網址、檔案大小與 sha512 都寫在 Runtime 自己的表裡，Runtime 自己用固定的 PowerShell 指令下載那一個網址（不執行廠商的 `install.ps1`）。檔案大小或 sha512 不符、檔案超出固定大小還在增長、或 Windows 沒有回報 Google LLC 的有效簽章，都會拒絕安裝，並在頁面上寫出原因。它每個使用者各自裝在 Runtime 自己的資料夾（不需要系統管理員，不改 PATH），而且只在那台電腦的主人開啟 `install` 開關時才能安裝；網頁只送 CLI id。Grok、Muse 與 Kiro 仍然只顯示官方指令，並各自寫出原因。
