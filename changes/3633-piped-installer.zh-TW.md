---
section: Fixed
---
- **Linux 安裝指令透過 `curl | bash` 執行時，不再被套件提示中斷（#3633）。** 套件管理員與 Node 設定不會讀走剩餘的安裝腳本；Debian／Ubuntu 套件以非互動方式安裝。若 PATH 上的 `agend --version` 無法執行，會明確報錯並傳回失敗。
