# #1306 browser acceptance — recorded run (§10.2)

The recorded manual browser run the design requires before implementation approval (docs/design/1306-inline-html-preview.md §10.2).
Per the leader (2026-10-07), a Chrome for Testing run in both modes is sufficient for approval, since the only guarantee is G1, the account boundary. The other browsers are a template marked "not yet run": the user fills in Safari and Firefox when testing 2.2.1. A failure there blocks the 2.2.1 release, not this merge.

## How it was run

- **Browser:** Chrome for Testing 151.0.7922.34 (Chromium, headless), driven by Playwright.
- **OS:** Linux on WSL2 (Windows host).
- **What ran:** the real dashboard (`/ui`) and the real preview listener (`/frame`), served by an in-process FleetManager in a scratch `AGEND_HOME` on fixed ports. No fleet was started; no CLI; no tmux.
- **How each row was checked:** it was executed inside the live preview frame (Playwright evaluation in that frame, the same realm as the agent's HTML), after the device opted in and **Preview** was clicked. Both listeners logged every request they received, and the browser's request log was recorded too, so "nothing was sent" is checked where it would have arrived.
- **Modes:**
  - **loopback**: dashboard `http://127.0.0.1:47380`, preview on the same host's next port;
  - **preview_origin**: dashboard `http://127.0.0.1:47390`, `web.preview_origin: http://preview.test:47391`, a separate host name mapped to 127.0.0.1 with `--host-resolver-rules`.
- **Code:** the run used commit `e5ab7870` (segment B with segment A merged in).
- **Harness:** `scripts/manual/preview-matrix-1306.mts`, in this PR; it needs playwright-core and a Chromium.

**Result: every G1 row passes in both modes.** 24 of the 28 rows are pass/fail rows, and all 24 pass in both modes; the other 4 are recorded-only.

## Results

| Check, inside the preview | Expected | loopback | preview_origin |
|---|---|---|---|
| document.cookie | throws SecurityError or ""; never the session | **pass**: throws SecurityError | **pass**: throws SecurityError |
| parent.document | throws | **pass**: throws SecurityError | **pass**: throws SecurityError |
| top.location.href (read) | throws | **pass**: throws SecurityError | **pass**: throws SecurityError |
| top.location = … (write) | blocked (dashboard stays) | **pass**: http://127.0.0.1:47380/ui | **pass**: http://127.0.0.1:47390/ui |
| fetch("/ui/send", POST) to the dashboard | blocked by CSP | **pass**: rejected TypeError — dashboard received: [] | **pass**: rejected TypeError — dashboard received: [] |
| fetch to the preview origin | blocked / nothing sent | **pass**: rejected TypeError — dashboard received: []; preview listener received: [] | **pass**: rejected TypeError — dashboard received: []; preview listener received: [] |
| navigator.sendBeacon to the dashboard | blocked / nothing sent | **pass**: returned true — dashboard received: [] | **pass**: returned true — dashboard received: [] |
| new WebSocket to the dashboard | blocked / nothing sent | **pass**: error event — dashboard received: [] | **pass**: error event — dashboard received: [] |
| new EventSource to the dashboard | blocked / nothing sent | **pass**: error event — dashboard received: [] | **pass**: error event — dashboard received: [] |
| <img src> to the dashboard | blocked / nothing sent | **pass**: error event — dashboard received: [] | **pass**: error event — dashboard received: [] |
| CSS url() to the dashboard | blocked / nothing sent | **pass**: styled; requests checked server-side — dashboard received: [] | **pass**: styled; requests checked server-side — dashboard received: [] |
| <link rel=prefetch> to the dashboard | blocked / nothing sent | **pass**: error event — dashboard received: [] | **pass**: error event — dashboard received: [] |
| form submit to the dashboard | blocked / nothing sent | **pass**: submitted (sandbox decides) — dashboard received: [] | **pass**: submitted (sandbox decides) — dashboard received: [] |
| window.open | blocked / nothing sent | **pass**: returned null — dashboard received: [] | **pass**: returned null — dashboard received: [] |
| alert | blocked / nothing sent | **pass**: returned — dashboard received: [] | **pass**: returned — dashboard received: [] |
| self-navigation: location = "https://example.org/?x" | blocked: the target never loads | **pass**: frame at chrome-error://chromewebdata/; original content gone — requests issued: []; preview listener received: [] | **pass**: frame at chrome-error://chromewebdata/; original content gone — requests issued: []; preview listener received: [] |
| self-navigation: <meta http-equiv=refresh> | blocked: the target never loads | **pass**: frame at chrome-error://chromewebdata/; original content gone — requests issued: []; preview listener received: [] | **pass**: frame at chrome-error://chromewebdata/; original content gone — requests issued: []; preview listener received: [] |
| self-navigation: link click | blocked: the target never loads | **pass**: frame at chrome-error://chromewebdata/; original content gone — requests issued: []; preview listener received: [] | **pass**: frame at chrome-error://chromewebdata/; original content gone — requests issued: []; preview listener received: [] |
| self-navigation: location = "data:…" | blocked: the target never loads | **pass**: frame at chrome-error://chromewebdata/; original content gone — requests issued: []; preview listener received: [] | **pass**: frame at chrome-error://chromewebdata/; original content gone — requests issued: []; preview listener received: [] |
| self-navigation: location = "blob:…" | blocked: the target never loads | **pass**: frame at chrome-error://chromewebdata/; original content gone — requests issued: []; preview listener received: [] | **pass**: frame at chrome-error://chromewebdata/; original content gone — requests issued: []; preview listener received: [] |
| self-navigation: location = "javascript:…" | blocked: the target never loads | **pass**: frame at http://127.0.0.1:47381/frame; original content still there — requests issued: []; preview listener received: [] | **pass**: frame at http://preview.test:47391/frame; original content still there — requests issued: []; preview listener received: [] |
| self-navigation: location = "/other" | blocked: the target never loads | **pass**: frame at chrome-error://chromewebdata/; original content gone — requests issued: []; preview listener received: [] | **pass**: frame at chrome-error://chromewebdata/; original content gone — requests issued: []; preview listener received: [] |
| self-navigation: location = "/frame?x" (the known bypass) | allowed by frame-src (path match): reaches only the preview listener | **pass**: frame at http://127.0.0.1:47381/frame?x; original content gone — requests issued: ["http://127.0.0.1:47381/frame?x"]; preview listener received: ["GET /frame?x"] | **pass**: frame at http://preview.test:47391/frame?x; original content gone — requests issued: ["http://preview.test:47391/frame?x"]; preview listener received: ["GET /frame?x"] |
| WebRTC entry points in the preview's realm | removed by the shim (defence in depth only — not a block) | **recorded**: {"RTCPeerConnection":"undefined","webkitRTCPeerConnection":"undefined","RTCDataChannel":"undefined","nestedFrame":"throws SecurityError"} — A nested about:blank frame is same-origin with the preview and inherits its sandbox; whether it exposes a fresh RTCPeerConnection is recorded here. The design makes no no-network claim either way (§4.3); STUN/TURN to a loopback relay and the RFC 8828 mode 3/4 cases were not exercised in this run. | **recorded**: {"RTCPeerConnection":"undefined","webkitRTCPeerConnection":"undefined","RTCDataChannel":"undefined","nestedFrame":"throws SecurityError"} — A nested about:blank frame is same-origin with the preview and inherits its sandbox; whether it exposes a fresh RTCPeerConnection is recorded here. The design makes no no-network claim either way (§4.3); STUN/TURN to a loopback relay and the RFC 8828 mode 3/4 cases were not exercised in this run. |
| watchdog: heartbeats stop | frame closed after ~10 s (best effort) | **pass**: closed after 10.1 s | **pass**: closed after 10.1 s |
| busy loop in the preview | recorded: does the parent's Stop and its timers respond within 1 s? | **recorded**: Stop clicked 8 ms after asking; parent timer {"ticks":18,"maxGapMs":100}; frames left 0 | **recorded**: Stop clicked 5 ms after asking; parent timer {"ticks":18,"maxGapMs":102}; frames left 0 |
| a new preview after a busy one was stopped | recorded | **recorded**: did not render within 60 s in the same tab (the stopped preview's renderer process keeps spinning); a reload of the tab did not clear it within 30 s | **recorded**: did not render within 60 s in the same tab (the stopped preview's renderer process keeps spinning); a reload of the tab did not clear it within 30 s |
| memory growth in the preview | recorded: does the parent's Stop and its timers respond within 1 s? | **recorded**: Stop clicked 25 ms after asking; parent timer {"ticks":18,"maxGapMs":105}; frames left 0 | **recorded**: Stop clicked 8 ms after asking; parent timer {"ticks":18,"maxGapMs":100}; frames left 0 |

### Reading the rows

- **G1 (the guarantee):** `document.cookie` throws `SecurityError`; `parent.document`, `top.location` read and write are refused, and the dashboard tab stays on `/ui`; a `fetch` POST to `/ui/send` is rejected, and the dashboard received nothing.
- **Network restrictions (best effort):** fetch, beacon, WebSocket, EventSource, images, CSS `url()`, prefetch and form submits all reached neither listener. `navigator.sendBeacon` returns `true` (queued) but nothing arrives: CSP blocks the request.
- **Self-navigation:** every external, `data:`, `blob:` and `/other` target is blocked. Chromium replaces the frame with its own error page (`chrome-error://chromewebdata`) rather than keeping the shim, and the target is never requested. `javascript:` URLs are refused outright. `/frame?x` is the known bypass (§4.3): it reaches only the preview listener, which answers with an empty 404.
- **WebRTC:** the shim removed the constructors from the preview's realm, and a nested frame cannot be used to get them back. This is defence in depth, not a block. STUN/TURN to a loopback relay and the RFC 8828 mode 3/4 cases were not exercised: with no constructor there is nothing to probe with, and the design makes no no-network claim (§1, §4.3).
- **Freezes (§8, residual risk accepted):** in this Chromium, a busy or allocating preview did **not** freeze the dashboard in either mode: the parent's 100 ms timer kept ticking (worst gap ≈ 100 ms), and **Stop** removed the frame within milliseconds. Chromium puts sandboxed frames in a separate process.
- **A stopped busy preview keeps spinning:** removing the frame does not stop its process, and new previews in the **same tab** do not start (still none after 60 s, nor 30 s after reloading the tab). A preview in a **new tab** does start. The card's "unavailable" message now says to open the dashboard in a new tab, and the user guide says so too.
- **Watchdog:** a preview that stops sending heartbeats is closed after ≈10 s.

## Not yet run (template)

| Check, inside the preview | Expected | Edge (desktop) | Chrome on Android | Safari (macOS) | Safari (iOS) | Firefox |
|---|---|---|---|---|---|---|
| document.cookie | throws SecurityError or ""; never the session | not yet run | not yet run | not yet run | not yet run | not yet run |
| parent.document | throws | not yet run | not yet run | not yet run | not yet run | not yet run |
| top.location.href (read) | throws | not yet run | not yet run | not yet run | not yet run | not yet run |
| top.location = … (write) | blocked (dashboard stays) | not yet run | not yet run | not yet run | not yet run | not yet run |
| fetch("/ui/send", POST) to the dashboard | blocked by CSP | not yet run | not yet run | not yet run | not yet run | not yet run |
| fetch to the preview origin | blocked / nothing sent | not yet run | not yet run | not yet run | not yet run | not yet run |
| navigator.sendBeacon to the dashboard | blocked / nothing sent | not yet run | not yet run | not yet run | not yet run | not yet run |
| new WebSocket to the dashboard | blocked / nothing sent | not yet run | not yet run | not yet run | not yet run | not yet run |
| new EventSource to the dashboard | blocked / nothing sent | not yet run | not yet run | not yet run | not yet run | not yet run |
| <img src> to the dashboard | blocked / nothing sent | not yet run | not yet run | not yet run | not yet run | not yet run |
| CSS url() to the dashboard | blocked / nothing sent | not yet run | not yet run | not yet run | not yet run | not yet run |
| <link rel=prefetch> to the dashboard | blocked / nothing sent | not yet run | not yet run | not yet run | not yet run | not yet run |
| form submit to the dashboard | blocked / nothing sent | not yet run | not yet run | not yet run | not yet run | not yet run |
| window.open | blocked / nothing sent | not yet run | not yet run | not yet run | not yet run | not yet run |
| alert | blocked / nothing sent | not yet run | not yet run | not yet run | not yet run | not yet run |
| self-navigation: location = "https://example.org/?x" | blocked: the target never loads | not yet run | not yet run | not yet run | not yet run | not yet run |
| self-navigation: <meta http-equiv=refresh> | blocked: the target never loads | not yet run | not yet run | not yet run | not yet run | not yet run |
| self-navigation: link click | blocked: the target never loads | not yet run | not yet run | not yet run | not yet run | not yet run |
| self-navigation: location = "data:…" | blocked: the target never loads | not yet run | not yet run | not yet run | not yet run | not yet run |
| self-navigation: location = "blob:…" | blocked: the target never loads | not yet run | not yet run | not yet run | not yet run | not yet run |
| self-navigation: location = "javascript:…" | blocked: the target never loads | not yet run | not yet run | not yet run | not yet run | not yet run |
| self-navigation: location = "/other" | blocked: the target never loads | not yet run | not yet run | not yet run | not yet run | not yet run |
| self-navigation: location = "/frame?x" (the known bypass) | allowed by frame-src (path match): reaches only the preview listener | not yet run | not yet run | not yet run | not yet run | not yet run |
| WebRTC entry points in the preview's realm | removed by the shim (defence in depth only — not a block) | not yet run | not yet run | not yet run | not yet run | not yet run |
| watchdog: heartbeats stop | frame closed after ~10 s (best effort) | not yet run | not yet run | not yet run | not yet run | not yet run |
| busy loop in the preview | recorded: does the parent's Stop and its timers respond within 1 s? | not yet run | not yet run | not yet run | not yet run | not yet run |
| a new preview after a busy one was stopped | recorded | not yet run | not yet run | not yet run | not yet run | not yet run |
| memory growth in the preview | recorded: does the parent's Stop and its timers respond within 1 s? | not yet run | not yet run | not yet run | not yet run | not yet run |

For each browser, record the browser, version, OS and mode (loopback / preview_origin), then pass, fail or recorded per row, with notes. The G1 rows (the first five) must pass.
