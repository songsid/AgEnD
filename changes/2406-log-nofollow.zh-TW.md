---
section: Changed
---

- `daemon.log` 不會穿過符號連結寫入或輪替（`O_NOFOLLOW`），與 #3083 拒絕跟著 chmod 的作法相同。 (#2406)
