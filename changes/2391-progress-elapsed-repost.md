---
section: Fixed
---
- **The progress bubble keeps counting across a reply (M-2391).** Each reply re-posts the in-flight bubble below it, and that used to restart its elapsed time at zero. An agent that replied more often than `progress_min_elapsed` (30 s by default) therefore never showed elapsed time at all. The re-posted bubble now continues the turn's time, showing it at once when the turn is already past the threshold. The first elapsed tick also fires just after the threshold, never a moment before it (which used to leave the bubble unchanged until the next minute).
