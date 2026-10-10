# 從 2.1 升級到 2.2

[English](upgrade-2.2.md)

這一頁照順序列出要做的事。完整的變更清單請看 [CHANGELOG](CHANGELOG.zh-TW.md)。

## 1. 升級前

**Node。**
- 在 **Linux（glibc 2.28 以上）和 macOS 11 以上的 x64 或 arm64** 上，AgEnD 2.2 自帶 Node 22.23.3（`@songsid/agend-node-<os>-<cpu>`，會隨 AgEnD 一起安裝），不管 PATH 上是哪個 Node，都用自帶的那個執行。你不需要自己升級 Node。
- **其他平台**（musl Linux 例如 Alpine、32 位元、其他系統）需要 PATH 上的 Node 是 **22.14 以上**（或 23.6+、24+），版本太舊時會拒絕安裝。

**從任何 2.1.x 升級，請用 `npm install -g @songsid/agend@<2.2 版本>`，不要用 `agend update` 或 `/update`。**

- **原因（#1487）：** 2.1 的更新程式會*先*移除已安裝的 AgEnD，再安裝新版。之後的安裝只要因為任何原因失敗，就什麼都不剩：AgEnD 2.2 拒絕安裝在你的主機、網路或 registry 出問題，或是 proxy。沒有 `agend` 指令；正在跑的 fleet 只能撐到下一次重啟或登入，之後服務就無法啟動。這在真的 Mac 上重現過：launchd 回報 `EX_CONFIG`，fleet 起不來。
- **直接用 `npm install -g` 沒有移除這一步：** 如果被拒絕，你目前的版本會留著。
- **如果 `agend update` 已經這樣失敗，** 請看[第 7 節](#7-如果從-21-執行-agend-update-已經失敗)。

## 2. 照步驟升級

下面的 `AGEND_HOME` 指的是 AgEnD 的資料目錄：沒有另外設定 `AGEND_HOME` 時就是 `~/.agend`。

**2.1 停掉 fleet，並確認它真的已經結束。** 請手動一步一步做，遇到任何意外就停下來。

1. **停止之前，先記下 fleet 的 PID：**
   ```sh
   cat "${AGEND_HOME:-$HOME/.agend}/fleet.pid"
   ```
   - 印出一個數字：那就是 fleet 的 PID，請記下來。
   - 出現 `No such file or directory`：表示這個資料目錄沒有執行中的 fleet。用 `agend fleet status` 確認後，直接跳到 2.2。
   - 出現其他錯誤（例如 `Permission denied`），或印出來的不是數字：**先停在這裡**，查清楚原因。PID 檔讀不到，不能當作 fleet 已經結束的證據。
2. **停止它：**
   ```sh
   agend stop          # 以服務方式執行的（執行過 agend install）
   agend fleet stop    # 自己用 agend fleet start 啟動的
   ```
   這兩個指令都可能在 fleet 還沒結束時就返回：忙碌中的 fleet（Kiro instance 正在把手上的 turn 做完）可能要好幾分鐘。指令返回本身，不代表已經停了。
3. **確認這個 PID 已經不在了**，用第 1 步記下的數字（這裡以 `12345` 為例）：
   ```sh
   ps -p 12345 -o pid=; echo "exit: $?"
   ```
   - 印出一行 `12345`：fleet 還在停止中。等幾秒再執行一次。
   - **沒有任何一行，而且是 `exit: 1`：** 行程已經不在了。只有這個結果才能繼續往下。
   - 出現錯誤訊息，或是其他的 exit 狀態：**不能當作已經結束。** 先停在這裡，查清楚原因。
4. **服務在 2.4 之前必須保持停止：**
   - **Linux：** `systemctl --user is-active com.agend.fleet` 要印出 `inactive` 或 `failed`。
   - **macOS：** `launchctl print gui/$(id -u)/com.agend.fleet` 要嘛說找不到這個服務，要嘛輸出裡沒有 `pid =` 那一行。
   - 如果指令本身失敗（例如連不到服務管理程式），不能當作已經停止；先停在這裡，查清楚原因。
   - 如果服務又跑起來了，它會有新的 PID。請回到第 1 步，用那個新的 PID 把第 1 到第 4 步重做一遍。

**2.2 備份**資料目錄（fleet.yaml、.env 和 SQLite 資料都在裡面）。有用 Kiro 的話，也把每個工作目錄的 `.kiro/` 各複製一份。
```sh
cp -a "${AGEND_HOME:-$HOME/.agend}" "${AGEND_HOME:-$HOME/.agend}.bak-2.1"
```

**2.3 安裝 2.2。**
```sh
npm install -g @songsid/agend@2.2.0
```

**2.4 重新啟動。**
- **以服務方式執行：** 執行 `agend install`。它會把服務改寫成 2.2 的版本並啟動（2.1 的服務定義會被 2.2 的重啟檢查拒絕）。
- **自己啟動：** 照原本的方式執行 `agend fleet start`。

**2.5 檢查**（第 4 節）。

## 3. 第一次啟動 2.2 之後的變化

**只發生一次：**
- **Kiro：** 每個 instance 第一次恢復時，會在投遞任何訊息之前，先在 pane 裡輸入 `/agent swap <agent>`（#906）。15 秒內無法確認切換時，會保留舊設定、發出說明，下次啟動再試。等所有使用該目錄的 fleet 都升級後，再手動刪掉舊的 `.kiro/steering/agend-<instance>.md`。
- **網頁登入：** 每個人都要重新登入一次。舊的 `?token=` 連結和書籤都會打開登入頁。對 bot 傳 `/dashboard`，或在主機上執行 `agend web --code`，就能拿到一次性代碼（8 個字元，5 分鐘內有效）。
- **General 會收到一則 web chat 介紹**（#1366），每個平台只送一次，記錄在 `AGEND_HOME/upgrade-notices.json`。

**從此以後的政策：**
- **網頁登入的 session**：在本機自己的 dashboard 上可維持 12 小時（閒置 2 小時失效）；透過公開連結則是 4 小時（閒置 30 分鐘失效）。
- **ClassicBot：** 不在允許清單上的人 `/start` 時，會請 General 核准（#1418）。`allowed_users`、`allowed_groups`、`allowed_guilds` 是空的或沒寫，不再等於「開放」。請用 General 的按鈕核准，或寫上明確的名單。已註冊的房間不受影響。
- **網頁 Settings 的敏感變更會變成提案**（#1423）：由 General 裡的 fleet 管理員在聊天中確認，或在主機上執行 `agend settings confirm <id>`。待確認的提案在重啟後會消失，需要重新送出。
- **停止 fleet 最多可能要 5 分鐘**（#1071），讓忙碌中的 Kiro instance 把手上的事做完；之後重新啟動另外還要花時間。如果服務已載入的停止期限少於 300 秒，`agend restart` 會拒絕執行；AgEnD 自己的 unit 會自動更新，你自訂的期限會保留並附上警告。

## 4. 升級後快速檢查

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

## 5. 退回 2.1.12

除非必要，否則不建議退回。2.1.12 不會執行 2.2 的幾項安全政策（見下方）。

1. **停掉 fleet，並確認它已經結束**，做法和 2.1 完全一樣。絕對不要讓兩個版本同時使用同一個資料目錄。
2. **備份目前的狀態**（資料目錄和每個工作目錄的 `.kiro/`）。升級前的備份不包含在 2.2 上產生的變更，而 2.1.12 可能會改寫部分檔案。
3. **安裝 2.1.12。** 它不自帶 Node，所以 PATH 上要有 Node 20 以上：
   ```sh
   npm install -g @songsid/agend@2.1.12
   ```
4. **重新啟動。**
   - **以服務方式執行：** 執行 `agend install`，它會把服務改寫成 2.1.12 的版本並啟動。這一步不能省：2.2 的服務啟動的若不是 AgEnD 自帶的 Node（2.1.12 取代套件時會把它移除），就是 2.2 的 launcher，而 2.1.12 沒有這個 launcher。
   - **自己啟動：** 執行 `agend fleet start`。

**在 2.1.12 上會失去的東西**（詳見[降版相容性](downgrade-compatibility.zh-TW.md)）：
- ClassicBot 空白的允許清單又變回開放。
- 網頁 Settings 的變更不再需要確認。
- `web.view_access: session` 不再生效，不登入也能讀 `/view`。
- 沒有公開連結，也沒有 Needs you。
- Kiro 回到以整個目錄為範圍的 `--resume`。

**資料。** 測試過的資料（投遞佇列、排程、事件、Needs you 指標、fleet.yaml 和 Kiro 檔案，在 Linux 上、只測資料、沒有執行中的 fleet）可以被 2.1.12 開啟和寫入，之後也能再被 2.2 開啟。這並不保證所有平台或執行中的 fleet 都一樣。待確認的敏感設定提案不會被帶過去；2.1.12 寫入時可能會覆蓋共用的 Kiro 檔案，所以請保留第 2 步的備份。

## 6. 常見問題

**我的 fleet.yaml 還是舊的單一 `channel:` 寫法，有問題嗎？**
可以照常使用。2.2 的 Settings 會把它安全地存成 `channels:` 清單（#1056）。如果還在 2.1.x，檔案是 `channel:` 寫法時，請不要在 Settings 裡儲存連線，先手動改成 `channels:` 清單。

**`/dashboard` 裡的「公開連結」是什麼？**
一個暫時性的 HTTPS 網址（透過 cloudflared，第一次使用時自動安裝），讓你從其他裝置打開 dashboard。
- `/dashboard` 預設會提供這個選項，但只有管理員在那裡選了，才會真的建立連結，而且連結會私下傳給你。
- `web.public_link.allow_public: false` 會拿掉這個選項，並關閉已經開著的連結。
- `web.public_link.ttl_minutes` 設定它固定的有效時間（預設 120 分鐘，可設 1 到 480）。
- `web.public_link.protocol` 決定 cloudflared 的連線方式：`http2`（預設）、`quic` 或 `auto`。

bot token 等機密，請在主機自己的 dashboard 上輸入，不要透過公開連結輸入。

**Settings → 狀態 emoji 裡，Discord 伺服器的 emoji 顯示成破圖。**
2.2 已修正：頁面現在允許載入 Discord 的 emoji 圖片。升級後重新整理頁面即可。

**`/dashboard` 以前給的是帶 token 的連結，現在怎麼變成代碼？**
對，連結會打開登入頁，在那裡輸入代碼（只能用一次，5 分鐘內有效）。`/dashboard revoke` 會讓所有瀏覽器登出。

**可以在瀏覽器裡輸入 bot token 嗎？**
可以。2.2 的 Settings → 連線會請你輸入 token，向平台驗證並顯示 bot 名稱後才儲存。token 存在 `~/.agend/.env`，之後不會再顯示。這個變更仍然需要確認（#1423）。

## 7. 如果從 2.1 執行 `agend update` 已經失敗

跡象：`agend: command not found`；或更新最後顯示「Failed to update」（聊天室裡是「❌ 更新在「下載／安裝」階段失敗」）；或 AgEnD 2.2 的安裝拒絕訊息說先前的 AgEnD 已經被移除。你的資料目錄沒有被動到，只是程式不見了。把一個版本裝回來：

```sh
npm install -g @songsid/agend@2.1.12   # 或者等你的主機可以安裝時，改裝 2.2 版本
agend install                          # 重寫並啟動服務；即使 fleet 看起來還活著也要做
```

即使舊的 fleet 還在回應，也要執行 `agend install`。它是從已刪除的檔案在跑，在服務被重寫之前，重啟或登入後都不會回來。
