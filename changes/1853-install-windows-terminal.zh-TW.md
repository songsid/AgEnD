---
section: Changed
---
- **Windows 安裝程式在有 Windows Terminal 時改在它裡面開。** 以系統管理員執行的安裝視窗原本是舊的藍色主控台，中文可能顯示成方框。裝有 Windows Terminal（Windows 11 內建）時，安裝程式和兩個桌面捷徑都改在它裡面開；你貼上指令的那個視窗一樣會等它，最後告訴你安裝的結果（或安裝視窗被提早關掉）。沒有 Windows Terminal 時一切照舊，設定 `AGEND_INSTALL_TERMINAL=conhost` 也會維持舊視窗。長步驟的即時進度列在舊主控台裡不會再每秒多一行，中文也不會再變成亂碼（#1853）。
