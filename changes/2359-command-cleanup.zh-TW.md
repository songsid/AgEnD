---
section: Changed
---
- **過時與重複的 CLI／聊天指令（#2359）。** `agend status` 是 `agend ls` 的隱藏別名，已送出的更新訊息與 Windows 捷徑仍可照跑。`agend fleet status` 是 `agend ls --resources` 的隱藏別名。已移除的指令打字會印一行指向：`agend schedule trigger`（沒有 Telegram 觸發介面）、`agend fleet logs`（請用 `agend logs`）、`agend install --activate`（啟用服務已是預設）、以及打字的 `/install-cli`／`/install_cli`（請用 `/login`，不再執行登入）。`/web` 是主要網頁指令；`/dashboard` 仍列在 Telegram 與 Discord 上並標為已棄用（「已棄用 — 請用 /web」），執行時先印一行提示再跑 `/web`。`agend health` 與 `agend doctor` 分開保留（即時 fleet 對上主機／安裝診斷）。`agend quickstart`、`setup`、`init` 仍是三條第一次設定路徑。第一次設定的文案改為 `agend start`。
