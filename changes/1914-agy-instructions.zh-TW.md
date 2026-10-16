---
section: Fixed
---
- **Linux 上的 agy instance 重新拿到 fleet 指令（#1914）。** AgEnD 原本把指令寫到 `.agents/agents.md`，但 agy 讀的是 `.agents/AGENTS.md`；在區分大小寫的檔案系統上它從來沒讀到（macOS 預設不分大小寫，兩個檔名是同一個檔，所以在 Mac 上沒有問題）。
  - 現在改寫到 `.agents/AGENTS.md`。只有舊的 `.agents/agents.md` 時，會改名成新檔名，你自己加的內容都會保留。
  - 如果你已經有自己的 `.agents/AGENTS.md`，會原封不動；只有 AgEnD 自己的區塊會從舊檔移出。改名時絕不覆蓋新檔名上已有的任何東西，包括同一時間剛建立的檔案。
  - 如果 `.agents/AGENTS.md` 是指向不存在檔案的符號連結，AgEnD 會保留它、不寫入指令，並在啟動時告訴你。
