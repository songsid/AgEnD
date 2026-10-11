---
section: Added
---
- **網頁：可以設定 dashboard 登入維持多久（#1620）。** 直接連到 dashboard 時（本機、區網或 tailnet），`fleet.yaml` 的 `web.session.local.absolute_hours` 和 `web.session.local.idle_hours` 可設定登入維持多久、以及可閒置多久——1 到 720 小時（預設仍是 12 和 2）。公開連結的登入維持固定的 4 小時／30 分鐘。變更不需重啟即生效；改短時，已超過新期限的 session 也會被登出。
