---
section: Added
---
- 用量報告（Fleet → Usage、`get_usage_report`、CSV）現在可量測 Grok：每個回合的 token 取自它的工作階段更新（輸入、快取讀寫、輸出與其中的推理、模型呼叫次數），依工作目錄歸屬。價目表沒有的 Grok 模型，金額取 grok 自己回報的費用，並標示「金額為 CLI 自行回報」。
