---
section: Fixed
---
- **`/update` 使用它要更新的那個 AgEnD 所屬的 npm（#3440）。** AgEnD 裝在 nvm 底下、系統另有 npm 時，General 的 `/update`（包含從網頁聊天和斜線指令觸發的）會用 Fleet PATH 上的第一個 npm，結果在準備階段失敗：「…/usr/lib/node_modules/@songsid/agend is not an installed AgEnD package」。
  - 現在只採用全域根目錄裡確實有「正在執行的 AgEnD」的 npm：該安裝自己 `bin` 裡的 npm、執行 AgEnD 的 Node 旁的 npm，或 PATH 上的 npm。
  - 更新時會把這個 npm 的目錄放在 PATH 最前面，讓更新用到的 `npm` 與 `node` 都屬於同一個安裝。
  - 即使服務的 PATH 很精簡也一樣。
  - 主機上沒有任何 npm 管理目前執行的安裝時，`/update` 會直接說明，列出預期的全域根目錄，以及每個 npm 回報的位置。
