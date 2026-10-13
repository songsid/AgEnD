---
section: Fixed
---
- **agent 回覆附加的檔案，在 fleet 重新啟動後仍可在網頁聊天中開啟（#1770）。**
  - 以前回覆附的 .html 或 .png 在更新或重新啟動後，通常會顯示「無法取得」：網頁聊天只保留放在 instance inbox 裡的檔案，但 agent 通常從 /tmp 或自己的工作資料夾傳檔。agent 之後改寫或刪除檔案，或 /tmp 被清掉，也會讓檔案失效。
  - 現在網頁聊天會把每個回覆檔案另存一份到 `workspaces/<instance>/web-files/`，並顯示這份副本。符號連結、超過 50 MB 的檔案，以及 AgEnD 狀態資料夾內（inbox/ 以外）的檔案不會顯示。
  - 訊息離開網頁聊天紀錄時，副本會一併刪除。每個 instance 最多保留 1 GiB，超過時先刪最舊的副本。副本不在時，訊息照舊把檔案標為無法取得。Telegram 與 Discord 不受影響。
