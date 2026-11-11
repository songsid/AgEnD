# 已配對的 Windows Runtime：連接電腦與一行安裝

這一頁說明如何把另一台 Windows 電腦接上你的 AgEnD，以及 **Windows（PowerShell）一行安裝**。完整的英文說明（網路連線、Tailscale Serve、SSH 轉發、清單與模型、斷線復原、憑證輪換）在 [Paired Windows runtimes](remote-runtime.md)。

## 連接電腦

1. 在 **設定 → Runtime** 開啟 **允許其他 Windows 電腦配對**（`fleet.yaml` 的 `runtimes.remote_runtime: true`，預設關閉）。開啟時需要 Fleet 管理員確認，不必重新啟動。這台電腦仍是你的 Fleet；另一台電腦只執行一個小 runner。
2. 按 **連接電腦**，在步驟 1 確認 **AgEnD 位址**：必須是另一台電腦連得到的位址。遠端位址必須是 HTTPS；只有 `localhost` 這類本機位址可用 HTTP（例如 SSH 轉發）。
3. 在位址下方的分頁選擇安裝方式：
   - **Windows（PowerShell）**：複製**一次性安裝指令**（內含頁面上顯示的腳本 SHA-256，先檢查、相符才執行，並帶著一個短效、只能用一次的 token），在**任何一台** Windows 電腦的 PowerShell 貼上，或交給在那台電腦上執行的 AI agent。它會安裝 Runtime 並直接連線：不用配對碼，也不用另外核准。token 是什麼、允許什麼，請見[一次性安裝指令](#一次性安裝指令不用配對碼不限電腦ai-agent-也能用)。配對碼放在**手動選項**裡。
   - **其他安裝方式（ZIP）**：下載 ZIP、傳到另一台電腦並解壓縮，雙擊 `connect-agend.bat`。這個流程維持原樣。
4. 在已安裝並登入各 CLI 的 Windows 使用者底下執行。兩種方式都需要 Windows 上的 Node.js。
5. 用**一次性安裝指令**時，不用輸入任何東西，也不用核准：電腦加入後會出現在「已連接的電腦」，並有通知。用 ZIP，或「手動選項」裡的配對碼做法時，第一次連線要輸入頁面上的**一次性配對碼**，比對 Runtime 視窗與頁面上的**配對指紋**，再在 AgEnD 核准這台電腦（會跳出核准對話框，見[核准要求配對的電腦](#核准要求配對的電腦)）。配對碼只在終端機輸入，不會出現在任何指令裡。產生配對碼、產生安裝指令和核准電腦，都需要直接連到的儀表板上的管理員 session（cookie 與 CSRF），也就是頁面上的「連接電腦」和「核准電腦」按鈕；只帶 `X-Agend-Token` 標頭的請求會被拒絕（#3327，見[威脅模型](SECURITY.zh-TW.md#威脅模型)）。

## 核准要求配對的電腦

有電腦要求配對時（ZIP，或「手動選項」裡的配對碼），**設定 → Runtime** 會在要求出現後約五秒內自己跳出核准對話框：電腦名稱、主機名稱、平台、要求時間，以及**大字顯示的配對指紋**，請和那台電腦終端機上的指紋比對。它是卡片上「核准」的捷徑，決定本身沒有放寬：

- **核准**會帶著指紋送出，對話框出現後的前一秒保持停用，所以已經在路上的點擊不會落在它上面；焦點不會落在任何按鈕上，所以按 Enter 不會核准。沒有指紋時一律停用。
- **拒絕**會丟掉這個要求，不再多問一次。它只對**仍在等待**的電腦有效：如果那台電腦剛被核准（在另一個分頁，或被另一位管理員），伺服器回 409，不會撤銷任何東西，頁面會說「已經被處理」並重新讀取清單。被拒絕的電腦不會留下「已撤銷」的卡片。
- **稍後**、Esc、點背景和 × 都只是關掉對話框。按過稍後的電腦**不會再自動跳出**，就算之後又有別台電腦出現也一樣（新出現的那台會單獨跳出）。它仍在電腦清單上方的提示條（「有 N 台電腦等待核准」，按「檢視並核准」會捲到第一台並打開對話框）和自己的卡片上。等待核准的電腦排在清單最前面，由舊到新。
- 同時有好幾台在等時，一次顯示一台（「第 1 台，共 2 台」）；對話框開著時才出現的電腦會加進它的清單。對話框不會蓋在其他已開啟的對話框上（重新命名、診斷、確認視窗），會等它關掉再跳。
- 要求在配對碼到期時一起到期（配對碼產生後十分鐘；Runtime 也在那時停止等待）。已過期的要求不會跳出對話框，也不計入「等待核准」：它的卡片會說明要在那台電腦重新執行連線指令，沒有「核准」，按「拒絕」可以清掉。
- 同名的電腦會標示 **#1**、**#2**（依要求時間）、配對或要求的時間和識別碼前 8 碼，並提示可以重新命名；如果已有同名的已配對電腦，對話框也會說明，這就是同一台電腦配對兩次的樣子。電腦的名稱和主機名稱一律當成文字顯示，不會被當成標記。

用一次性安裝指令加入的電腦不會經過等待，所以不會跳出這個對話框：它會改成顯示**有新電腦透過安裝指令加入**的通知，那是頁面上的一則通知（附**撤銷**和**關閉通知**），不是第二個彈出視窗。只有「設定 → Runtime」這一頁會跳出對話框。

## 一行安裝（Windows PowerShell）

頁面會帶入你確認過的位址。在另一台 Windows 電腦的 PowerShell 貼上這一行指令；不需要系統管理員權限。

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; $agend = 'https://your-agend-host'; $s = $null; $h = $null; $s = (iwr "$agend/runtime/install.ps1" -UseBasicParsing).Content; $h = (-join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($s)) | % { $_.ToString('x2') })); if ($s -and $h -eq '<頁面上顯示的 SHA-256>') { iex $s } else { Write-Host 'install.ps1 could not be verified against the hash on the AgEnD page (a certificate or download error above is the usual cause: trust this AgEnD certificate, or use the ZIP; otherwise reload the page and copy the command again)' -ForegroundColor Red; throw 'install.ps1 was not run' }
```

頁面會填入你的位址、`install.ps1` 的 SHA-256，**以及**一個一次性 token 和你這台 AgEnD 的伺服器指紋（上面的指令實際顯示為 `$agendEnroll = '…'; $agendFingerprint = '…'; try { … } finally { … }`；token 的部分見下一節）。指令先下載腳本、計算收到的位元組的雜湊，與頁面上的雜湊比對，**相符才執行**。腳本接著安裝 Runtime，並**在同一個視窗**直接連線那台電腦。不需要再打第二個指令。

安裝完之後會怎麼做，取決於指令有沒有帶 token，以及在哪裡執行：

| 執行的地方 | 腳本的行為 |
|---|---|
| 任何視窗，只要指令帶有一次性 token（頁面預設的指令）而且沒有設定 `$agendNoConnect` | 連線，**不用配對碼，也沒有核准步驟**，不論視窗是不是互動式（AI agent、CI、被管線串接、`powershell -NonInteractive` 都可以）。它執行 Runtime 自己的 `connect --connection-dir … --enroll-stdin --server-fingerprint …`，token 走 Runtime 的**標準輸入**。見下一節。 |
| 互動式主控台（沒有 token 時，也就是配對碼這條路：指令裡沒有 `$agendEnroll`）（stdin 與 stdout 都是主控台，不是 `-NonInteractive`，也不是 PowerShell ISE，也沒有設定常見的 CI 環境變數 `CI`、`GITHUB_ACTIONS`、`TF_BUILD`、`BUILD_BUILDID`、`JENKINS_URL`、`GITLAB_CI`、`CIRCLECI`、`BUILDKITE`、`TEAMCITY_VERSION`（空值、`0`、`false`、`no`、`off` 不算）），而且沒有設定 `$agendNoConnect` | 在那個視窗接著連線。它執行 Runtime 自己的 `connect --connection-dir`，邏輯與 ZIP 的 `connect-agend.bat` 相同：**新的 profile** 會要求輸入配對碼、顯示指紋、等待你核准，之後在前景執行；**已配對到這台 AgEnD** 的 profile 直接重連，不再要求配對碼；已配對到**另一台 AgEnD** 的電腦會另開獨立的 profile，原本的配對不受影響。 |
| 其他沒有 token 的情況：AI agent、CI、被管線串接、`powershell -NonInteractive`、輸入或輸出被導向；或 `$agendNoConnect = 1`（不論有沒有 token） | 只安裝。印出下一步要執行的確切指令（`agend-runtime connect --server "…"`），說明配對碼要由人在互動終端機輸入，結束時 exit code 為 0。 |

**配對碼**只能在互動式終端機輸入，不接受指令參數、環境變數或檔案，所以腳本無法代為傳遞，也看不到它；配對碼這條路的指紋比對與 AgEnD 的核准都沒有改變。**一次性 token** 是另一條有時效的授權，有自己的規則（下一節），不是把配對碼放進參數。`$agend` 只當成伺服器位址使用，沿用原本的來源檢查（HTTPS，或僅限本機的 HTTP；不得含帳密、路徑、查詢或片段）。

**給 AI agent 或腳本使用**：請給它**一次性安裝指令**：它會在任何視窗自己連線，不用輸入任何東西；以 `powershell -Command "<指令>"` 執行時，安裝或連線失敗會讓 exit status 為 1（否則為 0），`$LASTEXITCODE` 則是 Runtime 自己的狀態碼。（Runtime 一連上就會移到背景，指令隨即結束，所以 agent 不會被拖住，也不用把它當成獨立程序啟動；見〈在背景執行〉。）頁面上預設收合的「手動選項」列出配對碼這條路的兩行。第一行只安裝（它只對那一次指令設定 `$agendNoConnect = 1`，結束後會清掉，免得變數留在視窗裡，讓之後的貼上悄悄變成只安裝）；第二行用配對碼連線，必須由人在互動終端機執行：

```powershell
$agendNoConnect = 1; <同一個安裝指令>; $agendNoConnect = $null
agend-runtime connect --server "https://your-agend-host"
```

**重新連線。** 安裝程式會在 Runtime 旁邊留下這台 AgEnD 的重連入口 `%LOCALAPPDATA%\agend-runtime\connect\<host>-<port>-<hash>\`，裡面有 `agend-server.json`（只放公開的伺服器位址，不含任何憑證或配對碼）和與 ZIP 相同的 `connect-agend.bat`，並印出位置。雙擊即可重新連線；已存的 profile 不會再要求配對碼。每台 AgEnD 各有自己的資料夾，同一台電腦連到兩台 AgEnD 時不會互相覆蓋。批次檔會呼叫 `agend-runtime.cmd connect --connection-dir <自己所在的資料夾>`（所以會經 `current.txt` 啟動最新安裝的 Runtime）。`--connection-dir DIRECTORY` 讓 Runtime 從 `DIRECTORY\agend-server.json` 讀取位址，並照 ZIP 的 `connect-agend.bat` 的規則選 profile（尚未配對或已配對到這台 AgEnD 時用預設 profile，否則用獨立的 `profiles\<host>-<port>`）；可搭配 `connect`、`run`、`status`、`rotate`、`disconnect`，不能與 `--server` 同時使用。若安裝資料夾名稱含 `%` 或 `^`（批次檔的 `call` 會誤讀），就不寫入入口，腳本改為印出連線指令。修復模式（`AGEND_RUNTIME_REPAIR=1`，更新流程使用）不寫入入口，也不會連線。

### 一次性安裝指令（不用配對碼、不限電腦、AI agent 也能用）

**為什麼。** 指令是從你已經登入的頁面來的，所以可以直接帶著授權。它在**任何**連得到這台 AgEnD 位址的電腦都能用，不限瀏覽器所在的那台（在 A 電腦複製，到 B 電腦貼上，或交給 B 電腦上的 AI CLI 執行），不用配對碼，也不用再按一次核准。做法和 GitHub Actions 的 `config.sh --token`、Tailscale auth key、`kubeadm join --token` 一樣。

**token 是什麼。**

- 256 位元隨機值（`agend_enroll_` 加 43 個 URL-safe 字元）。伺服器**只存它的 SHA-256**；token 只在頁面顯示一次，只存在頁面記憶體（不寫進儲存空間或檔案，重新整理後就消失）。
- **15 分鐘有效、只能用一次。** 產生新指令會讓之前所有未使用的 token 失效；「撤銷並關閉」和「重新產生」會立刻讓它失效。用過、過期、被撤銷的 token 會各自得到明確的錯誤。
- 由同一批人、經由同一道檢查產生，和配對碼完全一樣：登入這台 AgEnD 儀表板的管理員（它的 session 和 CSRF：頁面自己的按鈕）。只帶 `X-Agend-Token` 標頭的請求、公開閘道連結、外來的 Origin、guest 或唯讀 session 都會被拒絕（#3327），不論是產生還是撤銷 token。本來無法建立配對碼並核准的人，不會因此多得到任何權限。
- 綁定這台 AgEnD 的身分：AgEnD 資料夾裡的一把 Ed25519 金鑰（`runtime-server-identity.json`，私有，第一次使用時建立）。指令帶著它的 SHA-256 **伺服器指紋**。
- 發出、使用、撤銷、被取代都會留下紀錄：寫進機器日誌（有上限）和 AgEnD 的 log，內容有 token 的 id、不透明的操作者代號，以及使用時那台電腦的 id；**對已知 token 的失敗嘗試**（含原因）也會留下。使用或失敗的來源位址只保留**遮罩過的版本**（`203.0.x.x`，IPv6 則是把八組寫完整後只留前兩組，例如 `fe80:0:x:x`；loopback 不記，因為本機 proxy 後面的所有 client 都是它）。不指向任何已知 token 的請求不會逐筆列出：這類 bucket 開始拒絕時，每個 bucket 每分鐘只寫**一筆限流彙總**。不含 token、雜湊或完整位址。
- **有電腦加入時會主動通知擁有者。** token 本身就核准了電腦，沒有人站在核准按鈕前。有電腦加入時，AgEnD 會走現有的通知管道（General topic、主要聊天頻道，或純網頁 fleet 的網頁通知）發一則訊息，寫明電腦名稱、主機名稱、token id 與撤銷方法（設定 → Runtime → 那台電腦 → 撤銷連線）。電腦的名稱和主機名稱是那台電腦自己說的，所以放進訊息前會先限縮成單純字元和較短的長度，放在引號裡，每個句點換成間隔點（避免長得像網域的名稱被聊天軟體變成連結）。**不做 quarantine**：電腦一加入就能用，這正是一行安裝的目的。

**指令執行時會發生什麼。** `install.ps1` 仍是被頁面雜湊固定的同一份位元組。它讀取 `$agendEnroll` 和 `$agendFingerprint`，立刻從視窗清掉，並在安裝任何東西**之前**檢查格式（格式錯誤的 token 會停下並顯示訊息，exit code 為 1），再把 token 用 Runtime 的**標準輸入**交給它：絕不放在命令列參數（會出現在程序清單）、環境變數或檔案；`agend-server.json` 和 `connect-agend.bat` 仍然只有公開位址。指令的 `try … finally` 即使在頁面的雜湊檢查拒絕執行腳本時，也會再清一次這兩個變數。Runtime 接著：

1. **先證明伺服器、並先和它協商金鑰。** 它帶一個全新的 nonce 和 token 的非秘密 id（SHA-256 的前 64 位元，只是讓 AgEnD 能把這個 token 自己的流量和其他人的流量分開限流）呼叫 `POST /runtime/v1/enroll-hello`。伺服器為這一次請求做一把**全新的 X25519 金鑰**，私鑰只放在記憶體兩分鐘，回傳這把公鑰和**用註冊金鑰對 nonce 與這把新公鑰做的 Ed25519 簽名**。Runtime 要求註冊金鑰的雜湊等於指令裡的指紋、簽名驗證通過。無法簽名的伺服器（被重複使用的位址、接錯網路、根本不是 AgEnD）會在這裡失敗，**這時沒有任何秘密離開那台電腦**，Runtime 會停下並說明。
2. **用掉 token（加密送出）。** Runtime 做自己的 X25519 金鑰，用 X25519 與 HKDF-SHA256 導出兩把金鑰（每個方向一把，綁定 nonce、token id 與雙方的新公鑰），再呼叫 `POST /runtime/v1/enroll`，請求內容（token、指紋、名稱、主機）以 **AES-256-GCM 加密**；只有持有那把新私鑰的一方讀得到。電腦一建立就已核准（token 就是核准），機器憑證**用另一個方向的金鑰加密**回傳；Runtime 先解開並檢查，才存任何東西。`enroll` 一呼叫，那把新金鑰就用掉了，不論結果如何，所以請求無法重送。機器憑證的保存方式和配對完全一樣。（全部用 Node 內建的 `crypto`，沒有新增依賴。）
3. **已經連到這台 AgEnD 的 profile 只會重連**，不消耗 token（它會維持有效直到過期；不需要的話可在頁面撤銷）。已經連到**另一台** AgEnD 的 profile 會另開獨立的 profile，做法與 `connect-agend.bat` 相同，原本的配對不受影響。

**頁面上會看到什麼。** 倒數時間，以及「重新產生」和「撤銷並關閉」；有電腦加入時，卡片會說明並寫出它的名稱。Runtime 頁面上會留著「有新電腦透過安裝指令加入」的通知（有「撤銷」和「關閉通知」），直到被關閉，所以沒人盯著時加入的電腦不會被漏掉；它的卡片標示為「以安裝指令加入」。撤銷那台電腦會立刻中斷它的連線。

**錯誤訊息。** 每一種都說明發生什麼事和下一步（開啟 設定 → Runtime → 連接電腦，產生新的安裝指令再執行一次），exit code 不為 0，也不會印出 token：

| 情況 | 訊息開頭 |
|---|---|
| token 格式錯誤或不完整 | 「…one-time token… is not valid…」（在安裝任何東西之前） |
| token 不存在 | 同上（不會和格式錯誤區分） |
| 過期 | 「…one-time token has expired (it lasts 15 minutes)…」 |
| 已使用 | 「…already used; each token works once…」 |
| 已撤銷，或被較新的指令取代 | 「…was revoked in AgEnD…」 |
| 不同的 AgEnD（指紋不符） | 「…did not prove it is the AgEnD this install command was made for… The one-time token was NOT sent…」 |
| 電腦數量達上限 | 「…reached its limit of connected computers…」 |

**安全分析（給擁有者判斷）。**

- *權限邊界不變。* 能打開 **設定 → Runtime** 的人，本來就看得到配對碼、也能核准待處理的電腦；同一個頁面發出的 token 不會多給任何權限。
- *真正新增的風險是指令外洩。* 指令可能留在聊天紀錄、AI 對話紀錄、截圖、PowerShell 的 PSReadLine 歷史（`ConsoleHost_history.txt`）或 CI log 裡。拿到的人只要在它**有效且未使用時**，就能把**他自己的電腦**註冊成你的 Runtime，之後 AgEnD 派的工作（程式碼、提示詞、Agent 可用的 repo 憑證）就會送到那台電腦。緩解措施：15 分鐘、只能用一次、被下一個指令取代、可撤銷、只存雜湊、token 絕不出現在參數、環境變數或檔案、電腦加入後頁面會通知並可一鍵撤銷，且每次使用都有稽核紀錄。剩下的風險是「產生指令到使用或撤銷」之間的空窗：**請把指令當成密碼**，不要貼到聊天或工單，看到不認識的電腦就撤銷。把它貼進 AI agent 的對話，就會留在那段對話的歷史裡；這是讓 agent 代為執行的代價。
- *用過的 token 無法重送*，請求也無法重送（它的新金鑰已用掉）。無法證明自己是被釘選的 AgEnD 的伺服器收不到 token。而且**夾在中間的伺服器讀不到它**：占用同一位址、又有自己合法憑證的伺服器，可以把 `enroll-hello` 轉給真的 AgEnD、拿到有效的證明，但後面的 token 與憑證是加密給只有真 AgEnD 持有的金鑰，中繼端只看得到密文。它可以丟棄或延遲這次交換（Runtime 會停下並說明，token 不會被用掉），但既讀不到也改不了：任何一個方向改一個位元組，AES-GCM 檢查都會失敗。（以真的中繼端夾在真的 Runtime client 與真的 coordinator 之間做了測試。）
- *不在保護範圍內：* 執行指令的那台電腦上的 script block logging 或工作階段紀錄會記下貼上的文字；拿到指令的人或工具當然能使用它（這正是它的用途）。**如果指令是透過外層的 `powershell -Command "<指令>"` 執行**（AI agent 或 CI 常這樣做），指令文字（含 token）會出現在**外層** PowerShell 的命令列：在程序清單、Windows 的程序建立事件（4688，若有開命令列稽核）和 script-block 日誌（4104）裡，直到 token 被用掉或過期。Runtime 自己的命令列不會有 token。已被撤銷的 profile 必須先 `agend-runtime disconnect`，新的指令才能再加入。如果交換在 AgEnD 已經用掉 token、答案卻還沒送達時中斷，會留下一台已核准、卻沒有人持有憑證的電腦：請在頁面撤銷它。
- *配對碼這條路不變：* 配對碼只能在互動式終端機輸入；token 是另一條有時效的授權，不是把配對碼放進參數。

### 為什麼指令要固定腳本的雜湊

腳本與 Runtime 壓縮檔來自同一台伺服器、同一條 TLS 連線，所以寫在腳本裡的雜湊只能證明「壓縮檔和腳本相符」，**防不了被改過的腳本**，而那才是執行下載腳本真正的風險。管理員正在看的這個頁面才是信任起點：腳本的 SHA-256 顯示在頁面上、放進指令，並且在**腳本的任何內容執行之前**就先檢查。因此，執行內容的完整性不依賴對 TLS 連線的信任決定。腳本接著再用寫在它裡面的雜湊檢查壓縮檔（第二道、獨立的檢查）。

- 頁面上的雜湊，是已登入的本機管理員向 AgEnD 讀取的，不是從腳本自己的回應取得。伺服器把腳本只組一次、以位元組保存，之後每次都送出完全相同的位元組（不改換行、不壓縮、不依請求而變），所以頁面上的雜湊就是實際送出內容的雜湊。傳輸中被改過的腳本、被轉換的換行、多出的位元組順序標記、或另一台伺服器的腳本，都會過不了檢查。過期的頁面也一樣：AgEnD 更新後，請重新整理頁面再複製指令。
- **任何失敗都不會走到 `iex`。** 在 PowerShell 裡，失敗的 .NET 方法呼叫只是「該敘述終止」：那一句被略過，下一句照跑。所以寫成 `if (<雜湊檢查>) { throw }; iex $s` 的檢查，在雜湊算不出來時（例如受限語言模式下 `[Security.Cryptography.SHA256]::Create()` 被拒絕）會直接執行未驗證的腳本。因此指令是反過來寫的：先清空 `$s` 與 `$h`，雜湊在獨立的一句算進 `$h`，條件只有 `$s -and $h -eq '<雜湊>'`（裡面沒有會丟例外的東西），而 `iex` 只放在條件通過的分支裡。不論哪一步失敗（下載、雜湊、TLS 那一句），`$h` 都會維持空值，條件為假，走到另一個分支：說明原因並 throw，永遠不會到 `iex`。第一句只是替這個 PowerShell 工作階段加上 TLS 1.2（Windows PowerShell 5.1 預設可能沒有）；它失敗時，檢查所依賴的東西都沒有改變，檢查照樣拒絕。（訊息先用 `Write-Host` 印出再 `throw`，因為使用者自己設的 `$ErrorActionPreference = 'SilentlyContinue'` 會吞掉單獨的 `throw`。）這個形狀和 `if (-not $s -or <雜湊> -ne …) { throw }; iex $s` 不同，後者會 fail-open，這是唯一的差異原因。
- 若頁面拿不到雜湊（例如這台 AgEnD 沒有建置 Runtime 檔案），就**完全不顯示安裝指令**並指向 ZIP；沒有未固定雜湊的備援做法。
- **若 PowerShell 顯示憑證錯誤**（例如自簽憑證：Windows PowerShell 5.1 會拒絕），請讓那台電腦信任這台 AgEnD 伺服器的憑證、改用受信任的 HTTPS 位址（例如 Tailscale Serve），或改用 ZIP。**絕對不要以任何開關、回呼或政策關閉憑證驗證**：本文件不會這樣建議，指令也不會這樣做。雜湊檢查不能取代 TLS，它只是讓腳本的完整性不必依賴對連線的信任。
- 位址**只**取自 `$agend`，也就是你在步驟 1 確認的、審核過的 remote runtime 位址。腳本不會從其他地方取得位址：不看送出它的 `Host` 標頭、不看轉址、不看網路。含帳密、路徑、查詢、片段或引號的位址不會產生指令；純 `http` 只接受 `localhost`（SSH 轉發）。
- 在**受限語言模式（Constrained Language Mode）或 AppLocker** 下，指令會**停下來、什麼都不執行**：那裡算不出雜湊，所以腳本不會被信任。請改用 ZIP。對字串執行 `iex` 不受執行原則限制，而且指令不會變更你的執行原則（電腦、使用者或處理序）。

### 安裝腳本做什麼

1. 檢查 Node.js 是否為 22.14 以上（22.14+、23.6+ 或 24+）。沒有時會停下來，只提示 `winget install OpenJS.NodeJS.LTS` 或 nodejs.org，**不會替你安裝軟體**。
2. 從 `$agend` 下載 Runtime 壓縮檔（單次、有上限、不跟隨轉址，最大 16 MiB）。
3. 自己計算壓縮檔的 SHA-256，與**寫在安裝腳本裡**的校驗碼比對；不符就在解壓縮之前停止。
4. 解壓縮到 `%LOCALAPPDATA%\agend-runtime\<版本>+<build>`，放在既有版本**旁邊**。`<build>` 是壓縮檔 SHA-256 的前 8 個字元，因為同一個版本號可能對應不只一個 build。
5. 讓 `agend-runtime` 指向它（見下），並把 `%LOCALAPPDATA%\agend-runtime\bin` 加進**你的使用者 PATH**。
6. 寫入重連入口（見上），然後在同一個視窗連線：帶有一次性 token 時任何視窗都會連線，沒有 token 時只在互動式主控台連線；設定了 `$agendNoConnect` 則絕不連線（此時 token 會被回報為未使用）。否則印出連線指令。Runtime 是在安裝鎖**釋放之後**才啟動，因為執行中的 Runtime 會取這個鎖來更新自己。

**版本並存。** 既有的資料夾永遠不會被刪除或取代，因為它可能就是正在執行的 Runtime（執行中的 Windows 程式會鎖住它的檔案）。安裝資料夾叫 `<版本>+<build>`，所以較新 AgEnD 的 Runtime，以及同一個版本號的不同 build，都只會在舊資料夾旁邊多一個新資料夾；再執行同一個 build 的指令會找到它自己的資料夾，只重新指向 `agend-runtime`。更新時不需要任何人手動刪資料夾。`bin\agend-runtime.cmd` 只寫一次、之後不再改變：它啟動單行檔 `bin\current.txt` 所記的版本，安裝在新版本**完整就位之後**，才用原子取代把這個檔案換掉。所以 `agend-runtime` 啟動的不是舊版就是新版，不會是裝到一半的版本，正在執行的批次檔也不會被改寫。shim 一開始就是 `setlocal DisableDelayedExpansion`，所以安裝資料夾裡的 `!`（可接受的 `AGEND_RUNTIME_INSTALL_DIR` 可以含有）即使在 cmd.exe 開啟延遲展開（`/V:ON` 或登錄檔的 DelayedExpansion 設定）時也會保留。在視窗裡執行的 Runtime 會維持自己的版本，直到你以 Ctrl+C 停止、再重新啟動；在背景執行的 Runtime，則會在安裝程式把 `agend-runtime` 切到不同 build 時由安裝程式自己重新啟動（見〈在背景執行〉）。若在切換之前失敗，`current.txt` 仍指向可用的版本。**這個安裝程式不會移除舊資料夾**（其中一個可能正在執行）；清理舊版本留到之後的更新與解除安裝指令。在那之前它們會留著，等沒有 Runtime 使用時你可以自己刪除。腳本唯一會拒絕的情況，是已經有一個資料夾剛好叫這個 build 的名字、內容卻不是它：只有被手動改過或沒裝完才會發生，它會被原樣保留，腳本也會說明。

**PATH。** `bin` 資料夾是寫進**使用者** PATH：直接寫登錄檔，並保留原本的值型別，所以含 `%VARIABLES%` 的 PATH 仍然可展開。寫入不使用 `[Environment]::SetEnvironmentVariable('Path', …, 'User')`，因為它會把 `REG_EXPAND_SZ` 的 PATH 變成純字串（已在 Windows PowerShell 5.1 與 PowerShell 7 實測）；也絕不使用 `setx`，因為它會在 1024 字元截斷。已經存在的項目（寫成完整路徑或含 `%VARIABLES%`）不會重複加入，PATH 的其他部分也不動。已開啟的終端機看不到變更，請開新的，或使用腳本印出的完整路徑。

它只會刪除自己的暫存資料夾、剛寫入的暫存同層檔案，以及失敗後仍為空、而且是它自己建立的安裝資料夾。失敗時會把 `$LASTEXITCODE` 設為非零。

可在同一個 PowerShell 視窗、執行指令之前設定：

| 變數 | 作用 |
|---|---|
| `$agendNoConnect = 1` | 只安裝：即使在互動式視窗也不連線。除了空值、`0`、`false`、`no`、`off` 之外的任何值都視為已設定；它會留在該視窗，直到你用 `$agendNoConnect = $null` 清除。 |
| `$agendEnroll`、`$agendFingerprint` | 一次性 token 與 AgEnD 伺服器指紋。由頁面的指令設定，腳本讀取後清除（指令的 `finally` 會再清一次）。你不需要自己設定。 |
| `AGEND_RUNTIME_NO_PATH=1` | 不修改 PATH；最後會顯示 `agend-runtime.cmd` 的完整路徑。 |
| `AGEND_RUNTIME_INSTALL_DIR=D:\agend` | 安裝到這個資料夾（須為磁碟機完整路徑），而不是 `%LOCALAPPDATA%\agend-runtime`。 |

### 版本與這台 AgEnD 不一致

AgEnD 需要說得出自己支援的協定（目前是協定 1）、並提供 `exec` 能力的 Runtime。回報內容不符的 Runtime，是從另一個 AgEnD 版本安裝的，所以 AgEnD **會明確拒絕，而不是讓它連上後才出錯**：

- AgEnD 不會歡迎它、也不會派工給它。**設定 → Runtime** 的電腦卡片會維持離線，並說明它不相容、需要重新執行安裝指令；回報內容會保留，讓你看得到是哪個版本。
- Runtime 自己的視窗會以非零結束碼停止，並說：AgEnD 因為版本不相容而拒絕它，請**重新執行安裝指令**（設定 → Runtime → 連接電腦），再用 `agend-runtime start` 在背景啟動（或 `agend-runtime run` 留在視窗）。配對會保留，不需要新的配對碼。
- 再次執行安裝指令，會把這台 AgEnD 的 Runtime 安裝在舊版**旁邊**，不會刪除或取代任何版本資料夾，所以正在執行的 Runtime 仍可繼續運作；`agend-runtime` 是在新版本完整就位後才改指向它。若你是用 ZIP 安裝的，請改從同一個頁面下載 ZIP。

什麼都沒回報的 Runtime（在有版本回報之前安裝的）不會被拒絕：它會顯示為舊版，並提示重新執行安裝指令。目前沒有自動更新或遠端安裝。

### 伺服器提供什麼

在配對端點旁提供三個唯讀、不用登入的 GET 路由：

| 路由 | 內容 |
|---|---|
| `/runtime/install.ps1` | 安裝腳本，內含這台伺服器的 runtime 版本與壓縮檔的 SHA-256。 |
| `/runtime/v1/bundle/windows.zip` | 通用 Runtime 壓縮檔：與設定頁下載的 ZIP 同一份 `createRuntimeBundle()` 輸出，但不含 `agend-server.json`。 |
| `/runtime/v1/bundle/windows.json` | 同一份快取壓縮檔的 `{version, sha256, bytes}`，不含下載網址或配對資料。 |

只有在 **允許其他 Windows 電腦配對** 開啟時才提供（關閉時全部回 `404`，和不存在的路由一樣）；不經公開的 gateway 連結（那裡也回 `404`：gateway 的公開路由清單沒有它們）；只接受 HTTPS 或 loopback（其他來源的純 HTTP 回 `403`）；仍受 Host 白名單限制。

兩者在同一個伺服器版本內都是**靜態**的：通用 bundle 每個伺服器行程只產生一次並保留，所以校驗碼固定；腳本就是這份 bundle 的版本與 SHA-256 填進固定範本。回應內容與請求無關，不看 Host 標頭、查詢參數（帶查詢會被拒絕）、cookie 或呼叫者。兩者都不含 token、密鑰、配對碼、設定檔、使用者資料或伺服器位址，位址來自指令裡的 `$agend`。腳本不會被快取（`Cache-Control: no-store`）；壓縮檔帶 `Cache-Control: no-cache` 與由伺服器版本和 SHA-256 組成的 `ETag`，符合的 `If-None-Match` 會回 `304`、不帶內容。腳本仍會驗證壓縮檔固定的 SHA-256，所以快取的副本不會被單獨信任。下載安裝程式**不授予任何權限**：配對（一次性碼、十分鐘期限、指紋、本機管理員核准）完全不變，未核准的電腦什麼都做不了。

中繼資料來自同一份快取 bundle，因此校驗碼與位元組數對應實際送出的 ZIP。ZIP 與中繼資料共用 `ETag`（`"<version>-<sha256>"`）、`Cache-Control: no-cache` 與條件式 `304` 行為；`HEAD` 只回標頭，不帶內容。這個端點先提供自動更新所需的伺服器介面，本身不會切換正在執行的 Runtime。

請求會依來源位址限速並允許小量連續請求（連續下載幾次之後降為穩定速率；ZIP 與中繼資料共用額度，腳本另有額度），也有總量上限，因為反向代理會讓所有用戶端看起來像同一個位址。條件式請求與 `HEAD` 同樣計入。會先問該用戶端位址自己的額度：被它自己的額度拒絕的請求不會扣共用的總量，所以一個位址高頻猛打某條路由時，只會被它自己的限制擋住，不會用掉其他人共用的額度。被限制的請求會得到 `429` 與 `Retry-After`。壓縮檔不會超過 bundle 本身的 8 MiB 上限。

### 移除

先中斷本機連線（這會停止它在背景執行的 Runtime，並移除它的登入工作）並刪除程式資料夾，再從使用者 PATH 移除它的 `bin` 資料夾（Windows **設定 → 系統 → 關於 → 進階系統設定 → 環境變數**，使用者變數 `Path`）：

```powershell
agend-runtime disconnect
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\agend-runtime"
```

這會一次刪掉所有版本資料夾和所有 profile 的 log；請先關掉所有 Runtime 視窗。請**先**對每個 profile 執行 `agend-runtime disconnect`（或 `agend-runtime autostart disable`）：程式資料夾被刪掉之後，留下來的登入工作只會在下次登入時悄悄失敗。`agend-runtime status` 會列出所有 profile。目前還沒有獨立的解除安裝指令。

配對資料夾（預設 `%USERPROFILE%\.agend-runtime`）是分開的，需要自己刪除。要在 AgEnD 端讓憑證失效，請在設定撤銷該電腦。

## 在背景執行

Runtime 連上之後（第一次，或已儲存的配對資料重新連線），`connect` 會把它移到背景並結束：Runtime 沒有視窗地持續執行，所以關掉執行安裝指令、`connect-agend.bat` 或 `agend-runtime connect` 的視窗**不會斷線**。配對碼、指紋比對與核准（或一次性 token）仍在前景視窗完成，而且在這之前。AI agent 或 CI 執行一次性安裝指令時，Runtime 一連上就拿到 exit status；不需要另外把什麼當成獨立程序啟動。

| | |
|---|---|
| `agend-runtime connect … --foreground`（或在安裝指令前先 `$agendForeground = 1`） | 像以前一樣讓 Runtime 留在視窗裡，Ctrl+C 停止。不會建立登入工作。 |
| `agend-runtime start [--profile 資料夾]` | 在背景啟動已配對 profile 的 Runtime；登入工作執行的就是它。 |
| `agend-runtime run` | 沒有變：重新連線既有 profile 並留在視窗。 |
| `agend-runtime status [--profile 資料夾\|名稱] [--json]` | 列出這台電腦上的每個 profile：狀態（在背景執行、在視窗執行、未執行）、程序編號、從何時開始、配對到哪台 AgEnD、autostart 與 log 資料夾。`--profile` 可以是資料夾，也可以是 `status` 印出的 profile 名稱。 |
| `agend-runtime stop [--profile …\|--all]` | 請背景 Runtime 像 Ctrl+C 一樣停止，並等到它結束（30 秒）。同時有多個在執行時，請指定一個或用 `--all`。在視窗裡執行的會被拒絕：請關掉那個視窗。不會關掉 autostart。 |
| `agend-runtime restart [--profile …\|--all]` | 先 `stop`，再用已安裝的版本 `start`。沒有在執行就什麼都不啟動。 |
| `agend-runtime logs [--profile …] [--tail N]` | 該 profile 的 log 結尾（預設 50 行）。 |
| `agend-runtime autostart [enable\|disable\|status]` | 見下。 |

**每個 profile 只跑一個 Runtime。** 由 profile 的鎖決定。再啟動一次（第二次雙擊、登入工作碰到已經在執行、`start`、`connect --foreground`）會回報「已在執行」、指出程序編號，並以 exit status 0 結束；不會啟動也不會停止任何東西。

**Log。** 背景 Runtime 把視窗原本會顯示的內容寫到 `%LOCALAPPDATA%\agend-runtime\logs\<profile>\runtime.log`，每個事件一行並帶時間。`<profile>` 對 `%USERPROFILE%\.agend-runtime` 是 `default`，對各伺服器自己的 profile 是資料夾名稱（`<host>-<port>`），每個 per-server profile 資料夾名稱若超過 64 個字元，或含有檔名不能用的字元，會被縮短並以完整 profile 資料夾路徑的 8 個十六進位字元結尾（所以兩個很長的名稱不會共用同一個 log 資料夾或工作）；對用 `--profile` 或 `AGEND_RUNTIME_HOME` 指定的資料夾是 `custom-<資料夾>-<8 位十六進位>`。單一檔案最多 2 MiB，之後變成 `runtime.log.1`，舊的依序往上移到 `.5`，最舊的刪除，所以一個 profile 的 log 最多佔 12 MiB。log 只有 Runtime 自己的訊息（已連線、中斷、更新、停止、AgEnD 結束連線的原因）；和它取代的視窗一樣，裡面沒有配對碼、token 或憑證。

**Autostart。** 背景連線第一次成功、且 Runtime **已連上**時（剛啟動的還在連線中，或找到的是視窗裡的 Runtime，都不算），Runtime 會為你自己的帳號加一個 Windows **工作排程器**工作 `AgEnD Runtime - <帳號> - <profile>`（工作名稱在整台電腦上必須唯一，所以名稱除了 profile，還帶著 Windows 帳號的 8 個十六進位字元：兩個人的 `default` 不會共用同一個工作），在你**登入**後 20 秒觸發。它不是 Windows 服務，也不需要系統管理員權限：它用 `schtasks.exe` 從 XML 定義建立，內容指定你的帳號、一般（受限）權杖、沒有密碼也沒有提升權限，所以不會出現 UAC 提示。工作本身不負責讓 Runtime 活著；它只執行短指令 `agend-runtime start --profile <資料夾>`（安裝程式的 `agend-runtime.cmd`，永遠啟動最新已安裝的版本），由它啟動背景 Runtime，或回報已經有一個在執行，然後結束。所以電腦關機過、或使用者登出過，下次登入就會讓 Runtime 回來，並自動重新連線。`autostart disable` 會移除工作並讓這個 profile 保持關閉（之後的 `connect` 不會再打開）；`autostart enable` 再建立；`autostart status` 會告訴你目前的狀態。若 Windows 拒絕（公司原則），`connect` 仍然成功並說明這件事，之後可以用 `autostart enable` 再試。`disconnect` 會移除工作，並保留你選的「關閉」：如果你執行過 `autostart disable`，斷開再重新連線不會把它打開（沒選過或原本是開的 profile 會重新開始）。工作不能安全承載的路徑（安裝資料夾、profile 資料夾或程式本身的路徑含有引號、`%`、`& ^ | < >` 或換行）會被拒絕並說明解法，不會寫成做別的事的工作。直接查詢失敗時，會改讀 Windows 自己的工作清單來判斷工作是否存在，所以 `schtasks` 本身壞掉時會回報，而不是被當成「沒有工作」。

**怎麼停止。**（無法確認停止時，例如還有帳號程序在執行，Runtime 會繼續執行並持續監看：下一次 `stop`、`restart` 或 `disconnect` 會再要求一次。）脫離視窗的 Windows 程序沒有主控台，也沒有能讓它有秩序停止的訊號，而強制結束會略過帳號程序與 profile 鎖的有序收尾。所以 `stop` 會在 profile 資料夾寫一個很小的請求檔（`stop-request.json`，只有時間），背景 Runtime 會監看並取走它；`stop` 接著等 profile 鎖被釋放，若 Runtime 正在交接給新版本就再請求一次。能寫入 profile 資料夾的人（同一個 Windows 使用者）本來就能結束這個程序，所以這沒有增加任何權限。

**profile 資料夾裡有什麼。** 除了 `connection.json` 與 `jobs.json`：`instance.json`（哪個程序是背景 Runtime，讓 `status` 說得出來）、`autostart.json`（你的 autostart 選擇）、`background-state.json`（啟動中的 Runtime 留給啟動它的指令的話），以及短暫存在的 `stop-request.json`。沒有一個含有祕密。背景 Runtime 的命令列是 `node.exe …\runtime-cli.js run --profile <資料夾>`：永遠沒有配對碼、一次性 token 或憑證（token 是 `connect` 在啟動 Runtime 之前從標準輸入讀走的）。

**啟動時不拖住呼叫端。** 在 Windows 上，Node 以「detached」啟動的程序仍會繼承父程序所有可繼承的 handle，其中包括執行指令的人（AI agent 的 shell、CI）的輸出管線：呼叫端會因為管線一直不關閉而等到 Runtime 結束。在 Windows 上實測：用替身程序時等了 40 秒，用這裡的做法是 0.3 秒。所以背景 Runtime 是用 Windows PowerShell 的 `Start-Process` 啟動的（隱藏、沿用相同的環境變數、有自己隱藏的主控台），它不會傳遞任何 handle，而啟動端是從 `background-state.json` 得知它已連上。它也不受執行啟動端的工作排程器工作結束影響（實測：工作結束 20 秒後仍然在線）。

**更新、修復與安裝程式。** 受管理安裝的就地更新會交接給新的 build，新的程序接手上述所有東西：同一份 log、同一個停止請求、同一個標記（實測：交接後 `status` 顯示新的程序仍在背景，`stop` 也能停止它）。當安裝指令把 `agend-runtime` 切到不同的 build，或是修復執行（`AGEND_RUNTIME_REPAIR=1`），它會在安裝鎖釋放後執行 `agend-runtime restart --all`，讓背景的 Runtime 用到已安裝的 build；在視窗裡執行的 Runtime 不會被動，重新啟動失敗只是警告，不會變成「安裝失敗」（如果安裝本身在選定新版本之後失敗，或安裝鎖無法確認已釋放，就不會停止或重新啟動任何東西，狀態維持失敗）。`$agendNoConnect = 1` 仍然代表「只安裝、不連線」，不會擋下這個重新啟動。

**限制。** 登入工作只在你登入時執行，這也正是你的 Windows CLI 與登入存在的時候；沒有登入前的服務。背景的 Runtime 沒有視窗可以顯示問題：請看 `status` 與 `logs`，`status` 會印出 log 資料夾。驗證時沒有真的登出再登入（那會結束執行測試的工作階段）；工作是用 `schtasks /Run` 手動執行的，也就是 Windows 在登入時執行的同一個動作。

## 帳號識別：看得出登入的是哪一個 Claude 帳號

Runtime 會在那台電腦上讀取 `claude auth status`，對每個 credential profile 與電腦自己的預設登入，回報**完整的 email 與方案**，顯示成 `work · alice@example.com · Team`（設定 → Runtime 的電腦卡片，以及 Agent 的「Claude 帳號」選單）。同一個人的多個帳號前綴通常相同，縮短成 `al***@example.com` 會讓兩個帳號看起來一樣，所以顯示完整地址。email 只會經由 Runtime 與所配對 AgEnD 之間已驗證的連線傳送；不會被記錄，也不會出現在錯誤訊息、audit、通知或聊天回覆裡，Runtime 只把它存在該 profile 自己資料夾內的狀態快取中（Windows 上受該使用者資料夾的 ACL 保護，POSIX 為 `0600`）。沒有 email、含非 ASCII 字元、含空白或第二個 `@`、或超過 254 字元時不會回報（絕不截短後送出）；API key 登入顯示為「沒有帳號 email（API key）」。方案是 `free`、`pro`、`max`、`team`、`enterprise` 或 `unknown` 其中之一；AgEnD 只接受這個格式（舊版 Runtime 已快取的 `ab***@example.com` 仍可接受），其他一律視為通訊協定錯誤，錯誤訊息只指出欄位，不會附上內容。只有按「重新偵測」或 `agend-runtime login` 之後才會更新；不認得這個欄位的舊版 Runtime 就只是不顯示。

**只有直接連到 dashboard 的 fleet 管理員看得到這些詳細資訊**（email 與方案；「直接連到」是指這台電腦、區網、tailnet 或自己的 proxy，見[三種連線方式比較](web-dashboard.zh-TW.md#三種連線方式比較)），在 Runtime 頁、Claude 帳號選單、設定 → Agents 與設定 → Accounts 看到。其他人看到的是同一個頁面但沒有這兩項，profile 名稱與是否已登入照舊：經由臨時公開連結或固定位址（named tunnel）登入的 session 看不到，即使是 fleet 管理員也一樣；guest、唯讀 session，以及用 CLI header token 呼叫的 Agent 也看不到。Agent 工具與 Agent 能讀到的內容裡也沒有。


## Profile 資料夾的 Windows 權限

Runtime 在讀取 profile 狀態前會檢查 Windows ACL，`--profile`／`AGEND_RUNTIME_HOME` 指定的自訂路徑也一樣。新目錄在建立時就只允許目前 Windows 使用者與 SYSTEM 存取。現有目錄不會被自動更改權限：擁有者及檔案、子目錄的存取權都只可屬於目前使用者、SYSTEM 或本機 Administrators。提高權限的 Windows 程序可能以 Administrators 作為新檔案的預設擁有者；它沿用同一組受信任身分，不會因此允許其他一般使用者或服務帳號。遇到 reparse point、共用子檔案、無法讀取的 ACL，或其他一般帳號可替換的父目錄，就會在讀取狀態前拒絕。父目錄的 ACL 與無關檔案都不會被改寫。

每次最多檢查 20,000 個項目、25 秒（PowerShell 程序最多 30 秒），因此很大或很慢的 profile 也可能被拒絕。請選擇新的專用目錄，或由目錄擁有者檢查並限制既有權限；不要把整個家目錄或共用工作目錄當成 profile。舊的共用 profile 會被拒絕，不會自動改權限或搬移內容。這不能隔離同一個 Windows 使用者、SYSTEM 或本機管理員；機器憑證也尚未加密，請勿共用或同步 profile。CLI 既有登入檔、profile 擁有權與移除標記維持原樣。
