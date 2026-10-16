# README hero image

`../hero-light.webp` and `../hero-dark.webp` are the picture at the top of `README.md` and `README.zh-TW.md`. The README switches between them with `<picture>` and `prefers-color-scheme`.

- **Left:** a real render of the web dashboard's chat view. It's drawn by this repository's own code, with made-up demo data only.
- **Right:** an illustrated phone in AgEnD's own style. It shows the same conversation as simple bubbles; it isn't a copy of any app's interface.

## What the render does

- `render.mts` builds a FleetManager on a temporary AGEND_HOME and serves the dashboard on 127.0.0.1.
  - No fleet is started, no agent CLI runs, and nothing connects to Discord or Telegram.
  - It reads nothing from your own AgEnD home, and it removes its temporary folders when it's done.
- Every name, message, number and file in the picture is in the `DEMO` section of `render.mts`. Edit it there.
- Chromium screenshots the dashboard in light and dark at 2×. `hero.html` then composes the screenshot with the phone at 1280×720 CSS px (2560×1440 pixels), and Chromium encodes the result as WebP.

## Regenerate

Run it from the repository root after a change to the web UI. You need:
- `playwright-core` (any folder whose `node_modules` has it, passed as `PW_DIR`);
- a Chromium build (`CHROME`);
- a colour emoji font that fontconfig finds. Without one, every emoji renders as an empty box. Noto Color Emoji (SIL OFL) works; a `fonts.conf` that includes the system one and adds its folder is enough.

```sh
PW_DIR=~/pw CHROME=~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome \
  FONTCONFIG_FILE=~/fonts/fonts.conf npx tsx docs/assets/readme/src/render.mts
```

Optional settings:
- `OUT=<folder>` (default `docs/assets/readme`);
- `PORT=<n>` (default 47990);
- `QUALITY=<0..1>` (WebP quality, default 0.86);
- `MEASURE=1`, which prints where the usage rail and the thread sit, for laying out `hero.html`.

Each image should stay under about 600 KB; a typical render is about 100 KB.

## Credits

- The Discord and Telegram glyphs in `icons/`, inlined in `hero.html`, are from [Simple Icons](https://simpleicons.org) 13.21.0, released under CC0 1.0.
- The marks themselves belong to their owners. They're used here only to say that the same chat lives in those apps.
