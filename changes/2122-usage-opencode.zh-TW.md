---
section: Added
---
- 用量報告（Fleet → Usage、`get_usage_report`、CSV）現在可量測 OpenCode：每則已完成的助理訊息的 token 取自它的資料庫（輸入、快取讀寫、輸出與推理），依其工作階段的目錄歸屬，OpenCode 兩張訊息表中的同一則訊息只算一次。價目表沒有的模型，若供應商有收費，金額取該費用並標示「金額為 CLI 自行回報」，否則為「未定價」。
