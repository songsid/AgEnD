---
title: 2.2 更新重點
description: "從 AgEnD 2.1 升級會注意到的變化：網頁聊天、集中的等你處理清單、多個 Claude 帳號、自帶 Node，以及更順利的升級。"
---

AgEnD 2.2 在 Telegram 和 Discord 之外，多了一個網頁 app。你可以從瀏覽器和 agent 對話，在同一個地方看到所有在等你處理的事，也可以用第二個 Claude 帳號。fleet 也會自帶 Node，在更多種主機上都能順利升級。這一頁寫給從 2.1.x 升級的人：列出你會注意到的變化，附上詳細說明的連結。

## 一步升級

- **從 2.1.12 在 Linux 或 macOS 上升級：** 在 General 傳 `/update`，或在主機上執行 `agend update`。fleet 會以 2.2 重新啟動，General 會收到一則簡短的新功能說明。適用於有 glibc 2.28 以上與 systemd 的 Linux（包括開啟 systemd 的 WSL），以及 macOS 11 以上，x64 或 arm64。
- **從 2.1.0–2.1.11 升級，或在其他平台上：** 請依[升級指南](https://github.com/songsid/AgEnD/blob/main/docs/upgrade-2.2.zh-TW.md)的手動步驟操作。
- **升級進行時，** 聊天會顯示每一步（下載、安裝、重新啟動），失敗時也會說明是哪一步失敗、原因。從 2.2 起，失敗的訊息還會附上更新紀錄的位置。

## 在瀏覽器和 agent 聊天

- **用一次性登入碼登入。** 在 General 傳 `/web`。選 **💻 AgEnD 電腦**，可在執行 AgEnD 的那台電腦上登入；選 **🌐 其他裝置**，則透過臨時公開連結，從手機或另一台電腦登入。登入碼只能用一次，五分鐘內有效。連結不再帶任何密碼。
- **和頻道是同一段對話。** 在網頁上寫的訊息，送到 agent 的方式和 Telegram 或 Discord 訊息完全一樣。fleet 頻道的聊天平台上也看得到；ClassicBot 聊天室則要設定 `web_echo: true` 才會同步。重新整理頁面或 fleet 重新啟動後，對話紀錄都還在。
- **完整的聊天功能。** 支援 Markdown、表格和程式碼標色。可以傳任何類型的檔案，預設每個 50 MB、每則訊息合計 100 MB（`web.upload_max_file_mb` / `web.upload_max_total_mb`）；圖片和影音直接在頁面上預覽。看得到訊息送到哪一步、agent 正在處理，也有 **Stop** 按鈕可以中止。agent 提供的回覆按鈕和投票會照樣顯示，提及（mention）也和 Discord、Telegram 上的樣子一致。
- **HTML 預覽。** agent 送來網頁時，可以在對話旁邊的面板打開。預覽預設關閉，開啟一次後，就會套用到所有已登入的裝置，但公開連結例外。預覽會在獨立隔開的網址上執行。
- **手機也好用。** 滑動開關側邊欄，有淺色和深色主題，也支援鍵盤與螢幕報讀器。
- **不需要聊天平台也能用。** fleet 可以只靠網頁 dashboard 運作。在瀏覽器裡就能設定：輸入 bot token、邀請 Discord bot。AgEnD 已經在跑一個連線時，再新增的連線不必重新啟動就會生效。

詳見[網頁 dashboard 指南](https://github.com/songsid/AgEnD/blob/main/docs/web-dashboard.zh-TW.md)，或網站上的[網頁使用說明](/AgEnD/zh-tw/docs/web-guide/)。

## 等你處理的事，集中在一個清單

**等你處理**（Needs you）會集中列出所有 bot 的提示、權限請求、登入、當掉的 agent，以及無法確認的投遞。它在 General 是一則即時更新的訊息，在網頁 app 裡是一個頁面。你在任何地方處理過的事（Discord、Telegram 或網頁），都會從每個清單上消失。詳見[等你處理](https://github.com/songsid/AgEnD/blob/main/docs/web-dashboard.zh-TW.md#等你處理uineeds)。

## 不只一個 Claude 帳號

- **Claude Code 的多組登入（credential profile）。** 和 Codex、kiro-cli 一樣，instance 可以用 `backend_options.claude-code.credential_profile` 改用另一個 claude.ai 帳號。在聊天裡用 `/login claude-code <profile>` 讓這個 profile 登入。用量會每個 profile 各列一行；把 agent 換到別的 profile 時，對話會保留。詳見 [credential profiles](https://github.com/songsid/AgEnD/blob/main/docs/configuration.zh-TW.md#credential-profiles同一-backend-的多個帳號)。
- **在聊天裡換 agent 的 CLI。** `/backend` 會把 instance 換到另一個 backend，再讓你選模型和 effort，只需重新啟動一次。

## 看得到 fleet 在做什麼

- **用量。** 用量面板（◔）會顯示每個訂閱的剩餘額度，寬螢幕時放在右側。
- **紀錄分頁**（需手動開啟，`web.log_tab: true`）。逐步顯示 instance 的提示、回覆和工具呼叫，秘密值會遮蔽，支援 Claude Code 和 Codex。
- **Fleet 頁面。** 可以在網頁上編輯排程和團隊。組織圖顯示誰負責什麼，快取頁面顯示每個 agent 的 prompt 快取多久失效一次，每個 instance 也都有自己的詳細資料頁。

## AgEnD 自帶 Node

在 Linux（glibc 2.28 以上）和 macOS 11 以上的 x64 或 arm64 上，AgEnD 會安裝並使用自己的 Node 22.23.3，不管 PATH 上是哪個 Node，你都不必自己升級 Node。其他環境需要 Node 22.14 以上。詳見[升級指南](https://github.com/songsid/AgEnD/blob/main/docs/upgrade-2.2.zh-TW.md#1-升級前)。

## 在實際的主機上都能順利升級

- **macOS：** 從 agent 自己的面板啟動的更新能夠完成，不會再讓 fleet 停在一半。
- **Linux，以 root 執行、使用系統 unit 的 fleet：** 更新現在會把 unit 指向新版本，fleet 真的會跑 2.2。
- **沒有使用者 session bus、或使用自訂 `AGEND_HOME` 的主機：** 服務都會正確更新並重新啟動。
- **從 2.2 起，安裝被拒絕時會說明原因。** 由 2.2 或更新版本執行的更新，聊天會顯示 AgEnD 自己的原因，而不是只有 npm 的「code 1」。從 2.1.12 升級的那一次仍由 2.1.12 的更新程式執行。

## 預設更安全

- **登入可以撤銷。** 改用一次性登入碼與伺服器端 session，網址裡不再帶 token。`/web revoke` 會讓所有瀏覽器登出。
- **敏感的設定變更改為提案。** 由 fleet 管理員在聊天中確認，或在主機上執行 `agend settings confirm <id>`。
- **ClassicBot 需要核准。** ClassicBot 的允許清單留空時，不再對所有人開放：新的聊天室會先請 General 核准。

## 已移除與不支援

- **`gemini-cli` backend 已移除**（自 2.1.12 起）。請改用 `backend: antigravity`：同樣是 Google 登入，透過 agy 執行。
- **不支援：** musl Linux（例如 Alpine）、沒有 systemd 的 Linux，以及原生 Windows（請改用開啟 systemd 的 WSL）。AgEnD 在這些環境上也許還能安裝，但沒有經過測試。[升級指南](https://github.com/songsid/AgEnD/blob/main/docs/upgrade-2.2.zh-TW.md#1-升級前)有列出處理方式。

所有變更請見[變更紀錄](https://github.com/songsid/AgEnD/blob/main/docs/CHANGELOG.zh-TW.md)。
