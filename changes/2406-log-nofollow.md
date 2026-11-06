---
section: Changed
---

- `daemon.log` is not written or rotated through a symlink (`O_NOFOLLOW`), matching the #3083 chmod refusal. (#2406)
