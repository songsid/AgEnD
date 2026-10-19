---
section: Added
---
- **Agent：General 可以替你修改「設定 → 網頁外觀」（#2056）。** 在聊天中請它幫忙即可。
  - **工具：** `get_web_settings` 以白話說明該頁的每一項設定；`set_web_settings` 一次修改一項，經過與網頁相同的檢查。
  - **涵蓋範圍：** 主機設定（是否顯示 agent 的主題、識別色與顯示位置、卡片大小、側欄小工具）、某個 agent 的顏色、聊天中的效果或效果欄位（Canvas Worker 效果仍是 2.3 beta）、agent 提出的 mod（先檢視，再只安裝你要的部分），以及還原預設。
  - **自訂 CSS：** 維持原本的安全規則。General 只能把它放上試用、還原試用或關閉；要保留仍須你在自己的畫面上按一下。
  - **誰有這些工具：** General、coordinator 與 full profile 的 instance。其他 agent 仍只能改自己的外觀並提出 mod。
  - **仍須在網頁上操作：** 從你電腦選檔案、這個瀏覽器自己的開關，以及卡片上傳上限。
