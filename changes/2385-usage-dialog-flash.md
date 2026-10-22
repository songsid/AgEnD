---
section: Fixed
---
- The web AI usage dialog and rail no longer flash "Could not load usage data." over the numbers they were showing when one read fails (a dropped request, a 500/502, a lapsed session). The last numbers stay, with a quiet "Couldn't refresh — showing the last numbers" note, and the full error shows only when nothing was ever read (#2385).
