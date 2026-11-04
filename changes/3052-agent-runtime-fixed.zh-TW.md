---
section: Fixed
---
- **已配對到另一個 AgEnD 的電腦現在也能連線。** 從連線就緒的 ZIP 雙擊 `connect-agend.bat` 時，會保留原有配對，並在 `profiles\<host>-<port>` 下為新的 server 另外配對一個獨立 profile；同一個 bat 以及在該資料夾執行的 `run`/`status`/`rotate`/`disconnect` 都會重用它。憑證不會被送往不同的 server，明確指定 `--profile` 時行為不變。`disconnect` 與 `rotate` 不再被 Windows 重開機前留下的鎖擋住；真的還在執行的 Runtime 仍保有它的鎖，訊息會指出要檢查的程序。
- AgEnD 中斷連線時，`connect-agend.bat` 不再讓視窗一閃而過：視窗會保持開啟，說明原因（電腦已被撤銷或不被辨識、同一組配對被另一個 Runtime 接手、或訊息被拒絕）與下一步，且 Runtime 以非 0 的結束碼離開。若資料夾仍保留另一個 AgEnD 的工作紀錄，現在不會再重送給新的伺服器（過去會在顯示「Connected」之後立刻被中斷）。
