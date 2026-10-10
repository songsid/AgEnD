---
section: Fixed
---
- **精靈建立的 Discord 連線現在能正確綁定 General 頻道。** `planQuickstart` 原本將 `general_channel_id` 寫在連線頂層（c25045b0 引入的 bug），但 runtime 讀的是 `channel.options.general_channel_id`。精靈現在寫入正確位置。含舊頂層欄位的既有 fleet.yaml 檔案仍透過 `discordGeneralChannelId()` 的 fallback 繼續支援。(#1552)
