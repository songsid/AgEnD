---
section: Changed
---
- **Config validator 現在會在 instance 條目裡設定 `startup` 時發出警告（#2322）。** `startup.concurrency` 與 `startup.stagger_delay_ms` 是 fleet 層級的控制項，應放在 `defaults.startup` 下；放在 `instances.X.startup` 底下不會產生任何效果。請將此設定移至 `defaults.startup` 或直接移除。
