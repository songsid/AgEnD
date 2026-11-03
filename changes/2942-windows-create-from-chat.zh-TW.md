---
section: Changed
---
- 現在也能從 Discord 或 Telegram 建立或設定 Windows agent，但只能由 fleet 管理員在 General 的確認卡上確認。當 agent 以 `runtime: "windows"` 呼叫 `create_instance`，或對 Windows agent 呼叫 `update_instance_config`（只限顯示名稱、描述、模型）時，呼叫本身不會建立或變更任何東西，而是保留為待處理的請求，確認卡會顯示磁碟路徑、沙箱模式與其他設定。只有 fleet 管理員在 General 按下「確認」才會套用，且只套用一次；按下「拒絕」或五分鐘內未確認，則不會有任何變更。網頁儀表板的路徑不變。
- 仍然拒絕：`replace_instance`、`deploy_template`、Windows 開關關閉的情況（會立即拒絕，確認時也會再次檢查），以及任何 agent 無法從網頁編輯器要求的 Windows 設定。
