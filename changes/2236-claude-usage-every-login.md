---
section: Fixed
---
- **Every Claude login on the host shows in usage, including a full one nothing runs on (#2236).** Once every agent ran on named Claude profiles, the default login, often the account that had just run out, disappeared from `/usage`, `get_usage` and the dashboard, and so did any profile whose agents were all stopped. Now each one has a row: "Claude (default)" and every profile. One at its limit shows 100% with its reset time, or that the usage check was rate-limited. A signed-out profile no agent uses stays hidden.
