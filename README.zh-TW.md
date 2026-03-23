# claude-channel-daemon

用一個 Telegram bot 跑多個 Claude Code session，每個 Forum Topic 對應一個獨立的專案。內建 Docker 沙盒、指令批准、排程任務、語音轉文字、自動 context 輪替、crash 自動恢復。

[English README](README.md)

> **⚠️ 注意：** daemon 會預先放行大部分工具，危險的 Bash 指令（rm、sudo、git push...）會透過 Telegram 按鈕讓你確認。批准 server 連不上的話，危險操作會被擋。詳見[權限機制](#權限機制)。

## 為什麼要做這個

Claude Code 的官方 Telegram plugin 是 1 bot = 1 session。終端機關掉，bot 就斷了。

這個 daemon 解決的問題：

- **Fleet 模式** — 1 個 Telegram bot、N 個 Forum Topics = N 個獨立 Claude session
- **Docker 沙盒** — Bash 指令跑在共用的 Docker 容器裡，host 檔案系統被隔離
- **排程任務** — cron 排程：叫 Claude「每天早上 9 點，檢查 deploy 狀態」
- **tmux 架構** — Claude 跑在 tmux window 裡，daemon crash 也不影響
- **自動 context 輪替** — 到 60% context 就等 Claude 空閒，讓它存狀態後換新 session
- **語音訊息** — Telegram 語音 → Groq Whisper → 文字送 Claude
- **批准系統** — 危險 Bash 指令會送 Telegram inline 按鈕讓你決定
- **自動 Topic 綁定** — 在 Telegram 開個 topic，選專案目錄，搞定
- **系統服務** — 裝成 launchd（macOS）或 systemd（Linux）

## 架構

```
                          ┌─────────────────────────────────────────────────────────┐
                          │                    Fleet Manager                        │
                          │                                                         │
Telegram ◄──long-poll──► │  TelegramAdapter (Grammy)     Scheduler (croner)        │
                          │       │                          │                      │
                          │  threadId 路由表                  │ cron 觸發            │
                          │  #277→proj-a  #672→proj-b        │                      │
                          │       │                          │                      │
                          │  ┌────┴────┐  ┌────┴────┐  ┌────┴────┐                 │
                          │  │Daemon A  │  │Daemon B  │  │Daemon C  │                │
                          │  │批准系統  │  │批准系統  │  │批准系統  │                │
                          │  │Context   │  │Context   │  │Context   │                │
                          │  │Guardian  │  │Guardian  │  │Guardian  │                │
                          │  └────┬─────┘  └────┬─────┘  └────┬─────┘                │
                          │       │              │              │                     │
                          │  ┌────┴─────┐  ┌────┴─────┐  ┌────┴─────┐               │
                          │  │tmux win  │  │tmux win  │  │tmux win  │               │
                          │  │Claude    │  │Claude    │  │Claude    │               │
                          │  │+MCP srv  │  │+MCP srv  │  │+MCP srv  │               │
                          │  └────┬─────┘  └────┴─────┘  └────┴─────┘               │
                          └───────┼─────────────────────────────────────────────────┘
                                  │ CLAUDE_CODE_SHELL
                                  ▼
                          ┌─────────────────────────────────────────┐
                          │         Docker 容器 (ccd-shared)         │
                          │                                         │
                          │  所有 Bash 指令在這裡執行                 │
                          │  ~/projects/ (bind mount)               │
                          │  ~/.claude/ (bind mount)                │
                          │                                         │
                          │  隔離：~/Desktop、~/Downloads            │
                          │  /etc、/usr、host processes              │
                          └─────────────────────────────────────────┘
```

## 核心功能

### Docker 沙盒

Bash 指令跑在共用的 Docker 容器裡。Claude Code 本身留在 host 上（保留 Keychain 認證、tmux attach、hooks）。只有 shell 執行被沙盒化。

```yaml
# fleet.yaml
sandbox:
  enabled: true
  extra_mounts:
    - ~/.gitconfig:~/.gitconfig:ro
    - ~/.ssh:~/.ssh:ro
```

**運作原理：** daemon 設定 `CLAUDE_CODE_SHELL` 指向 wrapper script（`sandbox-bash`），透過 `docker exec` 把指令轉發到共用容器。所有專案目錄用相同的絕對路徑 bind mount，不需要路徑轉換。

**隔離範圍：**
| 容器內看得到 | 看不到 |
|-------------|--------|
| `project_roots` 目錄（可讀寫）| `~/Desktop`、`~/Downloads` |
| `~/.claude/`（session、認證）| `/etc`、`/usr`（host 的）|
| `~/.gitconfig`、`~/.ssh`（唯讀）| host processes |
| `$TMPDIR`（cwd tracking）| 其他使用者目錄 |

**不在沙盒範圍內的：** Claude 的內建檔案工具（Read、Write、Edit、Glob、Grep）直接在 host 上操作——只有 Bash tool 的指令會走 Docker。

### 排程任務

Claude 可以透過 MCP tools 建立 cron 排程。排程存在 SQLite 裡，daemon 重啟後會自動恢復。

```
使用者：「每天早上 9 點，幫我檢查有沒有需要 review 的 PR」
Claude → create_schedule(cron: "0 9 * * *", message: "檢查需要 review 的 PR")
```

MCP tools：`create_schedule`、`list_schedules`、`update_schedule`、`delete_schedule`

排程可以指定目標 instance，或是在建立排程的同一個 instance 上觸發。觸發時，daemon 會像使用者發訊息一樣把內容推送給 Claude。

### Context 輪替

監控 Claude 的 status line JSON。是個 5 狀態的 state machine：

```
NORMAL → PENDING → HANDING_OVER → ROTATING → GRACE
```

- **PENDING** — context 超過門檻（預設 60%），等 Claude 空閒
- **HANDING_OVER** — 送 prompt 讓 Claude 把狀態存到 `memory/handover.md`
- **ROTATING** — 砍 tmux window，用 `--resume` 開新 session
- **GRACE** — 10 分鐘冷卻期，防止快速重複輪替

也會在 `max_age_hours`（預設 8h）後不管 context 用量直接輪替。

### 批准系統

PreToolUse hook 把每個 Bash 指令轉發到批准 server：

| 操作 | 結果 |
|------|------|
| `ls`、`cat`、`npm install`、`git status` | 自動放行 |
| `rm`、`mv`、`sudo`、`kill`、`git push/reset/clean` | → Telegram 按鈕讓你選 |
| `rm -rf /`、`dd`、`mkfs` | 設定檔直接擋 |
| 批准 server 連不上 | 擋掉（fail-closed）|

```
Claude 呼叫 Bash tool
  → PreToolUse hook 觸發（在 host 上，不在 Docker 裡）
  → curl POST 到批准 server（127.0.0.1:PORT）
  → 安全？→ 放行
  → 危險？→ IPC → fleet manager → Telegram 按鈕 → 你決定
  → server 掛了？→ 擋掉
```

### 語音轉文字

Telegram 語音訊息透過 Groq Whisper API 轉文字後送給 Claude。Topic 模式和 DM 模式都支援。需要在 `.env` 設定 `GROQ_API_KEY`。

### 自動 Topic 綁定

Topic 模式下，在 Telegram 建新的 Forum Topic 會觸發互動式目錄瀏覽器。選專案目錄 → instance 自動設定、topic 綁定、Claude 啟動。刪除 topic 會自動解除綁定並停止 instance。

## 開始用

```bash
git clone https://github.com/suzuke/claude-channel-daemon.git
cd claude-channel-daemon
npm install && npm link

# 需要
brew install tmux        # macOS
# Docker Desktop 或 OrbStack（沙盒模式用）

# 互動式設定
ccd init

# 啟動 fleet
ccd fleet start
```

### Docker 沙盒設定

```bash
# 建 sandbox image（只需一次）
docker build -f Dockerfile.sandbox -t ccd-sandbox:latest \
  --build-arg HOST_UID=$(id -u) --build-arg HOST_GID=$(id -g) .

# 在 fleet.yaml 加：
#   sandbox:
#     enabled: true

# 重啟 fleet — 容器會自動建立
ccd fleet stop && ccd fleet start
```

## 指令

```
ccd init                  互動式設定精靈
ccd fleet start           啟動所有 instance
ccd fleet stop            停止所有 instance
ccd fleet status          看 instance 狀態
ccd fleet logs <name>     看 instance log
ccd fleet start <name>    啟動特定 instance
ccd fleet stop <name>     停止特定 instance
ccd schedule list         列出所有排程
ccd schedule delete <id>  刪除排程
ccd topic list            列出 topic 綁定
ccd topic bind <n> <tid>  綁定 instance 到 topic
ccd topic unbind <n>      解除 topic 綁定
ccd access lock <n>       鎖定 instance 存取
ccd access unlock <n>     開放 instance 存取
ccd access list <n>       列出允許的使用者
ccd access remove <n> <uid> 移除使用者
ccd access pair <n> <uid> 產生配對碼
ccd install               裝成系統服務
ccd uninstall             移除系統服務
```

## 設定

Fleet 設定檔在 `~/.claude-channel-daemon/fleet.yaml`：

```yaml
sandbox:
  enabled: true
  extra_mounts:
    - /Users/me/.gitconfig:/Users/me/.gitconfig:ro
    - /Users/me/.ssh:/Users/me/.ssh:ro

project_roots:
  - ~/Projects

channel:
  type: telegram
  mode: topic           # topic（推薦）或 dm
  bot_token_env: CCD_BOT_TOKEN
  group_id: -100xxxxxxxxxx
  access:
    mode: locked         # locked 或 pairing
    allowed_users:
      - 123456789

defaults:
  context_guardian:
    threshold_percentage: 60
    max_age_hours: 8
  log_level: info

instances:
  my-project:
    working_directory: /path/to/project
    topic_id: 277
```

密鑰放在 `~/.claude-channel-daemon/.env`：
```
CCD_BOT_TOKEN=123456789:AAH...
GROQ_API_KEY=gsk_...          # 選用，語音轉文字用
```

## 資料目錄

`~/.claude-channel-daemon/`：

| 路徑 | 用途 |
|------|------|
| `fleet.yaml` | Fleet 設定 |
| `.env` | Bot token + API keys |
| `fleet.log` | Fleet log（JSON）|
| `fleet.pid` | Fleet manager PID |
| `scheduler.db` | 排程資料庫（SQLite）|
| `instances/<name>/` | 每個 instance 的資料 |
| `instances/<name>/daemon.log` | Instance log |
| `instances/<name>/session-id` | Session UUID，給 `--resume` 用 |
| `instances/<name>/statusline.json` | Claude 最新狀態資料 |
| `instances/<name>/channel.sock` | IPC Unix socket |
| `instances/<name>/sandbox-bash` | 沙盒 shell wrapper（啟用時）|
| `instances/<name>/claude-settings.json` | 每個 instance 的 Claude 設定 |
| `instances/<name>/memory.db` | 記憶檔 SQLite 備份 |
| `instances/<name>/output.log` | Claude tmux 輸出擷取 |

## 系統需求

- Node.js >= 20
- tmux
- Claude Code CLI（`claude`）
- Telegram bot token（[@BotFather](https://t.me/BotFather)）
- Docker Desktop 或 OrbStack（選用，沙盒模式用）
- Groq API key（選用，語音轉文字用）

## 已知限制

- 目前只在 macOS 測過（Docker 沙盒用到 macOS 特定路徑）
- 沙盒只隔離 Bash tool——Read/Write/Edit/Glob/Grep 直接在 host 上操作
- `~/.ssh` 以唯讀方式掛進沙盒——Claude 能讀但不能改 SSH key
- 全域 `enabledPlugins` 裡有官方 telegram plugin 會造成 409 polling 衝突（daemon 會自動重試）

## 授權

MIT
