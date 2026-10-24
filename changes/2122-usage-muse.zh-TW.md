---
section: Added
---
- 用量報告（Fleet → Usage、`get_usage_report`、CSV）現在可量測 Muse：每次模型呼叫的 token 取自它的工作階段，subagent 的用量算在其父工作階段所屬的 agent，含推理。Muse 的快取寫入顯示為「未回報」（目前一律為 0），金額為「未定價」（Meta 沒有公開每 token 價格）。
