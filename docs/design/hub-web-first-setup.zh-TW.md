# Hub 網頁首次設定與 AD 連線設定（alpha.9 設計草案）

狀態：**只供使用者審閱；尚未核准實作**。M-2687。M-2682 負責名稱、品牌顯示、預覽開關與資訊頁；兩者使用同一個設定提交及復原機制。這份設計不會更動正在執行的試用 Hub。

## 給使用者看的摘要

- 第一次在 **這台電腦的 AgEnD → 設定 → Hub → 建立 Hub** 完成設定。入口必須是 AgEnD 自己開啟的主機擁有者登入工作階段；知道網址或能連到本機位址並不算取得權限。
- 網頁依序填基本資料、AD 連線與管理員，檢查成功後按「完成設定」。不用另外到終端機輸入確認指令，也不用提供管理員的個人 AD 密碼來完成安裝。
- AD 頁面可測試連線、匯入或取得 CA、比對指紋，以及更換服務帳號密碼。**密碼只寫入、不回傳；留白不會把既有密碼清空。**
- **Hub 管理員也能在「Hub 管理 → AD 連線」修改設定**。儲存時須有近期、由目前受信任目錄驗證的管理員登入；新連線也必須查到同一個不可變管理員身分。測試失敗維持原設定，不會只改一半而讓 Hub 停住。
- 平常只按一次「儲存」；需要重新登入時在頁內輸入個人密碼，這個密碼只送到**目前受信任的目錄**。更換 CA 或伺服器網址時，才多一個指紋確認。同一 CA 換伺服器也要確認新主機與 leaf 憑證指紋；同主機只改搜尋範圍、服務帳號、密碼或 filter，不多一個確認。
- 每次實際變更都留下稽核，並向主機擁有者及其他管理員送出可保留的安全通知。本機擁有者保留明確的網頁修復入口；初次設定仍只允許主機擁有者。
- 首位管理員以目錄中不可變的身分指定，之後由那個人自己在 Hub 登入。改帳號顯示名稱不會換人，重新建立同名帳號也不會繼承管理權限。
- CLI 初始化保留為備援；網頁與 CLI 共用初始化器，不另外做一套較寬鬆的安裝方式。

圖片以真正的 `app.html`、側邊欄及應用程式模組呈現，僅在實際面板內容中放入模擬資料的設計稿；不是功能驗收。fleet 畫面保留第二層 Settings 選單並選中 Hub。Hub 畫面使用目前已落地的 Hub shell；M-2686 的新版 shell 尚未核准，不冒稱已使用。圖中不使用任何試用環境的位址、帳號、憑證或目錄資料。

## 目前的問題與既有程式

基準：alpha `9b06e6bd`。目前 `HubInitializer` 已有檢查、確認、提交、續作；網頁尚未提供完整首次設定。`hub.name`、目錄連線、初始保留政策等欄位在 `normalizedHubSettings()` 的簽署摘要內。直接改 YAML 會讓 `verifyHubInitialization()` 拒絕掛載；重新啟動不會修復摘要不一致。名稱另外受到 `settingsOf()` 非空字串檢查。

既有保留政策與瀏覽器憑證已有網頁控制，修改的是資料庫中的有效政策或憑證選擇，不是直接改原本被簽署的設定。不要把這兩種路徑混成「改設定檔後重啟」。

沿用：`src/authority/web-authority.ts`、`src/hub/init/{types,initializer,identity,plan-digest}.ts`、`src/hub/{initialization,mount,runtime}.ts`、`src/hub/compose/server.ts`。CA 信任沿用 `docs/design/hub-directory-ca-bootstrap.md`；管理員沿用 `hub-first-admin.md`；樣式沿用 `ui-style-guide.md`。

## 權限與入口

| 操作 | 權限與所在畫面 | 拒絕的情況 |
|---|---|---|
| 尚無 Hub 的檢查、測試、指定管理員、完成設定、續作 | 主機 fleet 的設定頁；每次請求都必須通過 `hostSessionHere(session, req)` | 沒有登入、只有標頭 token、只有 loopback、LAN/遠端、guest、gateway/公開連結、過期或撤銷的工作階段 |
| 已有 Hub 的名稱與一般資訊 | M-2682 的 Hub 管理頁；名稱由 configured admin 修改，資訊只讀 | 一般目錄使用者不得取得設定寫入權限 |
| HTML 預覽開關／連接埠 | M-2682 的 fleet 設定 → Hub，由主機擁有者管理 listener | Hub 管理員角色本身不授予主機 listener 權限 |
| AD 連線、服務秘密及 CA 調整 | Hub 管理頁：已設定的管理員 session＋CSRF＋目前受信任目錄的近期重新驗證。候選連線須確認操作者為同一個合格 PersonKey。主機擁有者在 fleet 本機頁面保留 D3 修復路徑 | guest／公開連結、非管理員、重新驗證逾期、新目錄中同名不同人、無法確認資格、失效 session、未確認的信任變更、錯誤 CA 或測試失敗 |
| 改 realm、不可變 ID 模型、管理員身分，或遺失目錄時復原 | 主機擁有者在本機網頁的受保護移轉流程；不能由一般「儲存連線」順便完成 | 不得把同名登入或任意 GUID 當作管理權限證明；不得自動重設管理員 |

使用者已決定 Hub 管理員可編輯 AD；這是窄的目錄設定權限，不把他擴大成主機擁有者。不把 host cookie 複製到 Hub origin，不因為同一個瀏覽器已登入 AD 就視為主機登入。共同提交器只能接受操作專屬 gate 產生的能力，不能接受客戶端傳入 `isAdmin: true`。初次設定、listener 及身分移轉的主機邊界不因本決定放寬。

D3 的登入來源是 AgEnD 自己的單次啟動連結，單次碼放 fragment、兌換後移除。每個請求還要檢查本機 TCP peer、Host、無轉送標頭及無 gateway。不得用「第一次到訪」、「第一個按下去的人」或 bare loopback 取代這個證明。登入碼、cookie、CSRF、密碼都不出現在查詢字串、Referer 或操作紀錄。

角色來源：`docs/concepts.md` 的 `## host owner / operator`、`## fleet admin (admin_users)`；其中 fleet admin 的描述包含 “Can: admin-gated commands, confirming sensitive changes, managing access.” Hub 的設定管理員仍是已設定的目錄身分，不會因此成為 fleet 主機擁有者。遵循 64a289a0、D3（bcbb541f）、721ca0c3 與 1bf9968c。

## 首次設定流程

### 1. 基本資料

在現有 fleet 的「設定 → Hub」顯示「建立 Hub」。尚未初始化時 Hub 的對外服務維持關閉，不先開一個可以遠端搶先指定管理員的設定頁。

欄位：Hub 名稱（與 M-2682 一致的清除及正規化語意；**提案首次也可省略，須同步調整 CLI／initializer，不是網頁的特例**）、明確選取的網路介面、瀏覽器與 member listener/origin、可選 HTML 預覽、瀏覽器憑證產生或匯入、內容與事件保留政策。提供建議值但不隱藏實際作用；檢查連接埠衝突與憑證 SAN，不綁 wildcard，不修改防火牆或 DNS。

既有 fleet 的證據會顯示在同一頁，讓擁有者選擇專用 Hub 或已支援的共存模式。產生的身分與私鑰不是可任意輸入的文字欄位。產生瀏覽器憑證時沿用可攜的產生器；初次提交後由既有憑證控制接手更新。

### 2. AD 連線與信任

| 欄位 | 行為 |
|---|---|
| LDAPS 伺服器 URL | 驗證合法 URL、主機及支援的傳輸；不提供略過 TLS 驗證的開關 |
| realm、目錄 profile | 首次設定可選；之後涉及身分移轉，不能當一般名稱修改 |
| 使用者搜尋起點 base DN | 預覽搜尋範圍；查詢有時間及筆數上限 |
| 服務綁定帳號 bind DN | 說明這是讀取目錄用帳號，不是首位管理員 |
| 服務帳號密碼 | 寫入專用密碼欄位；回應只提供「已設定／需更換」，不回傳值或儲存位置 |
| CA | 匯入 PEM，或透過受控取得流程；顯示來源、有效期及 SHA-256 指紋 |
| 進階查詢參數 | 有設定時顯示並驗證 profile 支援的 login attribute、filter、timeout；不默默丟掉 CLI 已有的值 |

第一次沒有信任 CA 時先做**不帶帳密**的憑證檢視。若一般驗證可用便直接沿用；否則顯示 leaf 主機、有效期與完整指紋，要求與管理者提供的值比對，再用「確認指紋並取得 CA」這個必要的信任動作繼續。

若匿名取得被拒，才在那一條**完全符合已確認 leaf** 的 LDAPS 連線用服務帳密讀取公開 CA；AIA 與查詢範圍沿用既有同主機、禁止 referral、回應大小及時限限制。取得後驗證 CA 資格、鏈、有效期，再以正常 CA 驗證重新建立連線。pin 或放寬驗證只存在此次 bootstrap，不存入正式 Hub 目錄設定。指紋不同、過期或主機不符就停止，沒有「仍然繼續」。

「測試連線」依序顯示 TLS、服務帳號綁定、指定管理員查詢的結果。只讀 LDAPS，不建立、更改或刪除 AD 物件。不抓取全體人員，不提供未登入者的帳號查詢。

### 3. 指定管理員及完成

主機擁有者輸入一個目錄登入名稱，使用既有 bounded lookup 與 immutable-ID/同連線資格重查。零筆、多筆、超額、停用或不明都不選人；不提供手填 objectId 或第一個登入者成為管理員的後門。

頁面顯示選取的人與目錄來源，說明「設定完成後，這個人用自己的公司帳號登入 Hub」。不索取他的個人密碼。不新增一般人員、session 或 grant 來假裝已登入。只把已驗證的 PersonKey 放入待提交計畫。

最後的「完成設定」同時是已驗證主機工作階段對這個確切計畫的確認；不另加終端機指令或重複確認彈窗。使用伺服器產生、session 綁定、短效、單次的 draft/confirmation；包含欄位、憑證材料與秘密版本的綁定。`prepareConfirmation()` 與 `commit()` 沿用原初始化器，擴充**明確的 host-session 確認來源**，不能捏造原本終端機確認字串。

初始化先維持關閉，建立既有私有資料庫、內容金鑰、版本 floor、member TLS/issuer 身分、瀏覽器 TLS、秘密參照、完整設定、簽署 manifest，最後才開啟。沿用原續作及精確計畫檢查。新增網頁進度不等於新增一套初始化格式。

完成後，只有服務已掛載、健康檢查與 HTTPS 成功才顯示「Hub 已就緒」及「開啟 Hub」。新 origin 不接收主機 cookie 或初始化 draft；管理員在 Hub 自己登入。首位管理員的 once-only `administrator.claimed` 沿用現有交易。

## AD 設定、密碼與登入失敗

Hub 管理的「AD 連線」提供目前連線、CA 狀態、最近測試結果、設定版本及編輯。管理員可直接在這個畫面完成，不跳到主機終端機或另一個來源登入。主機擁有者的 fleet「設定 → Hub」保留受保護的修復流程。修改時清楚標示「尚未儲存」；測試草稿不改目前有效服務。

### 儲存時的重新驗證與身分連續性

1. 「儲存」啟動候選檢查；有合格的近期 AD 驗證便直接沿用，否則在同頁索取目前管理員的個人密碼。近期驗證期限上限五分鐘，由伺服器記錄的驗證時間判定；不能採信客戶端時間或把一般 session 存活時間當近期驗證。
2. 個人重新驗證只使用**舊的、目前受信任且正在生效的目錄**。絕不把管理員的個人密碼送給正在提案的新伺服器。舊目錄無法驗證時，遠端管理員不能儲存；主機擁有者使用獨立 D3 修復流程。
3. 新設定須通過正常 TLS、服務綁定、bounded lookup 與新鮮 immutable eligibility 檢查；操作者在新設定中必須仍是原本合格的相同 `{realm, objectId}`。同名不同 GUID、停用、不明、不同 realm／ID 模型都拒絕，明白說明原設定保持不變。一般儲存不重新指定管理員。
4. 伺服器產生的短效單次證明綁定 actor、session、舊 authentication/config epoch、候選內容、秘密／憑證版本、舊設定／manifest image 與期限。每次 await 後及 durable commit 前重查，並與共同 writer 的 CAS 一起判定；不能讓瀏覽器提供 `recentAuth:true` 取代證明。
5. 畫面上的「測試連線」可先執行，但不是永久授權。儲存仍重新驗證候選；一般編輯只按一次 Save，驗證成功直接繼續，不再加「確定要儲存」對話框。

### 信任變更只用一個確認對話框

| 變更 | 儲存時唯一的額外確認 |
|---|---|
| 同一主機／URL、同一 CA，只改 base DN、bind DN、密碼或 filter | 無；仍須近期驗證、候選測試與身分連續性 |
| CA 改變 | 顯示新 CA 的 SHA-256 指紋及目標伺服器，確認後才進行需要該信任的認證／提交 |
| 伺服器主機／URL 改變，即使 CA 不變 | 顯示新主機及其 leaf 憑證 SHA-256 指紋；leaf 必須已通過原受信任 CA 的鏈、主機及有效期檢查 |
| CA 與 URL 同時改變 | 同一個對話框列出新主機、leaf 與新 CA 指紋，不連續要求兩次確認 |

確認綁定這個候選的確切 host／URL 及材料；修改候選即失效。取消或不相符就停止，不提供「仍然繼續」。第一輪未信任的憑證檢視不帶帳密，不能先對候選傳送秘密再補確認。

- 密碼欄位預設不帶值；「更換密碼」後才接受新內容。一般欄位留白不能意外清空秘密。
- 密碼是 opaque 內容，保留空白及 Unicode，不 trim、不正規化，也不因秘密檔案解碼而吃掉 BOM；沿用既有 opaque-secret 的讀取規則。
- 改 server、bind identity 或信任範圍時，不得把既有服務密碼自動送往新目標；需要明確重新輸入／提供那個目標的秘密。僅換 CA 也須確認新信任來源。
- 儲存前重新跑候選連線及管理員資格檢查，不把過去測試結果當永遠有效。未測試或測試失敗仍可保留草稿，但不能套用。
- 候選目錄不得以同名不同 objectId 取代目前管理員。更換管理員使用獨立、經擁有者驗證的移轉流程，不偷藏在「儲存連線」內。
- 有效目錄暫時故障時，畫面保留已顯示資料並可重試，不清空表單，不自動切到新目錄，也不自動把所有資源暫停。
- 本機擁有者可由同一個網頁入口進入明確的修復流程；這不是遠端免登入管理員。CLI 只在備援文件中保留，網頁不指示使用者執行主機指令。

### 持久安全通知

每次成功的實際變更（包含服務密碼輪替）都在下述同一個 SQLite 決策交易記下完整安全通知 outbox，送給**變更前已確定的主機擁有者及其他管理員**，並寫稽核；不是從 audit 事後猜通知。內容只有操作、人、時間及遮罩的變更類別，沒有秘密或完整 DN。純 no-op 不假裝是變更，失敗則保留失敗稽核。

目前 Hub 是單一 configured admin；「其他管理員」表示既有支援且已明確指定的管理員收件者，並不新增角色或把群組成員視為 admin。主機擁有者不是 Hub PersonKey，必須使用明確的主機通知 sink／Needs-you；即使新 AD 無法登入仍能看到。新增 typed security-notice outbox，不能把目錄變更塞進 pairing-notice schema。重啟復原要可冪等送達並顯示待送狀態；通知服務短暫不可用不遺失通知。outbox 保存完整且已遮罩的通知內容（明確寫「已提交／套用中」，不在 mount 成功前假稱已就緒）、變更前收件者的穩定身分／sink、操作與事件 id、建立時間及送達狀態，不只保存通知 id。提交後不再向新目錄查詢「原本應通知誰」。

近期已驗證的管理員 session 若遭竊仍有剩餘風險；短效單次證明、身分連續性、信任確認及獨立擁有者通知降低風險，不能宣稱完全防止已掌握有效 session 的攻擊者。

## 共同設定提交及復原：與 M-2682 的接點

已與 M-2682 作者協調：由他負責 `src/hub/settings-commit.ts` 的共同 `HubSettingsCommit`，先接名稱；本案設計 directory 擴充。預覽不在 seal 摘要中，走原本單檔 Settings save 及相同 writer serialization，不額外重新簽署或套用多檔 journal。**名稱／AD 同一個 writer／journal，不要做第二個簽署器。**

名稱清除的 canonical 表示是 `hub.name` key 不存在，不用空字串或空白字串；簽署摘要、runtime 與 renderer 要一致支援。M-2682 的 strict rename patch 與 private preparation ref 可直接延伸 AD，HTTP 不拿到內部 before/after。新操作 receipt 以 digest 連到 manifest 的 confirmationId，保留 manifest v1 的 strict schema。

共同 helper 已在 [#3426](https://github.com/songsid/AgEnD/pull/3426) 提出；目前 journal v1 只支援 rename。以下是**已有 Hub 重新設定目錄的 v2 擴充要求**，不是宣稱 rename v1 已實作跨 SQLite 交易，也不新增第二個 writer。writer 接受 route 證明的 actor/current；directory route 提供窄的近期 admin 證明或 D3 修復證明。actor 來源明確區分 directory PersonKey 與 host session，不能捏造主機擁有者的目錄身分。

### v2 的唯一提交決定在 Hub SQLite

檔案 rename 與 SQLite 不能成為一個 OS 原子動作。**唯一授權生效點，是現有 Hub 私有資料庫內一個 IMMEDIATE 交易的持久 COMMIT**。新增 `hub_settings_operations` 決策列；檔案 journal v2 只是 prepared／安裝進度的復原索引，自己的 `committed` 字樣或有效 staged signature 都不能授權目錄變更。現有 DB 的 WAL／`synchronous=FULL` 持久性要求繼續適用。

1. **準備、測試及私有 staging（尚未決定）**：驗證完整舊 seal、身分及設定；產生 op id、allowlisted 新設定、新簽署 manifest、私有服務秘密／CA 材料及 receipt。對每個 staged file 及其父目錄 fsync，記下確切內容 hash、材料 revision 與私有 reference。新舊材料分開，尚不覆寫有效檔案。重新驗證 proof、候選、session／config epoch 及期限；所有 LDAP await 都在資料庫交易之外。
2. **同一個 owning-DB 決策交易**：取得共同設定 writer gate，以同一個 Hub DB handle 開 IMMEDIATE 交易，重查 config／manifest／秘密／材料／政策／lifecycle／epoch 的完整 expected image。交易內一起寫入：決策列及其 staged-file hashes／receipt、已驗證的 group binding 和遞增版本、member authorization version、下述 directory/session epoch 與 session transition、必要 audit，以及**完整通知 payload＋變更前收件者快照**。不能用另一個先提交的 DB 或事後非必要 audit／outbox 補寫。
3. **提交前最後檢查與 floor**：沿用現有 transport writer 的 floor-before-audit/DB 規則，不另繞過 floor。必要 audit/outbox 的容量與儲存、精確來源身分、候選期限、角色／session、CAS 任一拒絕，SQL 不提交。必要同步 audit 等 callback 之後，再驗證授權來源仍有效及精確規畫的轉換；最後寫 session/epoch 轉換到 COMMIT 之間沒有 await 或可重入的外部 callback。callback 回傳 thenable 一律拒絕。若 floor 已提升而 SQL 回滾，依既有規則為 uncertain，不能宣稱維持舊服務成功。
4. **唯一決定及發布屏障**：上述 SQL COMMIT 同時授權這個 exact operation 的整組材料、政策／版本、audit 與通知。提交後新 DB head 尚未對應到已安裝並掛載的設定時，所有作用請求由 `mountedGeneration === durableSettingsHead` 屏障拒絕為暫時 unavailable；不能在記憶體舊設定下使用新 DB binding。舊 epoch 的等待請求也不能繼續。僅受保護的設定操作狀態／復原路徑可報告「套用中」。
5. **可冪等的實體完成**：同一 writer gate 下讀取 authoritative DB head，逐個安裝確切決定的 secret/material、manifest 及 config（檔案與父目錄 fsync），每步記進度並驗證；只接受預期的 old/new hashes，不覆寫第三種外部改寫。`rawFleetConfig`／`configHistory.accepted` 及 runtime generation 只在完整新組一致且通過嚴格 verify/mount 後一起發布，才開放作用請求。FleetManager load/save/reload → applyHubSwitches 與 CLI adapter 共用此 gate；目前沒有外部檔案 watcher。
6. **收尾與通知**：以操作／收件者／事件 id 去重派送已持久保存的通知，允許重試與保留待送狀態；不靠 cleanup 成功才記住誰應收到。audit、原操作決策及完整 outbox 早在步驟 2 的同一 COMMIT 已存在。外部 sink 若不支援 exactly-once，以相同 event id 冪等接收／去重，不能宣稱跨外部系統原子送達。

角色、期限及 exact-candidate 檢查都在唯一 SQL COMMIT 前完成。COMMIT 之後是已授權的持久決定，原 session 到期或瀏覽器斷線不會中斷整組檔案的完成；回應權限與實體收尾分開。initialization v1 的 confirmationId 不被冒用：新操作的 receipt digest 綁入新 manifest；`sealHubInitialization()` 仍只是簽章 primitive，不能代替此跨域決策協定。

### 啟動與 crash 復原的判定

所有 mount、session admission 及 member admission 之前，先讀 floor／DB 決策與 material head，再讀檔案索引。**DB 決策完整、floor 一致、通知／audit／binding／epoch 全部齊備，才有資格發布該世代**。

| crash／拒絕所在位置 | 復原規則 |
|---|---|
| staging 或 fsync 前後，DB 未提交且 floor 未提升 | 無授權新決定；完整舊組可繼續。只清理可證明屬於本操作的未提交 staging |
| floor 已提升，audit／outbox／DB 拒絕，或 COMMIT 結果無法證明 | floor 與 DB 不一致或結果不明即 uncertain；拒絕 mount／作用，不降低 floor，不從檔案 marker 猜成功，也不自動補出一個未授權決定 |
| 唯一 SQL COMMIT 已成功，但尚未安裝任何新檔案 | 新通知／audit／政策／epoch 已完整存在；屏障維持關閉，依決策完成 exact 新檔案，不回復舊 DB |
| 任兩個檔案安裝步驟之間，或已完整但尚未 mount | 依 DB head 與每個 old/new hash 冪等續作；舊 staged operation 若已被後續操作取代就不能重播。缺失／不符材料則 uncertain，不強行掛載 |
| mount／發布後、進度更新或通知送達／清理前 | 以 operation head／receipt／event id 證明已完成，保留同一組 audit/outbox 並冪等補派，不重複授權或重發新的事件 |

不存在「檔案 marker 已 committed，但通知或 group binding 可以稍後再補」的成功狀態。一般成功儲存不留下 `hub-unsealed`；不確定的儲存／掛載失敗仍需明確顯示，不能靠放寬 seal/floor 驗證變綠。

### 掛載失敗的補償只往前走

SQL 決定提交後若新 runtime 無法掛載，**不能還原舊資料庫、floor、epoch、session rows、revocation、provenance 或取消紀錄**。原決定仍是已發生的操作，保留其 audit 及全部通知。需要恢復先前連線內容時，建立新的 `directory-compensate` 操作，連到失敗的 op id，使用同一個 v2 決策協定：

- 原已驗證的操作只可預先授權「本次新設定掛載失敗時恢復確切上一組內容」這個窄補償，不能授權任意新目錄；補償只能針對仍是目前 head 的失敗操作。另有更新的設定決定就拒絕 stale 補償，不把它蓋回去。
- 重新讀取**現在**的 floor／DB／政策／撤銷與 provenance。把舊連線及材料內容寫為**新的** generation、秘密／材料 revision、receipt、簽署 manifest 與 binding revision；所有版本／member authorization／session epoch 只能增加，不能安裝舊版本號。前次秘密內容若要重用，也只能以新版本私有材料發布，不能回捲 reference/revision。若原操作只裝到一半，補償的 per-file preimage 只能來自該已授權操作鏈的 old/new hashes，並在新決策中逐檔綁定；未知第三種內容不會因重新拍快照就變合法。
- 群組規則、manual/group provenance、已撤銷 fleet/grant、已暫停資源及已取消工作保留最新狀態；不把原操作前的政策／資源 snapshot 當成可整包恢復的資料。先前失效的 cookies、近期驗證、draft、permit、lease、handshake 不恢復。補償再次失效 sessions 並 fence 工作。
- 原目的地的身分／群組 binding 連續性及材料仍需驗證；不能確認則補償拒絕並顯示 repair-required。補償的 audit 與完整舊收件者通知是新的事件，與原操作並存，說明「已提交但掛載失敗／補償結果」，不抹掉失敗歷史。
- 補償中 crash 仍按新決策 op 冪等續作；floor 已提升但補償 SQL 失敗、未知外部檔案或不符 DB head 都維持 uncertain，**先拒絕 mount 再要求修復**。不自動連續反覆補償，不以重試重設 floor。已提交的補償只能由自己的持久決定完成；舊原操作 worker 必須 recheck head，不能覆寫補償。

名稱正規化及預覽開關的 schema 與 M-2682 共用。CLI 仍可初始化；既有 Hub 的 CLI／網頁目錄設定提交必須使用同一 v2 writer gate，不能繞過上述決策與恢復規則。

### 目錄世代與群組權限不能漏掉

目前 `groupGeneration` 包含 URL、realm、profile、base DN、bind DN、查詢模型及 CA。只重新簽署 manifest，不處理這個 binding，會留下群組政策 `repair-required`。

- 同一身分命名空間內的連線變更，在提交前重查目前管理員及已設定群組的 immutable GUID／來源，並將經驗證的政策 binding 更新納入同一個 durable operation；不把 DN 字串當群組身分。
- 同一決策交易提升 member authorization version，讓舊 permit、lease、等待中的 member 握手失效；依既有 refreshAuthorization 讓 member links 重新連線。**這不會自行使 HubSessions 失效**；瀏覽器使用下面獨立的 durable session/config epoch。
- 未知／部分會員資料仍是 HELD：不開新權限、不因一次 AD 故障改寫或暫停既有資源；只有權威負向或明確政策縮限才能改狀態。保留 manual/group provenance。
- 無法證明既有 namespace／管理員／群組綁定連續時，拒絕一般儲存，原設定保持有效；進入明確的擁有者移轉設計。不得默默清空群組規則、把它關閉，或把舊授權套到另一個目錄。

### 瀏覽器 session 與目錄世代的明確轉換

目前 `HubSessions.session()` 檢查 token row、期限／idle 與 core lifetime，**不比較 transport.revocationVersion**。v2 必須新增持久的 `directoryEpoch`／`configGeneration`（在 authoritative settings head），並在 `hub_sessions` 記錄對應 epoch；不能只假設 remount 或 member refresh 會涵蓋瀏覽器。session schema 的 epoch 是必要欄位，缺少或不符就拒絕，不提供 legacy fallback；新 schema/component 也必須讓不支援它的舊 binary 拒絕。

- 每個 cookie 認證都同時比較 session row 的 epoch、DB head 及 mounted generation。request context 在建立時捕捉 epoch；`current()`、`isCurrent`、requirePerson/Admin、effect 前的交易斷言、近期驗證及所有 draft/confirmation 證明都要重查這個捕捉值，不能 await 後自動改綁新世代。即使候選中的 PersonKey 相同也一樣。
- `signIn` 在 LDAP await 前捕捉來源 epoch，回來後及寫 session 的交易中再比對；跨世代的登入結果不得在新世代鑄造 cookie。重啟後也只讀 durable epoch，不靠記憶體 flag。
- 與目錄變更同一個決策交易，提升 epoch 並終止所有舊 epoch session rows；近期驗證及草稿隨 epoch 不符失效。舊請求／SSE／背景操作立即被屏障或 current fence 阻擋，再實體關閉；不能讓異步收尾窗口繼續執行效果。
- **操作者不多按一次確認**：已有 fresh-admin 證明且候選 exact immutable admin 相同時，可在這個同一交易做一筆明確的 session rotation：結束原 session，產生新 id／新 token hash／新 CSRF 對應的新 epoch row。新 token 僅在這次請求的記憶體，絕不放 journal/outbox；只有 exact operation 已完整安裝、掛載且新 session 仍有效時，原連線的完成回應才 Set-Cookie 並更新頁內 CSRF。它是對本次已認證操作者的窄 transition，不把其他舊 sessions 搬過去，也不把已消耗的舊 epoch 近期驗證 proof 延續為新目錄的再次儲存權限；新 session 的普通作用仍走新目錄的新鮮 eligibility。
- 提交後的完成回應只可回傳該 op receipt／結果，不能以已失效的舊 `ctx.requireAdmin` 再啟動其他動作或把舊 current() 視為仍有效。若 crash／斷線導致新 cookie 未送達，變更仍按持久決定完成；重開頁面正常重新登入即可，不能靠舊 cookie 取回新 token。D3 修復路徑不製造任何 Hub admin session。
- 初次 setup 仍只指定 PersonKey，**不建立虛構管理員 session**；由本人之後登入。若補償發生，先前 rotation 的新 row 也失效，不能讓恢復舊連線內容復活舊登入。

## 草稿、錯誤與稽核

- 所有草稿有短期限、session 綁定、數量及大小上限。一次載入不會自動發出多組 LDAP 查詢；同一測試內共用已持有的實體查詢，沿用現有目錄工作配額，取消後等實體工作結束才釋放。
- 密碼不放 cookie、localStorage、sessionStorage、URL、log、audit 或錯誤內容；API 不回傳 bindPasswordRef／私有檔案位置。過期、取消、斷線及完成後清掉記憶體秘密與私有暫存。
- busy/429 依 Retry-After 顯示「目前忙碌，稍後自動重試」，保留已輸入欄位；不把額滿當密碼錯誤。進度由同一頁顯示，不增加另一條不受管理的 SSE。
- 稽核記錄操作 id、來源（host-session 或 configured-directory-admin）、所選穩定身分、設定版本與成功／失敗原因碼；有 prepare/test/commit/recovery 的關聯。完成事件與 durable operation 以 outbox／idempotent 設計避免重複或漏寫。
- 稽核不包含密碼、完整 DN、原始 bind/search 診斷、秘密 hash、私鑰或未遮罩的設定差異。管理員可看必要的連線欄位，但匯出支援資料要遮罩。

## 擬議 HTTP 邊界

初始設定只在主機 fleet listener 的 `/api/settings/hub/setup/*`，由既有 host-session、CSRF、same-origin gate 包住 `inspect / prepare / inspect-ca / fetch-ca / test / resolve-admin / commit / resume`。沒有 Hub admin 前，Hub listener 不掛一個公開初始化器。

已有 Hub 的 `/hub/v1/admin/settings/directory/*` 提供 `read / prepare / inspect-ca / test / reauthenticate / apply`；都由 configured-admin session、same-origin、CSRF（寫入）及操作專屬的近期驗證／信任確認保護。主機 fleet 的 `/api/settings/hub/directory/*` 是 D3 修復 adapter，不複製 Hub cookie，也不開放遠端 owner token 代用。兩者都走共同提交器，不直接寫 YAML。回應只有 opaque draft、expiry、revision、遮罩摘要、測試狀態及秘密是否已設定，不回傳內部 before/after、個人密碼或秘密參照。精確路由待實作拆分時鎖定；本設計不新增目前可呼叫的 endpoint。

## 驗收與拆分

1. **共用提交基礎（M-2682 協作）**：v2 唯一 SQLite 決策、同 DB 的 group binding/version／sessions／audit／完整 outbox、writer serialization、staging/fsync 及檔案安裝。對 staging→floor→audit/outbox→SQL COMMIT→每個 file install→mount/publish→delivery/cleanup 的每個邊界前後注入 crash，驗證未提交不授權、已提交完整重播、事件不漏不重、第三種檔案拒絕與 post-floor failure uncertain；不能用一個成功 stub 冒充跨域原子性。
2. **web bootstrap adapter**：fake LDAPS＋真 fleet HTTP listener，完成與 CLI 相同的 state set、簽章、權限與 schema；CLI fallback 仍可獨立初始化。中斷續作不換人、不覆寫已存在的 identity。
3. **AD 設定頁**：舊目錄近期重新驗證、候選測試、write-only secret、CA／host consent、同 key 管理員檢查、群組世代與安全 outbox，與名稱／預覽共用寫入序列。測實際 FleetManager load/save/reload 發布，不只測 helper 回傳。
4. **UI 驗收**：沿用 PageHead、`.s-section-layout`、`.card`、`.field`、`.grid2`、`.btn`、`.tag` 及共用 loading/error 元件；桌機／手機、EN／zh-TW、明／暗色；長值、無橫捲、無多餘確認、無主機指令。
5. **拒絕與競態**：bare loopback、header token、LAN、guest、gateway、D3 session 過期／撤銷、CSRF；CA mismatch/expired/hostname、錯誤帳密、含糊／停用管理員、lookup 超額、逾期 draft、並行 CLI／rename／AD、稽核拒絕、程序 crash、取消仍在實體 LDAP 工作中。
6. **權限效果**：更換連線不授予一般目錄使用者主機能力；舊 session/permit 失效；群組 unknown 不變成正向或大量暫停；未啟用政策仍維持原來語意。
7. **保密與 SKEW**：新舊前端互不放寬；能力標記不存在時不顯示可儲存的控制。API schema、audit/log/DOM/支援匯出都不含秘密；提交中舊頁顯示 conflict/refresh，不猜測已成功。
8. **新增 admin 改 AD 的反向案例**：沒有近期驗證、錯誤舊目錄密碼、驗證中撤銷 session、候選冒用同名 GUID、持有驗證跨過期限、信任確認後換 host／材料，一律不提交。確認個人密碼只到舊目錄、新目的地不重用舊 bind secret；同 CA 換 host 仍出現一次確認，同 host 一般編輯不出現確認；通知隨提交／crash recovery 保留並冪等送達主機擁有者。

9. **補償反向控制**：新設定 failed remount、補償每步 crash、floor 已升／DB 拒絕、原操作後新增 revoke／explicit deny，再補償。要求 head／floor／epoch 嚴格前進，原 audit/notices 與新補償事件都保留，revocation/provenance 不倒退，舊 session／permit／lease／取消工作不復活；補償不確定先 hold。
10. **真實 HubSessions／HTTP 路徑**：原 cookie／近期驗證／held request 在目錄提交及 restart 後都被拒，即使是相同 PersonKey；member version 單獨變更不能被當作 session invalidation 證據。測原登入 await 跨 commit、actor rotation 成功及新 CSRF、回應前 crash/斷線需重新登入、補償不復活 rotation、初次 setup 無 session。不能只 mock `current()` 或只驗 member reconnect。

所有設計與驗收先用假的目錄、人物及私有安裝。沒有核准前不碰實際目錄、試用 Hub 或系統信任庫。圖稿只代表排版與文案，不是連線或初始化的執行證據。

## 請使用者確認的方向

1. 初次設定限定這台電腦的擁有者頁面；以「完成設定」一次確認，不再要求終端機操作。名稱可略過，只顯示 AgEnD Hub；核准後同步改 CLI／initializer 的必填行為。
2. **使用者已決定：Hub 管理員可改 AD**，限近期舊目錄驗證＋新連線同一不可變身分；每次變更通知擁有者與其他管理員。這不授予一般主機權限；跨 realm／ID 模型或管理員移轉仍是獨立流程。
3. **已釐清：CA 或伺服器 host／URL 變更都有一個確認**；同 CA 換 host 顯示新 host＋leaf 指紋，同 host 的 base DN／服務帳號／密碼／filter 編輯不多確認。新目的地不重用舊 bind 密碼；測試失敗保留原服務，沒有「略過驗證」。
4. 名稱、預覽、AD 設定共用可復原的提交路徑；資料／身分不重建。更換整個目錄的移轉不假裝等同改一個網址，另列清楚的影響與流程。

本次更新先供使用者看實際 shell 內的設計，再由 Prism 安全審查；實作核准前只有設計與圖片。之後依上述順序拆小 PR 並送 parity review。
