---
section: Added
---
- **網頁授權：伺服器總開關、撤銷，以及 session 授權一次（#1939，第 2a 步）。**
  - **`web.verified_authority.enabled`**（自第 2c 步起預設開啟）是伺服器總開關。關閉時網頁訊息不記錄授權，已記錄的網頁授權在 `delivery_status` 中一律視為無。再打開也不會讓那些授權恢復。
  - **授權一次。** 只有該帳號授權過一次的 session 送出的網頁訊息才帶有授權（`web-verified`），最長 `max_session_hours`（預設 48 小時）。由帳號在 Discord 或 Telegram 上確認（第 2b 步）。
  - **撤銷。** `/web revoke` 現在也會撤銷到目前為止給出的所有網頁授權，並結束所有授權。打開「只有這台電腦」（`loopback_only`）會讓之前從區網給的授權視為無，再關掉也不會恢復。`delivery_status` 會說明收據為何視為無（`downgraded`）。
