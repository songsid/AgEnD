---
section: Fixed
---
- **設定：`web.access` 會有警告，「/web 已停用」會說 Fleet 管理員要設在哪裡（#1874）。**
  - 誰能用 `/web`、`/update`、`/doctor`，看的是 Fleet 管理員名單：bot 的 channel 底下的 `access.allowed_users`。沒有 `web.access` 這個設定。
  - `agend validate` 現在會對 `web.access` 提出警告，說明名單實際要設在哪裡；`web` 底下其他不認得的鍵也會警告。以前這些鍵都被默默忽略。
  - 名單空白時，`/web` 與 `/update` 的回覆會指出確切的鍵，例如 `channel.access.allowed_users` 或 `channels[id: main].access.allowed_users`。
