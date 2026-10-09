---
section: Changed
---
- **`agend update` 執行期間獨佔 npm prefix，並用新版本實際會使用的 Node 驗證新版本（#1450）。**
  - npm 執行前，更新會在已安裝的套件旁建立鎖（`<npm prefix>/.agend-install.lock`）。同一個 prefix 上若有第二個 `agend update`（不論來自哪個 fleet）會直接拒絕，不會互相衝突。已中斷的更新留下的鎖會被回收。
  - 鎖存在期間只有該次更新自己的 npm 子程序可以安裝：套件的安裝腳本會拒絕其他安裝到該 prefix 的動作，npm 會把它還原。請一次只執行一個安裝。
  - 自帶 Node 的版本，會用它自己的 Node 驗證：更新會詢問已安裝的版本選了哪個 Node，再用那個 Node 在主執行緒與 worker 各開一次資料庫；執行更新的 Node 不算數。
  - 聊天室的 `/update` 會執行 npm 安裝的那個 `agend`：透過 npm 找到並確認是該套件後，以完整路徑執行。無法確認時，`/update` 會拒絕並提示改從 shell 執行 `agend update`；絕不會改用 PATH 上第一個找到的 `agend`。
