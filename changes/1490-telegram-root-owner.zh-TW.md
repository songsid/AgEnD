---
section: Changed
---
- **Telegram forum 根層指令固定所屬 bot：** 不帶後綴的指令使用 primary
  連線在該群的 General；primary 沒有同群 General 時，依配置順序選第一個。
  不論 sibling 的接收順序，都使用目標 bot 的管理員名單；目標停止或無法判定
  時不會轉交其他 bot。對特定 bot 下指令請用 `/restart@ThatBot full`、
  `/update@ThatBot` 或該 bot 自己的 General topic。普通訊息與既有 Classic
  指令沿用原路由。 (#1490)
