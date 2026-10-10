---
section: Changed
---
- **公開連結的 cloudflared 下載在慢速網路上也能完成（#1554）。**
  - 不再固定 5 分鐘就失敗。只有連續 60 秒沒有收到資料才算失敗，整體上限 30 分鐘，所以慢但持續在動的下載會完成。
  - **Linux 現在先從 Cloudflare 自己的套件庫下載**（pkg.cloudflare.com）；套件不存在、停滯、太慢或不符時，再改用 GitHub release。套件的大小也只有一半。
  - 兩種來源都比對同一個固定的 SHA256。套件裡的執行檔由 AgEnD 自行解出，不會安裝任何其他東西。
  - macOS 仍從 GitHub 下載，因為 Cloudflare 沒有提供 macOS 套件。
  - 在 `/dashboard` 上，第 ② 步會標出何時改用 GitHub 以及原因。
