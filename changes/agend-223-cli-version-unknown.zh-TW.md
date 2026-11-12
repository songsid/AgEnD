---
section: Fixed
---
- **在容器裡執行時，Antigravity 和 Grok 的卡片不再顯示「已安裝 ？」。** 主機無法建立網路 namespace 時（Docker 容器裡 `unshare -rn` 會被拒絕），AgEnD 從不執行 `agy --version` 或 `grok --version`，版本因此一直是未知。這兩個 CLI 沒有把版本寫在磁碟上，現在在這種情況下會直接執行 `--version`（仍帶著停用自動更新的設定、systemd 允許時的記憶體上限，以及 5 秒期限）。其他 CLI 維持原本的嚴格規則。版本仍然讀不到時，Antigravity 也會顯示「讀不到已安裝的版本」，不再顯示「已安裝 ？」。
