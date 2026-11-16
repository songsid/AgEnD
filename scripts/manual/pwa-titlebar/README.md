# Headless theme-color acceptance (M-3214)

From Linux/WSL, using an owned Playwright installation and Linux Chromium:

```sh
PW_DIR=/path/to/owned/playwright-prefix \
PLAYWRIGHT_BROWSERS_PATH=/path/to/owned/linux-browsers \
node_modules/.bin/tsx scripts/manual/pwa-titlebar/run.mts
```

Uses a fresh scratch `AGEND_HOME`, the real Fleet web dispatcher, a test Hub HTTP service,
and headless Chromium contexts. No Fleet start, CLI, updater or live user profile is used.
The named HTTPS listener has a temporary test certificate; only the test browser context
ignores its trust error and maps `agend-pwa.test` to loopback. Host admission and the
page's production CSP stay enabled. This checks URL/manifest routing, not production
certificate provisioning or a native installed window.

Checks local Fleet, named HTTPS Fleet and signed-in named HTTPS Hub pages. Each manifest is parsed by
Chromium, icons must load, and live light/dark/custom colors must leave exactly one
unqualified `theme-color` tag while the emulated OS stays light. The screenshots show
page content, not an OS title bar. The browser, listeners and scratch home close in `finally`.

Output: `.artifacts/m3214/headless` (PNGs, checks and cleanup receipt).

Browser automation stays headless inside WSL. Any native Windows installed-window check
needs the leader to obtain the user's approval and a time slot first. This runner has no
Windows executable or headed mode.

Primary references: [Edge theme colors](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/icon-theme-color)
and [Chromium PWA protocol](https://chromedevtools.github.io/devtools-protocol/tot/PWA/).
