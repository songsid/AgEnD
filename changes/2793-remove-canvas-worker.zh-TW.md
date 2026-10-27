---
section: Changed
---
- **Canvas Worker 特效已移除（#2793）。** 設定 → 網頁儀表板的實驗功能開關拿掉了，也沒有任何方式能開啟這項功能。agent 不再有特效工具，也不再有 `export_web_mod`／`propose_web_mod`；特效頁面與路由會拒絕。已存的 `web.experimental.canvas_worker` 照常載入、不起作用，也留在 `fleet.yaml` 裡。已存的特效、套用位置與 mod 都原封不動留在磁碟上，降版後仍找得到。環境效果（落花、點擊星星、`set_web_ambient`）、主題、小工具與自訂 CSS 照常運作。
