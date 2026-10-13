---
section: Fixed
---
- **A Claude profile switch that coincides with another restart still keeps the conversation (#1753 follow-up).** If the switch's restart joined one that was already under way, such as an MCP revival, the conversation was not copied and the reply did not say so. Now the copy runs inside that restart, as long as it has not yet started the new CLI. If it has, the switch reply reports `carry_failed` with the reason, and the usual handover is sent.
