---
section: Fixed
---
- **The Office on a phone reaches the bottom of the scene when zoomed in (#2689).** The scene's stage was sized from the screen's height, assuming the bars above it fit in about 300 px. On a phone the Office bar wraps onto several rows, so the stage ran under the tab bar, and a swipe on the scene pans it rather than scrolling the page.
  - The stage now takes the height left under the bars, so dragging a zoomed scene up shows its bottom edge.
  - Only a very short screen keeps a 200 px stage and scrolls the panel, by a swipe on the bars.
  - The zoom buttons are now a row along the top of the scene (outside fullscreen), so they fit the shorter stage.
  - Desktop, fullscreen and the immersive view are unchanged.
