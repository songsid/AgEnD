---
section: Security
---
- **從另一台裝置確認「開啟連結」或「更改 secret」的變更時會發 Notice（#3486）。** 這類變更從另一台裝置確認後，除了稽核紀錄，擁有者也會收到 Notice（web-only fleet 在 dashboard 的 Notices；聊天型發到 General，否則主要連線，再否則網頁 Notices）。`docs/SECURITY.md` 用白話寫出剩餘風險：在擁有者開啟代碼選項或「只有這台電腦可以授權」之前，已登入的管理員 session 可以做任何變更，包括開啟連結。
