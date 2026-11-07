# 已配對的 Windows Runtime：連接電腦與一行安裝

這一頁說明如何把另一台 Windows 電腦接上你的 AgEnD，以及 **Windows（PowerShell）一行安裝**。完整的英文說明（網路連線、Tailscale Serve、SSH 轉發、清單與模型、斷線復原、憑證輪換）在 [Paired Windows runtimes](remote-runtime.md)。

## 連接電腦

1. 在 **設定 → Runtime** 開啟 **允許其他 Windows 電腦配對**（`fleet.yaml` 的 `runtimes.remote_runtime: true`，預設關閉）。開啟時需要 Fleet 管理員確認，不必重新啟動。這台電腦仍是你的 Fleet；另一台電腦只執行一個小 runner。
2. 按 **連接電腦**，在步驟 1 確認 **AgEnD 位址**：必須是另一台電腦連得到的位址。遠端位址必須是 HTTPS；只有 `localhost` 這類本機位址可用 HTTP（例如 SSH 轉發）。
3. 在位址下方的分頁選擇安裝方式：
   - **Windows（PowerShell）**：複製**安裝指令**（內含頁面上顯示的腳本 SHA-256，先檢查、相符才執行），在另一台 Windows 電腦的 PowerShell 貼上；再複製**連線指令**在那裡執行。
   - **其他安裝方式（ZIP）**：下載 ZIP、傳到另一台電腦並解壓縮，雙擊 `connect-agend.bat`。這個流程維持原樣。
4. 在已安裝並登入各 CLI 的 Windows 使用者底下執行。兩種方式都需要 Windows 上的 Node.js。
5. 第一次連線時，輸入頁面右側的**一次性配對碼**，比對 Runtime 視窗與頁面上的**配對指紋**，再在 AgEnD 核准這台電腦。配對碼只在終端機輸入，不會出現在任何指令裡。產生配對碼和核准電腦，都需要直接連到的儀表板上的管理員 session（cookie 與 CSRF），也就是頁面上的「連接電腦」和「核准電腦」按鈕；只帶 `X-Agend-Token` 標頭的請求會被拒絕（#3327，見[威脅模型](SECURITY.zh-TW.md#威脅模型)）。

## 一行安裝（Windows PowerShell）

頁面會帶入你確認過的位址。在另一台 Windows 電腦的 PowerShell 執行第一行；不需要系統管理員權限。

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; $agend = 'https://your-agend-host'; $s = $null; $h = $null; $s = (iwr "$agend/runtime/install.ps1" -UseBasicParsing).Content; $h = (-join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($s)) | % { $_.ToString('x2') })); if ($s -and $h -eq '<頁面上顯示的 SHA-256>') { iex $s } else { Write-Host 'install.ps1 could not be verified against the hash on the AgEnD page (a certificate or download error above is the usual cause: trust this AgEnD certificate, or use the ZIP; otherwise reload the page and copy the command again)' -ForegroundColor Red; throw 'install.ps1 was not run' }
```

頁面會填入你的位址與 `install.ps1` 的 SHA-256。指令先下載腳本、計算收到的位元組的雜湊，與頁面上的雜湊比對，**相符才執行**。它只安裝，**不會連線、不會配對**，最後印出下一行要執行的指令：

```powershell
agend-runtime connect --server "https://your-agend-host"
```

一次性配對碼是在終端機被詢問時輸入，不會出現在任何指令裡。之後比對**配對指紋**，並在 AgEnD 核准這台電腦。ZIP 流程維持原樣，放在「其他安裝方式（ZIP）」。

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
6. 印出連線指令。

**版本並存。** 既有的資料夾永遠不會被刪除或取代，因為它可能就是正在執行的 Runtime（執行中的 Windows 程式會鎖住它的檔案）。安裝資料夾叫 `<版本>+<build>`，所以較新 AgEnD 的 Runtime，以及同一個版本號的不同 build，都只會在舊資料夾旁邊多一個新資料夾；再執行同一個 build 的指令會找到它自己的資料夾，只重新指向 `agend-runtime`。更新時不需要任何人手動刪資料夾。`bin\agend-runtime.cmd` 只寫一次、之後不再改變：它啟動單行檔 `bin\current.txt` 所記的版本，安裝在新版本**完整就位之後**，才用原子取代把這個檔案換掉。所以 `agend-runtime` 啟動的不是舊版就是新版，不會是裝到一半的版本，正在執行的批次檔也不會被改寫。shim 一開始就是 `setlocal DisableDelayedExpansion`，所以安裝資料夾裡的 `!`（可接受的 `AGEND_RUNTIME_INSTALL_DIR` 可以含有）即使在 cmd.exe 開啟延遲展開（`/V:ON` 或登錄檔的 DelayedExpansion 設定）時也會保留。已經在執行的 Runtime 會維持自己的版本，直到你以 Ctrl+C 停止、再用 `agend-runtime run` 啟動。若在切換之前失敗，`current.txt` 仍指向可用的版本。**這個安裝程式不會移除舊資料夾**（其中一個可能正在執行）；清理舊版本留到之後的更新與解除安裝指令。在那之前它們會留著，等沒有 Runtime 使用時你可以自己刪除。腳本唯一會拒絕的情況，是已經有一個資料夾剛好叫這個 build 的名字、內容卻不是它：只有被手動改過或沒裝完才會發生，它會被原樣保留，腳本也會說明。

**PATH。** `bin` 資料夾是寫進**使用者** PATH：直接寫登錄檔，並保留原本的值型別，所以含 `%VARIABLES%` 的 PATH 仍然可展開。寫入不使用 `[Environment]::SetEnvironmentVariable('Path', …, 'User')`，因為它會把 `REG_EXPAND_SZ` 的 PATH 變成純字串（已在 Windows PowerShell 5.1 與 PowerShell 7 實測）；也絕不使用 `setx`，因為它會在 1024 字元截斷。已經存在的項目（寫成完整路徑或含 `%VARIABLES%`）不會重複加入，PATH 的其他部分也不動。已開啟的終端機看不到變更，請開新的，或使用腳本印出的完整路徑。

它只會刪除自己的暫存資料夾、剛寫入的暫存同層檔案，以及失敗後仍為空、而且是它自己建立的安裝資料夾。失敗時會把 `$LASTEXITCODE` 設為非零。

可在同一個 PowerShell 視窗、執行指令之前設定：

| 變數 | 作用 |
|---|---|
| `AGEND_RUNTIME_NO_PATH=1` | 不修改 PATH；最後會顯示 `agend-runtime.cmd` 的完整路徑。 |
| `AGEND_RUNTIME_INSTALL_DIR=D:\agend` | 安裝到這個資料夾（須為磁碟機完整路徑），而不是 `%LOCALAPPDATA%\agend-runtime`。 |

### 版本與這台 AgEnD 不一致

AgEnD 需要說得出自己支援的協定（目前是協定 1）、並提供 `exec` 能力的 Runtime。回報內容不符的 Runtime，是從另一個 AgEnD 版本安裝的，所以 AgEnD **會明確拒絕，而不是讓它連上後才出錯**：

- AgEnD 不會歡迎它、也不會派工給它。**設定 → Runtime** 的電腦卡片會維持離線，並說明它不相容、需要重新執行安裝指令；回報內容會保留，讓你看得到是哪個版本。
- Runtime 自己的視窗會以非零結束碼停止，並說：AgEnD 因為版本不相容而拒絕它，請**重新執行安裝指令**（設定 → Runtime → 連接電腦），再用 `agend-runtime run` 啟動。配對會保留，不需要新的配對碼。
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

先中斷本機連線並刪除程式資料夾，再從使用者 PATH 移除它的 `bin` 資料夾（Windows **設定 → 系統 → 關於 → 進階系統設定 → 環境變數**，使用者變數 `Path`）：

```powershell
agend-runtime disconnect
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\agend-runtime"
```

配對資料夾（預設 `%USERPROFILE%\.agend-runtime`）是分開的，需要自己刪除。要在 AgEnD 端讓憑證失效，請在設定撤銷該電腦。

## 帳號識別：看得出登入的是哪一個 Claude 帳號

Runtime 會在那台電腦上讀取 `claude auth status`，對每個 credential profile 與電腦自己的預設登入，只回報**遮罩過的 email 與方案**，顯示成 `work · ab***@example.com · Team`（設定 → Runtime 的電腦卡片，以及 Agent 的「Claude 帳號」選單）。遮罩只保留 email 前一到兩個字元，接著 `***`，再接完整網域，所以能分辨工作帳號與個人帳號；完整 email 不會離開那台電腦，不會被記錄，也不會寫入 Runtime 的磁碟。沒有 email 或含非 ASCII 字元時不會回報；API key 登入顯示為「沒有帳號 email（API key）」。方案是 `free`、`pro`、`max`、`team`、`enterprise` 或 `unknown` 其中之一；AgEnD 只接受這個格式，其他一律視為通訊協定錯誤，錯誤訊息只指出欄位，不會附上內容。只有按「重新偵測」或 `agend-runtime login` 之後才會更新；不認得這個欄位的舊版 Runtime 就只是不顯示。

**只有直接連到 dashboard 的 fleet 管理員看得到這些詳細資訊**（遮罩的 email 與方案；「直接連到」是指這台電腦、區網、tailnet 或自己的 proxy，見[三種連線方式比較](web-dashboard.zh-TW.md#三種連線方式比較)），在 Runtime 頁、Claude 帳號選單、設定 → Agents 與設定 → Accounts 看到。其他人看到的是同一個頁面但沒有這兩項，profile 名稱與是否已登入照舊：經由臨時公開連結或固定位址（named tunnel）登入的 session 看不到，即使是 fleet 管理員也一樣；guest、唯讀 session，以及用 CLI header token 呼叫的 Agent 也看不到。Agent 工具與 Agent 能讀到的內容裡也沒有。
