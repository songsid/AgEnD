---
section: Fixed
---
- **訊息不會再打進佔用 kiro 窗格的編輯器、分頁器或 `!` 指令（#2682）。** kiro 實例正在執行 `/editor`、`/transcript`、`!` 指令或取得焦點的 `/kvim` 面板時（legacy 則是 `/editor`、`/reply`、`!`），AgEnD 會暫停投遞，並顯示「Kiro's terminal is in use by another program — finish or close it in the instance pane」。kiro 的輸入列回來後，暫停的訊息才會送進去。修正前，貼上的內容和 Enter 都會送進那個程式：vi 會把貼上的內容當成指令，`!` 指令則會把它吞掉。#2676 的忙碌中插入也會打進正在執行的 `!` 指令。現在只有畫面上看得到 kiro 自己的輸入列（TUI 輸入框或 legacy 提示列）時才會投遞，所以無法辨認的畫面也會等待。
