---
section: Fixed
---
- **過期的命令確認（#1148／#754）：**`/clear` 在平台訊息更新等待後、破壞性指令送出前，重驗當下授權、來源／target 與確切 daemon／IPC、cached launch 與 lifecycle generation。Model／effort 選單亦拒絕同一 bot 內已搬移到另一 target 的來源 channel、已變更的 Telegram group，或有歧義的 topic 對應。F／C 角色不變；clear 維持不提供 web prompt。
