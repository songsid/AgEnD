---
section: Added
---
- Office skin packs now support multi-image and multi-frame character animations up to 600 frames (for 5–10 s+ loops at up to 30 FPS): strips accept a multi-sheet `src` array (up to 32 sheets, 32 frames each), a frame list `frames: [{ src, ms? }]`, per-frame `durations`, `once: true`, and `loopFrom` (intro then loop). Existing single-image packs stay unchanged; sheets are pre-decoded for flicker-free playback on desktop and phone and hold frame 0 with reduced motion (#4231).
