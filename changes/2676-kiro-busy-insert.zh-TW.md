---
section: Changed
---
- **送給忙碌中 kiro 的訊息幾秒內就送進去，不必等這一輪結束（#2676）。** AgEnD 本來就能 steer 進忙碌輸入框的 kiro TUI 啟動，現在一般訊息也會直接打進那個輸入框，就像 claude-code 與 codex 把訊息收進自己的佇列一樣，不再需要 `/steer`。兩種模式 kiro 都會收：`Type to steer` 會把訊息併入進行中的這一輪，`Type to queue` 則在這一輪結束後當成下一輪送出。AgEnD 不會切換模式。檢查和 steer 相同：貼上前輸入框必須是空的，按下唯一一次 Enter 前要顯示這則訊息，輸入框再度清空才算送達。較長的訊息會被 kiro 收合成 `42 lines ▸`，以行數比對。超過 500 字元的單行訊息，以及 legacy UI（輪次進行中按的 Enter 會被丟掉），仍然等待閒置提示。
