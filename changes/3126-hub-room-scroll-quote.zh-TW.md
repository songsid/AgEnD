---
section: Fixed
---
- **Hub 房間：往上捲會載入較早的訊息，引言可跳到原文（M-3126）。** 房間往上捲會載入下一頁較早的訊息（伺服器已有 `before=` 分頁）。第一頁填不滿視窗時也會載入較早的一頁（停在底部的長房間仍不會一次抓完整段歷史）。引言指向不在最新 50 則裡的原文時，仍顯示引言；點下去會載入到那一則並跳過去。提問失敗或被擋下時，顯示 Fleet 的 **!** / **⊘** 標記與簡短原因。Hub 會附上可選的 `ask.failed` / `ask.blocked`（0 省略），單一已結案未答時還有 `ask.reason`（`expired`、`retired`、`unavailable`、`interrupted` 或 `unknown`）。舊客戶端仍只看到原本的 queued / sent / answered。
