---
section: Fixed
---
- **atomic 寫檔現在包含 fsync。** 三個使用 write+rename 但缺少 fsync 的檔案已修正：`fleet.yaml`（`FleetManager` 的儲存路徑）、`web-sessions.json`（`WebSessionStore.persistNow`）和 `update-marker.json`。三者現在都遵循 write → fsync(temp fd) → rename → fsync(dir，盡力而為) 的流程。`src/atomic-write.ts` 新增了共用的 `atomicWriteFileSync` helper，供 update-marker 和 session 路徑使用；`FleetManager` 則以相同流程內聯實作，以保留預寫入驗證步驟。(#1490 P3)
