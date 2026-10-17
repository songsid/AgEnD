---
section: Added
---
- **Claude: an opt-in prompt-cache TTL per instance (#2010).** Set `backend_options.claude-code.prompt_cache_ttl` to `"1h"` or `"5m"` to choose how long Claude Code keeps its prompt cache. AgEnD passes the value as `CLAUDE_CODE_PROMPT_CACHE_TTL`, and as `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` for subagents, on the instance's next start. Left unset, the default, the CLI chooses as before. Any other value is refused when the config is checked.
