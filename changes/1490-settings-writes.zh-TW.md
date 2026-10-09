---
section: Security
---
- **Settings 的確認流程不再能透過「立即生效」設定的子欄位繞過（#1490）。**
  - 把敏感欄位放進立即生效設定的物件裡（例如 `persona: { bot_token: … }` 或 `persona: { allowed_users: … }`），原本會跳過管理員確認。
  - 現在這類欄位與其他密鑰或存取變更一樣需要確認；未知欄位會被拒絕。
  - 只有 `status_emojis` 與 `hang_detector` 的已知子欄位仍可不經確認立即生效。
- **在 Settings 儲存連線時只會寫入連線欄位（#1490）。**
  - `PUT /api/settings/fleet/channels` 會拒絕 Settings 不負責的欄位，例如內嵌的 `bot_token`、未知的 option 或未知的 access 欄位。
  - 手動加在 fleet.yaml 裡的欄位仍會原樣保留。
