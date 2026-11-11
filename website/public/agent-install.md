# 安裝並設定 AgEnD：給 AI 程式代理的步驟

> 這份文件是寫給 AI 程式代理（Claude Code、Codex 等）照著做的。使用者會對你說「請閱讀這份文件，照著幫我在這台電腦安裝並設定 AgEnD」。
> English: https://songsid.github.io/AgEnD/agent-install.en.md

你的工作：在**使用者正在用的這台電腦**上安裝 AgEnD，讓它跑起來，並讓使用者登入它的網頁儀表板。

- 照順序做。
- 用使用者的語言跟他說話。
- 每一步做完，用一兩句話告訴使用者目前進度。
- 看到 **⛔ 停下** 時，把該說的話告訴使用者，然後**結束你這一輪**，等他回覆再繼續。不要自己繞過。

AgEnD 是什麼：在這台電腦上同時管理多個 AI 程式代理（Claude Code、Codex、Kiro CLI 等），從網頁儀表板，或 Telegram／Discord 指派工作。

---

## 0. 規則（整個過程都要遵守）

1. **不碰任何 bot token、密碼或 API key。**
   - 不要詢問、讀取、複述、記錄，也不要把它們寫進任何檔案。
   - bot token 只由使用者自己輸入到 AgEnD 的設定頁。
   - 如果使用者把 token 貼到對話裡：不要使用它，提醒他這樣不安全，並建議他到 BotFather／Discord Developer Portal 重設 token。
2. **sudo 只用在安裝程式自己要求的地方。** 如果 sudo 要密碼而你無法輸入：⛔ 停下，請使用者在自己的終端機執行那一行，完成後告訴你。
3. **不要手動編輯** `~/.agend/fleet.yaml` 或 `~/.agend/.env`。設定頁會寫好它們。
4. **不要關閉或繞過任何安全設定。** 包括存取名單、登入碼、檔案權限（不要 `chmod 777`），也不要用 `--force` 重灌。
5. **不要做影響整台電腦的動作，除非使用者同意。** 例如重新開機、`wsl --shutdown`、`wsl --unregister`、刪除既有的 AgEnD 資料（`~/.agend`）。
6. **出錯時：** 把錯誤訊息原文告訴使用者，對照第 7 節「疑難排解」。找不到對應時就停下來說明，不要猜著修改系統設定。
7. **先檢查你自己是不是 AgEnD 裡的 Agent。** 在**你自己的** shell 執行 `echo "$AGEND_INSTANCE_NAME"`。
   - 有值：你就是 AgEnD 管理的 Agent，AgEnD 已經在這台電腦上跑了。只做第 5 節的驗證，**不要**安裝、停止或重新啟動 AgEnD（那會中斷你自己和其他 Agent）。
   - 沒有值：照下面的步驟做。

---

## 1. 先看這台電腦已經有什麼

macOS、Linux 或 WSL：

```bash
uname -s
agend --version
test -f ~/.agend/fleet.yaml && echo configured || echo not-configured
```

- 找不到 `agend` 指令（`command not found`）：還沒安裝。到**第 2 節**。
- 有版本，且 `configured`：已安裝並設定過。跳到**第 5 節**驗證。
- 有版本，但 `not-configured`：已安裝、還沒設定。跳到**第 4 節**。（這時 `agend ls` 可能印出一段關於 `fleet.yaml` 的錯誤，屬於正常。）

Windows（PowerShell）：如果有 `%LOCALAPPDATA%\AgEnD\install.json`，就表示 Windows 安裝程式已經跑過。到**第 3B 節**看怎麼檢查。

---

## 2. 判斷作業系統

- `uname -s` 是 `Darwin` → macOS，到**第 3A 節**。
- `uname -s` 是 `Linux`（包括 WSL）→ 先確認需求：
  ```bash
  ldd --version | head -1      # 要看到 GLIBC 或 GNU libc（Alpine 等 musl 不支援）
  ps -p 1 -o comm=             # 要是 systemd
  ```
  都符合就到**第 3A 節**；不符合就告訴使用者這台電腦不受支援，並停下。
- Windows（PowerShell 或命令提示字元，沒有 `uname`）→ 到**第 3B 節**。AgEnD 在 Windows 上跑在 WSL 2 裡，由安裝程式自動設定。

---

## 3A. macOS／Linux：安裝

### AI CLI

AgEnD 需要這台電腦上至少有一個它支援的 AI CLI：Claude Code（`claude`）、Codex（`codex`）、Kiro CLI（`kiro-cli`）、Grok（`grok`）、Muse（`muse`）、OpenCode（`opencode`）、Antigravity（`agy`）。

```bash
bash -lc 'for c in claude codex kiro-cli grok muse opencode agy; do command -v "$c"; done'
```

- 看印出來的路徑，不要看結束碼。沒有印出任何路徑才是「一個都沒有」。
- AI CLI 常裝在 `~/.local/bin` 或 nvm 的目錄。用新的登入 shell（`bash -lc`）檢查，才看得到剛裝好的。安裝程式若提醒某個目錄不在 PATH，用 `bash -lc 'command -v <指令>'` 確認；找得到就不用處理。
- 一個都沒有：⛔ **停下**，問使用者要用哪一個。他選定後，你可以用該 CLI 官方的安裝方式替他安裝（不需要帳號）。例如 Claude Code：`curl -fsSL https://claude.ai/install.sh | bash`。
- **AI CLI 的登入由使用者自己做**，不要替他輸入帳號資料。不必現在登入：第 4 節的設定頁會提供「登入」按鈕（Claude Code、Codex、Kiro CLI），也可以按「稍後登入」，之後在儀表板完成。

### 安裝 AgEnD

安裝程式會視需要裝好 Node.js（透過 nvm）與 tmux，再從 npm 安裝 `@songsid/agend`。**先下載成檔案，再用 `</dev/null` 執行**：從管線執行時，系統套件的設定問題可能吃掉安裝程式的其餘內容。

```bash
curl -fsSL https://songsid.github.io/AgEnD/install.sh -o /tmp/agend-install.sh && bash /tmp/agend-install.sh </dev/null
```

不要改成 `curl … | bash`：`</dev/null` 要接在 `bash 檔案` 後面才有效。

- 安裝 tmux 時可能需要 sudo。如果停在輸入密碼：⛔ **停下**，請使用者在自己的終端機執行上面那一行，完成後告訴你。
- 它最後會說可以執行 `agend quickstart`。**不用理會**，我們用第 4 節的設定頁。
- 這個指令可以重複執行：已安裝時它會升級或修復。

**一定要確認真的裝好了**（即使安裝程式結束碼是 0）：

```bash
bash -lc 'agend --version'
```

- 印出版本：到**第 4 節**。
- `command not found`：再執行一次上面的安裝指令。仍然沒有就把安裝輸出的最後 30 行給使用者看，並停下。

---

## 3B. Windows：安裝

Windows 安裝程式會：
- 設定 WSL 2 與 Ubuntu；
- 在 Linux 裡安裝 AI CLI 和 AgEnD；
- 最後在瀏覽器打開設定頁。

它會開**自己的視窗**問問題，所以**不要**在你自己的工具裡執行它（你的工具看不到也回答不了那些問題）。

1. 先告訴使用者：你要開一個新的安裝視窗，接下來那個視窗會問他問題，請他在那個視窗回答。然後由你開啟它（在 PowerShell 執行；它會開新視窗並立刻返回，不會卡住你的工具）：

   ```powershell
   Start-Process powershell -ArgumentList '-NoExit','-ExecutionPolicy','ByPass','-Command','irm https://songsid.github.io/AgEnD/install.ps1 | iex'
   ```

   如果這樣開不起來（例如你的工具不是在 Windows 上執行，或出現錯誤）：⛔ **停下**，請使用者自己打開 **PowerShell**（一般權限即可），貼上這一行並按 Enter：

   ```powershell
   powershell -ExecutionPolicy ByPass -c "irm https://songsid.github.io/AgEnD/install.ps1 | iex"
   ```

2. ⛔ **停下：系統管理員核准（UAC）。** Windows 會跳出「是否允許此應用程式變更你的裝置？」。請使用者自己按「是」。
3. ⛔ **停下：安裝視窗裡的問題**（例如 Linux 要裝在哪個磁碟、要用哪個 AI、AI 帳號的瀏覽器登入）。由使用者在那個視窗回答。
4. ⛔ **停下：重新開機。** 第一次啟用 WSL 時通常要重新開機。
   - 重開並登入後，安裝程式會自己繼續。
   - 沒有繼續的話，再用第 1 步的方式開一次安裝視窗（或請使用者自己貼那一行），它會從停下的地方接著做。
   - 重開後，使用者會再把同一句請求貼給你。請從**第 1 節**重新判斷，不要從頭重裝。
5. 安裝程式最後會在瀏覽器打開 AgEnD 的設定頁。設定由使用者在那一頁完成，步驟與第 4 節「開啟設定頁」的 1～7 相同：選使用方式；如果用 bot，在頁面上輸入 token。

檢查 Windows 上的安裝：讀 `%LOCALAPPDATA%\AgEnD\install.json`，裡面記著 Linux 發行版名稱（`distro`）和使用者（`user`），然後執行：

```powershell
wsl -d <distro> -u <user> -- bash -lc "agend --version && agend ls"
```

第 5 節的驗證指令都用同樣的方式在 WSL 裡執行。設定好之後，桌面上的「AgEnD 儀表板」捷徑會打開儀表板並帶上新的登入碼。

完整說明（給使用者看）：https://songsid.github.io/AgEnD/zh-tw/install-windows/

---

## 4. 設定：選擇使用方式

⛔ **停下，問使用者要怎麼使用 AgEnD：**

1. **只用網頁**（預設、最簡單）：不需要 bot，從瀏覽器的儀表板使用。
2. **Telegram**：用 Telegram 群組指揮 Agent（也可以用網頁）。
3. **Discord**：用 Discord 伺服器指揮 Agent（也可以用網頁）。

選 2 或 3：⛔ **停下：請使用者先建立 bot**，完成後告訴你。bot 只有使用者自己能建立。下面是重點步驟，請轉述給他；附圖的完整說明在連結裡。

**Telegram**（https://songsid.github.io/AgEnD/zh-tw/setup-telegram/）
1. 在 Telegram 找 @BotFather，傳 `/newbot`，取名字和以 `bot` 結尾的使用者名稱。BotFather 會給一組 token：請使用者**自己保存，不要貼給你**。
2. 對 @BotFather 傳 `/mybots` → 選這個 bot → Bot Settings → Group Privacy → Turn off。
3. 建一個私人群組，在群組設定裡打開「主題（Topics）」。
4. 把 bot 加進群組，設成管理員，至少要有「管理主題」、「傳送訊息」、「編輯訊息」權限。

**Discord**（https://songsid.github.io/AgEnD/zh-tw/setup-discord/）
1. 建一個只給 AgEnD 用的新伺服器，不要邀請別人。
2. 到 https://discord.com/developers/applications → New Application → Bot 分頁 → Reset Token。token 只會顯示一次：請使用者**自己保存，不要貼給你**。
3. 同一頁的 Privileged Gateway Intents：打開 **Message Content Intent**，按 Save Changes。
4. OAuth2 → URL Generator：勾選 `bot` 與 `applications.commands`，權限勾 Administrator。用產生的網址把 bot 邀請到剛建的伺服器。
5. Discord「使用者設定 → 進階」打開開發者模式。之後對要給 General 用的文字頻道按右鍵 → 複製頻道 ID。設定時會用到。

### 開啟設定頁

macOS／Linux：用你工具的**背景執行**啟動它（它會一直跑到設定完成，最多 15 分鐘）：

```bash
agend setup
```

它會印出：

```
  Setup page: http://127.0.0.1:19280/s/<一串隨機字元>/
  Setup code: XXXX-XXXX
```

網址裡的隨機字元每次都不同。把網址和設定碼都告訴使用者。設定碼是一次性的憑證：不要寫進檔案。

⛔ **停下，請使用者在這台電腦的瀏覽器照著做，並且在頁面說 AgEnD 正在啟動之前不要關掉分頁：**

1. 打開 Setup page，輸入 Setup code，按「繼續」。
2. 「登入你的 AI 後端」：按「登入」在頁面上登入，或按「稍後登入」。
3. 「Agent」：後端選要用的 AI；工作目錄可以留空（留空時 AgEnD 會替它建一個自己的資料夾）；名稱可用預設。
4. 「平台」：選「只用網頁（不接 bot）」、Telegram 或 Discord。用 bot 時，**把 token 貼在頁面的「Bot token」欄位**（不是貼給你），並照頁面指示完成（Telegram：到群組傳 `/start`；Discord：確認帳號並填頻道 ID）。
5. 按「顯示將寫入的內容」看一下，再按「建立並啟動 AgEnD」。
6. 頁面可能會說「請在執行 AgEnD 的電腦上核准」，並顯示一行 `agend settings confirm <編號>`。請使用者把那個編號告訴你，然後到下面的「核准設定」。
7. 核准之後，頁面的按鈕會變成「**啟動 AgEnD**」（旁邊寫「設定已確認。請按「啟動 AgEnD」完成設定」）。按下它，等頁面說 AgEnD 正在啟動。

### 核准設定

使用者給你編號後：

```bash
agend settings confirm <編號>
```

- 不加 `--yes` 時，它會印出**將套用的變更**，然後說需要確認（結束碼 1，這是正常的）。
- 把這些變更轉述給使用者。⛔ **停下，確認這就是他在頁面上選的**（例如使用方式、Agent 名稱、工作目錄；後端不一定會列出，可以請他在頁面上看一眼）。
- 他同意後才執行：
  ```bash
  agend settings confirm <編號> --yes
  ```
  應該印出 `Change applied.`。只核准使用者剛才在頁面上做的設定；來源不明的編號不要核准。

核准後，⛔ **請使用者回到仍開著的設定頁，按「啟動 AgEnD」**（上面第 7 步）。頁面會說 AgEnD 正在啟動，背景的 `agend setup` 印出 `Setup complete — starting AgEnD.` 並結束。到**第 5 節**。

### 設定頁出了狀況

- **分頁被關掉、設定碼不能再用**（頁面說代碼不正確）：設定碼只能用一次。
  1. 停掉還在背景跑的 `agend setup`（停止那個背景工作；若還在，`cat ~/.agend/fleet.lock` 會看到 `"role":"setup-host"` 和它的 `pid`，對那個 pid 送 `kill`）。
  2. 再執行一次 `agend setup`，把新的網址和設定碼給使用者。
- **再執行 `agend setup` 時說 `This installation already has agents configured`**：設定已經寫好了（例如核准後、還沒按「啟動 AgEnD」就關掉分頁）。停掉殘留的 `agend setup`（同上），執行 `agend start`，到**第 5 節**。
- **說 `Setup has already been completed`**：之前設定完成過。到**第 5 節**，不要用 `--reset` 重設，除非使用者明確要求。
- **核准了、但還沒按「啟動 AgEnD」分頁就關了**：設定已經寫好。停掉殘留的 `agend setup`（同上；它在 `ps` 裡可能顯示成 `node …/agend.cjs setup`），執行 `agend start`，到**第 5 節**。
- **頁面 15 分鐘後或錯誤太多次會自動關閉**：再執行一次 `agend setup`。

（使用者偏好在終端機設定的話，可以請他在**自己的終端機視窗**執行 `agend quickstart`，照提示回答。它是互動式的，你的工具無法代為回答。）

---

## 5. 驗證

```bash
agend ls        # 應列出 Agent（例如 agent-1 或你設定的名稱）
agend health    # AgEnD 是否在執行、各 Agent 的狀態
agend web --code
```

- `agend health` 說 AgEnD 沒在執行（`not running`）：執行 `agend start`，等幾秒再看。
- AI 還沒登入時，Agent 可能顯示 **Idle** 或 **Paused**（例如它啟動時停在登入畫面）。這都是正常的；AI 帳號登入後，若是 Paused 就喚醒它（見下面）。

`agend web --code` 會印出：

```
Sign-in page: http://localhost:19280/signin
Code:         ABCD-EFGH   (works once, valid ~5 min)
```

⛔ **停下：請使用者在這台電腦的瀏覽器打開 Sign-in page，輸入 Code。**
- 這組碼只能用一次，約 5 分鐘內有效。過期就再執行一次 `agend web --code`。
- 可以把碼轉告使用者，但不要寫進檔案。

使用者看到儀表板，就完成了。
- **AI 還沒登入的話**，儀表板的「等你處理」會列出來。請他在儀表板的「設定 → Agent」裡連接 AI 帳號（較新版本稱為「AI 帳號 → 連接帳號」，較舊版本稱為「登入」），或在自己的終端機執行一次那個 AI CLI（例如 `claude`）登入。登入後，在儀表板該 Agent 的選單按「喚醒」，或執行 `agend fleet start <Agent 名稱>`。
- **用 bot 的話**，請他在 Telegram 群組的 General 主題（或 Discord 的 General 頻道）傳一則訊息，確認 bot 有回應。

### 讓 AgEnD 開機（登入）後自動執行

設定頁啟動的 AgEnD 是一般背景程式，電腦重開後不會自己回來。⛔ **停下，問使用者要不要開機後自動執行**，並告訴他：設定時 AgEnD 會先停一下再以服務重新啟動，正在工作的 Agent 會被中斷一次。 要的話（macOS，或有 systemd 的 Linux）：

```bash
agend stop
agend install
agend ls
```

- `agend install` 會安裝並啟動使用者層級的服務（Linux：systemd user service `com.agend.fleet`；macOS：launchd）。應該印出服務已安裝並在執行。
- 之後 Agent 若顯示 Paused，通常是 AI 還沒登入（見上面）。
- 在 WSL 上若出現 `Failed to connect to bus`，見第 7 節。

### 最後告訴使用者

- 儀表板網址：`http://localhost:19280/`。以後要登入，就在這台電腦執行 `agend web --code`（Windows 用桌面的「AgEnD 儀表板」捷徑）。
- 更新 AgEnD：執行 `agend update`。有 Telegram／Discord 的話，也可以在 General 傳 `/update`；較新版本的儀表板有新版時也會出現「立即更新」。

---

## 6. 不要做的事（再提醒一次）

- 不要讀取、印出或寫入 token、`~/.agend/.env`、`~/.agend/web.token`。
- 不要手動改 `fleet.yaml`，不要關掉存取名單。
- 不要對已經在跑的 AgEnD 執行 `agend stop`、`agend restart`、`agend uninstall`，除非使用者要求，或第 5 節「開機後自動執行」需要。
- 你是 AgEnD 管理的 Agent（你自己的 `AGEND_INSTANCE_NAME` 有值）時，不要停止或重啟 AgEnD。

---

## 7. 疑難排解

| 狀況 | 怎麼處理 |
|---|---|
| 安裝程式結束碼 0，但找不到 `agend` | 再執行一次第 3A 節的安裝指令（下載成檔案、`</dev/null`）。仍然沒有就把安裝輸出的最後 30 行給使用者。 |
| 安裝後找不到剛裝的指令（`agend`、`claude`…） | 用新的登入 shell：`bash -lc '…'`，或 `source ~/.profile`。 |
| Node.js 版本不符或裝不起來 | 照安裝程式印出的訊息處理。需要 Node.js `^22.14.0 \|\| ^23.6.0 \|\| >=24`。可以再執行一次安裝程式，它會用 nvm 安裝。 |
| tmux 裝不起來（`sudo is not available`） | ⛔ 停下，請使用者自行安裝 tmux（例如 `sudo apt install tmux`、`brew install tmux`），再執行一次安裝程式。 |
| `agend web --code`：`Web token not found. Is the fleet running?` | AgEnD 沒在執行。執行 `agend start`，等幾秒再試。 |
| Agent 一直是 Paused | 通常是 AI 還沒登入（見第 5 節）。登入後喚醒它：`agend fleet start <Agent 名稱>`，或在儀表板按「喚醒」。 |
| WSL 上 `agend install` 或啟動服務時出現 `Failed to connect to bus` | WSL 的 systemd 使用者匯流排沒起來（#3630）。⛔ 停下，請使用者在 Windows 的 PowerShell 執行 `wsl --update`，然後關掉並重新打開 WSL 終端機，再試 `agend install`。仍失敗就把完整訊息給使用者，並附上 https://github.com/songsid/AgEnD/issues/3630 。重新啟動 WSL 或 user manager 會中斷 WSL 裡正在跑的所有程式，一定要先問使用者。 |
| Windows：公司網路擋下下載（`*.github.io`） | 改用：`powershell -ExecutionPolicy ByPass -c "irm https://raw.githubusercontent.com/songsid/AgEnD/installer-live/website/public/install.ps1 \| iex"`。 |
| 其他 | 執行 `agend doctor`，把輸出給使用者。說明文件：https://songsid.github.io/AgEnD/zh-tw/docs/getting-started/ |
