---
section: Fixed
---
- `/login`：有人把 bot 私訊的一次性存取 token 貼進聊天（topic、General 或網頁聊天）時，AgEnD 會在記錄、建索引或交給 agent 之前把它遮掉，接著作廢這個 token、私訊一個新的（或顯示在儀表板的登入視窗），並在那裡回覆一次，說明 token 要貼到終端頁面，不是聊天裡。之前這個 token 會以明文寫進 daemon.log、活動紀錄和搜尋索引。
