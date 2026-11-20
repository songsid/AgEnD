# Toolbar visual correction

The phone toolbar previously wrapped to three rows. The fullscreen control mixed a one-glyph pill with a 44px touch target, making it look circular beside neighboring buttons.

At narrow widths the primary view, Run/Stop and fullscreen controls now share one row. Secondary versions, width, reload, sharing, feedback and download controls open the existing shared Dialog as Preview options, with readable labels. Desktop keeps its existing control order. Fullscreen uses the standard icon button rather than a pill. No frame/controller, public-link or handoff policy changes.

The same mounted phone regression fails before this correction and passes after it: the options dialog exposes the existing width/download actions, cancel restores its trigger focus and leaves the preview and selected width intact.

Final dev proof: isolated widths 12/12, related panel/Versions/Pages 52/52, shared stylesheet suites 47/47, and test type check exit 0. One initial concurrent batch hit the existing 10-second import hook before any of its 12 width tests ran; the isolated run passed without changing a timeout. The three stylesheet suites in that batch passed.

Two real popup cases pass after the correction. Both have one primary row, no outer overflow and all phone primary targets at least 44×44. Pointer-click fullscreen has no drawn outline; keyboard focus is still the shared 2px solid outline. Both use an 8px rounded icon shape, not a circle. Versions, Changes, Pages, retained source draft, own frame and composer return checks pass.

Five final originals were independently checked across both branches: dev phone options/fullscreen and main phone toolbar/native fullscreen plus desktop fullscreen. Options labels are readable; there is no oversized circular border, clipping or private identifier. This remains synthetic Chromium evidence, not a live account/model/Windows/Safari run. USER VISUAL HOLD remains pending the retaken captures.
