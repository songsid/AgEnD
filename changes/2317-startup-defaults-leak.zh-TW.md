---
section: Fixed
---
- **修正 SIGHUP 熱重載：只改 `defaults.startup` 時不再重啟所有 instance（#2317）。** `defaults.startup.stagger_delay_ms` 與 `defaults.startup.concurrency` 原本會被合併進每個 instance 的設定，導致這兩個欄位一旦變更，每個執行中的 instance 都會判定「設定已變更」而被重啟。這些欄位現在已正確視為 fleet 層級的控制項，不再傳播到 instance 設定中。
