# 從 2.2 升級到 2.3

[English](upgrade-2.3.md)

本頁依順序說明從 2.2.x（2.2.5 或 2.2.6）升到 2.3.0 要做的事。2.3 新增了什麼，請看 [AgEnD 2.3 新功能](whats-new-2.3.zh-TW.md)；完整的變更列表在 [CHANGELOG](CHANGELOG.zh-TW.md)。

## 1. 升級前

- **比一般安裝多約 235 MB 的空間**：更新在動任何東西之前，會先把目前安裝的版本連同它的 Node 存一份，好在失敗時退回；npm 安裝新版時，這份副本仍會保留。npm 安裝 AgEnD 的那顆磁碟上，除了安裝本身需要的空間，還要多留約 235 MB。這份副本存不下來時，更新會在改動任何東西之前停下；安裝本身需要的空間不會事先檢查，所以也要留夠。
- **Node**：和 2.2 一樣。Linux（glibc）與 macOS 的 x64、arm64 會使用 AgEnD 自帶的 Node；2.3 鎖定 Node 22.23.4。
- **支援的主機**：和 2.2 一樣，macOS，或有 glibc 與 systemd 的 Linux。

## 2. 升級

### 在主機上

```bash
agend update
```

更新會執行新版本自己的安裝程式，更新 service 設定並重新啟動 fleet。之後不需要再執行 `agend install`。

**root 或 WSL 類主機要多一步（#2369）**：如果 2.2.x 的 `agend update` 是在沒有 `XDG_RUNTIME_DIR` 的 shell 執行（一般的 `wsl` shell、`docker exec`、cron，或 root），它連不到 systemd 使用者服務，會退回 2.2.x。請改用：

```bash
XDG_RUNTIME_DIR=/run/user/$(id -u) agend update
```

或重跑官方安裝指令。正在執行的 fleet 不受影響。升上 2.3 之後就不再需要這一步。

### 從 Discord 或 Telegram

在 General 傳 `/update`。

從 2.2.6 升級時，root 或 WSL 類主機也可以直接這樣做：上面那個額外步驟，只在主機的 shell 裡執行 `agend update` 時才需要。

### Mac：確認 fleet 有起來（#2481）

從 2.2.x 升級時，執行更新的是 2.2.x 自己的更新程式。在 Mac（launchd）上，即使 2.3 沒有起來，它也可能回報成功，而且不會自動退回；Linux 則會退回。

所以 Mac 更新完後，請確認 fleet 在跑：`agend ls` 列得出 fleet 和它的 instance，儀表板也打得開。如果沒有起來，先退回 2.2.6 再重新啟動：

```bash
npm i -g @songsid/agend@2.2.6
agend restart
```

然後請到 GitHub 開 issue 回報。Mac 升上 2.3 之後，之後的更新會自己確認新的 fleet 真的在跑，沒有的話會自動退回。

你不必自己發現：2.3 會檢查。當已安裝版本的 fleet 一直起不來時，每個 `agend` 指令（`agend ls`、`agend status`……）都會先印出來，`agend doctor` 也會把它列為失敗的檢查，並附上 `~/.agend/fleet.log` 的最後幾行（錯誤訊息在那裡）：

```
⚠ AgEnD v2.3.0 已安裝，但 fleet 無法啟動（launchd: exit 1, started 6 times）。
  回到 v2.2.6：npm install -g @songsid/agend@2.2.6 && agend restart
  更新程式保留了 v2.2.6 的副本：~/.npm-global/.agend-rollback/2.2.6-…/agend（不會自動還原）。
  錯誤訊息在 ~/.agend/fleet.log 的最後幾行。請回報（agend doctor 會列出要附上的內容）：https://github.com/songsid/AgEnD/issues/new
```

在 Mac 上還會跳出一次通知。同樣的訊息也會在聊天裡貼一次，給只從 Discord 或 Telegram 使用 AgEnD 的人（#2490）：貼在 General 的主題，沒有 General 時改私訊第一位管理員。它在該版本第三次啟動失敗時，由那次失敗的啟動本身透過平台的 API 送出。這是盡力而為：讀不到 `fleet.yaml`、`.env`，或連不上網路時就不會送出。要退回的版本，是這台主機上最後一次成功執行的版本，或 2.2.x 更新程式保留了副本的那個版本。正常但較慢的啟動、剛安裝還在啟動中，以及你自己停掉的 fleet，都不會被回報。

**從 2.3.2 起，Mac 會自己還原 2.2.x（#2481）。** 如果 2.2.x 更新程式裝上的 2.3.x 在 launchd 下 10 分鐘內啟動失敗 3 次，而且從未在這台主機成功執行過，它會放回更新程式保留的 2.2.x 副本（`<npm prefix>/.agend-rollback/2.2.x-<時間>/agend`），由 launchd 啟動。每個版本只會發生一次，並記錄在 `fleet.log` 和 `~/.agend/fleet-auto-restore.json`。如果還原本身失敗，會再送一則通知說明，並附上手動退回的指令。`agend doctor` 會顯示，聊天通知和 Mac 通知也會說明已退回。以下情況絕不會還原：
- 你手動啟動、或自己停掉的 fleet；
- 較慢的啟動；
- 曾在這台主機成功執行過的版本，或這台主機已經跑過任何 2.3.x（它只負責退回從 2.2.x 升上來的那一步）；
- 保留的副本不是能執行、並能回報自己版本的 2.2.x。

launchd 的 plist 不會更動。要注意一點：2.3.x 在失敗前可能已經改動 AgEnD 的資料。2.2.6 能讀取 2.3 寫入的資料（Data downgrade compatibility CI 有檢查），但如果還原後有任何異常，請在回報中說明。

### 遇到阻礙時

- **另一個安裝正在進行**：另一個 AgEnD 安裝或更新還占著安裝鎖時，新的這個會在改動任何東西之前停下並說明原因。等前一個完成，再更新一次。
- **安裝被中斷**：再執行一次安裝指令。它會修好中斷的安裝留下的東西。

## 3. 新版起不來時：自動退回

新版的 service 起不來時，更新會試著裝回前一版：
- 前一版的套件，連同它自帶的 Node；
- 前一版的 systemd unit（使用者或系統層級）或 launchd plist；
- 前一版的 service（如果原本在跑）。原本就停著的 service 會維持停止。

它只會還原能確認原本存在的東西；無法確認時，會保留復原用的副本，並印出要檢查什麼。不論哪一種，更新都會以錯誤結束，訊息會說明前一版是否已重新在跑。如果復原不完整，照它印出的步驟處理。

從 2.3 起，macOS（launchd）要等新的 fleet 真的跑起來，才算更新完成。從 2.2.x 升級的 Mac 是例外，請看上面的「Mac：確認 fleet 有起來」。

## 4. 第一次啟動 2.3 時會改變的事

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

第一次啟動時還會有這些變化：
- **service 設定會被修好**：Linux 的 unit 會加上 `NotifyAccess=all`。沒有這一行時，systemd 收不到就緒訊號，fleet 會每 15 分鐘被重啟一次。更新會寫入這個設定，再確認 systemd 實際載入的值；它也會檢查實際載入的 `OOMPolicy`。
- **儀表板登入會保留**：直接連到儀表板登入的瀏覽器，升級後仍是登入狀態。唯一的例外：升級前，同一台主機上的另一個 AgEnD 可能已經覆蓋了這個瀏覽器的登入 cookie，這時要再登入一次。透過公開連結的登入不會保留：它只跟著那個連結存在，重新啟動後會是新的連結。從 2.3 起，每個 fleet 的 cookie 都有自己的名稱。
- **有些指令改名或移除了**：
  - `agend restart` 是唯一的完整重啟。`agend fleet restart` 現在會改跑它，並將在 2.4 移除。
  - 已移除：`agend schedule trigger`、`agend fleet logs`（改用 `agend logs`）、聊天室的 `/install-cli`（改用 `/login`）、`agend install --activate`。輸入這些指令時，會告訴你該改用哪一個。

## 5. 升級後：快速檢查

```bash
agend --version   # 2.3.0
agend ls          # 列出每個 instance，且都在執行
agend doctor      # 檢查 service、runtime 與各 backend
```

接著打開儀表板（在 General 傳 `/web`），確認 instance 都在、每個的聊天都能打開。
