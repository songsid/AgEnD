# Hub 網頁首次設定與 AD 連線設定（alpha.9 設計草案）

狀態：**只供使用者審閱；尚未核准實作**。M-2687。M-2682 負責名稱、品牌顯示、預覽開關與資訊頁；兩者使用同一個設定提交及復原機制。這份設計不會更動正在執行的試用 Hub。

## 給使用者看的摘要

- 第一次在 **這台電腦的 AgEnD → 設定 → Hub → 建立 Hub** 完成設定。入口必須是 AgEnD 自己開啟的主機擁有者登入工作階段；知道網址或能連到本機位址並不算取得權限。
- 網頁依序填基本資料、AD 連線與管理員，檢查成功後按「完成設定」。不用另外到終端機輸入確認指令，也不用提供管理員的個人 AD 密碼來完成安裝。
- AD 頁面可測試連線、匯入或取得 CA、比對指紋，以及更換服務帳號密碼。**密碼只寫入、不回傳；留白不會把既有密碼清空。**
- 已有 Hub 的 AD 狀態顯示在 **Hub 管理 → 設定 → AD 連線**。會改變登入信任來源的設定，由主機擁有者在 **這台電腦的設定 → Hub → AD 連線** 修改。先測試新設定，成功後再整批套用；失敗時原設定繼續運作，不會只改一半而讓 Hub 停住。
- 首位管理員以目錄中不可變的身分指定，之後由那個人自己在 Hub 登入。改帳號顯示名稱不會換人，重新建立同名帳號也不會繼承管理權限。
- CLI 初始化保留為備援；網頁與 CLI 共用初始化器，不另外做一套較寬鬆的安裝方式。

圖片為模擬資料的設計稿，不是實機截圖。圖中不使用任何試用環境的位址、帳號、憑證或目錄資料。

## 目前的問題與既有程式

基準：alpha `9b06e6bd`。目前 `HubInitializer` 已有檢查、確認、提交、續作；網頁尚未提供完整首次設定。`hub.name`、目錄連線、初始保留政策等欄位在 `normalizedHubSettings()` 的簽署摘要內。直接改 YAML 會讓 `verifyHubInitialization()` 拒絕掛載；重新啟動不會修復摘要不一致。名稱另外受到 `settingsOf()` 非空字串檢查。

既有保留政策與瀏覽器憑證已有網頁控制，修改的是資料庫中的有效政策或憑證選擇，不是直接改原本被簽署的設定。不要把這兩種路徑混成「改設定檔後重啟」。

沿用：`src/authority/web-authority.ts`、`src/hub/init/{types,initializer,identity,plan-digest}.ts`、`src/hub/{initialization,mount,runtime}.ts`、`src/hub/compose/server.ts`。CA 信任沿用 `docs/design/hub-directory-ca-bootstrap.md`；管理員沿用 `hub-first-admin.md`；樣式沿用 `ui-style-guide.md`。

## 權限與入口

| 操作 | 權限與所在畫面 | 拒絕的情況 |
|---|---|---|
| 尚無 Hub 的檢查、測試、指定管理員、完成設定、續作 | 主機 fleet 的設定頁；每次請求都必須通過 `hostSessionHere(session, req)` | 沒有登入、只有標頭 token、只有 loopback、LAN/遠端、guest、gateway/公開連結、過期或撤銷的工作階段 |
| 已有 Hub 的名稱、預覽與一般資訊 | M-2682 的 Hub 管理頁；使用該操作既有的角色規則 | 一般目錄使用者不得取得設定寫入權限 |
| AD 連線、服務秘密及 CA 調整 | 主機擁有者在 fleet 設定頁，仍須 `hostSessionHere`／D3；候選目錄重新確認管理員的相同不可變身分。Hub 管理頁提供遮罩狀態，不提供遠端寫入能力 | Hub 管理員 cookie 本身不是主機權限；新目錄中同名不同人、無法確認資格、失效工作階段、錯誤 CA 或連線失敗 |
| 改 realm、不可變 ID 模型、管理員身分，或遺失目錄時復原 | 主機擁有者在本機網頁的受保護移轉流程；不能由一般「儲存連線」順便完成 | 不得把同名登入或任意 GUID 當作管理權限證明；不得自動重設管理員 |

此權限分工已與 M-2682 作者協調，仍要讓使用者審閱；不把 Hub 管理員擴大成主機擁有者。不把 host cookie 複製到 Hub origin，不因為同一個瀏覽器已登入 AD 就視為主機登入。共同提交器只能接受操作專屬 gate 產生的能力，不能接受客戶端傳入 `isAdmin: true`。

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

Hub 管理的「設定 → AD 連線」顯示目前連線、CA 狀態、最近測試結果及設定版本。主機擁有者的 fleet「設定 → Hub → AD 連線」提供編輯；不是擁有者的畫面不提供會失敗的儲存按鈕。修改尚未測試時清楚標示「尚未儲存」。測試草稿不改目前有效服務。

- 密碼欄位預設不帶值；「更換密碼」後才接受新內容。一般欄位留白不能意外清空秘密。
- 密碼是 opaque 內容，保留空白及 Unicode，不 trim、不正規化，也不因秘密檔案解碼而吃掉 BOM；沿用既有 opaque-secret 的讀取規則。
- 改 server、bind identity 或信任範圍時，不得把既有服務密碼自動送往新目標；需要明確重新輸入／提供那個目標的秘密。僅換 CA 也須確認新信任來源。
- 儲存前重新跑候選連線及管理員資格檢查，不把過去測試結果當永遠有效。未測試或測試失敗仍可保留草稿，但不能套用。
- 候選目錄不得以同名不同 objectId 取代目前管理員。更換管理員使用獨立、經擁有者驗證的移轉流程，不偷藏在「儲存連線」內。
- 有效目錄暫時故障時，畫面保留已顯示資料並可重試，不清空表單，不自動切到新目錄，也不自動把所有資源暫停。
- 本機擁有者可由同一個網頁入口進入明確的修復流程；這不是遠端免登入管理員。CLI 只在備援文件中保留，網頁不指示使用者執行主機指令。

## 共同設定提交及復原：與 M-2682 的接點

已與 M-2682 作者協調：由他負責 `src/hub/settings-commit.ts` 的共同 `HubSettingsCommit`，先接名稱；本案設計 directory 擴充。預覽不在 seal 摘要中，走原本單檔 Settings save 及相同 writer serialization，不額外重新簽署或套用多檔 journal。**名稱／AD 同一個 writer／journal，不要做第二個簽署器。**

名稱清除的 canonical 表示是 `hub.name` key 不存在，不用空字串或空白字串；簽署摘要、runtime 與 renderer 要一致支援。M-2682 的 strict rename patch 與 private preparation ref 可直接延伸 AD，HTTP 不拿到內部 before/after。新操作 receipt 以 digest 連到 manifest 的 confirmationId，保留 manifest v1 的 strict schema。

1. **Prepare**：操作各自驗證角色、session、CSRF；以完整已驗證的舊設定與 manifest 為基底，產生 allowlisted candidate。保留所有無關設定，拒絕替被手動竄改的舊設定重新背書。
2. **Stage / test**：秘密及 PEM 只在私有暫存，UI 只持有 opaque draft id。新舊材料分開，不能先覆寫有效 bind secret。測試成功後繫結 draft、actor、來源 session、設定／秘密／manifest 版本及期限。
3. **Commit**：取得全安裝共同的設定 writer gate。再查現有完整 image/CAS、角色、期限及必要的候選資格；產生新操作來源紀錄及 Ed25519 簽章。名稱只能改名稱，AD 操作只能改已核准的 AD 範圍；客戶端不能要求任意欄位或任意 planDigest。
4. **Durable generation**：config、secret reference、manifest 是多個檔案，不能宣稱單次 rename 就全部原子。使用私有可復原 journal 與新舊世代材料；序列化 FleetManager 的 load/save/reload → applyHubSwitches 發布（目前沒有外部檔案 watcher），在完整 commit 點前持續服務舊的不可變設定；完成後一次發布新世代。
5. **Recovery before mount**：程序啟動或重新載入時先復原 journal，再執行嚴格的 seal 檢查與掛載。以明確 durable commit marker 判斷：未提交世代回復完整舊組；已提交世代完成完整新組，不能僅憑 staged signature 有效就自動套用。檔案與父目錄都需 fsync。讀到不預期的外部改寫時拒絕覆蓋並顯示可修復狀態，不重新產生信任。
6. **Publish**：候選服務已完成所有可提前的檢查後才 remount；實際交接仍須釋放舊 listener。正常成功儲存不留下 `hub-unsealed` hold。若最後掛載失敗，只能依 journal 回到已知一致的上一世代，清楚顯示失敗；不能假稱已套用或用關閉驗證來維持綠燈。

所有可撤銷的角色及期限檢查在 durable commit marker 之前完成；marker 前取消就不生效。marker 寫下後是已授權的持久決定，後續 session 過期不能讓兩個檔案安裝一半就停止；仍須完成／復原整組世代，回應權限與實體收尾分開。若完成後掛載失敗而需要回到舊組，需另有明確且可稽核的補償狀態，不能把已提交的決定假裝成未發生。

`sealHubInitialization()` 只是既有 issuer 的簽章 primitive，不提供上述交易。初始 manifest 的 confirmationId 代表初始化確認；新的 rename／AD 操作須有可稽核且明確的網頁來源，不能冒稱當年主機擁有者再次確認。

共同 helper 的角色檢查由不同操作傳入的窄能力決定，不讓目錄使用者藉 rename 取得重新指定管理員或重設 CA 的能力。名稱正規化及預覽開關的精確 schema 與 M-2682 共用。CLI 仍可初始化；CLI 與網頁寫入必須遵守同一把 writer gate，不能各自提交。

### 目錄世代與群組權限不能漏掉

目前 `groupGeneration` 包含 URL、realm、profile、base DN、bind DN、查詢模型及 CA。只重新簽署 manifest，不處理這個 binding，會留下群組政策 `repair-required`。

- 同一身分命名空間內的連線變更，在提交前重查目前管理員及已設定群組的 immutable GUID／來源，並將經驗證的政策 binding 更新納入同一個 durable operation；不把 DN 字串當群組身分。
- 需要提升全域 authorization version，讓舊 permit、lease、等待中的握手及舊 session/config epoch 不能繼續使用；依既有 refreshAuthorization 語意讓 member links 重新連線。
- 未知／部分會員資料仍是 HELD：不開新權限、不因一次 AD 故障改寫或暫停既有資源；只有權威負向或明確政策縮限才能改狀態。保留 manual/group provenance。
- 無法證明既有 namespace／管理員／群組綁定連續時，拒絕一般儲存，原設定保持有效；進入明確的擁有者移轉設計。不得默默清空群組規則、把它關閉，或把舊授權套到另一個目錄。

## 草稿、錯誤與稽核

- 所有草稿有短期限、session 綁定、數量及大小上限。一次載入不會自動發出多組 LDAP 查詢；同一測試內共用已持有的實體查詢，沿用現有目錄工作配額，取消後等實體工作結束才釋放。
- 密碼不放 cookie、localStorage、sessionStorage、URL、log、audit 或錯誤內容；API 不回傳 bindPasswordRef／私有檔案位置。過期、取消、斷線及完成後清掉記憶體秘密與私有暫存。
- busy/429 依 Retry-After 顯示「目前忙碌，稍後自動重試」，保留已輸入欄位；不把額滿當密碼錯誤。進度由同一頁顯示，不增加另一條不受管理的 SSE。
- 稽核記錄操作 id、來源（host-session 或 configured-directory-admin）、所選穩定身分、設定版本與成功／失敗原因碼；有 prepare/test/commit/recovery 的關聯。完成事件與 durable operation 以 outbox／idempotent 設計避免重複或漏寫。
- 稽核不包含密碼、完整 DN、原始 bind/search 診斷、秘密 hash、私鑰或未遮罩的設定差異。管理員可看必要的連線欄位，但匯出支援資料要遮罩。

## 擬議 HTTP 邊界

初始設定只在主機 fleet listener 的 `/api/settings/hub/setup/*`，由既有 host-session、CSRF、same-origin gate 包住 `inspect / prepare / inspect-ca / fetch-ca / test / resolve-admin / commit / resume`。沒有 Hub admin 前，Hub listener 不掛一個公開初始化器。

已有 Hub 的 `/hub/v1/admin/settings/directory` 提供管理員可讀的遮罩狀態；寫入操作在主機 fleet 的 `/api/settings/hub/directory/*`，由本機擁有者 gate 提供 `read / prepare / test / apply`，透過共同提交器，不直接寫 YAML。回應包含 opaque draft、expiry、revision、遮罩摘要、測試狀態及秘密是否已設定，不回傳內部 before/after 或秘密參照。精確路由待實作拆分時鎖定；本設計不新增目前可呼叫的 endpoint。

## 驗收與拆分

1. **共用提交基礎（M-2682 協作）**：有效舊 seal、窄操作、CAS、writer serialization、journal/recovery、稽核及正常 reload。測 crash 在每個檔案寫入點，不用一個 stub 冒充多檔原子性。
2. **web bootstrap adapter**：fake LDAPS＋真 fleet HTTP listener，完成與 CLI 相同的 state set、簽章、權限與 schema；CLI fallback 仍可獨立初始化。中斷續作不換人、不覆寫已存在的 identity。
3. **AD 設定頁**：候選測試、write-only secret、CA consent、同 key 管理員檢查、群組世代處理，與名稱／預覽共用寫入序列。測實際 FleetManager load/save/reload 發布，不只測 helper 回傳。
4. **UI 驗收**：沿用 PageHead、`.s-section-layout`、`.card`、`.field`、`.grid2`、`.btn`、`.tag` 及共用 loading/error 元件；桌機／手機、EN／zh-TW、明／暗色；長值、無橫捲、無多餘確認、無主機指令。
5. **拒絕與競態**：bare loopback、header token、LAN、guest、gateway、D3 session 過期／撤銷、CSRF；CA mismatch/expired/hostname、錯誤帳密、含糊／停用管理員、lookup 超額、逾期 draft、並行 CLI／rename／AD、稽核拒絕、程序 crash、取消仍在實體 LDAP 工作中。
6. **權限效果**：更換連線不授予一般目錄使用者主機能力；舊 session/permit 失效；群組 unknown 不變成正向或大量暫停；未啟用政策仍維持原來語意。
7. **保密與 SKEW**：新舊前端互不放寬；能力標記不存在時不顯示可儲存的控制。API schema、audit/log/DOM/支援匯出都不含秘密；提交中舊頁顯示 conflict/refresh，不猜測已成功。

所有設計與驗收先用假的目錄、人物及私有安裝。沒有核准前不碰實際目錄、試用 Hub 或系統信任庫。圖稿只代表排版與文案，不是連線或初始化的執行證據。

## 請使用者確認的方向

1. 初次設定限定這台電腦的擁有者頁面；以「完成設定」一次確認，不再要求終端機操作。名稱可略過，只顯示 AgEnD Hub；核准後同步改 CLI／initializer 的必填行為。
2. AD 伺服器、帳密與 CA 會改變登入信任來源，所以由主機擁有者在本機網頁修改；Hub 管理員可讀狀態，但不因此獲得主機權限。跨 realm／ID 模型或管理員移轉走明確的影響預覽／移轉流程。
3. 新目的地不重用舊 bind 密碼；未知 CA 必須比對指紋。測試失敗保留原服務，不提供「略過驗證」。
4. 名稱、預覽、AD 設定共用可復原的提交路徑；資料／身分不重建。更換整個目錄的移轉不假裝等同改一個網址，另列清楚的影響與流程。

使用者確認方向後，依上述順序拆小 PR 並送 parity review；在此之前只有設計與圖片。
