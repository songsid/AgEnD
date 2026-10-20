---
section: Added
---
- **`agend shortcuts`：在 WSL 裡建立 Windows 桌面捷徑。** 給安裝時還沒有「AgEnD 儀表板」和「AgEnD 重新啟動」、或平常只用 `agend update` 更新的人：它透過 WSL interop，在 Windows PowerShell 裡執行安裝程式自己的捷徑程式碼，對象是目前這個 Linux 和你的使用者。interop 關閉時會直接說明，並建議再貼一次 Windows 一行安裝指令。在還沒有捷徑的 WSL 終端機裡執行 `agend update` 之後，會出現一行提示，只出現一次；更新本身絕不會在桌面上放任何東西（#1853）。
