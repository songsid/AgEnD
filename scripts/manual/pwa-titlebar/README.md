# Installed-window title-bar acceptance (M-3214)

From WSL with Windows Chrome and Node installed:

```sh
node_modules/.bin/tsx scripts/manual/pwa-titlebar/run.mts
```

Uses a fresh scratch `AGEND_HOME`, the real Fleet web dispatcher, a test Hub HTTP service,
and a fresh Windows Chrome profile. No Fleet start, CLI, updater or live user profile is used.
The named HTTPS listener has a temporary test certificate; only this fresh browser process
ignores its trust error and maps `agend-pwa.test` to loopback. Host admission and the
page's production CSP stay enabled. This checks URL routing/install behavior, not
production certificate provisioning.

CDP `PWA.install` and `PWA.launch` create real installed apps. Each must report standalone
mode. Light and dark run against an emulated light OS; the PNG captures the exact owned
Windows app window, including its native title bar. Caption brightness is checked. A live
custom surface change is checked separately. All installed test apps are uninstalled,
the browser closed and owned processes checked before the profile/scratch is removed. On failure,
`scope-private.json` points to retained owned scratch for diagnosis; never publish it.

Output: `.artifacts/m3214/browser` (PNG/result/cleanup; private scope file excluded from evidence).

Primary references: [Edge theme colors](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/icon-theme-color)
and [Chromium PWA protocol](https://chromedevtools.github.io/devtools-protocol/tot/PWA/).

Set `PWA_BROWSER=edge` to select Edge. The fresh test process enables Chromium’s documented `--enable-devtools-pwa-handler` automation switch; no setting is changed in the user’s browser.
