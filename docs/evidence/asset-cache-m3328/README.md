# M-3328: the org chart's route worker, the office pictures and the panels' stylesheets under the version

M-3316 measured the fixed public link on 2.4.0-beta.12, after M-3314 (#4160). The app's modules were cached by then. Three kinds of file still went out as plain `no-store` requests on every open:

- **The route worker.** A worker does not use the page's import map. The org chart started `/ui/js/fleet-route-worker.js` by its plain path, so its `./fleet-route-scene.js` and `./fleet-canvas-layout.js` were fetched again by their plain paths. The page already held both under its version. It was also one request after another: the `.wasm`, then the worker, then libavoid's glue and the worker's imports. That took about 1.7 s over the link.
- **The office backgrounds** (`office-cozy/guild/school.png`).
- **The panels' own stylesheets**, linked by the module when it is first used: loading, hub, reply-previews, chat-work-bar, task-board, runtime-install, access-overview, and the rest.

## What changed

- **`assetUrl()`** (`src/ui/shared/asset-url.js`) puts an `/assets/<name>` path under the page's version. The page loads this module through the import map, so the module's own URL carries `<V>`.
  - Every stylesheet or picture a module links later now goes through it. A unit test scans `src/ui` and fails on any plain one.
  - Under the version the server answers `public, max-age=31536000, immutable`.
  - A tab older than the server asks for its own `<V>` and gets a 404, never a newer file (the same rule as #4160 for stylesheets). Before this change, the plain link gave an old tab the newer stylesheet.
  - Kept plain on purpose: `stale-tab.css`, the prompt an older tab shows, because under that tab's version it would be a 404. Also the `app.css?…` heals for an older `app.css`, which never fire under a version.
  - Where the modules are loaded by their plain paths (the Hub's pages, the office share page), `assetUrl` changes nothing.
- **The route worker** starts at `/ui/js/v-<V>/fleet-route-worker.js`.
  - Its relative imports then resolve to the page's own cached files.
  - It keeps its own policy (`ROUTE_WORKER_CSP`, the one place WebAssembly may compile).
  - A page older than the server gets the stale-module answer. The worker fails and the lines keep their lane routes; a newer worker never runs in an older page.
- **`warmRouter()`**: when Live is on, the org chart asks for libavoid's `.wasm`, its glue and the worker all at once. The worker is included only under a version, where the answer is cached. The client then starts the worker with the `.wasm` bytes that were already fetched.

## Method

`scripts/manual/smoke/smoke-asset-cache-m3328.mts` runs the real app in a smoke fixture (headless Chromium) with 150 ms of latency on every request, as M-3314's smoke does. The fleet has two teams and three open delegations, with Live on.

Steps, in order:
1. Load `/ui` with an empty cache.
2. Open the org chart from the page. Time from opening it to every traffic line routed by the worker.
3. Open the Office view.
4. Open Settings, Needs you and the Hub.
5. Reload on the org chart (time to every line routed again).
6. Change the server's version under the open tab, then open two panels.

Server hits are counted at the listener, so they include the worker's own imports, which the page's CDP session does not see.

- `before.json`: the same script run with `BEFORE=1` against the base, `release/2.3.5-alpha` at ad2a86cc, which already has #4160.
- `after.json`: this branch, with all 15 checks passing.

## Results (150 ms latency)

| | Before | After |
|---|---|---|
| Org chart, first open: every line routed | 2.30 s | **1.53 s** |
| Route worker's imports fetched by plain path | `fleet-route-scene.js`, `fleet-canvas-layout.js` (`no-store`) | **none** (the page's cached files) |
| `.wasm`, libavoid glue, worker | asked for one after another | **one wave**; the worker's own start is served from the cache |
| Office picture | `/assets/office-cozy.png`, `no-store` | `/assets/v-<V>/office-cozy.png`, public immutable |
| Panel stylesheets seen | 6 plain (`loading`, `reply-previews`, `chat-work-bar`, `task-board`, `runtime-install`, `access-overview`) | **all under the version** |
| Org chart again (reload): every line routed | 1.48 s | **0.96 s** |
| Org chart again: stylesheets, router files and pictures that reached the server | 7 | **0** |

Other checks:
- No console errors and no CSP violations. The fixture has no task board, so the Office view's read of it is a 503 on both trees; that one is set aside.
- After the update, nothing under the newer version reached the old tab.
- `after-org-first.png` shows the routed lines; `after-office.png` shows the Office view on its versioned picture.

The re-measure over the real fixed link (M-3312's method) comes after this ships to the host.
