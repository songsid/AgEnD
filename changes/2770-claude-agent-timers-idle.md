---
section: Fixed
---
- A Claude Code agent whose own turn has ended now counts as idle while its background subagents are still running. The subagents' clocks redraw every second, and AgEnD used to take that as the agent still working. As a result, its messages waited and the dashboard showed it busy until the last subagent finished. Agents with no background subagents are detected exactly as before.
