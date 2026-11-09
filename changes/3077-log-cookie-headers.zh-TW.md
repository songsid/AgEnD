---
section: Security
---

- **網頁紀錄頁會遮住 Cookie 與 Set-Cookie 標頭的值（#3077）。** 整段標頭（含折行延續與結構化 Cookie 欄位）會在截斷前遮罩。無害的 SHA 形十六進位會留下。
