---
section: Fixed
---
- **Grok backend: rate limit error no longer false-triggers on agent code or prose mentioning "rate limit", "429", or "too many requests" (#2325).** The pattern is now anchored on the Grok terminal box border (`┃  Retry failed:`) so only the server-generated error line triggers a failover, not ordinary text in the agent's transcript or task description. Both the 1.0.60 format (`rate_limit_error:`) and the 1.0.52 format (`Some resource has been exhausted: … rate limit`) are matched, including line-wrapping at 80-column terminals.
