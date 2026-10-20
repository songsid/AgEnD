---
section: Added
---
- **Windows 桌面新增「AgEnD 重新啟動」捷徑**，放在「AgEnD 儀表板」旁邊。它會先詢問（「確定要重啟 AgEnD 嗎？…」，預設不重啟），確定後才在安裝時記下的 Linux 和使用者裡執行 `agend restart`（不預設是哪個使用者），接著顯示 `agend status`，等你按 Enter。WSL 或 AgEnD 不在時會直接說明，也絕不會關閉 WSL。**已經安裝的電腦：** 再貼一次 Windows 一行安裝指令時，如果偵測到已經裝好 AgEnD，只會提供新增或更新這兩個捷徑，不會重做 WSL、後端或設定。
