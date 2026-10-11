---
section: Fixed
---
- **View：清除顯示名稱後會恢復 agent 自己的名稱（#1630）。** 以前在 View 的**編輯個人資料**清除顯示名稱時，會存成空名稱，仍然蓋過 agent 自己設定的名稱（`set_display_name`），結果顯示的是 instance 名稱。現在清除會移除覆寫，再次顯示 agent 自己的名稱（或 instance 名稱）。這次更新前清除過的顯示名稱也會恢復。
