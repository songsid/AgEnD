---
section: Added
---
- 用量報告（Fleet → Usage、`get_usage_report`、CSV）現在涵蓋 Kiro。Kiro 不記錄 token 數，所以每個回合都依文字長度、照 tokscale 的做法**估算**，來源涵蓋 Kiro 的三個儲存區（classic、TUI 與 V3），並依指名模型的牌價換算（`auto` 不定價）。每一列 Kiro 都標示「估算」，總計會註明含估算值、以及金額中估算的部分，CSV 也有 `estimated` 欄。掃描在 worker thread 上執行，絕不寫入 Kiro 的儲存區。
