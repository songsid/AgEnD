---
section: Changed
---
- `agend restart`（以及 `agend update`）在使用者 systemd 失去 socket（WSL 可能換掉 `/run/user/<uid>`）或沒有執行時，會以 root 先修復它；非 root 使用者會看到要執行的完整 `sudo` 指令。Windows 捷徑 **AgEnD 重新啟動** 也會逐層檢查，只有在 systemd 沒有執行、而且你輸入了 Linux 名稱時，才會只重新啟動那一個 Linux。現有捷徑執行 `agend shortcuts` 就會更新。
