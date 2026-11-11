---
section: Fixed
---
- Windows Runtime 建置改為寫入同一份已驗證內容，讀取途中換檔或改寫時會拒絕。開發環境使用已驗證的 Windows 專用 node-pty 資產，不再為它編譯 Linux 原生模組；既有 Runtime 資產雜湊、授權檔與封裝內容保持不變。其他原生依賴仍維持原有需求。
