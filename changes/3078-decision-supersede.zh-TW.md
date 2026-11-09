---
section: Changed
---
- 取代一則決策（`post_decision` 帶 `supersedes`）現在需要與 `update_decision` 相同的權限。worker 仍可發布決策；General 與 coordinator 可以取代決策。被取代的決策必須仍有效、且你看得到；若無法取代，新的決策也不會存下。(#3078)
