# 用 Docker 執行 AgEnD

這是安裝 AgEnD 的第二種方式：`docker compose up` 就會在容器裡得到一個可用的 fleet。適合試用、展示，或不想在機器上裝 Node.js
和 tmux 的情況。要長期使用的伺服器，仍建議走一般安裝（systemd 或 launchd 服務）。

映像檔裡有 AgEnD、Node.js 和 tmux，但沒有任何 AI CLI。第一次啟動時，會把 `fleet.yaml` 用到的 CLI 安裝到 home volume，之後啟動就不必再裝。

> **映像檔還沒有發佈。** 在 `ghcr.io/songsid/agend` 發佈之前，請在這個 repository 的 checkout 用 `docker/build-from-checkout.sh` 建置，如下。
> 建置的機器需要 Node.js 22。直接 `docker compose build` 會安裝 npm 上的版本，它可能還沒有容器支援。

## 快速開始

```bash
git clone https://github.com/songsid/AgEnD.git && cd AgEnD/docker
cp .env.example .env          # 選填：instance 名稱、後端、聊天平台
./build-from-checkout.sh      # 映像檔發佈前需要（發佈後可略過）
docker compose up -d          # 第一次啟動會安裝 CLI；用 docker compose logs -f 觀看
docker compose exec agend agend web --code
```

打開 `http://localhost:19280/` 輸入代碼。側邊欄會有你的 instance（預設 `dev`，Claude Code）。登入它的 CLI（見下方），就能在聊天裡和它對話。

## 啟動時會做什麼

1. **只在第一次：** 還沒有 `~/.agend/fleet.yaml` 時，會依 `.env` 寫一份：一個名為 `AGEND_INSTANCE` 的 instance，在 `/work/<name>`
   執行 `AGEND_BACKEND`。除非設定了聊天平台（見下方），否則只用網頁。之後不會再改寫。要修改時，先複製出來，編輯後以容器使用者寫回：
   `docker compose exec -T agend cat .agend/fleet.yaml > fleet.yaml`，再執行
   `docker compose exec -T agend sh -c 'cat > .agend/fleet.yaml' < fleet.yaml` 和 `docker compose restart`。
2. **每次：** `fleet.yaml` 用到、但還沒安裝的後端，會用該後端自己的安裝程式安裝到 home volume。記錄會列出每個 CLI，以及能在不啟動 CLI 的情況下讀到的版本。
3. fleet 在前景啟動，由 Docker 的重新啟動政策（`restart: unless-stopped`）維持運作。

某個 CLI 安裝失敗時，記錄會說明原因；fleet 仍會啟動，那個 instance 會像一般安裝一樣回報缺少 CLI。

## 登入

**儀表板：** `docker compose exec agend agend web --code` 會印出 `http://localhost:19280/` 的一次性代碼。有聊天平台時，也可以在 General 傳 `/web`。

**CLI**，任選一種：
- 在 General 用 `/login`，或在儀表板替後端登入：瀏覽器與 device code 流程都和一般安裝一樣。
- 在容器裡開 shell：`docker compose exec -it agend claude`（或 `codex`、`kiro-cli`、`grok` 等），依 CLI 自己的流程登入。
- 在 `.env` 放 API key：`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`XAI_API_KEY` 等。

## 聊天平台（選填）

在第一次啟動前，於 `.env` 設定：

```bash
AGEND_CHANNEL=telegram          # 或 discord
AGEND_GROUP_ID=-1001234567890   # Telegram 論壇群組，或 Discord 伺服器 id
AGEND_ADMIN_IDS=123456789       # 你的使用者 id；只有這些人能進來
TELEGRAM_BOT_TOKEN=…            # 或 DISCORD_BOT_TOKEN
```

Token 只放在 `.env`（每次啟動讀取），不會寫進 `fleet.yaml`。之後要加平台，請依 [設定](configuration.zh-TW.md#channel) 編輯 `fleet.yaml`。

## 設定（`.env`）

| 變數 | 預設 | 作用 |
|---|---|---|
| `AGEND_INSTANCE` | `dev` | 第一次啟動：instance 名稱 |
| `AGEND_BACKEND` | `claude-code` | 第一次啟動：它的後端（`claude-code`、`codex`、`kiro-cli`、`grok`、`opencode`、`antigravity`、`muse`） |
| `AGEND_CLI_VERSIONS` | — | 固定版本，例如 `claude-code=2.1.300,kiro-cli=2.34.0`。已安裝但版本不同的 CLI 會依固定版本重新安裝 |
| `AGEND_CHANNEL`、`AGEND_GROUP_ID`、`AGEND_ADMIN_IDS` | — | 第一次啟動：Telegram 或 Discord 頻道 |
| `AGEND_PORT` | `19280` | 儀表板在主機上的連接埠 |
| `AGEND_TAG` | `latest` | 映像檔標籤：`latest`、`beta` 或版本號 |

只有 `claude-code` 和 `kiro-cli` 的安裝程式能指定版本；其他後端會安裝最新版，記錄會註明沒有套用固定版本。映像檔關閉了各 CLI 的自動更新，固定的版本不會被換掉。

## 資料放在哪裡

| Volume | 掛載位置 | 內容 |
|---|---|---|
| `agend-home` | `/home/agend` | `~/.agend`（fleet.yaml、資料庫、instance 狀態），以及每個 CLI 的安裝、登入和設定 |
| `agend-work` | `/work` | instance 的工作目錄 |

兩者都是具名 volume：`docker compose down` 會保留，`docker compose down -v` 會刪除。備份 home volume：
`docker run --rm -v agend_agend-home:/h -v "$PWD":/b alpine tar czf /b/agend-home.tgz -C /h .`。

也可以用 bind mount，但目錄必須屬於 uid 1000（映像檔的 `agend` 使用者）。建議用具名 volume：在 WSL 上，bind mount 的目錄重新啟動後可能變成 root 所有。
若啟動失敗並顯示「must be owned and writable by uid 1000」，記錄裡會印出修正用的指令。

## 更新、重新啟動、停止

| 一般安裝 | 容器 |
|---|---|
| `agend update`、`/update` | `docker compose pull && docker compose up -d`（在容器裡兩者都會拒絕並提示這行）。映像檔發佈前：`git pull`、`./build-from-checkout.sh`、`docker compose up -d` |
| `agend restart`、`/restart` | 相同：fleet 結束後由 Docker 重新啟動 |
| `agend stop` | `docker compose stop`（在容器裡 `agend stop` 會拒絕：Docker 會再啟動它） |
| `agend install`（安裝服務） | 不需要：由 Docker 的重新啟動政策監管 fleet |
| `agend logs`、`fleet.log` | `docker compose logs -f`，以及 `~/.agend` 裡的檔案 |
| `tmux attach -t agend` | `docker compose exec -it agend tmux attach -t agend` |

每日的更新檢查會用 `docker compose` 那一行告訴你有新版本。

## 容器裡能用什麼

| | 一般安裝 | 容器 | 說明 |
|---|:-:|:-:|---|
| 網頁儀表板與網頁聊天 | ✅ | ✅ | |
| Telegram / Discord | ✅ | ✅ | ¹ |
| 由 AgEnD 安裝 Claude Code、Codex、kiro-cli、Grok、OpenCode、Antigravity、Muse | ✅ | ✅ | 第一次啟動時安裝到 home volume |
| 透過 `/login` 或儀表板登入 CLI | ✅ | ✅ | ¹ |
| 固定 CLI 版本 | ❌ | ✅ | `AGEND_CLI_VERSIONS`；僅 claude-code 與 kiro-cli |
| `agend update` / `/update` | ✅ | ❌ | 改為更新映像檔 |
| systemd / launchd 服務 | ✅ | ❌ | 由 Docker 的重新啟動政策監管 fleet |
| 在 instance 的工作中使用 `sudo` | ✅ | ❌ | 容器以一般使用者執行 |
| 預設可從其他機器連到儀表板 | ❌ | ❌ | 兩者都只在本機監聽；named tunnel，或有聊天平台時的公開連結，兩者都能用 ¹；或刻意把容器連接埠發佈到其他位址，並把名稱加入 `web.allowed_hosts` |

¹ 與一般安裝是同一份程式碼。容器的端對端檢查涵蓋網頁聊天；bot token、廠商登入與 tunnel 不在其中（沒有使用真實帳號）。

## 疑難排解

- **儀表板打不開。** 第一次啟動後，`docker compose ps` 應顯示容器為 healthy（安裝 CLI 可能要幾分鐘）。確認連接埠：`.env` 的 `AGEND_PORT` 必須和你開的網址一致。
- **「must be owned and writable by uid 1000」。** bind mount 或由 root 建立的 volume。執行記錄印出的指令，或改用 `compose.yaml` 的具名 volume。
- **某個 CLI 沒裝起來。** 記錄那一行會說明原因。安裝程式會從各廠商網站下載，所以第一次啟動需要網路。
