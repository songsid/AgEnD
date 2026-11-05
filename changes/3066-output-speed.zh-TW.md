---
section: Added
---
- **「Fleet → 用量」現在會顯示每個模型的輸出速度。** 「速度」欄與「各模型速度」卡片顯示從第一個 token 起算的每秒輸出 token 數：也就是模型本身的生成速度，不含工具執行的時間。卡片也會列出有幾個請求可計時；累積 30 個可計時的回應後，另顯示 p10–p90 範圍。`get_usage_report` 會在每一列、總計與 `speedByModel` 中以 `speed` 回傳。
  - **哪些會計時。** Claude Code 的回應在以思考區塊開頭時可計時；Codex 的回應依 Codex 0.147 之後記錄的項目時間計時。
  - **方法與致謝。** 方法參考 [tokdash](https://github.com/JingbiaoMei/tokdash)（MIT，Jingbiao Mei），並記載於 `THIRD_PARTY_NOTICES.md`。(#3066)
