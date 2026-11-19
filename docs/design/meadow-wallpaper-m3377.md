# Meadow wallpaper

Meadow gains a static panel background with two layers: a tiny original SVG leaf/grass tile, then a soft sage gradient. The motif consists only of hand-authored curved paths and grass strokes; no imported art, brand assets, scripts, image references or filters. Light uses black ink at 2% group opacity, Dark white at 3.5%. Group opacity bounds overlap as well as individual strokes.

The background is painted on the stationary chat panel. Messages scroll in the existing child scroller. No animation, viewport-fixed background, observer or scroll listener is added. An explicit agent background written through the existing CSSOM wins; other palettes and neutral tokens remain byte-identical.

Names keep their opaque surface strips and user bubbles remain opaque. Direct text, metadata and links must pass AA against both gradient endpoints with the maximum tile alpha applied. Light and Dark both use the existing tokens. The change has no storage or API impact.

The dev-only PR stays on HOLD until the user approves. Desktop light/dark originals go to the leader before review completes. Rollback is a presentation revert, with no migration.
