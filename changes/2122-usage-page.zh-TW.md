---
section: Added
---
- **儀表板的 Fleet → 用量（#2122，第二部分）。** `/ui/fleet/usage` 依序列出每個 agent 的 token、請求數、已送達訊息數，以及**依牌價換算的 API 等值——不是實際花費**；期間可選今天、7 天、本月、全部或自訂日期，依 fleet 的時區計算；可依 agent、backend、模型、憑證 profile 或 team（依目前設定）分組。◔ 用量對話框有連到這裡的 **依 agent →**。
  - 每個標記都寫成文字：Codex 的快取寫入顯示「未回報」（絕不顯示 0）、模型「未定價」、讀取時尚未記錄 backend 與 profile 的小時。Kiro 與其他 AgEnD 讀不到的 CLI 會列出原因，絕不顯示成 $0。Claude 的 subagent（sidechain）回合目前還不計入。
  - 前 5 名 agent 與其他的每日趨勢、能分辨「已讀取但沒有用量」與「未收集」的日曆熱度圖，以及 **下載 CSV**（目前這份回答的每日資料列，每列都附計價基準）。
  - 已登入的 session 看得到；訪客一律看不到。透過臨時公開連結時，除非設了 `web.usage_report_on_public_link: true`，否則顯示「公開連結上不提供」。
