---
section: Fixed
---
- **CI：改到文件的 PR 現在會跑測試。** 測試會讀 `docs/` 裡的檔案和根目錄的 README，所以只改文件、卻動到測試釘住的那一列的 PR，可能在 test shards 被跳過的情況下合併（#1929 就這樣讓 main 變紅）。現在只有僅改動 `changes/` 片段的 PR 才會跳過測試。(#1932)
