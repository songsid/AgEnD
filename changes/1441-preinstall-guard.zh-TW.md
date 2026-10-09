---
section: Added
---
- **預裝安裝守衛（#1441 Part A）：在不相容的 Node 版本上 npm 中止安裝。** `preinstall` 生命週期腳本在執行中的 Node 不支援 N-API 10（`^22.14.0 || ^23.6.0 || >=24`）時以退出碼 1 中止。直接執行 `npm install -g @songsid/agend` 的情況下，安裝在更動任何檔案前就會失敗，保留現有版本不變。注意：2.1.x 更新器流程在安裝前會執行 `npm unlink`；若解除連結已完成後 preinstall 才失敗，則不會有版本殘留——詳見升級說明。`--ignore-scripts` 可繞過 preinstall 鉤子，但 CLI 本身的啟動守衛在首次執行時仍會以退出碼 1 中止，因此舊更新器的 `agend --version` 驗證步驟仍然會中止重啟。
