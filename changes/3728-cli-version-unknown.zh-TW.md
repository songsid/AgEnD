---
section: Fixed
---
- **在容器裡，Grok 的卡片會顯示已安裝的版本，Antigravity 的卡片不再顯示「已安裝 ？」。** 主機無法建立網路 namespace 時（Docker 容器；Ubuntu 23.10+／24.04 受 AppArmor 限制），AgEnD 不會為了問版本而啟動 CLI，所以 Grok 的版本一直是未知。現在改從 Grok 放在下載檔旁邊的 `.metadata_version` 讀取（只在該檔案不比執行檔舊時採用），不啟動任何程式。仍然讀不到版本時（Antigravity 沒有把版本寫在磁碟上），卡片會顯示「讀不到已安裝的版本」，不再顯示「已安裝 ？」。
