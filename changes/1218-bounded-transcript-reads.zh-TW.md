---
section: Fixed
---
- **AgEnD 不再一次讀完很大的對話紀錄（#1218）。**
  - 以前 agent 在兩次讀取之間寫了很多內容時（長指令的輸出、數 MB 的工具結果、追趕中的 300 MB codex session），AgEnD 會在主迴圈上一次把整段差異讀進記憶體。
  - 現在每次最多讀 1 MiB，每輪讀幾次。超過 256 KiB 的單行只看開頭 8 KiB，用來判斷這一步屬於哪個工具，所以進度訊息不會漏掉它。claude-code、codex 與 kiro 的 session 檔都適用。
