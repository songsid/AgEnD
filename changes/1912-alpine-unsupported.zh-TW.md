---
section: Upgrade Notes
---
- **不支援 musl Linux（例如 Alpine）與沒有 systemd 的 Linux 主機。** 在 Node 22.14+ 上 AgEnD 也許還裝得起來，但沒有測試過，也不保證能用。如果還是要在這些環境上跑，[升級指南](upgrade-2.2.zh-TW.md#1-升級前)列了兩個處理方式：從 2.1.x 更新後，刪掉 `~/.config/systemd/user/com.agend.fleet.service` 再執行 `agend start`；以及 `apk add procps`，讓 `agend update` 讀得到行程啟動時間。(#1912)
