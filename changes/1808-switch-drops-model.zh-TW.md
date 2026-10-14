---
section: Fixed
---
- **agent 切換 instance 的 backend 後，不會再留在舊 backend 的模型上（#1808）。**
  - 以前 `update_instance_config` 給了新的 `backend` 卻沒給 `model` 時，會保留 instance 原本的模型。agent 把 instance 從 claude-code 換到 codex，codex 就會以 `--model opus` 重新啟動，之後每一輪都失敗。
  - 現在切換 backend 時，除非有指定，否則會拿掉 instance 自己的模型和推理強度，新的 backend 用它自己的預設（或繼承的 fleet 預設）。
  - 新 backend 不接受的模型會在寫入任何東西之前被拒絕，並列出它可選的模型。它沒有的推理強度也一樣。
  - 「接受」的判斷和 `/backend` 用的是同一條規則：backend 提供的清單（以及 claude-code 認得的名稱）；還沒有清單時，看它常見的模型名稱格式。
