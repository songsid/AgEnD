---
section: Fixed
---
- Kiro 原生 TUI 的 trust-all-tools 確認畫面改為 startup/runtime 共用結構式 selector（#849，A 部分）。AgEnD 從「No, exit」只送一次 Down，重新觀察游標確實位於單次 session 的「Yes, I accept」後才送 Enter。未知布局、游標未移動與「Yes, and don't ask again」保留給人處理；歷史引用不會收到同意按鍵。既有 model-picker hold 與 engine/session 身分鎖定不變。本次不開放 `kiro_ui: v3`；v3 startup/enablement 與後續 steering 驗證等有原生證據及使用者需求再議。

- 每個 consent phase 的單次 claim 跨 startup／runtime 保留，包含按鍵 ACK 不明的情況；stop 與 tmux replacement 會淘汰舊 runtime 按鍵。原生 column-zero TUI composer 會排除被複製的 trust 畫面。
