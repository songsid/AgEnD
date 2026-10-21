# 使用 Cloudflare Tunnel 固定公開網址

AgEnD 的儀表板公開連結可選用 Cloudflare 遠端管理 tunnel 的連接器
token。重新開啟連結時仍使用同一個網域，手機「加到主畫面」便不必重新
儲存網址。未設定網域時，維持原本隨機網址的 quick tunnel。

固定的是網址，不是公開存取的期限。仍須從 AgEnD 選單開啟公開連結，並遵守
原有的 1–480 分鐘期限、關閉、登入驗證及工作階段撤銷規則。到期或 fleet
重啟後，重新開啟即可使用相同網址；不會自動建立永久公開服務。登入終端機
與預覽 tunnel 維持原本各自的行為。

## 在 Cloudflare 建立 tunnel

需要由 Cloudflare DNS 管理的網域，以及本機可用的 cloudflared；AgEnD
仍可照常安裝其固定版本。不需要提供 Cloudflare API key 或 DNS 編輯權限。

1. 在 Cloudflare 後台開啟 **Networking → Tunnels → Create a tunnel**，
   建立遠端管理的 Cloudflared tunnel 並命名。部分帳號的入口在
   Cloudflare One → Networks → Connectors。
2. 從連接器安裝指令中，僅複製 `--token` 後面的 **token 本身**。不要把整行
   安裝指令貼入 AgEnD，也不要另外安裝此 tunnel 的 cloudflared 系統服務；
   連接器程序由 AgEnD 管理。請為這台主機使用獨立 tunnel。
3. 在 tunnel 的 **Routes** 頁選 **Add route → Published application**，
   選擇子網域與網域，例如 `agend.example.com`。
4. Service URL 選 **HTTP**、填 **127.0.0.1:19282**，Path 留空，HTTP Host
   Header 不要覆寫，然後儲存。這是有路由限制的公開 gateway，**不要指向
   主網頁的 19280 port**。若 19282 已被使用，請在後台與 AgEnD 一起改用
   另一個連接埠。

後台名稱可能調整，請參考 Cloudflare 官方的
[建立教學](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
與[啟動參數](https://developers.cloudflare.com/tunnel/reference/run-parameters/)。

## 在 AgEnD 設定

從直接連線、已登入的儀表板開啟「設定 → Web」，不要透過公開連結設定：

1. 在「固定公開網域」填 `agend.example.com`，亦可填
   `https://agend.example.com/`。不可使用萬用字元、IP、連接埠、路徑、
   查詢參數、帳密或 fragment。
2. 「Named tunnel 本機連接埠」填 19282，或前一步使用的連接埠。檢視並套用
   變更；若出現確認要求，請確認。
3. 在遮蔽的「Cloudflare 連接器 token」欄貼入 token，按「設定 token」並
   確認。儲存時只檢查格式，實際憑證與路由會在開啟時驗證。
4. 從 AgEnD 選單開啟公開連結。AgEnD 必須經由固定 HTTPS 網域取得本次
   exposure 的專屬 marker，才會提供登入網址。接著用手機登入並加到主畫面。

設定檔僅保存 secret 的參照，不保存 token 本身：

```yaml
web:
  public_link:
    hostname: agend.example.com
    tunnel_token_env: AGEND_CLOUDFLARE_TUNNEL_TOKEN
    origin_port: 19282
    ttl_minutes: 120
    protocol: http2
```

Token 存於既有的 `~/.agend/.env`（或目前的 AGEND_HOME），使用原子寫入，
Unix 權限為 0600。設定頁只能設定、清除及查詢是否已設定，無法讀回內容。
Token 只透過該 cloudflared 子程序的 `TUNNEL_TOKEN` 環境變數傳入，不放進
命令列；named 模式不轉送可能回顯憑證的子程序診斷文字。同一 OS 帳號的
程序仍可能讀取私密檔案或環境變數；這不是共用 OS 帳號之間的隔離機制。

變更或清除 token、變更 named 設定時，都會關閉目前的公開連結，之後請
重新開啟。「清除 token」會清空值，並在 `.env` 保留空值覆寫，防止上層服務的舊環境變數在重啟後恢復；要恢復 quick tunnel，亦須清空
網域並套用設定。若網域已填卻缺 token，會失敗，不會偷偷改開隨機網址。
Port 被占用、token 錯誤、路由錯誤或取得其他頁面的 marker 時，也不會開放
公開存取。請檢查後台路由、port 與 token 後再試。Cloudflare Access 可作為
額外保護，但若 `/signin` 被 Access 驗證頁攔截，AgEnD 的 marker 驗證會
失敗；配置此類規則時須考慮這個限制。

## 使用自己的 Cloudflare 帳號驗收

開發測試只使用 stub，沒有連線真實 tunnel。請以自己的帳號檢查：

1. 開啟 named 連結並登入；其他未登入的瀏覽器仍須驗證。將網址加到手機
   主畫面。
2. 關閉後重新開啟：網域相同、舊 exposure 的工作階段已撤銷，原捷徑可開啟
   新的登入頁。
3. 到期或重啟後應維持關閉；重新開啟後，同一個捷徑仍可使用，不必儲存新網址。
4. 測試錯誤網域、路由或 token：開啟必須失敗，不可把未驗證的網址視為可用。
   恢復正確設定後再開啟。
5. 設定 API、聊天及 log 都不能出現 token。Linux 可在本機檢查自己啟動的
   cloudflared 命令列：應有 `run`，不能有 `--token` 或 token 內容。不要
   分享 `/proc/.../environ` 或 `.env`。
6. 清除 token 與網域、套用後再開啟，應恢復原 quick tunnel 行為。若網路已
   遭 Cloudflare 限流，避免反覆進行真實 quick tunnel 測試。

[English](named-tunnel.md)
