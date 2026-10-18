---
section: Added
---
- **網頁授權：伺服器總開關、撤銷與「須再確認」清單（#1939，第 2a 步）。** 仍然只是記錄：agent 仍把網頁訊息當成辨識。
  - **`web.verified_authority.enabled`**（預設關閉）是伺服器總開關。關閉時網頁訊息不記錄授權，已記錄的網頁授權在 `delivery_status` 中一律視為無。再打開也不會讓那些授權恢復。
  - **撤銷。** `/web revoke` 現在也會撤銷到目前為止給出的所有網頁授權。打開「只有這台電腦」（`loopback_only`）會讓之前從區網給的授權視為無，再關掉也不會恢復。`delivery_status` 會說明收據為何視為無（`downgraded`）。
  - **須再確認的清單。** `web.verified_authority.step_up.enforce` 列出一律需要該帳號當下再確認一次的動作：預設是發布、強制推送與刪除 instance，另有七項可選，也可在 `step_up.custom` 加入自訂動作。`delivery_status` 會隨每張人類收據回傳目前生效的清單。
