---
section: Changed
---
- **General 平常保持安靜（#2804）。** 21:00 的每日花費報告改為預設關閉，要的話設定 `defaults.daily_summary.enabled: true`，就會和以前完全一樣。無論開不開，日誌和收件匣的輪替每天照常進行。任務看板 09:00 的每日摘要移除了；`fleet.yaml` 裡已有的 `defaults.task_board.summary_at` 照常載入，但不再有作用。花費仍可在網頁的「用量」頁查看。
