---
section: Fixed
---
- A failed instance start can no longer stop another instance's CLI and MCP tools. Cleanup now requires its own tmux window before looking up or signalling a process, and empty window targets are refused.
