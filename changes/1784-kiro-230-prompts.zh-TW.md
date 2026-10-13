---
section: Fixed
---
- **kiro-cli 2.30.0：AgEnD 重新會回答改了措辭的 Classic 提示（#1784）。**
  - 2.30.0 把 kiro 啟動提示裡的「3.0」改成「V3」。AgEnD 因此認不得 legacy（Classic）instance 啟動時遇到的 Classic 停用提示：既不回答也不擋住，instance 收不到訊息，直到有人手動回答。
  - 現在 AgEnD 照舊回答：先從「Switch to V3」往下移一格，再選「Remind me later」，每次按鍵前都確認游標位置。不會改動你的引擎設定。
  - 改了措辭的 V3 提示（「You're using Kiro CLI V2. Switch to V3 today.」）和 agent 設定提示（「still in the V2 format」）也一樣，分別回答「Remind me later」和「Not now」。「Don't ask again」或 AgEnD 讀不懂的游標，仍留給你決定。
