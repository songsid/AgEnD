---
section: Changed
---
- **推理強度的選項跟著模型走，並從 CLI 自己的清單讀取（#3636）。** Claude 的等級來自帳號的 `GET /v1/models`（`capabilities.effort`）：Opus／Sonnet 4.6 沒有 `xhigh`、Opus 4.5 只到 `high`、Haiku 4.5 完全沒有強度設定。Grok 的等級來自它的 `models_cache.json`（`reasoning_efforts`），所以有 `xhigh` 的模型才會提供，沒有強度設定的模型不會帶 `--reasoning-effort`。讀不到清單時（沒有 cache、`opus` 這類別名、cache 過期）選項和以前相同。Grok 連不到 CLI 時的備用模型清單，現在先讀它自己的模型 cache，再退回它現在列出的模型。Muse 在設定摘要裡的強度不再顯示「—」。
- **聊天標題的強度 chip 一律顯示（#3636）。** 後端支援強度設定的 Agent，即使還沒設定也會顯示 chip（`auto`，也就是 CLI 自己的預設），一點就能用 `/effort`。以前要先設定過強度才會出現。
- **手機的模型清單會顯示每個模型的強度（#3636）。** `/model` 一列一個模型，右邊是強度（沒設定顯示「自動」）和 `›`；點 `›` 進入該模型自己的強度清單（目前使用的打勾，`‹` 返回），選一個等級時，若那不是目前使用的模型，會先換模型再設強度。沒有強度設定的模型沒有 `›`。輸入框上方的「Claude Code／模型」按鈕改用小尺寸（30px，原本 44px），觸控範圍仍是 44px。桌機標題列不變。這裡和 chip 的 `/effort` 清單一樣，不提供選回「自動」。
