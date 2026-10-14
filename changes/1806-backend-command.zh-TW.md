---
section: Added
---
- **`/backend`：從聊天把 instance 換到另一個 CLI backend（#1806）。**
  - Discord、Telegram 和 web chat 都能用，權限和 `/model` 完全相同：頻道管理員。
  - 先選 backend（只列這台主機已安裝的 CLI），再選模型（`/model` 的清單，或預設），再選推理強度（`/effort` 的等級；backend 沒有推理強度就跳過），最後確認。`/backend <backend> [模型] [推理強度]` 會直接跳到確認。
  - 確認之前不會有任何變更。確認後，backend、模型和推理強度一次寫入，instance 只**重新啟動一次**，並開**全新的 session**：對話不會跨 backend 延續。正在進行的一輪會被中斷。停止或暫停中的 instance 只儲存、不會啟動。
  - 走的是 `update_instance_config` 的 backend 切換：套用新 backend 自己的選項；若憑證 profile 沒有新 backend 的登入，會被拒絕，並附上登入指令。被拒絕時不會留下只改了一半的設定。
  - 未安裝的 backend，或新 backend 沒有的模型、推理強度，會被拒絕並列出可選項目。選到目前已在用的 backend 不會有變更，並提示改用 `/model` 和 `/effort`。
  - 只適用 fleet instance：ClassicBot agent 的 backend 在 `classicBot.yaml` 或設定頁裡設定，`/backend` 在那裡會說明這點。
