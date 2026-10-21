---
section: Fixed
---
- **Grok backend：agent 的程式碼或文字提到「rate limit」、「429」、「too many requests」時，不再誤觸 rate limit 偵測（#2325）。** 現在改為錨定在 Grok 終端機框線（`┃  Retry failed:`）上，只有伺服器產生的真實錯誤行才會觸發 failover，不再受 transcript 或任務說明裡的一般文字影響。1.0.60 格式（`rate_limit_error:`）與 1.0.52 格式（`Some resource has been exhausted: … rate limit`）均可命中，包含 80 欄終端機的換行情況。
