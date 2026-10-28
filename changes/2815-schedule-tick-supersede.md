---
section: Fixed
---
- A silent schedule no longer piles up while its agent is stuck or busy. Ticks that are still waiting when a newer tick of the same schedule arrives are dropped, so once the agent is free it gets one paste (the newest), not one per missed interval. Dropped ticks show in `delivery_status` as cancelled, "superseded by" the newer one. No notice is sent, and the schedule itself is unchanged.
