---
section: Fixed
---
- **`get_fleet_status` now counts ClassicBot channels in its totals, matching `agend ls` (#2259).** The tool previously counted only fleet.yaml instances; classic channels are now included. The response also carries a `fleet:` and `classic:` breakdown so callers can see each group's running/paused/stopped counts separately. Duplicate instance names (two classic channels sharing a name) are deduplicated the same way `agend ls` does it.
