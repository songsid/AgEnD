---
section: Fixed
---
- **kiro：AgEnD 讀的是 instance 實際所在的對話（#2598）。** AgEnD 會追蹤每個 kiro instance 的對話，看它的工具使用和回覆。它以前一律先看 kiro 的經典儲存區。經典對話在 kiro 的 TUI 下接續時，kiro 會把它複製到 TUI 的 session 檔，經典那份就不再更新；AgEnD 卻一直讀那份凍結的副本，看不到 instance 的新進度。現在 AgEnD 依 instance 啟動時的引擎讀對應的儲存區。接續既有對話的 instance 會跟著自己的對話，而不是資料夾裡最新的那個（那可能屬於同資料夾的另一個 instance）。較舊、無法得知引擎的 kiro 照舊讀取。
