---
title: CLI 參考
description: 所有 agend 指令，依你想做的事分組。
---

`agend` 在跑 fleet 的那台機器上操作 fleet。這裡的東西全部是本機指令；日常工作在聊天軟體裡做。

## 服務

啟動、停止、重啟已安裝的系統服務：

```bash
agend start
agend stop
agend restart
```

更新到最新版並重啟：

```bash
agend update
```

要指定別的目標，用 `--beta`、`--version 2.1.2`，或用 `--force` 重裝你已經有的版本。

重讀 `fleet.yaml`，不重啟 fleet 程序：

```bash
agend reload
```

新增的 instance 會啟動、移除的會停止、改過設定的就地套用。

## Fleet

啟動全部 instance，或單一一個：

```bash
agend fleet start
agend fleet start <name>
```

停止同理：

```bash
agend fleet stop
agend fleet stop <name>
```

優雅重啟 — 它會先等 agent 進入 idle：

```bash
agend fleet restart
```

這會沿用正在跑的程式碼。要載入新版的 AgEnD 本身，重啟程序：

```bash
agend fleet restart --reload
```

看目前在跑什麼：

```bash
agend fleet status
```

加 `--json` 輸出機器可讀格式。

看 fleet 做過什麼 — 花費、session 輪替、卡住：

```bash
agend fleet history
```

可用 `--instance <name>`、`--type <type>`、`--since <date>`、`--limit <n>`、`--json` 縮小範圍。

改看協作與 tool call：

```bash
agend fleet activity --since 2h --limit 200
```

`--format mermaid` 會把同一份活動印成 sequence diagram。

清掉已經沒有設定指向的 instance 目錄：

```bash
agend fleet cleanup
```

想先看清單再刪，先跑 `--dry-run`。

## Instance

列出 instance，含狀態、後端、team、context 用量、最後活動時間：

```bash
agend ls
```

`--json` 給結構化輸出，`--names-only` 一行一個名字。

接進某個 instance 的 tmux window — 名字支援模糊比對，不給參數就出選單：

```bash
agend attach <name>
```

看 fleet log：

```bash
agend logs
```

`-n 100` 看更多行（預設 50）、`-f` 持續追蹤、`--instance <name>` 篩選。

把 session 匯出成單一檔案的 HTML 聊天記錄：

```bash
agend export-chat --from <date> --to <date> -o <path>
```

## 診斷

出問題先從這裡開始：

```bash
agend health
```

它會直接講找到的問題，不是只給一個狀態。

更深入的檢查：

```bash
agend doctor
agend doctor mcp
```

`doctor mcp` 會檢查 IPC、設定檔路徑、重複的 server、以及每個執行檔是否在 PATH 上。

檢查某個後端的環境 — 執行檔、登入狀態、tmux、`TERM`：

```bash
agend backend doctor claude-code
```

預先信任工作目錄，讓 CLI 自己的信任對話框不會卡住啟動：

```bash
agend backend trust claude-code
```

啟動任何東西之前先驗證設定：

```bash
agend validate
```

## Web 儀表板

開啟即時儀表板：

```bash
agend web
```

`agend view` 開唯讀版。

一次撤銷所有儀表板連結和瀏覽器 session：

```bash
agend web-token rotate
```

正在跑的 fleet 會直接生效，不用重啟。

### 還沒有 fleet 時的設定頁

```bash
agend setup
```

它在 health port 上開一個表單，並印出兩樣東西：

```
Setup page: http://127.0.0.1:19280/s/8f3c…/
Setup code: K7QM-3XRD
```

連結只是頁面的位置，不是使用權限 — 憑證是你輸入的那組 code。答錯五次頁面就關閉，重放的 session cookie 也算其中一次。頁面在你完成後、15 分鐘後、或閒置 10 分鐘後會自己關掉。

要用手機設定：

```bash
agend setup --tunnel
```

它每次都會要你確認，沒有終端機可問時直接拒絕 — 沒有任何旗標可以事先回答這題。**你輸入的 bot token 會經過 Cloudflare 的邊緣節點**，不能接受的話請在機器本機上設定。機器上沒有 `cloudflared` 時，頁面會留在 loopback 並直說。

`--tunnel` 不能跟 `--port` 併用，而且永遠不會綁 health port。你完成之後，頁面會先撤銷自己的憑證、釋放 port、關掉 tunnel，最後才啟動 AgEnD。萬一無法確認 tunnel 已關閉，AgEnD 還是會啟動，但訊息會告訴你該砍哪個 process，而且在你處理完之前不會再開新的 tunnel。

已經有 fleet 之後 `agend setup` 會拒絕執行，並指向儀表板裡的設定精靈 — 那個是就地修改 `fleet.yaml`，而這個頁面是重新寫一份檔案。`agend setup --reset` 是唯一的回頭路，而且只能在本機執行。

從網頁版 Telegram 或 Discord 點連結進來，儀表板如果說 **"No session"**，重新整理一次就好：cookie 是 `SameSite=Strict`，重新整理那次算同站。如果一直繞回同一句，去看 AgEnD 前面擋著什麼 — 代理伺服器如果送 `X-Forwarded-Proto: https` 但實際走 plain HTTP，瀏覽器就會拒絕存這個 cookie。

## 排程

看目前有哪些排程：

```bash
agend schedule list
```

新增一個 — cron 運算式、目標 instance、訊息三個都是必填：

```bash
agend schedule add --cron "0 9 * * *" --target myproject --message "daily standup"
```

`--label <text>` 給人看的名稱；`--timezone <tz>` 吃 IANA 時區（預設 `Asia/Taipei`）。

用 id 修改、啟用、停用、刪除：

```bash
agend schedule update <id> --cron "0 10 * * *"
agend schedule enable <id>
agend schedule disable <id>
agend schedule delete <id>
```

立刻執行一次，或看它上次跑的結果：

```bash
agend schedule trigger <id>
agend schedule history <id>
```

## Topic 與存取控制

把 instance 綁到聊天 topic：

```bash
agend topic bind <name> <topic-id>
agend topic unbind <name>
agend topic list
```

控制誰可以跟某個 instance 說話：

```bash
agend access list <name>
agend access lock <name>
agend access unlock <name>
agend access pair <name> <user-id>
agend access remove <name> <user-id>
```

`lock` 是只認白名單；`unlock` 重新開放配對。

## 設定與搬移

```bash
agend quickstart
```

想要每一個選項都自己決定，用完整互動精靈 `agend init`。

裝成系統服務（macOS 用 launchd、Linux 用 systemd）：

```bash
agend install
```

`--no-activate` 只寫服務檔不啟動。`agend uninstall` 移除它。

換一台機器：

```bash
agend export config.tar.gz
agend import config.tar.gz
```

`--full` 會連所有 instance 資料一起帶走，不只設定。

## Shell 補全

幫 `agend attach` 和 `agend fleet start|stop|restart` 補 instance 名稱：

```bash
agend completion install
```

bash 會寫入 `~/.local/share/bash-completion/completions/agend`，不動任何 rc 檔。zsh 則是印出該加的那行給你，因為啟用它就得改 `~/.zshrc` — 加 `--modify-rc` 可以讓它幫你寫進去。

`install.sh` 最後會自動跑這個（用 `AGEND_NO_COMPLETION=1` 跳過），`agend update` 會更新已安裝的補全檔，但不會安裝新的。

zsh 需要先初始化補全系統。如果 `~/.zshrc` 裡還沒有 `autoload -Uz compinit && compinit`，它必須放在 `agend` 那行的**上面**。

名字來自 `agend ls --names-only`，所以補全給的正好是 `attach` 接受的那些 — 包含只存在於 `classicBot.yaml` 的 ClassicBot instance。

## 聊天指令

這些在聊天軟體的 General topic 裡執行，而且只有管理員能用：

| 指令 | 作用 |
|---|---|
| `/status` | Fleet 狀態、context 用量、花費 |
| `/restart` | 就地重啟所有 instance，程序不結束 |
| `/update` | 更新 AgEnD 到最新版 |
| `/sysinfo` | 版本、負載、IPC 狀態 |
| `/pause` | 暫停某個 instance |
| `/wake` | 喚醒暫停中的 instance |

其他事情 — 建立 instance、刪除、派任務 — 直接用自然語言跟 General instance 講。

## 環境變數

| 變數 | 設定什麼 |
|---|---|
| `AGEND_BOT_TOKEN` | Telegram 或 Discord bot token。要讀別的變數名稱，在 `fleet.yaml` 用 `bot_token_env`。 |
| `GROQ_API_KEY` | 語音轉文字用的 Groq key。選用。 |
| `AGEND_TMUX_SESSION` | tmux session 名稱。預設 `agend`。 |
| `AGEND_HOME` | 資料目錄。預設 `~/.agend`。 |
