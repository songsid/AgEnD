# 已配對的 Windows Runtime：連接電腦與一行安裝

這一頁說明如何把另一台 Windows 電腦接上你的 AgEnD，以及 **Windows（PowerShell）一行安裝**。完整的英文說明（網路連線、Tailscale Serve、SSH 轉發、清單與模型、斷線復原、憑證輪換）在 [Paired Windows runtimes](remote-runtime.md)。

## 連接電腦

1. 在 **設定 → Runtime** 開啟 **允許其他 Windows 電腦配對**（`fleet.yaml` 的 `runtimes.remote_runtime: true`，預設關閉）。開啟時需要 Fleet 管理員確認，不必重新啟動。這台電腦仍是你的 Fleet；另一台電腦只執行一個小 runner。
2. 按 **連接電腦**，在步驟 1 確認 **AgEnD 位址**：必須是另一台電腦連得到的位址。遠端位址必須是 HTTPS；只有 `localhost` 這類本機位址可用 HTTP（例如 SSH 轉發）。
3. 在位址下方的分頁選擇安裝方式：
   - **Windows（PowerShell）**：複製**安裝指令**，在另一台 Windows 電腦的 PowerShell 貼上；再複製**連線指令**在那裡執行。
   - **其他安裝方式（ZIP）**：下載 ZIP、傳到另一台電腦並解壓縮，雙擊 `connect-agend.bat`。這個流程維持原樣。
4. 在已安裝並登入各 CLI 的 Windows 使用者底下執行。兩種方式都需要 Windows 上的 Node.js。
5. 第一次連線時，輸入頁面右側的**一次性配對碼**，比對 Runtime 視窗與頁面上的**配對指紋**，再在 AgEnD 核准這台電腦。配對碼只在終端機輸入，不會出現在任何指令裡。

## 一行安裝（Windows PowerShell）

頁面會帶入你確認過的位址。在另一台 Windows 電腦的 PowerShell 執行第一行；不需要系統管理員權限。

```powershell
$agend = 'https://your-agend-host'; irm "$agend/runtime/install.ps1" | iex
```

它只安裝，**不會連線、不會配對**，最後印出下一行要執行的指令：

```powershell
agend-runtime connect --server "https://your-agend-host"
```

安裝指令依序做這些事：

1. 檢查 Node.js 是否為 22.14 以上（22.14+、23.6+ 或 24+）。沒有時會停下來，只提示 `winget install OpenJS.NodeJS.LTS` 或 nodejs.org，**不會替你安裝軟體**。
2. 從 `$agend` 下載 Runtime 壓縮檔（單次、有上限、不跟隨轉址，最大 16 MiB）。
3. 自己計算壓縮檔的 SHA-256，與**寫在安裝腳本裡**的校驗碼比對；不符就在解壓縮之前停止。
4. 解壓縮到 `%LOCALAPPDATA%\agend-runtime\<版本>`，並把 `agend-runtime.cmd` 放在 `%LOCALAPPDATA%\agend-runtime\bin`。
5. 把這個 `bin` 資料夾加進**你的使用者 PATH**（登錄檔 `HKCU`，不是系統 PATH）。
6. 印出連線指令。

它只會刪除自己的暫存資料夾，以及要取代的同版本資料夾。同一版本重複執行不會改變任何東西；伺服器更新後再執行，會安裝到新的版本資料夾並更新 `agend-runtime.cmd`，舊版本資料夾要自己刪除。目前沒有自動更新。失敗時會說明原因，並把 `$LASTEXITCODE` 設為 1。

可在同一個 PowerShell 視窗、執行指令之前設定：

| 變數 | 作用 |
|---|---|
| `AGEND_RUNTIME_NO_PATH=1` | 不修改 PATH；最後會顯示 `agend-runtime.cmd` 的完整路徑。 |
| `AGEND_RUNTIME_INSTALL_DIR=D:\agend` | 安裝到這個資料夾（須為磁碟機完整路徑），而不是 `%LOCALAPPDATA%\agend-runtime`。 |

### 伺服器提供什麼

在配對端點旁新增兩個唯讀、不用登入的 GET 路由：

| 路由 | 內容 |
|---|---|
| `/runtime/install.ps1` | 安裝腳本，內含這台伺服器的 runtime 版本與壓縮檔的 SHA-256。 |
| `/runtime/v1/bundle/windows.zip` | 通用 Runtime 壓縮檔：與設定頁下載的 ZIP 同一份 `createRuntimeBundle()` 輸出，但不含 `agend-server.json`。 |

只有在 **允許其他 Windows 電腦配對** 開啟時才提供（關閉時兩條都回 `404`，和不存在的路由一樣）；不經公開的 gateway 連結（那裡也回 `404`）；只接受 HTTPS 或 loopback；仍受 Host 白名單限制；依來源位址與總量限速；壓縮檔不會超過 bundle 本身的 8 MiB 上限。

兩者在同一個伺服器版本內都是**靜態**的：通用 bundle 每個伺服器行程只產生一次並保留，所以校驗碼固定；腳本就是這份 bundle 的版本與 SHA-256 填進固定範本。回應內容與請求無關，不看 Host 標頭、查詢參數（帶查詢會被拒絕）、cookie 或呼叫者。腳本不含任何 token、密鑰、配對碼或伺服器位址，位址來自指令裡的 `$agend`。校驗碼是釘在腳本裡，而不是從下載壓縮檔的同一個回應取得，因此從正確伺服器經 TLS 取得的腳本，會拒絕任何其他壓縮檔。下載安裝程式**不授予任何權限**：配對（一次性碼、十分鐘期限、指紋、本機管理員核准）完全不變，未核准的電腦什麼都做不了。

校驗碼保護的是取得腳本之後的壓縮檔不被損毀或替換，不能證明腳本本身的來源：對腳本的信任，來自伺服器的 HTTPS 來源，和 ZIP 相同。

### 移除

先中斷本機連線並刪除程式資料夾，再從使用者 PATH 移除它的 `bin` 資料夾（Windows **設定 → 系統 → 關於 → 進階系統設定 → 環境變數**，使用者變數 `Path`）：

```powershell
agend-runtime disconnect
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\agend-runtime"
```

配對資料夾（預設 `%USERPROFILE%\.agend-runtime`）是分開的，需要自己刪除。要在 AgEnD 端讓憑證失效，請在設定撤銷該電腦。
