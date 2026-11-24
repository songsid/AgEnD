---
section: Added
---
- An Office skin pack may set its own scene size with `"canvas": [w, h]` (640×360 to 5120×2880, any shape) instead of the fixed 1280×720: a bigger office, or a wide one. Coordinates stay within it, the background and foreground take its shape, Edit layout's grid follows it, and All offices scales a big office into its tile. Packs without it are unchanged; an older AgEnD refuses a pack that sets it.
