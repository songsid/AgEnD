---
section: Fixed
---
- **在 Telegram 的 instance topic 下只能在 General 使用的指令，現在會直接說明，不再送到 agent（#1148）。** 論壇群組的指令選單在每個 topic 都一樣，所以 `/status`、`/sysinfo`、`/dashboard`、`/restart`、`/update`、`/profile`、`/doctor`、`/login`、`/usage`、`/visibility` 在 instance topic 也看得到。以前在那裡選了，會被當成一般文字交給 agent：沒有任何動作，也沒有說明。現在會回覆「要在 General topic 使用，請到那裡執行」；在 General 照常運作。
