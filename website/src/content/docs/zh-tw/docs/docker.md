---
title: Docker
description: 在一個 Docker 容器裡執行整個 AgEnD fleet，由照著 Docker 操作手冊的 agent 替你架設與維護。
---

AgEnD 可以用一個容器執行整個 fleet，由 Docker 監管。檔案不用自己寫：[在 Docker 中執行 AgEnD](https://github.com/songsid/AgEnD/blob/main/docs/docker.zh-TW.md) 是寫給 agent 的操作手冊。把它交給 General 或任何 agent，它會問你幾個問題、架好容器，之後也負責維護。General agent 有一個指向它的 `docker-install` skill。

要長期使用的伺服器，仍建議用一般安裝（[快速開始](/AgEnD/zh-tw/docs/getting-started/)）搭配 systemd 或 launchd 服務。Docker 適合試用、展示，或不想在機器上裝 Node.js 和 tmux 的情況。

## 你會得到什麼

- 非 root 使用者（uid 1000），tini 為 PID 1。
- AgEnD 的資料、每個 AI CLI 的安裝與登入都放在具名 volume，重建映像檔也會保留。
- 儀表板只在主機的 `127.0.0.1:19280`。
- 映像檔安裝的是 npm 上發佈的套件（`AGEND_VERSION`：`latest` 是最新的穩定版，或 `beta`，或指定版本）。AgEnD 本身沒有任何 Docker 專用的部分。

## Agent 會問你什麼

- 要安裝哪些 AI backend（`claude-code`、`codex`、`kiro-cli`、`grok`、`opencode`、`antigravity`、`muse`），以及要不要固定某個 CLI 的版本。
- 只用網頁，還是也接 Telegram 或 Discord bot（那就需要 bot token、群組或伺服器 id，以及你的使用者 id）。
- Linux，還是 macOS 或 Windows（WSL）上的 Docker Desktop，以及 CPU 架構。
- 要用哪個 AgEnD 版本。

需要 `docker compose` v2.24 或更新版本。token 與 API key 只放在 `.env`，絕不放進 `fleet.yaml` 或聊天裡。

## 維護

| 要做什麼 | 怎麼做 |
|---|---|
| 更新 AgEnD | 在 `.env` 設定 `AGEND_VERSION`（或維持 `latest`），再執行 `docker compose build --pull --no-cache` 與 `docker compose up -d` |
| 重新啟動、停止、啟動 | `docker compose restart`、`docker compose stop`、`docker compose up -d` |
| 備份 | 停止後，照操作手冊的步驟把 volume 打包成 tar 檔 |

**絕對不要**在容器裡執行 `agend update`、`agend restart`、`agend stop` 或 `agend install`，也不要在聊天裡傳 `/update`：容器裡沒有 systemd，在容器裡更新的內容會在映像檔下次啟動時被還原。fleet 每天的「有新版本」通知仍會寫 `/update`；請改用重建映像檔的方式更新。

## Docker 裡能用什麼

| | 一般安裝 | Docker |
|---|:-:|:-:|
| 網頁儀表板與網頁聊天 | ✅ | ✅ |
| Telegram / Discord | ✅ | ✅ |
| 全部七種 backend | ✅ | ✅ |
| claude-code、codex、kiro-cli、grok 的 `/login` | ✅ | ✅ |
| `agend update` / `/update` | ✅ | ❌ |
| `agend restart` / `stop` / `install` | ✅ | ❌ |
| systemd / launchd 服務 | ✅ | ❌ |
| instance 工作中使用 `sudo` | ✅ | ❌ |

操作手冊還涵蓋記錄、觀看或操作 instance、新增 backend 或 instance，以及疑難排解（包含 WSL 的 bind-mount 陷阱）。
