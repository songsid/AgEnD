---
section: Fixed
---
- Hub room messages load with less repeated work: a history page checks shared Hub state once for the page instead of reparsing it for each message. Current access is still checked before returning the page.
