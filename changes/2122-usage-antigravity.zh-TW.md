---
section: Added
---
- 用量報告（Fleet → Usage、`get_usage_report`、CSV）現在可量測 Antigravity：每次生成的 token 取自 agy 的對話資料庫（輸入、快取讀取、輸出與其中作為推理的思考），依對話的工作區歸屬。Claude 模型依牌價換算；Gemini 模型為「未定價」。資料庫沒有公開格式，所以只讀取 agy 1.4.x（已核對的版本）；其他版本列為未量測。至此，AgEnD 執行的每個 backend 都在報告裡。
