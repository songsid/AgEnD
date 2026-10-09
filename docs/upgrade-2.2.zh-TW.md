# 從 2.1 升級到 2.2

[English](upgrade-2.2.md)

這一頁照順序列出要做的事。完整的變更清單請看 [CHANGELOG](CHANGELOG.zh-TW.md)。

## 1. 升級前

**Node。**
- 在 **Linux（glibc 2.28 以上）和 macOS 11 以上的 x64 或 arm64** 上，AgEnD 2.2 自帶 Node 22.23.3（`@songsid/agend-node-<os>-<cpu>`，會隨 AgEnD 一起安裝），不管 PATH 上是哪個 Node，都用自帶的那個執行。你不需要自己升級 Node。
- **其他平台**（musl Linux 例如 Alpine、32 位元、其他系統）需要 PATH 上的 Node 是 **22.14 以上**（或 23.6+、24+），版本太舊時會拒絕安裝。

**怎麼安裝。**
- 2.1.12 的 `agend update` 會**先移除已安裝的 AgEnD，再安裝新版**（#1487）。如果新版接著被拒絕安裝（例如在沒有自帶 Node 的平台上 Node 太舊），結果是一個 `agend` 都不剩。
- 最安全的做法是直接安裝新版：
  ```sh
  npm install -g @songsid/agend@2.2.0
  ```
  直接安裝如果被拒絕，舊版會原封不動地留著。
- 如果還是要用 `agend update`，請先確認網路穩定；在沒有自帶 Node 的平台上，先把 Node 升到 22.14 以上。

**備份。** 先停掉 fleet，再複製 `~/.agend`（fleet.yaml、.env 和 SQLite 資料都在裡面）：
```sh
agend fleet stop
cp -a ~/.agend ~/.agend.bak-2.1
```
有用 Kiro 的話，也把每個工作目錄的 `.kiro/` 各留一份。

## 2. 第一次啟動 2.2 時會發生的事

下面每一項都只發生一次，除非特別註明，否則你不需要做任何事。

| 你會看到 | 原因 |
|---|---|
| 每個 **Kiro** instance 第一次恢復時，會在投遞任何訊息之前，先在 pane 裡輸入 `/agent swap <agent>`（#906）。15 秒內無法確認切換時，它會保留舊設定、發出說明，下次啟動再試。 | 現在每個 Kiro instance 都有自己的 agent。等所有使用該目錄的 fleet 都升級後，再手動刪掉舊的 `.kiro/steering/agend-<instance>.md`。 |
| **網頁 dashboard 要求重新登入。** 舊的 `?token=` 連結和書籤都會打開登入頁。 | 現在改用一次性代碼登入（8 個字元，5 分鐘內有效）：對 bot 傳 `/dashboard`，或在主機上執行 `agend web --code`。登入後的 session 可維持 12 小時（閒置 2 小時會失效）。 |
| **General 會收到一則 web chat 介紹**（#1366）。 | 每個平台只送一次，記錄在 `~/.agend/upgrade-notices.json`。 |
| **ClassicBot：不在允許清單上的人 `/start` 時，會請 General 核准**（#1418）。 | `allowed_users`、`allowed_groups`、`allowed_guilds` 是空的或沒寫，不再等於「開放」。請用 General 的按鈕核准，或寫上明確的名單。已註冊的房間不受影響。 |
| **網頁 Settings 的敏感變更會變成提案**（#1423）。 | 由 General 裡的 fleet 管理員在聊天中確認，或在主機上執行 `agend settings confirm <id>`。待確認的提案在重啟後會消失，需要重新送出。 |
| **fleet 重啟最多可能要 5 分鐘**（#1071）。 | 讓忙碌中的 Kiro instance 有時間停下來。如果服務已載入的停止期限少於 300 秒，`agend restart` 會拒絕執行；`agend install`（或下一次重啟）會更新 AgEnD 自己的 unit。你自訂的期限會保留，並附上警告。 |

## 3. 升級後快速檢查

```sh
agend --version          # 2.2.x
agend fleet status       # 每個 instance 都在執行
agend health             # fleet 有回應
```
接著：
- 登入網頁 dashboard（在聊天裡傳 `/dashboard`，或執行 `agend web --code`），打開一個 instance 的聊天。
- 分別從聊天 App 和網頁傳一則訊息給某個 instance，兩邊都要送得到。
- 打開網頁側欄的 **Needs you**：所有等你處理的事（登入、確認）都列在那裡。
- 有用 Kiro 的話：確認每個 Kiro instance 在 `/agent swap` 之後都回應過一次。

## 4. 退回 2.1.12

除非必要，否則不建議退回。2.1.12 不會執行 2.2 的幾項安全政策（見下方）。

```sh
agend fleet stop
npm install -g @songsid/agend@2.1.12    # PATH 上要有 Node 20 以上：2.1.12 不自帶 Node
agend install                            # 把服務改寫成 2.1.12 的版本
agend fleet start
```

- **一定要執行 `agend install`。** 2.2 的服務啟動的是 AgEnD 自帶的 Node，而安裝 2.1.12 時會把它移除。不重新安裝服務，服務就會指向一個已經不存在的 Node。
- **絕對不要讓兩個版本同時使用同一個 `~/.agend`。**
- **在 2.1.12 上會失去的東西**（詳見[降版相容性](downgrade-compatibility.zh-TW.md)）：
  - ClassicBot 空白的允許清單又變回開放。
  - 網頁 Settings 的變更不再需要確認。
  - `web.view_access: session` 不再生效，不登入也能讀 `/view`。
  - 沒有公開連結，也沒有 Needs you。
  - Kiro 回到以整個目錄為範圍的 `--resume`。
- **資料：** 資料庫可以被 2.1.12 讀取，之後也可以再被 2.2 讀取。待確認的敏感設定提案不會被帶過去。
- **Kiro 工作目錄的檔案：** 2.1.12 寫入時可能會覆蓋共用的 Kiro 檔案，需要時請從備份還原。

## 5. 常見問題

**我的 fleet.yaml 還是舊的單一 `channel:` 寫法，有問題嗎？**
可以照常使用。2.2 的 Settings 會把它安全地存成 `channels:` 清單（#1056）。如果還在 2.1.x，檔案是 `channel:` 寫法時，請不要在 Settings 裡儲存連線，先手動改成 `channels:` 清單。

**`/dashboard` 裡的「公開連結」是什麼？**
一個選用、暫時性的 HTTPS 網址（透過 cloudflared，第一次使用時自動安裝），讓你從其他裝置打開 dashboard。除非 `web.public_link.allow_public` 設為 true，否則不會出現。有效時間是 `web.public_link.ttl_minutes`（預設 120 分鐘），連結會私下傳給你。bot token 等機密，請在主機自己的 dashboard 上輸入，不要透過公開連結輸入。

**Settings → 狀態 emoji 裡，Discord 伺服器的 emoji 顯示成破圖。**
2.2 已修正：頁面現在允許載入 Discord 的 emoji 圖片。升級後重新整理頁面即可。

**`/dashboard` 以前給的是帶 token 的連結，現在怎麼變成代碼？**
對，連結會打開登入頁，在那裡輸入代碼（只能用一次，5 分鐘內有效）。`/dashboard revoke` 會讓所有瀏覽器登出。

**可以在瀏覽器裡輸入 bot token 嗎？**
可以。2.2 的 Settings → 連線會請你輸入 token，向平台驗證並顯示 bot 名稱後才儲存。token 存在 `~/.agend/.env`，之後不會再顯示。這個變更仍然需要確認（#1423）。
