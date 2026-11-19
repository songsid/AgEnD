# Built-in browser colours

The shared theme dropdown keeps its System, Light and Dark choices and adds
Other… (其他…). Appearance and palette remain independent. The new item opens
the existing native Dialog, centred on desktop and phone, and shows five radio
cards: Default, Clear Sky (晴空), Meadow (青草), Night Violet (夜紫) and Mint
(薄荷). The selected card has a check and ring; the native radios support arrow
keys. All four colour palettes have both light and dark variants.

The dialog previews its choices immediately. Apply keeps them; Cancel, Escape
and backdrop/close restore the prior appearance and palette. The controller
uses a preview lease so an outside choice retires a stale preview and closes its dialog. Changing
System/Light/Dark outside the dialog keeps the selected palette. Default is the
explicit route back to neutral colours.

Settings → Look already uses AgendTheme and the shared semantic tokens. This
feature extends those same pieces. It adds no per-agent theme store and no
server API. A palette is kept in the browser as `agend_palette` and painted by
`theme.js` before the UI mounts; mode keeps its existing `agend_theme` and
signed-in preference behavior. New and invalid palette values fall back to
Default. Blocked storage can still paint the current page.

Fixed `data-palette` selectors in tokens.css contain all colour values; the
same declarations paint the real page and the swatches. Agent chat/page themes
and owner custom CSS keep their existing precedence. The shared module is in
the normal static asset list, so the Fleet, anonymous reader and Hub import
the same picker. The signed-in Fleet also exposes it in Look.

All eight variants must pass the existing theme validator, the full AA token
pair matrix, metadata on accent-tinted rows, and the phone audit's dark APCA
Lc 60 floor. Sizes, assets, fonts and layout tokens are unchanged. Captures use
synthetic content on owned Hub/Fleet listeners, with Linux headless Chromium.
The feature introduces no service branding or external assets.

Meadow follows the approved olive-sage reference. Light uses white page, sidebar
and panels, with `#c4cf93` limited to the chat area. Neutral message-name strips
keep preset and automatic identity names readable at 4.5:1. Chat metadata uses
darker olive text. The reference green `#4fae4e` is decorative; controls carrying
white text use `#317531` (5.65:1). Dark uses an olive chat background (`#30351f`),
distinct from Mint's teal. Meadow-only CSS consumes its chat tokens; the other
six palette declarations remain byte-identical to the reviewed values after the
light-sidebar contrast correction. Inline agent colours retain precedence.
