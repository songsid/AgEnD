---
section: Fixed
---
- Fixed Hub room assistants failing before launch because queued input lacked its audit-content binding, and bound completed replies so they remain readable. Failed turns now log a bounded phase and protocol reason without room text or raw worker errors.
