---
section: Upgrade Notes
---
- **musl Linux such as Alpine, and Linux hosts without systemd, are not supported.** AgEnD may still install there on a Node 22.14+, but it is not tested or promised to work. If you run it there anyway, the [upgrade guide](upgrade-2.2.md#1-before-you-upgrade) lists two workarounds: remove `~/.config/systemd/user/com.agend.fleet.service`, then run `agend start`, after updating from 2.1.x; and `apk add procps` so `agend update` can read process start times. (#1912)
