# AgEnD 2.3 新功能

2.3 是正式版。本頁寫給從 2.2.x 升級的使用者。2.2.5 在 2.3 預覽期間收進了大部分功能（網頁外觀、訪客登入、網頁授權、用量頁面和組織圖），所以這裡只列 2.3 新增的東西，以及升級後行為會不一樣的地方。

## 升級前

依順序的步驟請看[從 2.2 升級到 2.3](upgrade-2.3.zh-TW.md)。重點如下：

- **怎麼升級**：在 General 傳 `/update`，或在主機上執行 `agend update`。更新會執行新版本自己的安裝程式。安裝中途被打斷時，再執行一次安裝指令就能修好。
- **root 或 WSL 類主機（#2369）**：2.2.x 的 `agend update` 如果是在沒有 `XDG_RUNTIME_DIR` 的 shell 執行（一般的 `wsl` shell、`docker exec`、cron，或 root），連不到 systemd 使用者服務，會自動退回 2.2.x。請改用：

  ```bash
  XDG_RUNTIME_DIR=/run/user/$(id -u) agend update
  ```

  或重跑官方安裝指令。升上 2.3 之後就不再需要這一步。現有的 fleet 不受影響。
- **比一般安裝多約 235 MB 的空間**：更新在動任何東西之前，會先把目前安裝的版本存一份，好在失敗時退回；npm 安裝新版時，這份副本仍會保留。npm 安裝 AgEnD 的那顆磁碟上，除了安裝本身需要的空間，還要多留約 235 MB 給這份副本。
- **退回機制**：新版的 service 起不來時，更新會試著裝回前一版：它的套件、service 設定，以及（如果原本在跑）它的 service。只有在能確認原本是什麼狀態時才會這麼做；否則它會保留復原用的副本，並告訴你要檢查什麼。訊息會說明前一版是否已重新在跑、這次更新沒有成功；如果復原不完整，照它印出的步驟處理。macOS（launchd）要等 fleet 真的跑起來，才算更新成功。
- **同時有兩個安裝**：另一個 AgEnD 安裝或更新還占著安裝鎖時，新的這個會在改動任何東西之前停下並說明原因。等前一個完成，再執行一次。
- **service 設定會在更新時修好**：Linux 的 unit 會加上 `NotifyAccess=all`。沒有這一行時，systemd 收不到就緒訊號，fleet 會每 15 分鐘被重啟一次。更新會寫入這個設定，並確認 systemd 實際載入的值。它也會檢查實際載入的 `OOMPolicy`。
- **儀表板不用重新登入**：直接連到儀表板登入的瀏覽器，升級後仍是登入狀態。例外：升級前，同一台主機上的另一個 AgEnD 已經覆蓋了這個瀏覽器的登入 cookie，這時要再登入一次。透過公開連結的登入不會保留：它只跟著那個連結存在，重新啟動後會是新的連結。

### 升級後會改變的預設值

| 項目 | 2.3 預設 | 如何修改 |
|---|---|---|
| 聊天裡的任務看板卡片（「等你處理」） | 關閉 | `needs_you.task_board: true` |
| 任務看板的每日摘要 | 關閉 | `defaults.task_board.summary_at: "09:00"`（fleet 所在時區的 24 小時制時間） |
| 新建立的 `fleet.yaml` | 會寫入 `defaults.dashboard.task_board: false` | 在設定中修改，或為個別 agent 設定 `dashboard` |
| 既有的 `fleet.yaml` | 不會被改寫，任務看板照常可用 | 同上 |
| Canvas Worker 特效 | 實驗功能，預設關閉 | 設定 → 網頁外觀 → 實驗功能 |
| CLI 語言 | 跟著 `defaults.locale`；沒設定時，UTC+8 的主機用中文，其他用英文 | 設定 `defaults.locale: en` 或 `zh-TW` |
| ClassicBot 聊天室 | 會同步網頁聊天（`🌐 web · <名字>: …`） | 在 `classicBot.yaml` 設定 `web_echo: false`，或在該聊天室的 Settings 取消勾選「Web 同步」 |
| 主機有安裝 AgEnD 服務時，手動執行 `agend fleet start` / `agend fleet stop` | 改交給 `agend start` / `agend stop` | 在自己的 shell（不是 agent session）執行 `agend fleet start --direct` |

## 網頁儀表板

### 任務看板（Fleet › Tasks）

- 看板分成專案、主任務（`M-n`）和子任務（`S-n`）。主任務會跟著子任務的進度走。支援依賴關係、留言和歷史紀錄，可以拖拉卡片和篩選。公開連結只能看。
- 卡片被指派、退回、問題被回答、有新留言、被確認或取消時，相關的 agent 會收到通知。10 秒內的變動會合成一則。
- 每張卡片都記錄是誰派的。只有你派出去的卡片需要你確認；agent 派的卡片由派工的 agent 確認。派工的 agent 被刪掉時，卡片會改回給你。
- 開啟 `needs_you.task_board: true` 後，等你確認的卡片和卡住的卡片會出現在 General 的「等你處理」，可以直接確認、退回或回覆。設定 `defaults.task_board.summary_at` 後，還會收到每日摘要。
- Instance 抽屜會依團隊列出每個 agent 手上的卡片。

### 全域搜尋

- 在側邊欄按「搜尋」，或在任何地方按 **Ctrl+K**（Mac 為 **⌘K**）。在某個 agent 的聊天裡按 **Ctrl+F**，只搜尋這個 agent。
- 範圍包括聊天訊息、agent 之間的訊息和任務。結果依 agent 分組，點一下就跳到原訊息。
- 可以依 agent 或團隊、時間、來源篩選，或只看自己說的話。
- 只有直接在儀表板登入的 fleet 管理者可以搜尋。訪客和公開連結不能用。
- 索引預設保留 90 天，可以用 `web.search.retention_days` 修改。

### Office 檢視

- **Fleet → 組織圖 → Office** 是和 Canvas、List 並列的第三種檢視。它把 fleet 畫成一間像素風的辦公室：每個團隊一間房，每個 agent 一張桌子。
- 可以看出每個 agent 在做什麼：工作中會打字，閒置會喝茶，暫停會睡覺，需要你處理時會舉手。訊息會沿著走廊在桌子之間飛過去。
- 有 **Desks** 和 **Studio** 兩種風格。
- fleet 管理者可以新增、改名、刪除辦公室，並選擇風格和成員。唯讀 session 和公開連結只能看、不能編輯；訪客看不到組織圖和 Office 檢視。如果你編輯時有人先儲存了辦公室，你的儲存會被拒絕，不會覆蓋任何東西；接著由你選擇：保留你的修改（下次儲存會取代對方存的內容），或載入對方的版本。

### 聊天

- **回覆指定訊息**：滑鼠移上去按 ↩、按右鍵、手機左滑或長按，或按 **R**。
- **原生回覆**：在網頁回覆一則來自 Discord 或 Telegram 的訊息時，會在那個平台以原生回覆的方式發出。
- **reaction**：agent 可以對你的網頁訊息回一個 emoji，適合只需要確認或道謝的時候。
- **送出狀態**：送出後，訊息會立刻以灰色出現，agent 收到後才變成正常顏色。失敗時可以重試、放回輸入框或刪除。上傳會顯示各自的進度。10 分鐘內的重試會被認出來，不會送出兩次；這份紀錄只存在記憶體裡，重新啟動後重試的訊息可能會再送一次。
- **聊天圖片**可以縮放和拖曳。
- **復原與重做**：每個文字欄位都可以用 Ctrl/⌘+Z 復原，用 Ctrl+Shift+Z（Mac 為 ⌘⇧Z）重做。
- 桌機上的輸入框下方只剩一行，省出空間。

### 外觀

- agent 的主題可以套用到整個頁面：左側欄、標題列和右側欄都會換成它的顏色。可以在 **⋯ → 頁面配色** 覆蓋。
- 身分卡從聊天標題列的一個按鈕開啟。
- **App 圖示**：在 **設定 → 網頁外觀 → App 圖示** 上傳一張圖。「加入主畫面」時就會顯示你的圖。
- **Canvas Worker 特效是實驗功能，預設關閉**。本機管理者可以在 **設定 → 網頁外觀 → 實驗功能** 開啟。特效在隔離的 Worker 中執行，無法讀取頁面內容或輸入欄位。落花、點擊星星這類環境效果不受影響。
- 沒有自己設定的 agent，工具集選單會列出它實際生效的 profile。

### 用量面板

- 標題旁有 **完整／精簡** 切換。精簡檢視依供應商分組，每個帳號幾行：帳號名稱、方案和重置時間，再加上較短和較長的時間窗（有的話）各一條長條和百分比（不到兩天的，例如 5 小時；兩天以上的，例如一週或一個月）。Antigravity 則是每個額度池一行。選擇會同步到你所有的裝置。
- 每個 Claude 登入各有一列：預設帳號和每個 credential profile 都會顯示。額度用完時顯示 100% 和重置時間；被限流時顯示「Rate limited」。
- 讀不到數字時，會保留上次的數字，並標示為過期與快取時間，不再顯示「無法載入」。
- Antigravity 會顯示方案名稱；付費方案顯示正確的 Gemini 額度，Gemini 4 Argon 也有自己的一行。

### 啟動

- 冷啟動或完整重啟時，儀表板會在 agent 啟動前就打開，你可以看到每個 agent 依序啟動的進度。

### 公開連結與登入

- **自己的網域**：在 **設定 → 網頁** 填入 Cloudflare 具名 tunnel 的 hostname 和 token。之後每次開啟公開連結都是同一個網址，手機「加入主畫面」的捷徑不會失效。詳見[具名 tunnel](named-tunnel.zh-TW.md)。
- **token** 只能設定或清除，設定後讀不回來，也不會出現在 log 裡。格式不對會直接提示。
- **有效時間**：快速 tunnel 的連結為 1 到 480 分鐘。具名連結為 1 到 10080 分鐘，或 0 代表不過期（`web.public_link.ttl_minutes`）。
- **重啟後自動重開**：`web.public_link.auto_open`（預設關閉）會在 fleet 重啟後，替最後開啟連結的管理者重新打開連結。登入碼仍然需要。
- **用自己的網域授權此瀏覽器**：`web.verified_authority.named_link`（預設關閉）開啟後，透過具名連結登入的瀏覽器可以被授權。快速 tunnel 一律不行。
- 可以在儀表板登入 backend：從 **設定 → Agents**、`/backend` 選單、「等你處理」，或每頁的提示列。
- 每個 fleet 的登入 cookie 有自己的名稱，同一個瀏覽器開兩個 AgEnD 不會再互相登出。
- fleet 可以只靠瀏覽器運作。設定頁可以建立第一個 agent，不需要連接任何聊天 bot。

## Agent 與設定

- **每個 agent 可以個別關閉儀表板功能**：在 agent 或 `defaults:` 裡設定 `dashboard:`，可以分別關閉 `appearance`、`task_board` 或 `web_settings`。被關閉的功能，agent 無法使用對應的工具。agent 的設定會逐項覆蓋預設值。

## 穩定性與重啟

- **`agend restart` 是唯一的完整重啟**。它會透過實際管理 fleet 的方式重啟（systemd、launchd 或 detached）。`agend restart <name>` 立即重啟單一 agent。`agend stop` 也會停止系統 unit。
- **記憶體吃緊時不會重啟循環**：因為記憶體不足而延後啟動 agent 時，fleet 會向 systemd 申請更多啟動時間，不會在 15 分鐘時被整個停掉。健康檢查提早開始，批次停止也會依記憶體分批。
- **單一 agent 記憶體不足不會拖垮整個 fleet**：同一個 Claude Code session 連續兩次因記憶體不足而死掉時，agent 會停在 `crashed` 並通知你，不會一直重開同一個 session。
- **建立 agent 或修改 fleet 層級的設定**，不再讓所有 agent 逐一重啟。
- **啟動更快**：`startup.concurrency` 會真正同時啟動 agent。預設值依可用記憶體和 CPU 核心數推算，範圍 2 到 10。`startup.stagger_delay_ms` 預設 500 毫秒。記憶體吃緊時一次啟動一個的保護不變。
- **`/login` 失敗只結束那一次登入**：如果登入流程出錯，只會結束那一個登入，fleet 繼續運作，也不會被誤判為成功。
- **效能**：狀態更新快約 4 倍，開多個分頁時快約 7 倍。tmux 指令改由小的 helper 程序執行，每個指令在事件迴圈上的耗時約從 26 毫秒降到 0.4 毫秒。

## 後端

- **Codex**：碰到 429（請求太頻繁）、Codex 用完重試後放棄這一輪時，AgEnD 會在 30、60、120 秒後請它接著做，最多三次。「Quota exceeded」會被判定為額度用完，agent 會暫停。
- **Codex 套件檢查**：`agend doctor` 多了「Codex 套件」一列。官方套件應有的檔案缺少時會提醒。
- **Claude Code**：閒置時的冷啟提示會自動回答，agent 不會再卡在那裡。
- **kiro-cli**：在 `--trust-all-tools` 下，kiro V3 引擎的「Trust this workspace?」提示會自動回答。沒有 `--trust-all-tools` 時，這個提示會留在 instance 的終端機畫面，等你處理。
- **Grok**：程式碼或聊天裡只是提到 quota 或 rate limit，不再被誤判為額度用完。開著背景 watcher 時，訊息也不會再一直排隊。

## 安裝與指令

- **Windows 一行安裝**。在 PowerShell 執行：

  ```powershell
  powershell -ExecutionPolicy ByPass -c "irm https://songsid.github.io/AgEnD/install.ps1 | iex"
  ```

  它會裝好 WSL 2 和 Ubuntu，重新開機後自動接續，也可以在瀏覽器完成設定並登入各 AI 後端，最後建立桌面捷徑。如果安裝已經壞掉，同一行指令會直接修復。
- **`agend shortcuts`**（WSL）：為較早的安裝建立或更新 Windows 桌面捷徑。
- **指令變更**：
  - `agend status` 現在是 `agend ls` 的別名，`agend fleet status` 是 `agend ls --resources` 的別名。
  - **已移除**：`agend schedule trigger`、`agend fleet logs`（改用 `agend logs`）、聊天的 `/install-cli`（改用 `/login`），以及 `agend install --activate`。輸入這些指令會顯示應改用的指令。
  - **已淘汰**：`/dashboard` 仍可用，但請改用 `/web`。`agend fleet restart` 會改執行 `agend restart`，2.4 會移除。
- **回報問題**：可以產生已去除機密的回報檔，並附上預填的 GitHub 連結。它不會替你送出任何東西。
- **內建 Node** 更新為 22.23.4。

## 安全

- `~/.agend` 一律以 0700 權限建立。較早版本建成群組可寫的目錄，啟動時會自動收緊。
- 相依套件已做安全更新。
- 修掉兩個正規表示式阻斷服務（ReDoS）問題。

## 已知問題

- **WSL 上 `/login` 後偶爾卡住**：有時 WSL 上的主程式會在 `/login` 後卡住，並被 watchdog 重啟（#1880）。根因仍在調查。
- **Codex 的 silent schedule**：偶爾會顯示「無法確認送達」，但訊息其實已經送到，也不會重送（#2301）。
- **root 或 WSL 類主機**：從 2.2.x 升級要多一步，見上方[升級前](#升級前)（#2369）。

## 完整變更

- [CHANGELOG.zh-TW.md](CHANGELOG.zh-TW.md)
- [CHANGELOG.md](CHANGELOG.md)
