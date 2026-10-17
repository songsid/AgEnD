---
section: Added
---
- **Claude：可選的每個 instance 提示快取 TTL（#2010）。** 把 `backend_options.claude-code.prompt_cache_ttl` 設成 `"1h"` 或 `"5m"`，就能決定 Claude Code 保留提示快取多久。AgEnD 會在 instance 下次啟動時，把這個值傳給 `CLAUDE_CODE_PROMPT_CACHE_TTL`，子代理則是 `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`。不設定（預設）時，和以前一樣由 CLI 決定。檢查設定時，其他值都會被拒絕。
