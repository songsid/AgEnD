# Toolbar visual correction

The phone toolbar previously wrapped to three rows. The fullscreen control mixed a one-glyph pill with a 44px touch target, making it look circular beside neighboring buttons.

At narrow widths the primary view, Run/Stop and fullscreen controls now share one row. Secondary versions, width, reload, sharing, feedback and download controls open the existing shared Dialog as Preview options, with readable labels. Desktop keeps its existing control order. Fullscreen uses the standard icon button rather than a pill. No frame/controller, public-link or handoff policy changes.

The same mounted phone regression fails before this correction and passes after it: the options dialog exposes the existing width/download actions, cancel restores its trigger focus and leaves the preview and selected width intact.

Main proof: four focused width/style suites 32/32, plus all five real-app native/fallback browser cases. The phone row is one row, unclipped; native fullscreen still belongs to the panel, never its iframe. The unchanged pre-existing Phone/Tablet content-width emulation can still scroll inside its own viewport.

Five final originals were independently checked across both branches: dev phone options/fullscreen and main phone toolbar/native fullscreen plus desktop fullscreen. Options labels are readable; there is no oversized circular border, clipping or private identifier. This remains synthetic Chromium evidence, not a live account/model/Windows/Safari run. USER VISUAL HOLD remains pending the retaken captures.
