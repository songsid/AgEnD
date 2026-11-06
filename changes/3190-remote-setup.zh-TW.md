---
section: Added
---
- **Windows 電腦的本機管理員現在可以讓 AgEnD 管理那台電腦上的 Claude 帳號（Runtime 端，尚無 Dashboard 畫面）。** `agend-runtime remote-setup accounts on [--for 2h]`（以及保留給安裝 CLI 的 `install`）是兩個預設關閉、只能在那台電腦上設定、也可以自動關閉的開關。`accounts` 開啟後，Fleet 管理員的請求可以新增、登入、登出與移除「由這個 Runtime 自己建立」的 Claude Code profile。請求只帶名稱、走 AgEnD 不會儲存的專用訊息，登入畫面也由固定的白名單行重組，所以只有連結與一次性 code 會離開那台電腦。登出時會一併刪除該 profile 的 `backups\.claude.json.backup*`；當該 profile 是配對的預設、有執行中的任務或終端機、或正在登入時，移除會被拒絕，而且不會跟隨連結或 junction。每個請求都會記錄在那台電腦的 `audit.jsonl`。遠端只接受訂閱（Claude 帳號）登入，Codex profile 尚未提供。
