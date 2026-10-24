---
section: Fixed
---
- **instance 沒接上先前的對話、改從頭開始時，現在會通知你（#749）。** 多次 resume 失敗後，AgEnD 會放棄並以全新對話啟動 instance，讓它能繼續工作；先前的對話移到 instance 資料夾保留，沒有刪除。以前這件事只寫在 daemon.log，instance 就這樣不記得之前的事。現在 AgEnD 會在該 instance 的 topic 和 General 說明先前的 context 已遺失，計畫內的重啟也照樣通知。ClassicBot 的通知只送到 General，不會出現在它使用者的聊天裡。Log 分頁也會顯示這個事件，webhook 會收到 `context_lost`。
- **同時冷啟動的數量改看 fleet 可用的 CPU，而不是主機的核心數（#749）。** 原本上限用主機核心數；在容器或設了 CPU quota 的 systemd slice 裡，這比 fleet 實際能用的多，啟動因此逾時。現在改看 CPU affinity 與 cgroup v1/v2 的 CPU quota。`startup.concurrency` 仍可覆寫。
