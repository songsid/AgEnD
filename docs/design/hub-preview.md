# Hub HTML preview origin

This is the server half of chat proposal [#3226](https://github.com/songsid/AgEnD/issues/3226). It follows the [revised seam](https://github.com/songsid/AgEnD/issues/3226#issuecomment-6689091238): the fleet's existing static shim and opaque sandbox replace the initial capability-URL proposal. There are no bearer URLs, mint routes, preview cookies or server-side preview sessions. The Hub panel UI follows separately.

An initialized Hub can opt in locally in its `fleet.yaml`:

```yaml
hub:
  # Keep the other initialized Hub settings.
  web:
    preview_port: 9445
```

Omitting `hub.web.preview_port` disables the listener. A configured value must be an integer from 1 to 65535, distinct from both Hub web/member listener ports and public origins. It uses the web listener's bind address, the web origin's hostname, HTTPS and the browser certificate, including live certificate renewal. The port must be reachable from the browser; forward it alongside the web port when necessary. CDN loading is disabled. Changing this setting through the normal configuration reload replaces the mounted Hub generation. The setting does not change the existing initialization seal or require re-initialization.

The preview listener accepts only the exact canonical Host and `GET /frame`, with no query. It returns `previewFrameResponse` unchanged, including `sandbox allow-scripts`, no `allow-same-origin`, the fleet CSP and exactly the Hub web origin as `frame-ancestors`. Other paths and methods return an empty 404. A fenced generation returns an empty 503. The handler never examines Cookie, authenticates a session, reads a file or sets cookies. Cookies share host scope across ports, so the security boundary is the opaque sandbox and the authority-free handler, not cookie isolation by port.

The Hub shell supplies `data-dashboard-origin`, `data-preview-origin` and a fresh 32-hex boot ID for the mounted generation, and allows only `<previewOrigin>/frame` through its `frame-src`. When disabled, it supplies the existing `notOffered` reason code and no frame source. Existing shell callers without preview data still work. Cached public UI modules use the same data and optional preview API as the fleet.

The signed-in Hub page fetches HTML through D1's ordinary `GET /hub/v1/rooms/:roomId/files/:fileId` download. Its session, exact room/file, current owner eligibility and active `read-own-room` grant checks remain authoritative. The response is an attachment with `nosniff`. The page posts the bytes once into the shim; `/frame` never contains a filename, file ID or the HTML. The unchanged shared preview code checks the exact iframe window, opaque message origin, boot, message shape and per-preview channel. Its iframe has `sandbox="allow-scripts"`, `allow=""` and `referrerpolicy="no-referrer"`.

The guarantee remains the fleet's [account boundary](1306-inline-html-preview.md): untrusted HTML cannot use the Hub account. CSP restricts networking; it is not a universal no-egress guarantee across all browsers or future browser changes. Browser opt-in and the existing warning remain necessary. The Chromium acceptance canary observes no fetch, image, nested-frame or self-navigation requests, and no access to Hub cookies or storage. This does not expand that browser observation into a stronger product guarantee.

Validation uses scratch homes, real loopback HTTPS listeners and D1 storage, a fake directory and member delivery, and the unchanged fleet preview code. `scripts/manual/hub-preview/accept.mts` produces before/after desktop/phone PNGs in EN/zh-TW, including cached-shell modules. It is explicitly a server acceptance fixture, not the pending panel UI. Unit/integration coverage includes default-off, config admission, fencing/reload, certificate renewal, failed-bind cleanup, session/grant revocation, strict response surface and the shared handshake checks. Semantic mutations cover authorization, boot/channel/single-render guards and listener admission.

Rollback: remove `hub.web.preview_port` and reload to stop the listener and remove the shell allowance, or revert this server feature. It adds no database schema component. Keep the normal D1 database rollback restrictions when moving to a build older than D1.

## 設定與邊界

在已初始化的 Hub 設定 `hub.web.preview_port` 後，正常重新載入設定即可啟用；省略此欄位則關閉。它與 Hub 網頁共用主機名稱、綁定位址和瀏覽器憑證，使用獨立 HTTPS 連接埠，且不能與網頁或成員連線的連接埠、來源衝突。瀏覽器必須能連到這個連接埠。此設定不會改變初始化封印，也不必重新初始化。

預覽來源只提供靜態 `GET /frame`，不讀取或設定 Cookie、不驗證登入、不提供檔案內容。HTML 仍須由已登入的 Hub 頁面透過原本的房間檔案權限檢查取得，再傳入不透明來源的沙箱。隔離邊界保護 Hub 帳號；CSP 限制網路，但不保證所有瀏覽器都完全無法傳出資料。既有的裝置預覽同意與風險提示仍適用。移除設定並重新載入即可停止；此功能沒有新增資料庫結構。
