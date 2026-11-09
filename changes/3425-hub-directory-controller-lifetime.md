---
section: Fixed
---

- Retire an expired AD settings controller after its Hub identity or runtime changes, so later authorized requests can acquire the current controller without restarting the fleet. Drain old physical work before replacement and share one successor across concurrent requests.
