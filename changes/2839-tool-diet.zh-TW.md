---
section: Changed
---
- Agent 每一輪帶的工具定義少了約 4,000 個 token：
  - 外觀工具（主題、圖片、小工具、氛圍效果）預設改為關閉，要用的 Agent 請在「設定 → Agents」逐一開啟。開啟後，Agent 看到的是一個 `web_appearance` 工具，不再是十個。
  - 表情符號和貼圖的工具合併成一個 `emoji_sticker` 工具。
  - task、reply、report_result 的說明改得更短，欄位一個都沒少。任務看板的完整規則移到新的 `task-board` 技能。

  沿用舊工具名稱接續的工作階段，仍然可以呼叫舊名稱。
