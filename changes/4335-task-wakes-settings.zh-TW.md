---
section: Added
---
- **任務板的叫醒開關在設定頁。** 設定 → Agent 共用設定 → 進階，在「接手者停下來時」旁邊新增「任務板何時叫醒 Agent」：「留言叫醒 Agent」（`defaults.task_board.comment_wakes`）、「進度叫醒關注卡片的人」（`progress_wakes`）和「任務板 leader」（`leader`，從這個 Fleet 的 Agent 裡選）。每個開關都有一句話說明關掉後哪些情況不會叫醒誰。Fleet 在每次卡片變動時都會重新讀取，所以改完下一次變動就生效。儲存時只寫你改的部分（沒動的開關不會被寫進 fleet.yaml，`task_board` 裡其他的設定也保留），leader 的名字會顯示在確認畫面。
