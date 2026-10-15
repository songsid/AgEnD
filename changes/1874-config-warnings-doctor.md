---
section: Changed
---
- **`agend doctor` and fleet start show fleet.yaml warnings (#1874 follow-up).** Before, the validator's warnings only appeared in `agend validate`, which someone hand-editing fleet.yaml rarely runs. Examples are a setting AgEnD ignores, such as `web.access`, or a locked channel with no `allowed_users`. Now `agend doctor` lists each warning as a ⚠ row under **Fleet**, and each one is logged once at warn level in `daemon.log` when the fleet starts. No new checks were added.
