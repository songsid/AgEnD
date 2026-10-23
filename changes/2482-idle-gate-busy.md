---
section: Changed
---
- **A message delivered to a busy agent is no longer logged as a warning (#2482).** When an agent is mid-task, AgEnD waits up to a minute for it to finish and then hands the message over; the agent's CLI reads it after its current turn. Measured on a real fleet, every one of these "Idle gate timed out" warnings was such a busy agent, so it is now an INFO line with how long the agent had been busy. A warning remains for what may really be wrong: an agent reported busy for an hour with a screen that has not changed for ten minutes, or a timeout on an agent that is not busy at all.
