---
title: "2.3 更新重點"
description: "從 AgEnD 2.2.x 升級會注意到的變化：升級前要先做的事、指令改名，以及依功能區分的新功能：任務看板、全域搜尋、辦公室檢視、自己網域的公開連結，以及更穩的更新與重啟。"
---

<p align="center">
  <img class="dark:sl-hidden" src="https://raw.githubusercontent.com/songsid/AgEnD/main/docs/assets/readme/hero-light.webp" width="880" alt="AgEnD 的網頁儀表板（示範資料）：側欄有六個 agent 和各自的狀態；與 agent Pixel 的對話裡有一張 bundle 大小的表格、一段程式碼、已選的「Ship it」回覆按鈕、一份附件報告，以及列出五個 AI 服務的用量面板。旁邊是一支手機，顯示同一段對話，附 Discord 與 Telegram 的標誌。">
  <img class="light:sl-hidden" src="https://raw.githubusercontent.com/songsid/AgEnD/main/docs/assets/readme/hero-dark.webp" width="880" alt="AgEnD 的網頁儀表板（示範資料）：側欄有六個 agent 和各自的狀態；與 agent Pixel 的對話裡有一張 bundle 大小的表格、一段程式碼、已選的「Ship it」回覆按鈕、一份附件報告，以及列出五個 AI 服務的用量面板。旁邊是一支手機，顯示同一段對話，附 Discord 與 Telegram 的標誌。">
</p>

AgEnD 2.3 是正式版。這一頁寫給從 2.2.x（尤其是 2.2.5 與 2.2.6）升級的人。先講升級時要做的事，再列指令的改名，最後依功能區分列出新功能。2.2 新增了什麼，請看[2.2 更新重點](/AgEnD/zh-tw/docs/whats-new-2-2/)。

## 從 2.2.x 升級

依順序的步驟請看[升級指南](https://github.com/songsid/AgEnD/blob/main/docs/upgrade-2.3.zh-TW.md)。重點如下：

- **怎麼升級：** 在 General 傳 `/update`，或在主機上執行 `agend update`。更新會安裝 2.3、檢查它，然後重啟 fleet。聊天會顯示每一步，失敗時會說明是哪一步失敗。
- **root 或 WSL 類主機（#2369）：** 如果你在沒有 `XDG_RUNTIME_DIR` 的 shell 裡執行 `agend update`（一般的 `wsl` shell、`docker exec`、cron，或 root），2.2.x 連不到 systemd 使用者服務，會自動退回 2.2.x。請改用這個指令：

  ```bash
  XDG_RUNTIME_DIR=/run/user/$(id -u) agend update
  ```

  或重跑官方安裝指令。升上 2.3 之後就不需要這一步了。
- **更新失敗會自動退回（#2420）：** 新版的 service 起不來時，更新會試著裝回前一版：它的套件、service 設定，以及（如果原本在跑）它的 service。只有在能確認原本是什麼狀態時才會這麼做；否則它會保留復原用的副本，並告訴你要檢查什麼。訊息會說明前一版是否已重新在跑、這次更新沒有成功；如果復原不完整，照它印出的步驟處理。從 2.3 起，macOS（launchd）要等 fleet 真的跑起來，才算更新成功。從 2.2.x 升級的 Mac 是例外：2.2.x 自己的更新程式可能在 2.3 沒起來時也回報成功，而且不會退回，所以請確認 fleet 有起來；沒有的話，執行 `npm i -g @songsid/agend@2.2.6` 再 `agend restart`（[詳細說明](https://github.com/songsid/AgEnD/blob/main/docs/upgrade-2.3.zh-TW.md#mac確認-fleet-有起來2481)，#2481）。
- **磁碟空間：** 除了安裝本身需要的空間，請再多留約 235 MB。新版安裝期間，退回機制會保留你升級前那個版本的一份副本，連同它的 Node 約有這麼大。這份副本存不下來時，更新會在改動任何東西之前停下（#2420）；安裝本身需要的空間不會事先檢查。
- **之後的更新改用新版本自己的安裝程式（#2264）：** `/update` 和 `agend update` 會執行目標版本的 `agend-install --upgrade`，安裝、升級、修復走同一條路。被打斷的安裝，再跑一次安裝指令就能修好。如果另一個安裝或更新還占著安裝鎖，新的這個會在改動任何東西之前停下並說明原因：等前一個完成，再執行一次。
- **升級時會修好 service 設定：** 在 Linux 上，unit 會寫入 `NotifyAccess=all`（#2331）。沒有它，fleet 會每 15 分鐘被重啟一次。`OOMPolicy` 也會檢查（#2446）。更新會回報 systemd 實際載入的值。
- **儀表板不用重新登入（#2403）：** 直接連到儀表板登入的瀏覽器會保持登入。例外：升級前，同一台主機上另一個 AgEnD 已經蓋掉這個瀏覽器的登入 cookie，這時要再登入一次。透過公開連結的登入不會保留：它只跟著那個連結存在，重新啟動後會是新的連結。
- **升級後預設值會改變的地方：**
  - **聊天裡的任務看板：** 需要你處理的卡片，要設 `needs_you.task_board: true` 才會出現在 General 的「等你處理」（#2425）。每日摘要要設 `defaults.task_board.summary_at` 才會發。
  - **新建立的 fleet：** 新的 `fleet.yaml` 會帶 `defaults.dashboard.task_board: false`（#2391）。既有的設定檔不會被改寫，任務看板照常可用。
  - **Canvas Worker 特效是實驗功能，預設關閉**（#2275）。可以在「**設定 → 網頁外觀**」開啟。內建的環境效果（例如落花、點擊星星）不受影響。
  - **CLI 的語言跟著 `defaults.locale`**（#2404）。沒設的話，時區為 UTC+8 的主機會用中文，給程式讀的那幾行固定保持英文。
  - **有安裝 AgEnD 服務的主機**（#2356）：手動執行 `agend fleet start` 和 `agend fleet stop` 會改交給 `agend start` 和 `agend stop`，不會在服務旁邊多跑一個 fleet。
- **已知問題：**
  - WSL 上，`/login` 偶爾會讓主程式卡住，直到 watchdog 重啟它（#1880）。原因還在調查。
  - Codex 的 silent 排程偶爾會顯示「無法確認送達」，其實已經送達，也不會重送（#2301）。

## 指令變更

| 2.2 的寫法 | 2.3 的寫法 |
|---|---|
| `agend fleet start`（整個 fleet） | `agend start`。`agend fleet start <name>` 仍可啟動單一 instance |
| `agend fleet stop`（整個 fleet） | `agend stop`。`agend fleet stop <name>` 仍可停止單一 instance |
| `agend fleet restart` | `agend restart`。舊寫法仍會執行它，但已淘汰，2.4 會移除 |
| `agend fleet status` | `agend ls --resources`。`agend ls`（也就是 `agend status`）顯示 instance |
| `agend fleet logs` | `agend logs`。舊寫法已移除 |
| `agend schedule trigger` | 已移除。請用 `agend schedule enable`，或任務看板 |
| 聊天裡的 `/install-cli` | 已移除。請用 `/login` |
| `agend install --activate` | 已移除。啟用是預設行為；只想寫入 service 檔時用 `--no-activate` |
| 聊天裡的 `/dashboard` | 仍可用，但已淘汰。請改用 `/web` |
| Windows 桌面捷徑 | 在 WSL 裡執行 `agend shortcuts`，建立或更新捷徑 |

輸入已移除的指令時，會顯示該改用哪個指令。

## 新功能

### fleet 與任務

<p align="center">
  <img src="https://raw.githubusercontent.com/songsid/AgEnD/main/docs/assets/whats-new-2.3/task-board.webp" width="760" alt="任務看板（示範資料）：Leaderboard 專案，待辦、進行中、卡住各一張卡；卡住的那張顯示它的問題。">
  <img src="https://raw.githubusercontent.com/songsid/AgEnD/main/docs/assets/whats-new-2.3/office.webp" width="760" alt="Office 檢視（示範資料）：有 Work、Lounge、Help desk、Nap corner 幾間房的像素風辦公室；桌子都空著，三個示範 agent 在 Lounge 等著。">
</p>

- **任務看板**（`Fleet → Tasks`）：以專案、主任務（M-n）和子任務（S-n）組成的看板。主任務會跟著子任務的進度走。卡片支援依賴關係、留言和歷史紀錄，可以拖拉與篩選。公開連結只能看。
  - **agent 會依看板工作：** 卡片被指派、退回、回答、留言、確認或取消時，相關的 agent 會收到通知。10 秒內的變動會合成一則。每個 agent 同時只做一張卡。
  - **誰確認：** 只有你派出去的卡片需要你確認（#2434）。agent 派出的卡片，由派出的那個 agent 確認。派出卡片的 agent 被刪掉時，卡片會改回給你（#2451）。
  - **在聊天室處理：** 設定 `needs_you.task_board: true` 後，等你確認或卡住的卡片會出現在 General 的「等你處理」，你可以直接確認、退回或回覆。
  - **每日摘要：** 設定 `defaults.task_board.summary_at`（例如 `"09:00"`，以 fleet 的時區計算）才會發送。沒設就是關閉。
- **辦公室檢視**（`Fleet → 組織圖 → Office`，#2399）：把 fleet 畫成像素風的辦公室。每個團隊一間房，每個 agent 一張桌子。工作中的在打字，閒置的在喝茶，暫停的在睡覺，等你處理的會舉手，agent 之間的訊息會沿著走廊飛過去。有 Desks 和 Studio 兩種風格。管理者可以新增、改名、刪除辦公室，並布置成員與風格。唯讀 session 和公開連結只能看；訪客看不到組織圖和辦公室檢視。
- **重啟與啟動：**
  - `agend restart` 是唯一的完整重啟。它會透過實際管理 AgEnD 的對象重啟（systemd、launchd 或 detached 的 fleet）。`agend restart <name>` 會立即重啟那一個 instance（#2356）。
  - 冷啟動或完整重啟時，網頁在 agent 還在啟動時就能打開，並顯示每個 agent 啟動的進度（#2398）。
  - `startup.concurrency` 會真的同時啟動那麼多個 instance；記憶體吃緊時仍然一次一個（#2288）。
  - 記憶體吃緊時，延後啟動不會再造成重啟循環（#2461）。
  - 同一個 Claude Code session 連續兩次確定死於 OOM 時，該 agent 會停在 crashed 並通知你，不再一直重開（#2015、#2035）。
  - 建立 agent，或改 fleet 層級的設定，不會再讓所有 agent 逐一重啟（#2317）。
- **儀表板更快：** 狀態更新快約 4 倍；開多個分頁時快約 7 倍（#1956）。

### 網頁儀表板

<p align="center">
  <img src="https://raw.githubusercontent.com/songsid/AgEnD/main/docs/assets/whats-new-2.3/chat-sending.webp" width="460" alt="網頁聊天裡送出途中、標示「Sending…」的訊息。">
  <img src="https://raw.githubusercontent.com/songsid/AgEnD/main/docs/assets/whats-new-2.3/usage-compact.webp" width="300" alt="精簡模式的用量面板（示範資料）：Claude、Codex、Kiro 共五個帳號。">
</p>

- **全域搜尋**（Ctrl+K，或 ⌘K）：搜尋聊天訊息、agent 之間的訊息和任務，依 agent 分組。點一下結果就會跳到原訊息。在聊天裡按 Ctrl+F，只搜那一個 agent。可以依 agent 或 team、時間、來源篩選，也可以只看自己說的。fleet 管理者可以搜尋，在本機或透過公開連結都行（`web.search.public_link: false` 會在公開連結上關閉）；訪客不能用（#2486）。從 2.3.1 起索引預設不限天數（`web.search.retention_days` 未設定或 0；上限 30 萬筆）；2.3.0 仍保留 90 天。
- **聊天：**
  - **回覆指定訊息：** 滑鼠移上去按 ↩、按右鍵、手機左滑、長按，或按 R。從網頁送出的回覆，在 Discord 和 Telegram 上也會是原生回覆（#2281）。
  - **reaction：** agent 可以對網頁上的訊息加一個 emoji，例如只需要確認或道謝時（#2305）。
  - **送出狀態：** 送出後訊息會立刻以灰色出現，agent 收到後才變成正常顏色。失敗時可以重試、把文字放回輸入框，或刪除。圖片和檔案各自顯示上傳進度。10 分鐘內的重試會被認出來，不會送出兩次；這份紀錄只存在記憶體裡，重新啟動後重試的訊息可能會再送一次。
  - **圖片**可以縮放和拖曳（#2333）。**復原與重做**在每個文字欄位都能用（Ctrl/⌘+Z、Ctrl+Shift+Z）（#2342）。桌機上的輸入框少了一行高度（#2215）。
- **外觀：**
  - agent 的主題可以套用到整個頁面，包括左側欄、標題列和右側欄。可以在 **⋯ → 頁面配色** 覆蓋（#2196）。
  - 身分卡集中在聊天標題列的一個按鈕（#2217）。
  - **自訂 App 圖示：** **設定 → 網頁外觀 → App 圖示**（#2308）。「加入主畫面」時會顯示你上傳的圖。
- **用量面板：**
  - 標題旁有 **完整／精簡** 切換。精簡檢視依供應商分組，每個帳號幾行：名稱、方案和重置時間，再加上較短和較長的時間窗（有的話）各一條長條和百分比（不到兩天的，例如 5 小時；兩天以上的，例如一週或一個月）。Antigravity 則是每個額度池一行。你的選擇會同步到每一台裝置。
  - 每個 Claude 登入各一列，包括預設帳號和每個 profile（#2236）。額度用完會顯示 100% 和重置時間；被限流會顯示「Rate limited」。
  - 讀不到數字時，面板會保留上次的數字並標示「已過期 · 快取於 HH:MM」，不會閃出「無法載入」（#2236、#2385）。
  - Antigravity 會顯示方案名稱；付費方案會顯示正確的 Gemini 額度。Gemini 4 Argon 有自己的一行（#2240）。
- **Canvas Worker 特效（實驗功能，預設關閉）：** 開啟 `web.experimental.canvas_worker`（或在 **設定 → 網頁外觀** 打開開關）後，可以上傳特效、放到聊天或個人區域，agent 也能用工具放置自己的特效（#1629）。特效在隔離的 worker 裡執行，接觸不到頁面內容和輸入框。

### 遠端存取與安全

- **自己網域的公開連結（具名 tunnel，#2307）：** 在 **設定** 裡填入 `web.public_link.hostname` 和 Cloudflare tunnel 的 token，公開連結每次都是同一個網址，手機主畫面上的捷徑就不會隔天失效。token 只能設定或清除，設定後讀不回來，也不會出現在 log 裡。格式不對會直接提示（#2344）。
  - **有效時間：** 用自己的網域時，`ttl_minutes` 可以設 1 到 10080 分鐘（7 天），或設 `0` 代表不過期（#2448）。快速 tunnel 最多 480 分鐘。
  - **重啟後自動重開：** `web.public_link.auto_open`（預設關）會在 fleet 重啟後，替最後開啟連結的管理者重新打開。只適用於自己的網域。
- **自己網域的「授權此瀏覽器」（#2453）：** `web.verified_authority.named_link`（預設關）開啟後，你確認過的瀏覽器可以以你的帳號行事，但只限於你自己的網域。快速 tunnel 永遠不符合。
- **從已驗證的網頁套用設定（#2170）：** 如果你的帳號是受影響連線的管理者，被擋下的設定變更會直接生效。
- **同一個瀏覽器開兩個 AgEnD 不再互相登出**（#2396）。
- **相依套件與安全：** 內建的 Node 更新到 22.23.4（#2405）。production 和開發用套件的 `npm audit` 都是 0（#2408）。修掉兩個 ReDoS（#2416）。`~/.agend` 一律建成 0700，之前被建成群組可寫的，下次啟動時會自動收緊（#2435）。

### 設定與每個 agent 的限制

- **每個 agent 可以個別關閉儀表板功能（#2391）：** `dashboard: { appearance, task_board, web_settings }`，可以設在單一 agent，或設在 `defaults`。關掉的那一項，agent 就不能用對應的工具。設在 agent 上，只影響那一個 agent。
- **從儀表板登入 backend（#2233）：** 在設定的登入區、`/backend` 選單、「等你處理」，以及每頁的提示列都可以登入。
- **只用網頁也能開始：** 設定頁可以建立第一個 agent，不需要連接聊天平台。

### 後端

- **Codex：**
  - 429 重試失敗、放棄這一輪後，AgEnD 會在 30、60、120 秒後請它接著做，最多三次（#2282）。「Quota exceeded」會被判為額度用完，agent 會暫停。
  - `agend doctor` 多了「Codex package」一列，安裝缺件時會提醒（#2357）。
- **Claude Code：** 閒置冷啟時的提示會自動回答，agent 不會再卡住（#2268）。
- **kiro-cli 2.33：** 在 `--trust-all-tools` 下，「Trust this workspace?」會自動回答。
- **Grok：** 程式碼或聊天裡提到 quota 或 rate limit，不再被誤判成額度用完（#2324）。開著背景 watcher 時，訊息不會再一直排隊（#2334）。

### 語言

- **介面與 bot 訊息：** 設定變更的確認卡片和按鈕、網頁上伺服器回的訊息，以及 `/login` 的網頁終端機頁面，在語言為 `zh-TW` 時都會顯示中文（#2390）。
- **CLI：** `agend` 的訊息跟著 `defaults.locale`（見上方的升級說明）。

### 其他修正

- **回報問題：** 可以產生已去除機密的回報檔，並附上預填的 GitHub 連結（#2258）。
- **設定檔共用錨點：** 連線之間用 YAML anchor 和 alias 共用設定時，在設定頁只改你編輯的那一個連線（#2208）。連線沒寫 `mode` 時，確認的範圍不會擴大到每個連線（#2211）。
- **斷網時重啟：** 斷網時重啟或更新，「Fleet 就緒」會在連線恢復後補送一次（#2213）。
- **`agend ls` 與 attach 選單**的中文欄位已對齊。

## 2.2 起仍然成立

- `gemini-cli` backend 已移除（自 2.1.12 起）。請改用 `backend: antigravity`。
- 不支援 musl Linux（例如 Alpine）、沒有 systemd 的 Linux，以及原生 Windows。Windows 請改用開啟 systemd 的 WSL。見[快速開始](/AgEnD/zh-tw/docs/getting-started/#安裝)。

所有變更請見[變更紀錄](https://github.com/songsid/AgEnD/blob/main/docs/CHANGELOG.zh-TW.md)。
