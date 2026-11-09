---
section: Fixed
---
- **A ClassicBot agent's project decisions stay in its own room (#3454).** Through the agent endpoint (CLI mode, `agend-agent decision-*`), a ClassicBot agent's project-scoped decisions were stored under an empty project, which every CLI-mode ClassicBot room shared. They now belong to the agent's own workspace, as they already did through the MCP tools. An agent that is neither a fleet instance nor a ClassicBot agent is refused instead. Fleet instances are unchanged.
