---
section: Fixed
---
- **Settings 精靈 S1：新增第二個平台不再靜默覆蓋第一個連線。** `draftQuickstart` 原本以 `bot_token_env` 比對現有連線並直接取代。現在永遠新增一筆。精靈 UI 的 `token_env` 預設改為依平台命名（`AGEND_TELEGRAM_TOKEN` / `AGEND_DISCORD_TOKEN`），並在切換平台時自動更新，讓每個連線自然使用不同的環境變數。(#1519)
- **Settings 密鑰端點：公開連結（gateway）session 一律回傳 403。** 六個負責寫入或驗證連線 token/密鑰的端點，現在在公開連結 session（`surface: "gateway"`）呼叫時會回傳 403 和明確錯誤訊息。本機 dashboard session 不受影響。(#1519)
