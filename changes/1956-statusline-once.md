---
section: Fixed
---
- The fleet's status reads each agent's statusline.json once per build instead of up to three times, and without a separate existence check (#1956): on a 40-agent test fleet, 247 synchronous file calls per status build became 167.
