---
section: Security
---
- **網頁登入與設定頁的強化（#1490）：**
  - 在本機自己的 dashboard 上，過期的 `__Host-agend_session` cookie 不會再遮住有效的 `agend_session`：之前一個已結束的安全 session，會讓已登入的瀏覽器看起來像是登出了。寫入動作會以實際登入的那個 session 來檢查。公開連結仍然只接受它自己的 `__Host-` cookie。
  - 頁面在你等待時會輪詢套用進度（包括 token 和綁定的套用），最多 10 分鐘；這種輪詢不再算作活動，所以不會讓閒置的 session 一直延長（#1373）。
  - `agend setup` 的頁面現在會送出 Content-Security-Policy，只允許它自己的 inline script 和 style（每次回應都用新的 nonce），並加上 `X-Frame-Options: DENY`，其他網站無法用 frame 嵌入它。
