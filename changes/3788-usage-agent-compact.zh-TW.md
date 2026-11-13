---
section: Changed
---
- **Agent 用量工具預設回傳精簡帳號列。** `get_usage` 與 `agend-agent usage` 保留額度、重設時間、帳號與快取狀態，省去重複翻譯及容量統計；`detail: true`（`--detail`）可取得完整 JSON。`get_usage_report` 只在頂層說明一次 API 等值金額，速度統計改由詳細模式提供。網頁用量面板與 `/usage` 維持原有顯示。
