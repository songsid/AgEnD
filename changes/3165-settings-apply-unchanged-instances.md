---
section: Fixed
---
- Saving a web public-link change no longer lists every parked or other-team agent as "Restart this Agent". The apply summary uses `classifyInstanceChange` for instances without a live daemon too, so only a real instance-block change is listed.
