# M-3882: an installed AgEnD Hub has its own icon (real handlers)

After "Install as an app" (#4544), the AgEnD dashboard and the AgEnD Hub showed the same icon in the taskbar, dock and app list.

**Now.** The Hub's listener serves its own set at the same paths: `/favicon.svg`, `/favicon.ico` (16, 32, 64), `/apple-touch-icon.png`, `/icon-192.png`, `/icon-512.png`, and the Hub-only `/icon-maskable-192.png` and `/icon-maskable-512.png`.

**Its manifest.** It is named **AgEnD Hub** and lists `any` and `maskable` icons. The dashboard's manifest and icons are unchanged. A fleet's custom app icon (#2308) never applies to the Hub.

**The mark.** It is the same Ag mark, inverted: a light Ag on a blue tile, with a three-node badge in the top corner. The blue fill tells the two apart even at 16 px, on light and dark taskbars. The sources are `src/ui/icons/hub-favicon.svg` and `hub-maskable.svg`, the latter full bleed with the mark inside the safe zone. The PNGs and the ICO are rendered by `scripts/manual/hub-app-icon-m3882/build-icons.mts`.

**The capture.** `scripts/manual/hub-app-icon-m3882/capture.mts` ran at the commit in `receipt.json` and passed 3 of 3 checks. It starts one server per flavor on the real `handleWebIconRequest`. A sheet then loads each origin's manifest name, its favicon at 16 and 32 px and its 192 px app icon, side by side, on light and on dark. A headless browser has no taskbar or install dialog to photograph, so these are the exact bytes those surfaces draw.

| Frame | What it shows |
|---|---|
| `m3882-light-dashboard-vs-hub.png` | AgEnD and AgEnD Hub at 16, 32 and 192 px on a light page |
| `m3882-dark-dashboard-vs-hub.png` | The same on a dark page |
