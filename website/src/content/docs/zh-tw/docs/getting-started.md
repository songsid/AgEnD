---
title: 快速開始
description: 安裝 AgEnD、接上 bot，用手機跑第一個 agent。
---

AgEnD 把你的 AI coding agent 變成系統服務，放進 Telegram 或 Discord。一個 bot、一個專案一個 agent，全部從手機操作。

## 環境需求

- Node.js 20 以上
- tmux
- Telegram bot token（跟 [@BotFather](https://t.me/BotFather) 要）或 Discord bot token
- 至少一個已安裝並登入的 AI coding CLI — 見[安裝後端](#安裝後端)

支援 macOS 和 Linux。不支援 Windows，請用 WSL。

## 安裝

```bash
curl -fsSL https://songsid.github.io/AgEnD/install.sh | bash
```

沒有 Node.js 的話會用 nvm 裝，接著裝 tmux、裝 `agend`，然後直接跑設定精靈。

已經有 Node 和 tmux：

```bash
npm install -g @songsid/agend
```

在 WSL 上，安裝腳本會避開 PATH 裡的 Windows `node.exe`。如果指令還是指到 Windows 的執行檔，在 `/etc/wsl.conf` 加上這段，然後執行 `wsl --shutdown`：

```ini
[interop]
appendWindowsPath=false
```

## 安裝後端

AgEnD 是驅動你本來就在用的 CLI。先裝一個並登入，再跑設定。

| 後端 | 安裝 | 登入 |
|---|---|---|
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` | `claude` |
| OpenAI Codex | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | `codex` |
| Kiro CLI | `curl -fsSL https://cli.kiro.dev/install \| bash` | `kiro-cli login` |
| Antigravity CLI | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | `agy` |
| Grok Build | `curl -fsSL https://x.ai/cli/install.sh \| bash` | `grok` |
| Meta Muse Code | `curl -fsSL https://api.meta.ai/muse-launcher.sh \| bash` | `muse login` |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash` | `opencode` |

往下走之前先確認你選的那個能用：

```bash
agend backend doctor claude-code
```

Gemini CLI 還能跑，但 2026-06-18 起已棄用，請改用 Antigravity CLI。

## 設定

```bash
agend quickstart
```

它會問你的 bot token、要用哪個後端、第一個 agent 在哪個目錄工作。Discord 是內建的 — 在選單裡選它就好，不用另外裝東西。

之後要加使用者或伺服器到現有設定，再跑一次 `agend quickstart`。

想用手機設定而不是在終端機設定，見 [`agend setup --tunnel`](/AgEnD/zh-tw/docs/cli/#web-儀表板)。

## 啟動 fleet

```bash
agend fleet start
```

要讓它重開機後也活著，裝成系統服務：

```bash
agend install
```

## 送出第一則訊息

打開 Telegram 找到你的 bot，傳一則訊息給它。在論壇群組裡，每個 topic 就是一個 agent；送到 **General** topic 的訊息會被路由給該處理它的那個 agent。

Discord 上用 `/start` 在目前頻道開一個 agent、`/chat <訊息>` 跟它說話、`/stop` 結束它。

如果都沒有回應，先看 fleet 的狀況：

```bash
agend health
```

## 下一步

- [功能](/AgEnD/zh-tw/docs/features/) — fleet 能做什麼
- [CLI 參考](/AgEnD/zh-tw/docs/cli/) — 所有指令
- [設定](/AgEnD/zh-tw/docs/configuration/) — `fleet.yaml` 完整參考
