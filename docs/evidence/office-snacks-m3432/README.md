# Office Custom Snacks, Drag-to-Feed & Placed Snacks (M-3432, #4255)

Real-app captures from `scripts/manual/smoke/smoke-office-snacks-m3432.mts` using a synthetic pixel-art skin pack (`synth-snacks`, 3 custom snacks: Cookie / Pudding / Cake + `eat` strips) and a synthetic roster (`Alpha`, `Beta`, `Gamma`, `Delta`; zero real names or chat IDs).

## Artifacts

| File | Description | Size | SHA-256 |
| --- | --- | ---: | --- |
| `office-snacks-board.png` | 5-panel storyboard (1688×948, dark zh-TW): (1) dragging Cookie onto Alpha (`餵給 Alpha` + blue ring, no hover tooltip), (2) Alpha eating with hearts, crumbs and `好吃！` bubble, (3) placed Pudding on Lounge floor with Beta & Gamma racing, (4) Beta eating (`好吃！`) while Gamma scatters (`被搶先了！`), (5) Phone 390×844 showing 44 px snack tray above zone pills with zero overflow | 216,973 B | `457ddfad05b3cdabc0b7b07e1ddf483655635b810f92e2e46fac763d857b8e34` |
| `drag-place-ring.png` | Full-resolution desktop frame (1366×900, dark zh-TW) showing the `放在這裡` pudding ghost floating above-right of the dashed target ring on empty Lounge floor | 79,166 B | `6ee52f0c02abe62f0ee5fed80f202d2351a1a3a944ffb985c6bcd5f4d0d9f5bf` |
| `office-snacks-demo.mp4` | ~9.3 s desktop recording (1366×900, H.264 encoded at 25 FPS) showing direct drag-to-feed on Alpha, placed Pudding race/eat/scatter in Lounge, tap-to-arm Cake placement, and unobstructed `Beta` nameplate (`0` badge clear of `B`) | 390,115 B | `7be28fb29a9499261c9ee8a895c001e136bb6b1e98db7c3f28d01d1879bbec53` |

## Additional Automated Checks in Smoke
- Backwards compatibility: switching to `cozy` (no `snacks`) renders zero `.oo-snacks` elements.
- Reduced motion (`prefers-reduced-motion: reduce`, light EN): renders zero `.oo-snacks` elements.
- Zero page errors, zero CSP violations, zero horizontal overflow on desktop and phone.
