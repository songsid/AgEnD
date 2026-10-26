# 在 Docker 中執行 AgEnD：給 agent 的操作手冊

這份文件寫給 AI agent：替使用者在 Docker 中架設 AgEnD，並持續維護。請依序執行每個步驟，每個指令都要親自執行並確認結果，再進行下一步。
告訴使用者你做了什麼、需要他們提供什麼。這裡的做法不需要修改 AgEnD 本身：映像檔安裝的是 npm 上發佈的套件。

完成後會有一個容器執行整個 AgEnD fleet，由 Docker 監管。它具備：
- 非 root 使用者（uid 1000），tini 為 PID 1；
- AgEnD 的資料、每個 AI CLI 的安裝與登入都放在具名 volume；
- 儀表板在主機的 `127.0.0.1:19280`。

要長期使用的伺服器，仍建議一般安裝（`install.sh`、systemd 或 launchd 服務）。Docker 適合試用、展示，或不想在機器上裝 Node.js 和 tmux 的情況。

## Agent 守則

- **絕不在容器裡執行 `agend update`、`agend restart`、`agend stop` 或 `agend install`，也絕不在 fleet 的聊天裡用 `/update`。**
  容器沒有 systemd。更新只會換掉容器裡的 AgEnD，不會換掉它所依據的映像檔，所以下次啟動容器時就會退回原版本。`restart`、`stop`、`install` 需要容器沒有的服務管理員。請改用[維護](#維護)裡的 `docker compose` 指令。
- token 與 API key 只放在 `.env`，絕不放進 `fleet.yaml`、`compose.yaml` 或聊天裡。
- 發佈的連接埠保持在 `127.0.0.1`，除非使用者刻意要求其他位址；那時也要把主機名稱加進 `fleet.yaml` 的 `web.allowed_hosts`。

## 1. 詢問使用者

| 問題 | 為什麼重要 |
|---|---|
| 要用哪些 AI 後端？（`claude-code`、`codex`、`kiro-cli`、`grok`、`opencode`、`antigravity`、`muse`） | 步驟 4 只安裝這些 |
| 是否固定某個 CLI 版本？ | `claude-code` 與 `kiro-cli` 的安裝程式能指定版本；其他會安裝最新版 |
| 只用網頁，還是也接 Telegram 或 Discord？ | 步驟 5 的 `fleet.yaml`；頻道需要 bot token、群組或伺服器 id、使用者 id |
| 主機作業系統：Linux，或 macOS / Windows（WSL）上的 Docker Desktop？ | WSL 有 bind mount 陷阱（見[疑難排解](#疑難排解)） |
| CPU 架構（`uname -m`：`x86_64` 或 `aarch64`）？ | kiro-cli 的固定版本壓縮檔依架構區分 |
| AgEnD 版本：`latest`（穩定版）、`beta` 或指定版本？ | 步驟 2 的 `AGEND_VERSION` |

確認 Docker 可用：`docker compose version` 必須是 v2.24 以上。

## 2. 寫入檔案

建立一個資料夾（例如 `~/agend-docker`），把下面四個檔案原樣寫進去。

<!-- file: Dockerfile -->
```dockerfile
# AgEnD + tmux on Node 22. No AI CLI is baked in: they are installed into the home volume (step 4).
FROM node:22-bookworm-slim
ARG AGEND_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux git curl ca-certificates procps xz-utils unzip less tini socat bash \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@songsid/agend@${AGEND_VERSION}" && npm cache clean --force
# The base image's uid-1000 user, renamed: a bind mount owned by a typical host user matches it.
RUN groupmod -n agend node \
 && usermod -l agend -d /home/agend -m -c AgEnD node \
 && mkdir -p /work && chown agend:agend /work
COPY --chmod=755 entrypoint.sh /usr/local/bin/agend-entrypoint
# The CLIs' own self-updates stay off, so a pinned version stays and updates go through this runbook.
ENV HOME=/home/agend \
    PATH=/home/agend/.local/bin:/home/agend/.opencode/bin:/home/agend/.grok/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    DISABLE_AUTOUPDATER=1 KIRO_NO_AUTO_UPDATE=1 OPENCODE_DISABLE_AUTOUPDATE=1 \
    TERM=xterm-256color LANG=C.UTF-8
USER agend
WORKDIR /home/agend
VOLUME ["/home/agend", "/work"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=5m --retries=3 CMD curl -fsS http://127.0.0.1:19280/health >/dev/null || exit 1
# tini as PID 1 reaps the CLIs' children: without it, a killed CLI stays a zombie that still holds its session lock.
ENTRYPOINT ["tini", "--", "agend-entrypoint"]
```

<!-- file: entrypoint.sh -->
```sh
#!/bin/sh
# With arguments: run them (installs, one-off commands). Without: run the fleet in the foreground.
set -eu
if [ "$#" -gt 0 ]; then exec "$@"; fi
if [ ! -f "$HOME/.agend/fleet.yaml" ]; then
  echo "agend-entrypoint: no ~/.agend/fleet.yaml yet (runbook step 5)" >&2
  sleep 30; exit 78
fi
# AgEnD's dashboard listens on 127.0.0.1 inside the container, which a published port cannot reach.
# socat forwards the container's port 19380 to it.
socat TCP-LISTEN:19380,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:19280 &
exec agend fleet start
```

<!-- file: compose.yaml -->
```yaml
name: agend
services:
  agend:
    build:
      context: .
      args:
        AGEND_VERSION: ${AGEND_VERSION:-latest}
    image: agend-local:${AGEND_VERSION:-latest}
    restart: unless-stopped
    # The fleet stops its instances gracefully before it exits.
    stop_grace_period: 2m
    env_file:
      - path: .env
        required: false
    ports:
      - "127.0.0.1:${AGEND_PORT:-19280}:19380"
    volumes:
      - agend-home:/home/agend
      - agend-work:/work
volumes:
  agend-home:
  agend-work:
```

<!-- file: .env -->
```sh
# AgEnD version for the image: latest, beta, or an exact version (2.3.1).
AGEND_VERSION=latest
# Host port of the dashboard.
AGEND_PORT=19280
# Chat platform tokens, only if the person wants a channel (step 5):
# TELEGRAM_BOT_TOKEN=
# DISCORD_BOT_TOKEN=
# API keys, if a CLI signs in with a key instead of a login (step 7):
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# XAI_API_KEY=
```

接著建置映像檔，輸出最後會出現 `naming to … agend-local:<version>`：

```sh
docker compose build
```

## 3. 檢查映像檔

```sh
docker compose run --rm agend sh -c 'id; agend --version; tmux -V'
```

應看到 `uid=1000(agend)`、AgEnD 版本與 tmux 版本。

## 4. 安裝 AI CLI

依使用者選的後端，每個執行一行。每行都裝進 home volume，之後重新啟動或更新映像檔都會保留。把 `<version>` 換成固定版本，或用不指定版本的寫法。

| 後端 | 安裝（不指定版本） | 固定版本 |
|---|---|---|
| claude-code | `curl -fsSL https://claude.ai/install.sh \| bash` | `curl -fsSL https://claude.ai/install.sh \| bash -s <version>` |
| kiro-cli | `curl -fsSL https://cli.kiro.dev/install \| bash` | 見下方 |
| codex | `curl -fsSL https://chatgpt.com/codex/install.sh \| CODEX_NON_INTERACTIVE=1 sh` | ❌ |
| grok | `curl -fsSL https://x.ai/cli/install.sh \| bash` | ❌ |
| opencode | `curl -fsSL https://opencode.ai/install \| bash` | ❌ |
| antigravity | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | ❌ |
| muse | `mkdir -p ~/.local/bin && curl -fsSL https://api.meta.ai/muse-launcher.sh -o ~/.local/bin/muse && chmod +x ~/.local/bin/muse && MUSE_LAUNCHER_INSTALL=1 ~/.local/bin/muse` | ❌ |

每一行都在映像檔裡執行：

```sh
docker compose run --rm agend sh -c 'curl -fsSL https://claude.ai/install.sh | bash'
```

固定 kiro-cli 版本時，把 `V` 設為版本、`ARCH` 設為 `x86_64` 或 `aarch64`：

```sh
docker compose run --rm agend sh -c 'set -e; V=2.34.0; ARCH=x86_64; D="$HOME/.local/share/agend-cli/kiro-cli/$V"
  mkdir -p "$D" "$HOME/.local/bin"
  curl -fsSL "https://prod.download.cli.kiro.dev/stable/$V/kirocli-$ARCH-linux.tar.xz" | tar -xJ -C "$D"
  for b in "$D"/kirocli/bin/*; do ln -sf "$b" "$HOME/.local/bin/$(basename "$b")"; done'
```

檢查每個 CLI，固定版本的必須印出該版本：

```sh
docker compose run --rm agend sh -c 'claude --version; kiro-cli --version'
```

安裝程式會從各廠商網站下載，所以這一步需要網路。某個安裝失敗時，輸出會說明原因：修正它，或在 `fleet.yaml` 不放那個後端。

## 5. 寫入第一份 `fleet.yaml`

先寫在其他檔案旁邊，再以容器使用者的身分複製進 volume（AgEnD 要求檔案屬於該使用者）。

<!-- file: fleet.yaml -->
```yaml
# One instance per backend the person chose. working_directory is in the work volume.
instances:
  dev:
    backend: claude-code
    working_directory: /work/dev
```

- **kiro-cli instance：** 另外設定 `kiro_ui: tui`。
- **多個 instance：** 每個一段，名稱不可重複。
- **Telegram 或 Discord 頻道：** 加上下面這段。token 放在 `.env` 的 `TELEGRAM_BOT_TOKEN` 或 `DISCORD_BOT_TOKEN`。`allowed_users` 填使用者的數字 id。AgEnD 第一次啟動時會建立 General instance。

```yaml
channels:
  - type: telegram            # or discord
    mode: topic
    bot_token_env: TELEGRAM_BOT_TOKEN
    group_id: "-1001234567890"  # the Telegram forum group, or the Discord guild id
    access:
      mode: locked
      allowed_users: ["123456789"]
```

```sh
docker compose run --rm -T agend sh -c 'mkdir -p ~/.agend && chmod 700 ~/.agend && cat > ~/.agend/fleet.yaml' < fleet.yaml
docker compose run --rm agend agend validate
```

`agend validate` 必須沒有錯誤。只用網頁的 fleet 會警告沒有設定頻道和 General，這是預期的。

## 6. 啟動並驗證

```sh
docker compose up -d
```

等到 healthy（第一次啟動可能要一分鐘）：

```sh
until curl -fsS http://127.0.0.1:19280/health >/dev/null; do sleep 3; done; docker compose ps
```

檢查 fleet 與 instance：

```sh
docker compose exec agend tmux list-windows -t agend
docker compose logs --tail 50 agend
```

每個 instance 有一個 tmux 視窗。接著給使用者儀表板的登入代碼：

```sh
docker compose exec agend agend web --code
```

它會印出一次性代碼（約 5 分鐘有效）和 `http://localhost:19280/signin`。若 `AGEND_PORT` 不是 19280，請替換網址裡的連接埠。使用者打開網址、輸入代碼，在網頁聊天傳訊息給某個 instance；收到回覆就代表整條路徑正常。若 CLI 還沒登入，instance 會說明：請先做步驟 7。

## 7. 登入 CLI

每個後端任選一種方式：

| 後端 | `/login`（聊天或儀表板） | `.env` 的 API key | 容器裡的 shell |
|---|:-:|:-:|:-:|
| claude-code | ✅ | ✅ | ✅ |
| codex | ✅ | ✅ | ✅ |
| kiro-cli | ✅ | ❌ | ✅ |
| grok | ✅ | ✅ | ✅ |
| opencode | ❌ | ✅ | ✅ |
| antigravity | ❌ | ❌ | ✅ |
| muse | ❌ | ❌ | ✅ |

API key：
- claude-code：`ANTHROPIC_API_KEY` 或 `CLAUDE_CODE_OAUTH_TOKEN`；
- codex：`OPENAI_API_KEY`；
- grok：`XAI_API_KEY`；
- opencode：各 provider 自己的 key。

- **`/login`：** 在 General，或在儀表板替後端登入。瀏覽器與 device code 流程都和一般安裝一樣。
- **API key：** 加到 `.env`，然後執行 `docker compose up -d`（會重新讀取 `.env`）。
- **shell：** `docker compose exec -it agend claude`（或 `codex`、`kiro-cli`、`grok` 等），使用者依該 CLI 自己的流程登入。

登入資料保存在 home volume。

## 維護

### 更新 AgEnD

1. 在 `.env` 設定新版本（`AGEND_VERSION=2.3.2`），或保留 `latest` 取得最新穩定版。
2. 重新建置並重建容器：

```sh
docker compose build --pull --no-cache
docker compose up -d
docker compose exec agend agend --version
```

volume 會保留 `fleet.yaml`、資料庫、CLI 與登入。**絕不**在容器裡用 `agend update` 或 `/update`，原因見[守則](#agent-守則)。fleet 每天的「有新版本」通知會寫 `/update`；這種安裝請改用上面的步驟更新。

### 重新啟動、停止、啟動

| 要做的事 | 指令 |
|---|---|
| 重新啟動 fleet | `docker compose restart` |
| 停止 | `docker compose stop` |
| 再次啟動 | `docker compose up -d` |
| 移除容器（保留資料） | `docker compose down` |

### 升級或固定 CLI 版本

再執行一次步驟 4 的安裝行（指定新版本或不指定），然後 `docker compose restart`。用 `docker compose exec agend <cli> --version` 確認。

### 新增後端或 instance

先安裝它的 CLI（步驟 4），再把 instance 加進 `fleet.yaml`。依步驟 5 再複製一次，執行 `docker compose run --rm agend agend validate`，然後 `docker compose restart`。

要編輯正在使用的檔案，先複製出來：

```sh
docker compose exec -T agend cat .agend/fleet.yaml > fleet.yaml
```

### 記錄

```sh
docker compose logs -f agend                          # the fleet's own output
docker compose exec agend tail -n 200 .agend/daemon.log   # the detailed log
docker compose exec agend ls .agend/instances/        # each instance's logs are in its folder
```

### 觀看或操作 instance

```sh
docker compose exec -it agend tmux attach -t agend
```

用 `Ctrl-b d` 離開。instance 正在工作時，不要在它的視窗裡打字。

### 備份與還原

在停止時備份。每個指令都以 root 身分在映像檔裡執行，volume 掛載在服務掛載的位置，並寫到目前的資料夾：

```sh
docker compose stop
docker compose run --rm --user root -v "$PWD":/b --entrypoint tar agend czf /b/agend-home.tgz -C /home/agend .
docker compose run --rm --user root -v "$PWD":/b --entrypoint tar agend czf /b/agend-work.tgz -C /work .
docker compose up -d
```

還原時（例如在新機器上，用同樣四個檔案），先建置映像檔（步驟 2），再執行：

```sh
docker compose run --rm --user root -v "$PWD":/b --entrypoint sh agend -c 'tar xzf /b/agend-home.tgz -C /home/agend && tar xzf /b/agend-work.tgz -C /work && chown -R 1000:1000 /home/agend /work'
docker compose up -d
```

## Docker 裡能用什麼

| | 一般安裝 | Docker（本手冊） |
|---|:-:|:-:|
| 網頁儀表板與網頁聊天 | ✅ | ✅ |
| Telegram / Discord | ✅ | ✅ |
| 七個後端都能安裝並執行 | ✅ | ✅ |
| claude-code、codex、kiro-cli、grok 用 `/login` | ✅ | ✅ |
| `agend update` / `/update` | ✅ | ❌ |
| `agend restart` / `stop` / `install` | ✅ | ❌ |
| systemd / launchd 服務 | ✅ | ❌ |
| 在 instance 的工作中使用 `sudo` | ✅ | ❌ |
| 預設可從其他機器連到儀表板 | ❌ | ❌ |

Docker 為 ❌ 的項目，請改用上面的 compose 指令。容器以一般使用者執行，沒有 sudo。

## 疑難排解

- **`agend-entrypoint: no ~/.agend/fleet.yaml yet`：** 跳過了步驟 5。寫入檔案後執行 `docker compose up -d`。
- **儀表板打不開：**
  - 檢查 `docker compose ps`（是否 healthy）與 `docker compose logs agend`。
  - 網址的連接埠必須是 `AGEND_PORT`。
  - 轉送程式必須在執行：`docker compose exec agend pgrep -a socat`。fleet 啟動期間記錄裡出現幾行 `socat … Connection refused` 是正常的：儀表板還沒開始監聽。
- **啟動時出現「requires an owned real AGEND_HOME」或權限錯誤：** home volume 或 bind mount 不屬於 uid 1000。修正一次即可：
  `docker compose run --rm --user root --entrypoint chown agend -R 1000:1000 /home/agend /work`。
- **在 WSL 上，Windows 重新開機後 bind mount 的資料夾變成 root 所有。** 改用 `compose.yaml` 的具名 volume，不要用 bind mount。
- **更新映像檔後 CLI 顯示「not installed」：** 只有 volume 保存 CLI。確認 compose 專案沒變：volume 以 `compose.yaml` 的 `name:` 命名（`agend_agend-home`）。或再做一次步驟 4。
- **instance 一直要求登入：** 做步驟 7。device code 登入需要使用者在瀏覽器打開連結。
- **WSL 上的 Docker Desktop 建置時出現 `docker-credential-desktop.exe: exec format error`：** 從 Windows 端建置，或把 `DOCKER_CONFIG` 指向一個 `config.json` 內容為 `{}` 的資料夾。
