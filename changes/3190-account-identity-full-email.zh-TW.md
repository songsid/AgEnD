---
section: Changed
---
- **設定 → 帳號（以及 Runtime 頁與 Claude 帳號選單）現在顯示帳號的完整 email，不再是 `ab***@example.com`。** 同一個人的多個帳號前綴通常相同（`junsionloh@gmail.com` 與 `junsion.main@gmail.com` 都會變成 `ju***@gmail.com`），縮短的格式因此分不出是哪一個。完整地址仍只提供給直接連到 dashboard 的 fleet 管理員（公開連結、gateway、guest、唯讀 session、agent 的 header token 與 Hub 一律完全拿不到帳號資訊），也絕不會寫進日誌、錯誤訊息、audit、通知或聊天回覆；`agend-runtime` 在終端機仍只印遮罩格式。超過 254 字元、非 ASCII、含空白或第二個 `@` 的地址會直接捨棄、不會截短；舊版 Runtime 已快取的 `ab***@example.com` 仍可使用。
