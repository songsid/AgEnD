# S4 acceptance

`node scripts/manual/hub-execution/mutate.mjs` compiles each semantic reversal and requires targeted assertion failures. It restores every source file and keeps logs under `.artifacts/hub-execution-mutations`. Run it without simultaneous edits or tests in the checkout. No provider, CLI, fleet, tmux or model account is launched.

`needs-skew.mts` uses the shared smoke fixture's scratch home and real web handlers, with Chromium. Fleet lifecycle, CLI delivery, external tunnel installation/process and chat notifications are inert. The local public gateway is real; Playwright carries its synthetic HTTPS origin to the owned loopback listener. No real account or host network setting is used.

```bash
REPO=$PWD PW_DIR=<prefix-containing-playwright-core> OUT=$PWD/.artifacts/hub-needs-skew \
  npx tsx scripts/manual/hub-execution/needs-skew.mts
```

Set `PLAYWRIGHT_BROWSERS_PATH` to the private browser installation when needed. Ports default to 48572/48573 and refuse if occupied; `HP` selects another pair. `SKEW_BASE` selects the pre-S4 source ref, defaulting to the carried S1 checkpoint `b6a1c683897e604a83078d58fde7a73bb3ab3435`. That ref must exist locally; the script never silently replaces it with current source.

The 16 cases cover desktop/phone, English/zh-TW, fresh shell, actual cached pre-S4 dictionary with a new panel, actual pre-S4 dictionary and already-loaded old panel, and public-link withholding. Exact action, canonical arguments, consequences, literal text, no decision controls, ordinary delivery acknowledgment, errors and phone overflow are asserted. An already-loaded old panel has no new proposal-detail renderer: it remains non-executable and needs a browser refresh to show those details and updated words. The run records this boundary and screenshots both sides of that refresh; it does not claim cached old code changes itself. The updated panel supplies its own translations when only the old shell dictionary is retained.
