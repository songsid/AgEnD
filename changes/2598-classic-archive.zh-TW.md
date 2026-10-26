---
section: Fixed
---
- 重新啟動已帶入的 kiro 2.34+ 對話前，AgEnD 會驗證有所有權的 V2 副本，將原封不動的凍結 classic 紀錄寫入私人、校驗碼驗證過的備份，再於 instance 停止時只移除這些紀錄。因舊版重試流程被放棄的固定 id，會先修復，再考慮空白的替代 session；證據不完整時會停止，不會改開新對話。可用 `agend kiro restore-classic` 還原已驗證的備份，不會覆寫既有資料（#2598）。
