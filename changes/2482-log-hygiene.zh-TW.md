---
section: Changed
---
- **daemon.log 縮短約 60%，沒有遺漏任何與事故相關的紀錄（#2482）。** 以前 agent 每一輪都會記兩行「execution state changed」和兩行取消按鈕的紀錄，現在都改為 debug 等級（進入或離開「stuck」仍會記錄）。暫停中的 instance 不會再在每次重新載入時被記成「New instance in config — starting」。你自己的 skill 蓋過內建 skill 的警告，改成每個資料夾一行，而且只有在那組 skill 或其內容改變時才會出現，不再每次啟動都記。Discord 停止後，失敗的訊息編輯只記一行，而不是每次編輯一行。以一天的實際紀錄重播：72,824 → 27,260 行，所有 watchdog、crash、auth 和傳送失敗的事件都保留。
