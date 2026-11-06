---
section: Added
---
- 設定 → Runtime → 連接電腦現在有兩種安裝方式。**Windows（PowerShell）**會顯示可複製的安裝指令與連線指令，並帶入確認過的 AgEnD 位址；**其他安裝方式（ZIP）**維持原本的下載與 `connect-agend.bat` 流程。安裝指令（`irm "$agend/runtime/install.ps1" | iex`）會檢查 Node.js 22.14 以上、下載這台 AgEnD 的 Runtime、在解壓縮前驗證寫死的 SHA-256、安裝到 `%LOCALAPPDATA%\agend-runtime`，並把 `agend-runtime` 加進你的使用者 PATH。它不需要系統管理員權限，也不會連線或配對；一次性配對碼仍在終端機輸入，電腦仍需要你核准。
- AgEnD 伺服器新增 `/runtime/install.ps1` 與 `/runtime/v1/bundle/windows.zip`，為唯讀、靜態、有限速、不用登入的下載。只有在「允許其他 Windows 電腦配對」開啟時才存在（關閉時回 404），不經公開 gateway 連結，且只接受 HTTPS 或 loopback。內容不含 token、密鑰、配對碼或伺服器位址，也不授予任何存取權限。
