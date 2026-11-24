---
section: Changed
---
- **新的 fleet 預設開啟任務板。** `agend init`、`agend quickstart` 和設定頁以前會寫入 `defaults.dashboard.task_board: false`，新使用者打開看板後，留言和 `#` 引用都沒有任何作用，也沒有說明原因。新的 `fleet.yaml` 現在不寫看板的設定，看板是開的；既有的檔案不會被改寫，裡面的 `false` 照舊。某個 agent 的看板關閉時：Tasks 頁會點名並說明去哪裡打開（設定 → Agent 共用設定，或這個 agent 自己的設定 → 進階），卡片的留言框會說這則留言叫不醒負責人或被 @ 的 agent，用 `#` 引用卡片送給它時，聊天會說明沒有把卡片交給它。
