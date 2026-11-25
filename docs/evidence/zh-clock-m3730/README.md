# zh-TW 24-hour clock (M-3730)

Real-app captures from `scripts/manual/zh-clock-m3730/capture.mts` at source `2cb24aae9` (no uncommitted `src/` changes; see `receipt.json`). The browser's zone was set so that "now" is in the midnight hour (`Etc/GMT+4` for this run), which is the case the user saw as 上午12:xx.

| Screen | English (unchanged) | zh-TW |
|---|---|---|
| Chat thread, message times (the fleet's zone) | `12:44 PM` | `12:44` |
| Session menu, end time and idle span | `Ends by 12:48 AM at the latest, or after 48 h unused` | `最晚 00:48 結束；閒置 48 小時 也會結束` |
| Fleet → Usage, when it was read | `Updated 12:48 AM · read every 10 min …` | `更新於 00:48 · 每 10 分鐘讀取一次 …` |

All 10 checks in `receipt.json` pass: each zh-TW time is `HH:mm` with no 上午/下午, durations read 小時/分鐘, and no page had errors.
