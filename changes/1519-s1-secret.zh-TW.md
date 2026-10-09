---
section: Fixed
---
- **Settings 精靈 S1：新增不同平台的第二隻 bot 不再取代第一個連線。** `draftQuickstart` 現在只有在平台類型、`bot_token_env` 和實際 bot 身分（group_id / guild_id）三者全部一致時才就地更新；跨平台或不同群組的情況永遠新增一筆。`defaultTokenEnvName` 計算唯一 env 名稱，精靈以 `token_env_is_auto` 旗標追蹤是否為自動填入，確保手動輸入的值（包含 `_2` 後綴）在切換平台時不被覆蓋。(#1519)
- **Settings 密鑰端點：公開連結（gateway）session 一律回傳 403。** 六個負責寫入或驗證連線 token/密鑰的端點，以及接收原始 bot token 的 quickstart probe 端點，現在在公開連結 session（`surface: "gateway"`）呼叫時回傳 403。本機 dashboard session 不受影響。(#1519)
