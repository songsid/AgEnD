# 使用 Cloudflare Tunnel 固定公開網址

AgEnD 的儀表板公開連結可選用 Cloudflare 遠端管理 tunnel 的連接器
token。重新開啟連結時仍使用同一個網域，手機「加到主畫面」便不必重新
儲存網址。未設定網域時，維持原本隨機網址的 quick tunnel。

仍照常從 AgEnD 選單開啟公開連結，並遵守關閉、登入驗證及工作階段撤銷規則。
設定固定網域時，期限可以比 quick tunnel 的 1–480 分鐘更長：最多 10080
分鐘（7 天），或設 `0` 代表不到期。到期或 fleet 重啟後，重新開啟即可使用
相同網址；也可以用 `auto_open` 讓 AgEnD 在重啟後自動重開（見
[更長的期限與重啟後自動重開](#更長的期限與重啟後自動重開)）。登入終端機
與預覽 tunnel 維持原本各自的行為。

## 在 Cloudflare 建立 tunnel

需要由 Cloudflare DNS 管理的網域，以及本機可用的 cloudflared；AgEnD
仍可照常安裝其固定版本。不需要提供 Cloudflare API key 或 DNS 編輯權限。

1. 在 Cloudflare 後台開啟 **Networking → Tunnels → Create a tunnel**，
   建立遠端管理的 Cloudflared tunnel。在名稱欄位**自行輸入任意名稱**，
   例如 `agend-home`，不需要從清單選取。部分帳號的入口在
   Cloudflare One → Networks → Connectors。
2. 從連接器安裝指令中，僅複製**以 `eyJ` 開頭的長字串 token**。Windows
   顯示的指令可能是 `cloudflared.exe service install eyJ…`：token 在
   `service install` 後面，沒有 `--token`。其他指令範例則可能把 token 放在
   `--token` 後面。無論哪一種，都只把該長字串貼入 AgEnD，不含指令、旗標、
   空白或引號。不要執行這行安裝指令，也不要另外安裝此 tunnel 的 cloudflared
   系統服務；連接器程序由 AgEnD 管理。請為這台主機使用獨立 tunnel。
3. 回到 **Networking → Tunnels**，點開剛建立的 tunnel（本例為
   `agend-home`），再進入**這個 tunnel 自己的 Routes 分頁**，選
   **Add route → Published application**。不要進入帳號層級的
   **Networks → Routes**；那一頁是私人 IP／CIDR 路由，不是這次設定的位置。
   選擇子網域與網域，例如 `agend.example.com`。
4. 在 **Add published application** 視窗的單一 **Service URL** 欄位，
   完整填入 **`http://127.0.0.1:19282`**，包含前面的 `http://`，不需要另找
   Type 下拉選單。**尾端不可加 `/`，也不可加路徑。** 路由的 Path 欄位留空，
   HTTP Host Header 不要覆寫，最後按 **Add route** 儲存。這是有路由限制的
   公開 gateway，**不要指向主網頁的 19280 port**。若 19282 已被使用，請在
   後台與 AgEnD 一起改用另一個連接埠。

若填入 `http://127.0.0.1:19282/` 後出現
「Validation failed: http://127.0.0.1:19282/ is an invalid address, ingress rules don't support proxying to a different path on the origin service」，
請刪掉最後的 `/`，讓 Service URL 恰好是 `http://127.0.0.1:19282`。

後台名稱可能調整，請參考 Cloudflare 官方的
[建立教學](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
與[啟動參數](https://developers.cloudflare.com/tunnel/reference/run-parameters/)。

## 在 AgEnD 設定

從直接連線、已登入的儀表板開啟「設定 → Web」，不要透過公開連結設定：

1. 在「固定公開網域」填 `agend.example.com`，亦可填
   `https://agend.example.com/`。不可使用萬用字元、IP、連接埠、路徑、
   查詢參數、帳密或 fragment。
2. 「Named tunnel 本機連接埠」填 19282，或前一步使用的連接埠。有效的修改
   會立即列在底部固定的「尚未套用」提示列，按「套用變更」；若出現確認
   要求，請確認。不需要先按「檢視變更」。
3. 在遮蔽的「Cloudflare 連接器 token」欄貼入 token，按「設定 token」並
   確認。儲存時只檢查格式，實際憑證與路由會在開啟時驗證。
   貼上時會移除前後空白與成對引號；只接受單一 base64/base64url 連接器
   token，不接受完整指令或 `--token` 旗標。解碼後的 JSON 必須包含帳號、
   tunnel UUID 與編碼的 tunnel secret。格式不符時會提示：
   「請只貼上以 eyJ 開頭的長字串。」
4. 從 AgEnD 選單開啟公開連結。AgEnD 必須經由固定 HTTPS 網域取得本次
   exposure 的專屬 marker，才會提供登入網址。接著用手機登入並加到主畫面。

設定檔僅保存 secret 的參照，不保存 token 本身：

```yaml
web:
  public_link:
    hostname: agend.example.com
    tunnel_token_env: AGEND_CLOUDFLARE_TUNNEL_TOKEN
    origin_port: 19282
    ttl_minutes: 120      # 有網域時 1–10080，或 0 = 不到期
    protocol: http2
    auto_open: false      # true：AgEnD 啟動後自動重開（僅限固定網域）
```

Token 存於既有的 `~/.agend/.env`（或目前的 AGEND_HOME），使用原子寫入，
Unix 權限為 0600。設定頁只能設定、清除及查詢是否已設定，無法讀回內容。
Token 只透過該 cloudflared 子程序的 `TUNNEL_TOKEN` 環境變數傳入，不放進
命令列。Named 模式的原始子程序診斷文字不會對外顯示；AgEnD 只將它分類
為固定的安全原因，不回顯廠商輸出或憑證。同一 OS 帳號的
程序仍可能讀取私密檔案或環境變數；這不是共用 OS 帳號之間的隔離機制。

變更或清除 token、變更 named 設定時，都會關閉目前的公開連結，之後請
重新開啟。「清除 token」會清空值，並在 `.env` 保留空值覆寫，防止上層服務的舊環境變數在重啟後恢復；要恢復 quick tunnel，亦須清空
網域並套用設定。若網域已填卻缺 token，會失敗，不會偷偷改開隨機網址。
Port 被占用、token 錯誤、路由錯誤或取得其他頁面的 marker 時，也不會開放
公開存取。請檢查後台路由、port 與 token 後再試。Cloudflare Access 可作為
額外保護，但若 `/signin` 被 Access 驗證頁攔截，AgEnD 的 marker 驗證會
失敗；配置此類規則時須考慮這個限制。

## 更長的期限與重啟後自動重開

僅限固定網域（quick tunnel 每次開啟網址都會變，所以維持 1–480 分鐘，也不會
自動開啟）：

- **`ttl_minutes`** 可設 1–10080（7 天），或 **`0` = 不到期**：連結會一直
  開著，直到被關閉（「關閉」、`/web revoke`）、named 設定或 token 變更、
  關閉公開連結功能，或 AgEnD 停止。此時 `/web` 與私送的登入訊息會顯示
  「不會到期」而非時間。期限在開啟時決定：修改後的期限從下次開啟起生效；
  要結束目前的連結，請按「關閉」。
- **`auto_open: true`**（預設 `false`）會在 AgEnD 啟動後——網頁伺服器開始
  監聽、聊天連線就緒後——替上次用 `/web` 開啟 named 連結的管理員重新開啟
  一次，並做與手動開啟相同的就緒檢查。不會發任何訊息，也不會送出登入碼：
  登入頁仍需登入碼。可以用 `/web` 取得（會加入已開啟的連結，私下送出網址
  與登入碼），或由曾登入過的瀏覽器（例如手機主畫面捷徑）在登入頁索取，
  登入碼會私訊給你。
- 在管理員至少用 `/web` 開過一次 named 連結之前，或該管理員已不是那個
  General 的 fleet 管理員時，都不會自動重開。按 **「關閉」** 或
  **`/web revoke`** 後，直到下次 `/web` 前也不會自動重開，所以重新啟動不會
  推翻刻意的關閉。
- 重開失敗會寫入 log，並再試兩次（30 秒與 2 分鐘後，等待網路就緒）。仍然
  失敗時，會以私訊通知該管理員一次，顯示失敗的步驟（與 `/web` 相同）；
  請執行 `/web` 再試。

在設定 → Web 中，填入網域後，分鐘數欄位可設 0–10080，並出現
**「AgEnD 啟動時重新開啟公開連結」** 勾選框。若清空網域時分鐘數超過 480、
為 `0`，或已勾選 `auto_open`，在調整為 quick tunnel 可接受的值之前都無法
儲存。

不到期的連結在開啟期間都可以從網際網路連到：任何知道網址的人都能看到登入
頁。登入仍需只會私下送給管理員的單次登入碼，而且每次經由連結登入都會像
以前一樣在 General 公告。

**透過連結授權瀏覽器（#2453），需自行開啟。**
`web.verified_authority.named_link: true` 讓透過你的網域登入的瀏覽器也能使用
**授權此瀏覽器**（見 web-dashboard：agent 看到的是誰）。
- **預設關閉。** 開啟時需在 General 或這台電腦上確認。
- **只認這個確切的網域。** Quick tunnel 另有自己的選項 `quick_link`
  （見 web-dashboard）。
- **授權隨連結結束：** 按「關閉」、`/web revoke`、到期、重新啟動
  （`auto_open` 重新開啟算新的連結），或關閉這個選項。

## 開啟失敗時

`/web` 與網頁設定中的公開連結控制會顯示失敗步驟及原因。固定 tunnel 的
訊息只使用預先定義的文字，不顯示連接器原始輸出、token 或識別資訊。
請依原因檢查後重新開啟：

| 原因 | 下一步 |
| --- | --- |
| 連接器 token 被拒絕 | 只複製以 `eyJ…` 開頭的長字串，再按「設定 token」。 |
| 沒有連到公開應用程式 | 檢查該 tunnel 自己的 Routes 分頁、網域與 DNS。 |
| 傳回了其他頁面 | 將公開應用程式指向 `http://127.0.0.1:19282`，並檢查重新導向或 Cloudflare Access 驗證頁。 |
| 本機來源無法連線 | 檢查 Service URL，確認路由與 AgEnD 使用相同的本機連接埠。 |
| 無法連上 Cloudflare | 檢查網路、DNS 與防火牆後重試。 |
| 本機來源連接埠已占用 | 關閉衝突的程式，或同時修改 AgEnD 與 Cloudflare 路由的連接埠。 |

Readiness 驗證失敗時不會開放連結。無法分類的錯誤只顯示通用的檢查步驟，
不洩漏任意連接器輸出。儲存 token 只做本機格式檢查，不代表 Cloudflare
已接受憑證；開啟連結時才會確認憑證與路由。

## 使用自己的 Cloudflare 帳號驗收

開發測試只使用 stub，沒有連線真實 tunnel。請以自己的帳號檢查：

1. 開啟 named 連結並登入；其他未登入的瀏覽器仍須驗證。將網址加到手機
   主畫面。
2. 關閉後重新開啟：網域相同、舊 exposure 的工作階段已撤銷，原捷徑可開啟
   新的登入頁。
3. 到期或重啟後應維持關閉；重新開啟後，同一個捷徑仍可使用，不必儲存新網址。
   設 `ttl_minutes: 0` 時，`/web` 應顯示「不會到期」；設 `auto_open: true`
   時，重新啟動 AgEnD 後不執行 `/web`，捷徑的登入頁也應能載入，且仍要求
   登入碼。
4. 測試錯誤網域、路由或 token：開啟必須失敗，不可把未驗證的網址視為可用。
   恢復正確設定後再開啟。
5. 設定 API、聊天及 log 都不能出現 token。Linux 可在本機檢查自己啟動的
   cloudflared 命令列：應有 `run`，不能有 `--token` 或 token 內容。不要
   分享 `/proc/.../environ` 或 `.env`。
6. 清除 token 與網域、套用後再開啟，應恢復原 quick tunnel 行為。若網路已
   遭 Cloudflare 限流，避免反覆進行真實 quick tunnel 測試。

[English](named-tunnel.md)
