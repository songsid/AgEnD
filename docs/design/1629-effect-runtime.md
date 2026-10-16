# Canvas Worker effects (#1629, user choice A)

The effect entry is a UTF-8 classic Worker script. **No mod HTML or CSS is executed in a document.** Widgets are drawn by the host; they use no effect Worker or iframe. This replaces the unshipped HTML effect primitive from #1885. Ordinary HTML previews at `/frame` retain their existing policy.

## Execution boundary

`GET /effect` serves a static trusted document containing a canvas and bootstrap only, on the preview listener. It retains its exact Host/ancestor admission, opaque `sandbox allow-scripts` (no `allow-same-origin`), no cookies, no per-request logging and local-dashboard origins only. The public preview gateway still exposes `/frame` alone.

The effect CSP adds `blob:` to `script-src` and permits only `worker-src blob:`. `frame-src 'none'`, `child-src 'none'`, `connect-src 'none'`, form/object/base restrictions and the other preview headers remain. No `unsafe-eval`, remote script or same-origin permission is added. The current dashboard CSP is unchanged; a future mounting PR must admit only the preview effect origin and retain the local-only/public-link gate.

A single render from the exact dashboard parent transfers one private MessagePort. Its closed payload contains code, resolved primitive params, a scoped instance name (or null), host-chosen dimensions/DPR and bounded raster asset bytes. There is no HTML field. The shim decodes assets to ImageBitmaps with an aggregate 8 Mi pixel limit (and 4096 per side), transfers its canvas to an OffscreenCanvas, and loads a trusted Worker bootstrap. That bootstrap imports the user's separate Blob script in a later task, outside any port-bearing event. It never concatenates user source into a trusted lexical scope.

The Worker receives a frozen `agend` facade:

- `canvas`: OffscreenCanvas, no DOM/ownerDocument/focus capability;
- `params`: frozen, already validated values;
- `asset(name)`: a transferred ImageBitmap;
- `on(kind, callback)`: closed content-free signal subscriptions;
- `frame(callback)`: captured Worker rAF, with a timer fallback;
- `ready()`: at most one readiness signal.

Nested Worker constructors and `importScripts` are neutralized before user code runs. The trusted loader retains its captured import function. This is defence in depth; the opaque origin/CSP and absence of DOM are the boundaries. A single classic entry is supported, with no supplied helper/module files. JS lints are not a confinement proof.

The frame ignores the Worker's global messages. Its private link forwards exactly one `{type:'ready'}`. No errors, diagnostics, health/timing, commands or pong reach the dashboard. The host-facing protocol remains ready-only. Native data getters and asynchronous schedulers are captured before user code; callbacks cannot receive the private init event or port. Signals are checked both in the document and Worker and reject sibling instance/content fields.

The shim terminates an unready Worker after ten seconds. Unsupported capability, asset decode failure, Worker error or pagehide closes ports, terminates the Worker and releases Blob URLs/bitmaps. A decode finishing after disposal cannot start another Worker. The product factory must supply its own boot/source/origin/second-load fence, registry/caps, trust clipping and profiler before mounting anything; this PR does not implement or bypass those prerequisites.

## Format agreed with r4-5

An effect uses `effect.json`, fixed `worker.js`, runtime `canvas-worker-v1`, optional sanitized raster `assets/` (at most 16), and the r2 poster/cursor. No HTML/CSS/WOFF2. Closed params descriptors support bounded numbers/integers, booleans, colors and enums; no arbitrary JSON Schema, URL or executable strings. The whole normalized entry is at most 1 MiB. The library/manifest validation and upload tools land separately; a runtime render is not upload authorization.

## Browser controls and limits

Run `npm run build`, then the checked-in scratch recipe:

```
PW_DIR=<private Playwright prefix> PLAYWRIGHT_BROWSERS_PATH=<private cache> \
  PROBE_ENGINES=chromium,firefox,webkit node scripts/manual/effect-runtime-1629.mts
```

It uses the built production shim on scratch HTTP listeners, private HOME/TMPDIR/browser contexts, and cleans up in finally. It never starts a fleet, backend, adapter, account session or tmux. WebKit may run in an official pinned Playwright container with network disabled, read-only own sources and an own output mount; no `/tmp` bind or host package installation is needed.

Controls cover real Worker DOM/focus absence, keyboard injection, Chromium CDP IME (not physical IME), content-free events, PNG/ImageBitmap/canvas pixels, one ready/load, Worker-side fetch, image-fetch, WebSocket, EventSource, dynamic import, FontFace and XHR attempts before ready with zero scratch trap hits, plus an unrestricted Worker control that reaches every available transport (including a nested Worker); nested-frame CSP denial, pagehide termination and a nonresponsive Worker killed at the startup deadline. Actual Safari/OS IME/mobile installation is a later rehearsal, not implied by Linux WebKit. Unsupported startup leaves the future product poster; it must never fall back to DOM execution.

Dedicated Worker CPU/GPU cost is not measurable from ready-only messages. The future profiler uses host-observed load/cadence/long tasks/hidden state only, with conservative degradation while effects are active when attribution is unavailable. Callback-reported cost is not trusted. Registry caps, hard resource exhaustion limits and browser engine vulnerabilities remain separate concerns.

### Review round 2

The browser recipe measures Worker-originated traffic, not just document-created frames. Each available transport must settle before ready without reaching the scratch server; a no-CSP control uses the same probe and must reach that server for every available transport. The Worker constructors are separately absent in the effect realm. These observations cover the tested engine builds, not all future versions or physical Safari. The decoded-pixel sum prevents sixteen independently valid bitmaps from accumulating sixteen per-image budgets; peak decoder allocation and image codec vulnerabilities remain outside this check.


## Reserved mention trigger

The `mention` codec/manifest kind remains reserved for compatibility, but the registry and independent final-send gate never emit it in 2.3.0. No text parsing or inferred target is permitted. Provider-confirmed direct-ID, viewer-scoped boolean pulses are deferred to [#1963](https://github.com/songsid/AgEnD/issues/1963). Worker subscriptions may name the reserved kind without receiving events.
