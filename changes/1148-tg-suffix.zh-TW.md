---
section: Fixed
---
- **Telegram General bot 定址（#1148／#754）：**forum 根層的明列命令 suffix 在 shared dedup 前驗證，即使沒有 message ID 也一樣。錯誤或不明的 receiving username 不會消費 intended bot 的訊息或執行其 General 命令。Bare 命令、Classic／有-thread 行為與精確別名形式不變。
