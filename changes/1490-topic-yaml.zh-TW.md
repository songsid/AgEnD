---
section: Fixed
---
- **`agend topic bind` / `unbind` 不再整份覆寫 fleet.yaml（#1490）。** 以前綁定 topic 會把展開預設值後的設定 dump 回去，註解消失、工作目錄變成絕對路徑，而且會同時寫入舊的 `channel:` 與 `channels:` 清單。現在只在原始 YAML 上改 `instances.<name>.topic_id`，其餘內容保留。
