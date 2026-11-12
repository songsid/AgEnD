# Author visual read

A built-in image-reading helper inspected 27 selected final originals; this is author evidence, not the parity review. Current light/dark menus, the 360 px pane and phone sidebars have no observed clipping or mixed row presentation. Model values are grey and the model Settings form is visible. Quote labels use AgEnD Leader. Phone sidebars were re-captured after their slide-in settled.

Paths below are relative to `browser/`:

- `after-desktop-{light,dark}-zh-TW/`: `*-sidebar-menu.png`, `*-quote-options.png`, `*-pane-model.png`, `*-model-settings.png` (8)
- `after-desktop-light-en/`: `light-en-pane-model.png`, `light-en-sidebar-menu.png` (2)
- `after-phone-{light,dark}-{en,zh-TW}/`: `*-sidebar-rest.png`, `*-sidebar-menu.png` (8)
- `before-desktop-light-zh-TW/`: `light-zh-TW-sidebar-menu-before.png`, `light-zh-TW-pane-menu-before.png`, `light-zh-TW-quote-options-before.png` (3)
- `narrow360/`: `light-zh-TW-quote-options.png`, `light-zh-TW-pane-model.png`, `light-zh-TW-pane-layout.png` (3)
- `skew-css/`: `light-zh-TW-sidebar-menu.png`, `light-zh-TW-retained-pane-menu.png` (2)
- `skew-ui-menu/`: `light-zh-TW-sidebar-menu.png` (1)

Known retained-style limit: with the pre-change `app.css` and new JavaScript, the model label/value run together, the value loses its grey styling, and `auto` wraps. The menu remains inside the viewport and navigation works. Current CSS meets the one-line grey-value requirement. This SKEW control proves bounded operation, not matching presentation across stylesheet versions. Lower menu groups are separately captured after scrolling; a single top-of-menu image does not show every group.
