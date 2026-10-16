---
section: Added
---
- **Node 相容性檢查（#1441）。** 沒有支援的 bundled runtime 時，preinstall 會拒絕不相容的系統 Node；bundled-runtime 平台可在 npm 本身使用舊 Node 時安裝。略過 lifecycle scripts 不會讓不相容 runtime 變安全：launcher 仍須找到私有 runtime 或明確允許且合格的系統 fallback。舊 updater 若已先 unlink，安裝失敗仍可能沒有已安裝的指令；請見 2.2 升級指南。
