---
section: Changed
---

- Connect Hub directory decisions to the existing runtime and settings writer, with recovery before mounting and immediate fencing of the old generation. AD editing remains unavailable. This adds a required Hub schema component: back up stopped Hub state before upgrading; an older binary needs the matching pre-upgrade state.
