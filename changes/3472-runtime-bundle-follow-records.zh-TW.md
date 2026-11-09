---
section: Fixed
---
- **Windows Runtime 的 pane host 可以再次啟動（#3472）。** 自 #3281 起，Runtime bundle 裡的 `transcript-records.js` 會 import 兩個 bundle 沒有帶的檔案：`workspace-follow-records.js` 和 `workspace-follow-parse.js`。pane service 在寫出 descriptor 之前就以 `ERR_MODULE_NOT_FOUND` 結束，所以開啟 pane 會失敗，訊息是 `Pane host startup was not confirmed`。現在 bundle 兩個檔案都帶了，並有測試檢查 bundle 內各模組 import 或啟動的每個檔案都在 bundle 裡。更新 Runtime 即可取得修正；它的 build id 會改變。只影響 `release/2.3.5-alpha`。
