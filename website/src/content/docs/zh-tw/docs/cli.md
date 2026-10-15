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

要指定別的目標，用 `--beta`、`--alpha`、`--stable`、`--version 2.1.2`，或用 `--force` 重裝你已經有的版本。從 fleet agent 的 session 內執行時需要加 `--yes`，否則會被拒絕。

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

立即重啟指定的 instance（不等 idle — 可能中斷正在忙碌的工作）：

```bash
agend fleet restart <name>
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

接進某個 instance 的 tmux window — 接受真實名稱、`agend ls` 顯示的顯示標籤（含中文／emoji 標籤），或模糊前綴；不給參數就出選單：

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

啟動任何東西之前先驗證設定：

```bash
agend validate
```

## Web 儀表板

開啟即時儀表板並印出登入碼：

```bash
agend web
agend web --code     # 只印碼，不開瀏覽器
```

`agend view` 開唯讀版 View 面板。

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

`--tunnel` 不能跟 `--port` 併用，而且永遠不會綁 health port。你完成之後，頁面會先撤銷自己的憑證、釋放 port、關掉 tunnel，最後才啟動 AgEnD。

已經有 fleet 之後 `agend setup` 會拒絕執行，並指向儀表板裡的設定精靈。`agend setup --reset` 是唯一的回頭路，而且只能在本機執行。

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

看某個排程的執行記錄：

```bash
agend schedule history <id>
```

`agend schedule trigger <id>` 目前只會印出指引，不會執行排程。

## 設定確認

敏感設定變更（來自網頁儀表板或 Settings）會成為待確認的提案。AgEnD 會先嘗試透過 General instance 向 fleet admin 發送確認（聊天軟體裡的 Confirm/Reject 按鈕）。若沒有可用的 General instance — 例如變更跨平台、或找不到合適的 General — 則退回主機 CLI 確認：

```bash
agend settings confirm <id>        # 檢視 diff，然後確認
agend settings confirm <id> --yes  # 非互動式確認（你已看過 diff）
agend settings reject <id>
```

必須以跟 fleet 相同的使用者在主機上執行。Agent session 內不能使用這個指令。

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
agend completion status     # 檢查 <TAB> 在新 shell 裡能不能用
```

bash 會寫入 `~/.local/share/bash-completion/completions/agend`，不動任何 rc 檔。zsh 則是印出該加的那行給你，因為啟用它就得改 `~/.zshrc` — 加 `--modify-rc` 可以讓它幫你寫進去。

`install.sh` 最後會自動跑這個（用 `AGEND_NO_COMPLETION=1` 跳過），`agend update` 會更新已安裝的補全檔，但不會安裝新的。

zsh 需要先初始化補全系統。如果 `~/.zshrc` 裡還沒有 `autoload -Uz compinit && compinit`，它必須放在 `agend` 那行的**上面**。

名字來自 `agend ls --names-only`，所以補全給的正好是 `attach` 接受的那些 — 包含只存在於 `classicBot.yaml` 的 ClassicBot instance。

## 聊天指令

這些在聊天軟體裡執行。在 **Discord** 上，它們可以在任何 fleet topic 頻道使用。在 **Telegram** 上，操作整個 fleet 的指令（`/status`、`/sysinfo`、`/usage`、`/restart`、`/update`、`/doctor`、`/login`、`/web`、`/visibility`）只能在 General topic 使用；在 worker topic 下會被拒絕。完整指令清單（含各平台權限細節）請看 [commands.md](https://github.com/songsid/AgEnD/blob/main/docs/commands.md)。

| 指令 | 作用 | 權限 |
|---|---|---|
| `/status` | Fleet 表格：backend、model、context、推理強度、花費、執行狀態 | 🔒 管理員 |
| `/sysinfo` | 版本、負載、IPC 狀態、各 backend CLI 版本 | 所有人 |
| `/usage` | AI 訂閱用量（每個訂閱各一列） | 所有人 |
| `/ctx` | Agent context 用量 | 所有人 |
| `/steer <text>` | 插入當前 turn（claude-code、codex、grok、muse、kiro TUI） | 所有人 |
| `/btw <text>` | 不中斷當前任務的側邊提問（claude-code 限定） | 所有人 |
| `/compact` | 壓縮 agent context | 🔒 管理員 |
| `/clear` | 完全重置對話（要求確認） | 🔒 管理員 |
| `/model` | 切換後端模型 | 🔒 管理員 |
| `/effort` | 調整 AI 推理強度 | 🔒 管理員 |
| `/backend` | 將 instance 移至另一個 CLI 後端 | 🔒 管理員 |
| `/pause` | 暫停 instance | 🔒 管理員 |
| `/wake` | 喚醒暫停中的 instance | 🔒 管理員 |
| `/restart` | 就地重啟所有 instance | 🔒 管理員 |
| `/update` | 更新 AgEnD 到最新版 | 🔒 管理員 |
| `/doctor` | Fleet 健康診斷 | 🔒 管理員 |
| `/login [backend]` | 遠端登入 CLI（缺少時先安裝） | 🔒 管理員 |
| `/web` | 登入網頁儀表板；`/web revoke` 讓所有人登出 | 🔒 管理員 |
| `/collab` | 在 fleet topic 切換 bot/webhook 訊息接收 | 🔒 管理員 |
| `/visibility` | 跨 instance 訊息在 topic 裡的顯示方式（full/summary/hidden） | 🔒 管理員 |
| `/tips` | 抽一條隨機使用提示 | 所有人 |

其他事情 — 建立 instance、刪除、派任務 — 直接用自然語言跟 General instance 講。

## 環境變數

| 變數 | 設定什麼 |
|---|---|
| `AGEND_BOT_TOKEN` | Telegram 或 Discord bot token。要讀別的變數名稱，在 `fleet.yaml` 用 `bot_token_env`。 |
| `GROQ_API_KEY` | 語音轉文字用的 Groq key。選用。 |
| `AGEND_TMUX_SESSION` | tmux session 名稱。預設 `agend`。 |
| `AGEND_HOME` | 資料目錄。預設 `~/.agend`。 |
