---
title: 快速開始
description: 安裝 AgEnD、接上 bot，用手機跑第一個 agent。
---

AgEnD 把你的 AI coding agent 變成系統服務，放進 Telegram 或 Discord。一個 bot、一個專案一個 agent，全部從手機操作。

## 環境需求

- Node.js 和 npm。在 macOS（11 以上）和 glibc 2.28 以上的 Linux（x64 或 arm64）上，AgEnD 會安裝並使用自己的 Node 22，不論執行 npm 的是哪個 Node。其他環境需要 Node 22.14+、23.6+ 或 24+。
- tmux
- 要從 Telegram 或 Discord 聊天：Telegram bot token（跟 [@BotFather](https://t.me/BotFather) 要）或 Discord bot token。沒有 bot 也能只用網頁儀表板，見[網頁使用說明](/AgEnD/zh-tw/docs/web-guide/)。
- 至少一個已安裝並登入的 AI coding CLI — 見[安裝後端](#安裝後端)

支援 macOS 和 Linux。不支援 musl Linux（例如 Alpine）與沒有 systemd 的 Linux 主機：AgEnD 也許裝得起來，但沒有測試過，也不保證能用。同樣不支援原生 Windows：請在 WSL 裡執行 AgEnD，[Windows 安裝指南](/AgEnD/zh-tw/install-windows/)會幫你設好。

## 安裝

```bash
curl -fsSL https://songsid.github.io/AgEnD/install.sh | bash
```

沒有 Node.js 或版本太舊時，會用 nvm 裝 Node.js 22，接著裝 tmux、裝 `agend`，然後提示你執行 `agend quickstart`。腳本在互動式終端機裡執行（不是透過管線）時，會詢問要不要直接開始。

在 Windows 上，改在 PowerShell 執行這一行。它會裝好 WSL 2 和 Ubuntu，在裡面裝 AI 後端和 AgEnD，再串接你的 bot。過程中會詢問一次系統管理員權限；WSL 需要重新開機時，重開後再執行同一行即可接續。詳見 [Windows 安裝指南](/AgEnD/zh-tw/install-windows/)。

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://songsid.github.io/AgEnD/install.ps1 | iex"
```

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
| Meta Muse Code | `mkdir -p "$HOME/.local/bin" && curl -fsSL https://api.meta.ai/muse-launcher.sh -o "$HOME/.local/bin/muse" && chmod +x "$HOME/.local/bin/muse" && MUSE_LAUNCHER_INSTALL=1 "$HOME/.local/bin/muse"` | `muse login` |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash` | `opencode` |

往下走之前先確認你選的那個能用：

```bash
agend backend doctor claude-code
```

fleet 跑起來之後，也可以在聊天裡做這件事：在 General 用 `/login`，會安裝缺少的 CLI 並登入（Claude Code、Codex、Kiro CLI、Grok），不需要 SSH。OpenCode 和 Muse 在那裡只能安裝，Antigravity 要在主機上登入。

## 設定

```bash
agend quickstart
```

它分四步：

1. 找出你已安裝的 AI coding CLI，有好幾個時讓你選。
2. 問你要用 Telegram、Discord 還是兩者都要。Discord 是內建的，不用另外裝東西。
3. 檢查你的 bot token。Telegram 會在你到群組裡傳 `/start` 後找出那個群組和你的 user ID。Discord 會列出 bot 所在的伺服器；如果它還不在任何伺服器，就請你貼上伺服器 ID。接著最多等 30 秒，從你在該伺服器或 bot 私訊送出的訊息偵測帳號，再請你確認顯示的 username 與 ID。偵測失敗或拒絕採用時，必須手動輸入有效的 17–20 位 user ID。另需 General 頻道 ID（開發者模式 → 複製 ID），並可選擇設定 ClassicBot。
4. 問你的專案放在哪裡。

它會寫好 `~/.agend/fleet.yaml`（存取權鎖定給你的 user ID），bot token 則寫進 `~/.agend/.env`。最後它會提議把 fleet 裝成系統服務並啟動，接著告訴你網頁儀表板在哪裡。

逐步的 bot 設定教學：[Telegram](/AgEnD/zh-tw/setup-telegram/)、[Discord](/AgEnD/zh-tw/setup-discord/)。

之後要在現有設定加使用者、第二個平台或 Discord persona bot，再跑一次 `agend quickstart`。

想用手機設定而不是在終端機設定，見 [`agend setup --tunnel`](/AgEnD/zh-tw/docs/cli/#web-儀表板)。

## 啟動 fleet

如果 quickstart 已經裝好系統服務，fleet 已經在跑了。否則：

```bash
agend fleet start
```

要讓它重開機後也活著，裝成系統服務：

```bash
agend install
```

## 送出第一則訊息

在 **General** topic（Telegram）或 General 頻道（Discord）傳一則訊息。General 會把它路由給該處理的 agent，也能為你的專案建立新的 agent。之後每個 agent 各有自己的 topic 或 thread。

ClassicBot 可以把 agent 掛到其他任何頻道。Discord 上用 `/start` 在那裡開一個 agent、`/chat <訊息>` 跟它說話、`/stop` 結束它。在 Telegram 群組裡，由 ClassicBot 管理員用 `/start@YourBot` 開啟。其他人在不在 ClassicBot 名單上的新 server、群組或私人對話開啟時，會先在 General 請你核准。

## 打開網頁儀表板

fleet 也會在 `http://localhost:19280/` 提供儀表板。裡面有和你的 bot 一樣的對話、列出所有在等你處理的事的 **等你處理** 清單，還有設定頁，可以新增 bot、agent 或 token。

登入用的是一次性登入碼，不是帶著密碼的連結。兩種方式都能拿到：

```bash
agend web          # 在這台機器上：印出登入碼並打開登入頁
agend web --code   # 只印出來
```

或在 General 傳 `/web`（fleet 管理員）。bot 會私訊給你連結和登入碼；手機連不到這台機器時，也可以選臨時公開連結。登入碼只能用一次、5 分鐘內有效。直接連到儀表板的登入預設維持 48 小時；透過公開連結的登入維持 4 小時（閒置 30 分鐘），連結關閉時也會結束。

儀表板只聽 `127.0.0.1`。要用手機開啟，以及登入期限和登出，見[網頁使用說明](/AgEnD/zh-tw/docs/web-guide/)。

如果都沒有回應，先看 fleet 的狀況：

```bash
agend health
```

## 更新

在 General 傳 `/update`（fleet 管理員），或在主機上執行：

```bash
agend update
```

它會留在你安裝的頻道（beta 就留在 beta），安裝新版、檢查它，然後重啟 fleet。從 2.1 升級，請先看[從 2.1 升級到 2.2](https://github.com/songsid/AgEnD/blob/main/docs/upgrade-2.2.zh-TW.md)。從 2.1.0–2.1.11 升級，或主機沒有 AgEnD 內建的 Node 時，請改照它的手動步驟。

在 Windows 上，桌面捷徑 **AgEnD 儀表板**（打開儀表板並帶入登入碼）和 **AgEnD 重新啟動**（先詢問再重啟）是由 Windows 安裝程式建立的。如果你是之前安裝的，再貼一次 [Windows 一行安裝指令](/AgEnD/zh-tw/install-windows/)：它會偵測到 AgEnD 已經裝好，只提供新增或更新捷徑。

## 下一步

- [網頁使用說明](/AgEnD/zh-tw/docs/web-guide/) — 登入、用手機開啟、登出
- [功能](/AgEnD/zh-tw/docs/features/) — fleet 能做什麼
- [CLI 參考](/AgEnD/zh-tw/docs/cli/) — 所有指令
- [設定](/AgEnD/zh-tw/docs/configuration/) — `fleet.yaml` 完整參考
