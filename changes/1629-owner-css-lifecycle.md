---
section: Added
---
- Added positive owner-CSS lifecycle evidence for the 2.3 effect runtime: an absent or unreadable version is not silently treated as disabled, and late stylesheet events cannot restore a superseded state. This is an unmounted prerequisite; it does not start effect playback.
