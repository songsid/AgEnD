---
section: Fixed
---
- **kiro: a resumed conversation is no longer switched to the instance's own agent, because one lost AgEnD's tools (#1800).**
  - Since #906, AgEnD typed `/agent swap` into a resumed kiro conversation to move it onto the instance's own agent. A user's instance then lost its AgEnD tools: it could not `reply`, and its workaround through a subagent delivered nothing.
  - The switch is suspended. A resumed conversation keeps the agent it was saved under and gets AgEnD's server and instructions from the shared `.kiro` files again, as before #906.
  - Instances whose switch was already recorded get those shared configuration entries back on their next launch. After a restart, check that the instance calls `reply`. That is expected to bring its tools back, but kiro's own tool loading was not verified live.
  - New conversations still start as the instance's own agent.
