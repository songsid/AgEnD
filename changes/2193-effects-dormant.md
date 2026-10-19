---
section: Changed
---
- **With no effects set, the effect player isn't loaded at all (#2193).** The page now loads it only when there's something to play: the open chat has a Canvas Worker effect, you chose a personal effect, or an agent offers a Try. Until then it costs nothing. Its code isn't even fetched, so clicking around does no effects work (about 2 ms per click at a 4× slower CPU, from 60 ms). An effect that appears later starts as quickly as before. Ambient effects and your custom CSS work without it.
