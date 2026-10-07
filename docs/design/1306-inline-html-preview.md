# #1306: interactive inline HTML in the web chat

**Status:** design for review (🔒 Prism), **r3** — no code yet. Milestone 2.2.1, branch `feature/2.2-web`.
**Inputs:** the leader's decision on #1306 (2026-10-07, delegated by the user, to be adjusted after testing) and
claude-fable's *AgEnD web chat design study*, section 3. Every claim about today's code was re-read at
`feature/2.2-web` **4ed04167** (after #1313/#1316/#1317 and #1300's style nonces); external references (CVEs, specs) are the study's or the
review's and are cited, not re-verified. r2 answers Prism's review of r1 (8e3a846e) with the leader's decision-owner
calls on it (2026-10-07; the user delegated web decisions): §11 maps each finding.

## 1. What we are building — and what we promise

When an agent's reply contains a fenced ` ```html ` block — or attaches a `.html` file — the web chat shows a card
under it. Nothing runs until the person clicks **Preview**. The preview runs in a sandboxed frame served by a
*separate listener*, so the HTML never executes with the dashboard's authority: the dashboard origin holds the
session cookie, can read the CSRF value, and fronts every write (stop, restart, delete instances, config, send,
approve prompts).

**The guarantee, stated narrowly.**

- **G1 — account boundary (all supported browsers), the real guarantee:** the preview cannot act as the signed-in
  person. It runs in an opaque-origin sandbox on a separate listener, so it has no dashboard origin, no
  cookie-bearing request it can read, and no CSRF value; cookie writes still need Origin and CSRF. Only
  server-marked agent messages are rendered, frames are fenced by origin and boot id, and its messages reach nothing
  but a resize/heartbeat handler.
- **No "no network" guarantee (r3 — decision owner, 2026-10-07).** The network restrictions (§4.3) are
  **best effort**, and the design does not claim that a preview cannot send data out.
  - **WebRTC:** no shipping browser enforces CSP `webrtc 'block'`. Firefox does not implement it
    ([bug 1783489](https://bugzilla.mozilla.org/show_bug.cgi?id=1783489)). Chromium's CSP parser does not recognise
    it, and its RTCPeerConnection gate reads a different, experimental header, `Connection-Allowlist`
    ([CSP parser](https://chromium.googlesource.com/chromium/src/+/0d3c97b1914dbf780413c8ab904f2ca736af61c3/services/network/public/cpp/content_security_policy/content_security_policy.cc),
    [RTC gate](https://chromium.googlesource.com/chromium/src/+/0d3c97b1914dbf780413c8ab904f2ca736af61c3/third_party/blink/renderer/modules/peerconnection/rtc_peer_connection.cc),
    revision 0d3c97b1).
  - **Navigation** can carry data too (§4.3).
  - **So Preview is off by default in every browser.** One explicit per-device opt-in enables it (§7), and every
    preview then carries the banner "Previews run the agent's HTML in an isolated frame. It cannot use your login, but it may be able to send data out. Only preview content you trust. A preview can slow or freeze this tab."
- **Not promised:**
  - The HTML is **not** assumed to be harmless or public. Agent output can contain private data, and a preview runs
    code the agent wrote, inside the person's browser, without a guarantee that it cannot send that data out.
  - Click-to-run is a consent step, not proof that the source is non-confidential.
  - Availability is best effort, and the remaining risk is **accepted** (§8): a preview may freeze the tab or use
    memory without bound.

Decided (realised here, not re-opened):

1. A dedicated **preview listener on a separate port**, loopback by default; optional `web.preview_origin` (a
   separate hostname) for the strongest isolation. Never a same-origin `/ui/preview` route.
2. **Network restricted, best effort:** `connect-src 'none'` and the rest of §4.3; libraries must be inlined.
   r3: no no-network claim; Preview is off by default everywhere, with one per-device opt-in.
3. **Source:** only ` ```html ` fences (and `.html` attachments, Q4) in messages the **server** marks
   `role: "agent"`. HTML from users (web, Telegram, Discord, other members) is never rendered.
4. **Limits:** 1 MiB of HTML, 4000 px height cap, rate-limited resize, 10 s watchdog (best effort).
5. **Click to run**, always. Controls: Preview / Stop / Source / Download. **Open in new tab is deferred** (§13).
6. **postMessage:** accept only `event.source === iframe.contentWindow`, fixed shapes; the listener is connected to
   nothing that sends, approves or calls an API.
7. When the dashboard is reached through a tunnel/gateway exposing one port and no `web.preview_origin` is set,
   preview is **disabled** — Source and Download only.

## 2. Today (verified at 4ed04167)

| Fact | Where |
|---|---|
| `reply.format` is `"text" \| "markdown"`; there is no HTML format. | `src/outbound-schemas.ts:14`, `:25` |
| An agent reply reaches the web chat only through `afterReplyRouted`, which emits `message` with `instance, sender, text, ts, attachments` — no format, no role. Text is cut at `WEB_CHAT_TEXT_MAX`. | `src/fleet-manager.ts:6712`, `:6735-6740` |
| `WEB_CHAT_TEXT_MAX` is 16,000 characters; the history cuts again on record. | `src/web-chat-history.ts:70`, `:105-115` |
| The same `message` event carries **people's** messages: a platform user to an instance (`sender: msg.username`), the same for General, and the dashboard's own sends (`sender: "web-user"`). A daemon status line on a web-only fleet also arrives as `message` with the instance as sender. | `src/fleet-manager.ts:6450-6453`, `:6334-6337`; `src/web-api.ts:915`; `src/fleet-manager.ts:6665-6668` |
| `emitSseEvent("message")` records a fixed field list (`instance, sender, text, ts, attachments, messageId`) and broadcasts the *recorded* copy, so a new field is dropped unless `record()` copies it. | `src/fleet-manager.ts:11617-11630`; `src/web-chat-history.ts:105-115` |
| The dashboard decides "user or agent" from `sender` by heuristic (`isUserMsg`: `web-user`, starts with `agend`, equals the instance, `general`). A platform user can pick any username, so this decides styling only and is **not** a trust boundary. | `src/ui/dashboard.html:883` |
| `renderMarkdown` escapes everything first; fenced code becomes `<pre><code>` (highlighted only for known languages, `html` is not one). The fence regex also accepts an **unterminated** fence (`(?:```\|$)`), which is what a 16,000-character cut produces. | `src/ui/chat-render.js:1-8`, `:225-228`, `:246-262` (regex `:250`) |
| Since #1313 the chat is **keyed**: one node per message, key `boot-id`. `renderMsgs` appends new nodes, **replaces** a node whose HTML string changed (`replaceWith`), **re-inserts** a node whose position changed (`insertBefore`), removes nodes that left the list, and starts over (`textContent = ""`) when the `#messages` element changes (another instance). `msgNode` builds a node from `msgHtml` through a `<template>`, then `decorateCode` wraps each `pre` with DOM nodes. | `src/ui/dashboard.html:871-879`, `:884-890`, `:892-897`, `:900-917`, `:918-953` |
| The R6 prompt cards are built from DOM nodes with `textContent` — the pattern the HTML card follows. | `src/ui/dashboard.html:1038-1061` |
| Every response from the web listener gets `X-Frame-Options: DENY` and a CSP with **no `frame-src`** (so frames fall back to `default-src 'self'`) and `frame-ancestors 'none'`. Panels add a per-response nonce for scripts **and styles** (#1300): no inline style attribute applies. | `src/web-host-guard.ts:67-78` (`:77`), `:114-123` (`:118`), `:126-130`, `:137-142` |
| `/ui` is served by `sendPanelHtml`. | `src/web-api.ts:252-258` |
| Session cookie `agend_session` / `__Host-agend_session`, `HttpOnly; SameSite=Strict`; `Secure` is decided from `X-Forwarded-Proto`. | `src/web-auth.ts:24-25`, `:194`, `:198`, `:178` |
| A request whose `Origin` does not match `Host` is refused — including the opaque `null` a sandboxed frame sends. A cookie write also needs `Origin`, `Sec-Fetch-Site: same-origin` (when sent) and `X-Agend-CSRF`. | `src/web-auth.ts:160-172`, `:243-248` |
| Any script on the dashboard origin can obtain the CSRF value (`/auth/session`). HttpOnly protects the cookie's value, not its authority. | `src/ui/shared/agend-auth.js:29-39` |
| The web listener binds **127.0.0.1** only (default port 19280). Remote use goes through a proxy/tunnel whose name must be `hostname` or in `web.allowed_hosts`; loopback names are `localhost`, `127.0.0.1`, `[::1]`. | `src/fleet-manager.ts:4795`, `:16021`, `:16029`; `src/web-host-guard.ts:23`, `:86-97` |
| `WebConfig` has no preview settings today. | `src/types.ts:325-344` |
| A `.html` file is not in `MIME_BY_EXT` → `application/octet-stream`; `/ui/file/<id>` serves anything but four image types as an attachment with `sandbox` CSP. Upload cap 10 MiB per file. | `src/web-upload.ts:129-133`, `:290`, `:18-25`; `src/web-api.ts:416-432` |
| A loopback side listener already exists as a precedent (`127.0.0.1:0` per web-terminal session). | `src/web-terminal-http.ts:2-4` |
| `/api/activity` and the roster answer with `Access-Control-Allow-Origin: *`; `/view` reads bypass the gate unless `web.view_access: session`. | `src/fleet-manager.ts:15824`, `:15856`; `src/auth-api.ts:95` |

So today an agent's HTML is shown as escaped text and runs nowhere. That is the baseline every change below must
keep for anything not explicitly opted in.

## 3. Architecture

```
 dashboard origin (http://127.0.0.1:19280, or the tunnel host)        preview origin (separate port or host)
 ┌───────────────────────────────────────────────┐                   ┌──────────────────────────────┐
 │ /ui  CSP …; frame-src <preview origin>/frame  │  iframe src=      │ GET /frame  → static shim    │
 │  chat card ── click Preview ──────────────────┼──────────────────▶│  CSP sandbox allow-scripts;  │
 │  <iframe sandbox="allow-scripts" allow=""     │                   │  default-src 'none' …        │
 │          referrerpolicy="no-referrer">        │◀── postMessage ───│  frame-ancestors <dashboard> │
 │  listener: ready/resize/heartbeat only        │  ready{boot}      │                              │
 │  ── postMessage {render, html} ──────────────▶│                   │ everything else → 404        │
 └───────────────────────────────────────────────┘                   └──────────────────────────────┘
```

### 3.1 The preview listener

- A second `http.Server`, created with the web listener and closed with it. It serves **only**:
  - `GET /frame` — the shim (§4), built once at start from config (it embeds the dashboard origins and the
    listener's boot id), then identical for every request;
  - everything else, every other method, any query string: `404`, empty body. It never redirects.
- No `/ui`, `/api`, `/auth`, `/assets` routes; no session lookup; it never parses, logs or reflects `Cookie`,
  `Authorization`, the request target or any header. Because cookies are not isolated by port (RFC 6265 §8.5), a
  same-host preview port **will** receive `agend_session`; ignoring it is a requirement, and the test plan checks it.
- Its own `Host` allow-list: the loopback names, plus the `web.preview_origin` host when set. Anything else → 403.
- It does **not** call `applyWebSecurityHeaders` (that sets `X-Frame-Options: DENY` and `frame-ancestors 'none'`,
  which would make the shim unframeable). It sets its own headers (§5.1).
- **Boot id.** A random 128-bit value generated per fleet start. The shim embeds it and reports it in `ready`, and
  the `/ui` page receives it from the server. The parent sends HTML only to a frame that reports this exact id, so
  another process that happens to answer on the preview port is never given content (§3.2). It is not a secret
  from the content (content runs after `ready`), only proof of which listener served the shim.
- **Address.** Proposed new config, all optional:

  | key | default | meaning |
  |---|---|---|
  | `web.preview` | `true` | Master switch. `false`: no listener, cards show Source/Download only. |
  | `web.preview_port` | `health_port + 1` (19281) | Port of the preview listener; bound to `127.0.0.1`. A fixed default (not `:0`) so an SSH user can forward it alongside the dashboard (Q2). |
  | `web.preview_origin` | — | Full origin (`https://preview.example.net`) of a **separate hostname** that a proxy maps to the preview listener. Must be https when the dashboard is reached over https (mixed content), must not equal any dashboard origin, and must not share the dashboard's registrable domain unless the owner accepts same-site (Q3). |

  The validator rejects a `preview_origin` with a path, query, credentials or wildcard, and one whose host is in the
  dashboard's allowed names (`allowedHostNames`) — that would be a same-origin preview by another name.

### 3.2 When preview is available

Two checks, one on the server and one in the page. Both must pass.

**Server, per `/ui` load.** From the request's `Host` (and the scheme already used for the cookie's `Secure`,
`X-Forwarded-Proto`, `web-auth.ts:178`), the server computes the **dashboard origin** it believes it is serving
and picks the preview origin:

| Dashboard `Host` | `web.preview_origin` | Preview origin |
|---|---|---|
| loopback name | not set | `http://<same loopback name>:<preview_port>` |
| any | set | `web.preview_origin` |
| not loopback (tunnel, proxy, `hostname`, `allowed_hosts`) | not set | none — **disabled** |

It hands the page `data-dashboard-origin`, `data-preview-origin` (empty when disabled) and `data-preview-boot`,
and builds the `/ui` response's `frame-src` from the same preview origin (§5.2). `X-Forwarded-Host` is **never**
read for this.

**Page, before creating any frame.** `location.origin` must equal `data-dashboard-origin` exactly. A mismatch
disables preview for the page load and says why. This catches the case Prism raised: a reverse proxy that
rewrites the upstream `Host` to `127.0.0.1:19280`. The server then believes it is local and would offer
`http://127.0.0.1:19281`, but the browser is really at `https://fleet.example.net`.
- **Deployment requirement (documented):** a proxy must pass the external `Host` through unchanged. Today that is
  already what `web.allowed_hosts` assumes (`web-host-guard.ts:86-97`).
- **What a Host-rewriting proxy loses:** Preview, with a visible reason, and nothing else.

**Frame identity.** The parent sends `render` only after a `ready` from that frame carrying
`boot === data-preview-boot`, and only on a device that has opted in (§7). With no valid `ready` within 3 s, the card unloads
the frame and shows "Preview unavailable from this browser". That is the SSH case where only 19280 is forwarded,
and it is also any other process answering on 19281.

## 4. The shim and the postMessage protocol

The shim is one static HTML document with one inline script, served from the preview listener. It knows nothing
about chats, users or instances; the HTML arrives over `postMessage` (the web.dev "shim" pattern), so the listener
stays stateless: AgEnD does not put HTML in the transport URL, and the listener logs nothing.

### 4.1 Messages

**Frame → parent** — the only accepted shapes:

```js
{ v: 1, type: "ready",     ch: null, boot: "<listener boot id>" }
{ v: 1, type: "resize",    ch: "<id>", height: <integer> }
{ v: 1, type: "heartbeat", ch: "<id>" }
```

**Parent → frame** — exactly one message, sent only after a valid `ready` (boot matches), and only on a device that
has opted in (§7):

```js
{ v: 1, type: "render", ch: "<per-frame random id>", html: "<the HTML, ≤ 1 MiB>" }
```

- `targetOrigin` is `"*"`: the sandboxed shim has an opaque origin, so no other value can address it. The frame
  was checked by window identity, boot id and the `frame-src` that pins what it can be (§5.2); the message holds
  only the HTML (no ids, tokens, names or CSRF). The HTML itself may be private (§1).
- `ch` lets the parent tell its own frames apart; it is **not** authentication (the content can read it).

**Shim.**
1. On load, it posts `ready`.
2. It accepts **one** `render` that passes all of these:
   - `event.source === window.parent`;
   - `event.origin` is in the exact allow-list of dashboard origins it was built with; never `"null"`;
   - `html` is a string of ≤ 1 MiB (UTF-8).
3. It neuters the WebRTC entry points in its own realm (defence in depth, §4.3).
4. It `document.open()`s, writes a prologue (heartbeat and height reporter) and then the HTML, and `close()`s.
5. Any later `render` is ignored.

### 4.2 Parent listener

One `window` `message` listener for all cards:

| Rule | |
|---|---|
| Source | `event.source === card.iframe.contentWindow` for a live card; otherwise dropped silently. `event.origin` must be `"null"` (the opaque sandbox), checked *in addition*, never instead. |
| Shape | A plain object with exactly the keys above, `v === 1`, `type` in the set, `ch` equal to the card's (for `resize`/`heartbeat`), `height` a finite integer, `boot` a string. Anything else is dropped. |
| Effect | `ready` → validate the boot id and the device's opt-in (§7), then send `render` once (or unload with a reason). `resize` → set the height (rules below). `heartbeat` → reset the watchdog. **Nothing else**: the listener has no reference to `api()`, `sendMsg`, `answerPrompt`, the composer, navigation or storage, and the test plan asserts it (the Open WebUI CVE-2026-54007 class). |
| Height | Clamp to [40, 4000] px; at most once per animation frame and 10 times per second; ignore changes < 2 px; after 5 consecutive increases within 2 s, freeze the height and let the frame scroll. |
| Watchdog | Best effort, §8. |

### 4.3 Network restrictions (best effort — not a guarantee)

| Channel | Control | Proven by |
|---|---|---|
| fetch, XHR, beacon, WebSocket, EventSource, img/script/style/font/media/prefetch | Preview header CSP `default-src 'none'` + per-type directives (§5.1) | Browser matrix (§10.2) |
| Forms | `form-action 'none'` + no `allow-forms` | Browser matrix |
| Popups, new windows, top navigation | No `allow-popups*`, no `allow-top-navigation*` | Browser matrix |
| **Self-navigation** of the frame (`location =`, `<meta refresh>`, link click, `data:`/`blob:`/`javascript:` URLs) | The **dashboard's** `frame-src <preview origin>/frame` governs every navigation of the nested frame, including one the frame starts itself. Any other URL, `data:` and `blob:` are refused, and the listener answers anything but `/frame` with an empty 404 and never redirects. Known bypass: a navigation to `<preview origin>/frame?…` is allowed. With a loopback preview it reaches only our listener, which logs nothing; with a `preview_origin`, it reaches that proxy's access log. | Browser matrix: every transition named here, in every supported browser |
| **WebRTC** (RTCPeerConnection / ICE / STUN / TURN) | **Not blocked.** CSP `webrtc 'block'` stays in the header for a browser that may honour it one day; no shipping browser does (§1). As defence in depth, the shim deletes `RTCPeerConnection`, `webkitRTCPeerConnection`, `RTCDataChannel`, `RTCIceTransport` and `RTCSctpTransport` from its realm before writing content. No other realm is reachable (`frame-src 'none'`, `worker-src 'none'`, no popups). This is a restriction, not a guarantee. | §10.2 records the outcome per browser |

How this table is read: every row above is a **restriction that makes exfiltration harder**. The browser matrix
(§10.2) records which ones hold where. None of them, alone or together, is presented to the user as "this preview
cannot send data out". WebRTC/STUN/TURN and navigation to `/frame?…` (below) are known ways around them.

**Why there is no probe-based gate** (kept so nobody re-adds one). r2 sent HTML to a frame only if a pre-render
`RTCPeerConnection` probe saw no ICE candidate within 1.5 s. That is not a capability proof:
- RFC 8828 modes 3/4 withhold host candidates, so a probe with no ICE servers sees zero candidates while STUN/TURN
  still work ([RFC 8828 §5.2, §7](https://www.rfc-editor.org/rfc/rfc8828.html#section-5.2));
- gathering slower than the timeout looks like "blocked";
- a constructor or offer failing for an unrelated reason (resources, a policy that is not a block) looks like
  "blocked".

A finite timeout cannot prove an absence. The probe is **removed**: it enables nothing, and there is no
`rtc` field in `ready`. If it ever returns, it may only be informational.

**`web.preview_origin` (proxy) mode.** The shim's URL — and a self-navigation to `/frame?…` made by content — may
appear in that proxy's access log. AgEnD itself never puts content in a URL: the HTML travels only by
`postMessage` (§4.1), never in a path, query or fragment. A malicious preview that writes data into
`/frame?…` is one of the known bypasses above, covered by the opt-in banner, not by a claim.

**Decided (decision owner via the leader, 2026-10-07, r3 — replaces r2's per-browser split):**
- **Preview is off by default on every browser**, with Source and Download only.
- **Opt-in:** **one explicit per-device opt-in** enables it. It is stored in `localStorage`, revocable, and also a
  toggle in the dashboard's settings. It is off by default and never silent: it asks once and states the consequence.
- **Banner:** every preview carries the banner "Previews run the agent's HTML in an isolated frame. It cannot use your login, but it may be able to send data out. Only preview content you trust. A preview can slow or freeze this tab."
- **Controls stay best effort:** the CSP, `frame-src`, sandbox, origin and boot checks all still apply.

## 5. Content Security Policy

### 5.1 The preview listener — `/frame`

```
Content-Security-Policy:
  default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
  img-src data: blob:; font-src data:; media-src data: blob:;
  connect-src 'none'; worker-src 'none'; frame-src 'none'; child-src 'none';
  form-action 'none'; base-uri 'none'; manifest-src 'none'; object-src 'none';
  webrtc 'block';
  frame-ancestors <each dashboard origin>;
  sandbox allow-scripts
Permissions-Policy: camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), display-capture=(), fullscreen=()
Referrer-Policy: no-referrer
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
Cache-Control: no-store
(no X-Frame-Options)
```

- `default-src 'none'` is required: directives without their own fetch directive fall back to it (CSP3 §8.6).
- `webrtc 'block'` is forward-looking only: no browser is relied on to enforce it (§4.3).
- `img-src data: blob:` lets content show inlined images. A navigation to `data:`/`blob:` is a different check,
  governed by the parent's `frame-src` (§4.3).
- `sandbox allow-scripts` in the **header** makes the document opaque-origin even if it is ever loaded without the
  iframe attribute — two independent layers.
- `frame-ancestors` lists exact origins (scheme, host, port): `http://localhost:19280 http://127.0.0.1:19280
  http://[::1]:19280` plus each configured https dashboard origin. Never `'self'`, never `*`.

### 5.2 The dashboard (`/ui` only)

`panelContentSecurityPolicy` gains one directive **for `/ui`, and only when the server chose a preview origin for
this load** (§3.2): `frame-src <preview origin>/frame`. It is path-scoped, so no other route of that origin can be
framed or navigated to. Nothing else changes: `X-Frame-Options: DENY`, `frame-ancestors 'none'`, the script and
style nonces and `connect-src 'self'` stay.

Because styles are nonce-only since #1300, the card and the frame never get a `style` attribute or
`setAttribute("style", …)`. The height from `resize` is applied through the CSSOM (`iframe.style.height = …px`),
which CSP does not restrict, and every other look comes from classes in the nonce'd stylesheet. `/view`, `/settings` and sign-in are untouched. With preview disabled, `/ui` has no
`frame-src` and keeps today's `default-src 'self'` fallback.

### 5.3 The iframe

```html
<iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer" loading="eager"
        src="<preview origin>/frame" title="Untrusted HTML preview"></iframe>
```

Never `allow-same-origin`, `allow-top-navigation*`, `allow-popups*`, `allow-forms`, `allow-modals`,
`allow-downloads`, `allow-pointer-lock`, `allow-presentation`. Created by **one** function (`mountPreview`), the only
place in `src/ui/` that creates an iframe or writes `sandbox`; a test fails if any other code does.

## 6. Where the HTML comes from, and where the card lives

### 6.1 `role: "agent"`, set by the server

`afterReplyRouted` is the one place an agent's delivered `reply` reaches the chat, and it adds `role: "agent"` to
its `message`.
- **Other emitters:** platform and web users get `role: "user"`; the web-only status line gets `role: "status"`.
- **History:** `WebChatHistory.record()` copies `role` (today it drops unknown fields). A recorded message without
  one is treated as `user`.
- **Trust:** the role comes from the code path. It is never read from message text, `sender`, or anything an agent
  or user supplies. `isUserMsg` (`dashboard.html:883`) keeps deciding styling only.

`renderMarkdown(text, { htmlCards: true })` is called only for `role === "agent"`. With that option, the fence loop
(`chat-render.js:250-262`) emits two things for a fence whose language is exactly `html` (case-insensitive) **and
that is terminated**:
- the same escaped `<pre><code>` as today;
- an empty placeholder `<div class="html-card" data-card="<n>"></div>`.

No HTML text goes into an attribute. An unterminated fence (the 16,000-character cut) gets no card, only a note:
"Truncated — ask the agent to send it as a .html file". `.html`/`.htm` **attachments** on a `role: "agent"`
message get the same card (Q4). For an attachment, Preview fetches `/ui/file/<id>` (same-origin and
authenticated), reads it as text, and refuses anything over 1 MiB.

### 6.2 Cards in the keyed renderer (#1313)

- **Card key:** `<boot>-<id>:f<n>` for a fence, `<boot>-<id>:a<attachmentId>` for an attachment. It lives in the
  message node's own key space, so it is stable across renders.
- **Mounting:** `msgNode` already builds every message node once and decorates it with DOM (`decorateCode`).
  `decorateHtmlCards(node)` runs after it and fills each placeholder with a card built from nodes (`textContent`),
  in the **Source** state. Building a card creates no iframe.
- **What keeps a running preview alive:** a live frame is recorded in `livePreviews: Map<cardKey, {iframe, …}>`.
  `renderMsgs` touches the node of a message only in four cases, and each one has an explicit outcome:

  | `renderMsgs` would… (`dashboard.html:918-953`) | When it happens | Outcome for a live preview in that message |
  |---|---|---|
  | leave the node in place | every other update: new messages appended, other messages' ticks or status, prompts, the turn row | untouched (the common case) |
  | **replace** it (`replaceWith`): its `msgHtml` string changed | agent messages carry no ticks, so this happens only if the message itself changes | stop first, then replace; the new card shows "Preview stopped — the message changed. Preview again" |
  | **move** it (`insertBefore` of an existing node) | the list's order changed under it, for example a history merge that interleaves | stop first, then move. Moving an iframe reloads it, so it is never moved alive |
  | **remove** it, or **start over** (another instance, `textContent = ""`) | message trimmed by the cap, or the instance switched | stop |

  "Stop" removes the iframe and clears its watchdog. A preview is never re-parented or reloaded silently. These
  rules are a small addition to `renderMsgs`: before `replaceWith`, `insertBefore` or `remove` on a node, call
  `stopPreviewsIn(node)`. No other renderer replacement is planned.
- **Not preserved:** the folded/unfolded state of the Source view's code block follows `decorateCode` as today.

## 7. The card

Built with DOM nodes; labels via `textContent`.

| Control | Behaviour |
|---|---|
| **Source** (default) | The existing code block. |
| **Preview** | Shown only on an opted-in device (§4.3). Runs the checks in §3.2, then creates the iframe (§5.3). One running preview per page: starting another stops the first. A parent-drawn banner: "Previews run the agent's HTML in an isolated frame. It cannot use your login, but it may be able to send data out. Only preview content you trust. A preview can slow or freeze this tab." |
| **Stop** | Removes the iframe. |
| **Download** | A `Blob` of the source text with type `application/octet-stream`, saved through `<a download="reply.html">`, URL revoked at once. The `blob:` URL belongs to the dashboard origin, so it is **only** ever used for a download — never navigated to, never opened in a tab. |

A per-browser **kill switch** ("Never preview HTML on this device", in `sessionStorage`) hides Preview on every card.
**Click to run is always required**; there is no auto-run setting.

The per-device **opt-in** ("Allow HTML previews on this device — they may be able to send data out"), stored in
`localStorage`, sits in the card's menu and as a toggle in the dashboard's settings; turning it off stops every
running preview. Without it, a card shows Source and Download and a one-line note on how to enable previews.

## 8. Limits and availability (best effort)

| Limit | Value | Enforced |
|---|---|---|
| HTML size | 1 MiB (UTF-8 bytes) | Parent before `render`; the shim refuses a larger one. Fences are also bounded by the 16,000-character message cut. |
| Height | 40–4000 px, then scroll | Parent (§4.2) |
| Resize rate | ≤ 1 per animation frame, ≤ 10/s, Δ ≥ 2 px, growth freeze | Parent |
| Ready | 3 s, with a matching boot id, else unavailable | Parent |
| Watchdog | 10 s without heartbeat while visible → unload | Parent: **best effort** |
| Concurrency | one running preview per page | Parent |

**The watchdog does not guarantee containment.**
- **Freezing:** if the preview frame shares a renderer process with the dashboard, a busy page also freezes the
  parent, including the watchdog timer and the Stop button. That happens for a same-site port, in any browser that
  does not isolate opaque frames.
- **Memory:** a 1 MiB input can still allocate without bound.
- **What a separate origin buys:** a separate hostname (`web.preview_origin`) gets cross-site process isolation
  where the browser provides it. A separate port, or even an origin-keyed agent cluster, does not promise a
  separate process.

So this design:
- **requires a responsive-parent probe** in the browser matrix (§10.2). Load a busy-looping page and an
  allocating page, then measure whether the dashboard's Stop button and timers still run within 1 s, per supported
  browser and per preview mode (same-host port vs. `preview_origin`). Record the results.
- **accepts the residual risk (decided, leader 2026-10-07).** On a browser and mode without isolation, a hostile
  preview can freeze the dashboard tab, or crash it by exhausting memory, until the tab is closed.
  - The mitigations are click-to-run, Stop, one preview at a time, the 1 MiB input cap, and recommending
    `web.preview_origin`.
  - None of these is described as containment.
  - Preview is **not** disabled because of a parent-freeze probe result. The results are recorded only so the
    decision can be revisited with data.
  - The banner says so plainly: "A preview can slow or freeze this tab".

## 9. Threat model

| Threat | Precedent | Mitigation here |
|---|---|---|
| Preview runs with dashboard authority: reads the CSRF value and calls writes | Open WebUI file preview CVE-2026-70486 and port preview CVE-2026-87995: same-origin content plus `allow-same-origin` | Content is never served by the dashboard listener; no `/ui/preview` route; never `allow-same-origin`; header `sandbox` as a second layer; single `mountPreview` with a test that pins the attribute set. (G1) |
| CSRF write from the frame to `/ui/*` | — | `connect-src 'none'`, `form-action 'none'`, no `allow-forms`, and parent `frame-src` refuses navigations to the dashboard. Independently, today's checks refuse `Origin: null` and need `X-Agend-CSRF` the frame cannot read (`web-auth.ts:160-172`, `:243-248`). |
| Reading open GET endpoints (`/view` reads, `/api/activity` with `ACAO: *`) | — | `connect-src 'none'`; images only `data:`/`blob:`. (`ACAO: *` at `fleet-manager.ts:15824`/`:15856` is a separate clean-up — Q6.) |
| Exfiltration of **private** content by request (fetch, img, beacon, websocket, prefetch, CSS) | Image-markdown exfiltration in Bard/M365 Copilot; sandbox without CSP escapes via `data:` navigation (Willison) | Restricted, best effort: header CSP `default-src 'none'` and friends (meta CSP not relied on), recorded per browser (§10.2). Not presented as a guarantee: Preview is opt-in, behind the "may be able to send data out" banner. |
| Exfiltration by **self-navigation** (`location`, meta refresh, link, `data:`/`blob:`/`javascript:`) | `navigate-to` never shipped | Restricted: parent `frame-src <preview origin>/frame` refuses every other navigation target; the listener 404s everything else and never redirects. Known bypass: a navigation to `/frame?<data>` is allowed, and in `preview_origin` mode it reaches that proxy's log (§4.3). Covered by the opt-in banner, not a claim. |
| Exfiltration by **WebRTC** | Firefox has no CSP `webrtc` (bug 1783489); Chromium does not parse it (rev 0d3c97b1); a no-candidate probe can pass while TURN works (RFC 8828) | Not blocked. RTC globals are removed from the shim's realm (defence in depth). There is no probe gate (§4.3 explains why). Preview is off by default; the opt-in banner says data may be sent out. |
| The HTML itself is private (an agent wrote a secret into it) | Pluto: agents published env values in 10/85 runs | Not assumed away: agent output can contain private data, and a preview may be able to send it out. Hence off by default, an explicit opt-in, and a banner that says so: "Only preview content you trust". Click-to-run is consent, **not** a confidentiality check; Source view lets a person look first. |
| Content delivered to the wrong frame (another process on the preview port; a Host-rewriting proxy) | — | `location.origin === data-dashboard-origin`; the `ready` must carry this fleet's boot id; mismatch → unavailable (§3.2). |
| Phishing UI inside the frame | Open WebUI GHSA-9wj4-mcm3-ppj6 | Parent-drawn banner and border; no `allow-modals`, no fullscreen; a separate hostname keeps password managers from offering dashboard credentials. |
| Top navigation, popups, tabnabbing | — | Flags not granted; content stays in the sandboxed frame; no new-tab feature in v1 (§13). |
| CPU / memory exhaustion, freezing the dashboard | No resource quota for sandboxes; process isolation is browser- and site-dependent | Best effort only (§8): click-to-run, Stop, one running preview, the 1 MiB cap, a watchdog where the parent stays responsive, a recommended `preview_origin`. The residual risk is **accepted** (decision owner, 2026-10-07): Preview is not disabled on a freeze-probe result, and the banner says "A preview can slow or freeze this tab". No containment claim. |
| Resize loop / layout bomb | Open WebUI's uncapped height | §4.2 clamps, rate limit, hysteresis, freeze. |
| postMessage type confusion driving a privileged action | Open WebUI CVE-2026-54007 (`input:prompt` → `action:submit`) | Fixed shapes, one effect each; the listener holds no reference to any API/send/approve function; source checked by window identity, origin and boot. |
| Card XSS (fence language, file name, the HTML) | #1306 acceptance | The fence still goes through `escapeHtml`; the card is DOM + `textContent`; HTML only travels by `postMessage`. |
| Preview listener receives the session cookie | Cookies are not port-isolated | Listener never parses/logs cookies or anything else; static responses; `web.preview_origin` removes it. |
| Cross-user injection (a Telegram/Discord user or shared-group member posts HTML) | Their messages reach the web chat (`fleet-manager.ts:6450-6453`, `:6334-6337`) | Only server-marked `role:"agent"` is rendered; the `sender` heuristic is not used for trust. |
| A future regression frames the dashboard itself | — | Dashboard keeps `X-Frame-Options: DENY` + `frame-ancestors 'none'`; only the preview listener's `/frame` omits XFO. |

## 10. Test plan

No real fleet, CLI or tmux, and never the live fleet (bd0c88aa).

### 10.1 Automated (Node, and the page code in a vm with a minimal DOM)

These prove wiring, headers and the parent's logic. They do **not** prove what a browser enforces.

1. **Preview listener:**
   - only `GET /frame` answers; every other path (including `/open`), method or query gets an empty 404 with no
     redirect; a foreign `Host` gets 403;
   - the exact header set (§5.1), and **no** `X-Frame-Options` on `/frame`;
   - a request carrying `Cookie: agend_session=…` gets byte-identical output, and nothing is logged;
   - it binds 127.0.0.1;
   - the shim embeds the boot id and the exact origin allow-lists.
2. **Dashboard CSP:** `/ui` has `frame-src <origin>/frame` iff a preview origin was chosen for that `Host`; `/view`,
   `/settings` and sign-in are unchanged; XFO DENY and `frame-ancestors 'none'` stay on every dashboard response.
3. **Availability (§3.2):**
   - a loopback Host gets the same-host port; a non-loopback Host without `preview_origin` is disabled; a set
     `preview_origin` is used;
   - `X-Forwarded-Host` is ignored;
   - **the Host-rewriting proxy case:** the server is told `Host: 127.0.0.1:19280`, the page runs at
     `https://fleet.example.net`, and the page disables Preview with its reason;
   - the validator rejects a `preview_origin` equal to or under a dashboard host, with a path, or http behind https.
4. **Role:** `afterReplyRouted` emits `role:"agent"`; platform users, General and `/ui/send` emit `user`; the
   web-only status line emits `status`; `record()` keeps `role` through `/ui/history` and SSE replay; a platform
   user named like the instance (or `agend-*`) still gets `user`.
5. **Detection:** cards only for `role:"agent"` plus a terminated ` ```html `; not for `html5`, `xhtml`, ` ```htm `,
   user messages, or an unterminated fence; `.html` attachments only on agent messages; XSS probes in the language
   tag, file name and body render as text.
6. **`mountPreview`:** the only iframe creator in `src/ui/`; the attribute set is exactly `allow-scripts`, with
   `allow=""` and `referrerpolicy="no-referrer"`.
7. **postMessage (parent and shim, both directions):**
   - ignored: the wrong `source`, wrong `ch`, wrong boot, extra keys, unknown `type`, a non-integer, negative or huge
     `height`, string payloads;
   - opt-in: without it, no `render` happens and the card shows Source, Download and how to enable previews. With
     it (card menu or dashboard settings toggle), `render` is sent with the "may be able to send data out" banner.
     Turning it off stops every running preview. There is no `rtc` field and no probe; nothing else enables Preview;
   - the shim refuses `render` from `"null"`, from a non-listed origin, and over 1 MiB;
   - heights are clamped, with the rate limit and growth freeze;
   - the listener module references no API helper (static assertion);
   - `render` is sent once, only after a valid `ready`.
8. **Keyed renderer (§6.2):**
   - with a live preview, a new message, a tick/status change on another message, or a prompt leaves the same
     iframe element in place;
   - a changed own message, a reorder, a trim and an instance switch each **stop** the preview first; it is never
     replaced or moved alive.
9. **Mutations:**
    - adding `allow-same-origin`;
    - dropping the `source` or boot check, or rendering without the opt-in;
    - putting content anywhere in a URL (path, query, fragment) instead of `postMessage`;
    - accepting `role` from the client, or letting `user` messages get cards;
    - removing the Host gate or the `location.origin` check;
    - adding XFO to `/frame`;
    - accepting `"null"` in the shim;
    - moving a live node in `renderMsgs`.

    Each one must turn a test red.

### 10.2 Browser acceptance (required before implementation approval)

CI has no browser, so the gate is a **recorded manual run** (decided). It records browser, version, OS and preview
mode (same-host port / `preview_origin`), then pass/fail per row with notes, and is attached to the implementation
PR. Implementation is not approved without it.

Targets: current Chrome and Edge (desktop), Chrome on Android, Safari (macOS, iOS) and Firefox, each in loopback
mode and in `preview_origin` mode, all opted in. Every run is recorded. The rows document which **best-effort**
restrictions hold where. A "blocked" result is the expected outcome for those rows, but it never turns into a
no-network claim. G1's rows (cookie, parent, `/ui` writes) are the ones that must pass.

| Check, inside the preview | Expected |
|---|---|
| `document.cookie` | throws `SecurityError` or returns `""`; never the session |
| `parent.document`, `top.location.href` (read), `top.location = …` | throws / blocked |
| `fetch("/ui/send", {method:"POST"})`, `fetch` to the preview origin, `navigator.sendBeacon`, `new WebSocket`, `new EventSource` | blocked by CSP |
| `<img src="http://127.0.0.1:19280/…">`, CSS `url()`, `<link rel=prefetch>` | blocked |
| form submit, `window.open`, `alert` | nothing sent / null / no modal |
| self-navigation: `location = "https://example.org/?x"`, `<meta http-equiv=refresh>`, link click, `location = "data:…"`, `"blob:…"`, `"javascript:…"`, `location = "/other"` | blocked (frame stays on `/frame`); `/frame?x` loads the 404-free shim only |
| WebRTC, recorded as documentation of why there is no probe gate (§4.3): a data channel to a loopback STUN/TURN listener on the test host; a browser configured to withhold host candidates (RFC 8828 mode 3/4) with TURN reachable; gathering delayed beyond any timeout; a constructor that throws a non-policy error | expected in every browser today: the connection can succeed (the globals' removal is defence in depth only). Recorded; nothing is enabled or disabled by it |
| Busy loop and memory growth (§8) | record whether the parent's Stop and timers respond within 1 s, per mode (the residual risk is accepted; the record is for revisiting it) |

## 11. Review r1 → r2 (Prism, 8e3a846e; decisions by the leader, 2026-10-07)

| Finding | r2 |
|---|---|
| P1 "no network / no secret" unsupported (Firefox `webrtc`, self-navigation; agent HTML can be private) | Dropped "no secret" entirely (§1, §9). G2 holds in a browser that enforces the controls — the Chromium family today — with an adversarial matrix (§10.2: fetch, img, form, WebSocket, RTCPeerConnection/STUN, self-navigation via `data:`/`blob:`/`javascript:`). A browser that fails the **capability check** (Firefox today) gets Preview off by default, plus a per-device opt-in that carries the banner "This browser can't fully block network access from the preview; content may be able to send data out" (§4.3, §7). Click-to-run is consent, not confidentiality. *(Superseded in r3: the Chromium premise was false; see r2 → r3.)* |
| P2 new-tab handshake impossible (opaque `/open`, `frame-ancestors`, `null` origin) | **Removed from v1** (§13), along with the `/open` route and every wrapper exception in the CSP. A future design needs a trusted static wrapper and a bounded one-time transport. |
| P2 Host-only availability fails behind a Host-rewriting proxy; timeout ≠ identity | §3.2: the page compares `location.origin` with the server's `data-dashboard-origin` before creating a frame or sending HTML, and a mismatch disables Preview. `X-Forwarded-Host` is never trusted. A preserved external Host is a deployment requirement. The boot id must come back in `ready`. The proxy case is in §10.1.3. |
| P2 watchdog is not containment; memory unbounded | §8: best effort, with a responsive-parent probe recorded per browser and mode. The residual same-process CPU and memory risk is **accepted**, mitigated by click-to-run, Stop and the 1 MiB cap. No containment claim. |
| P2 fragment transport (confidentiality, decoding) | Gone with the new-tab feature (§13). |
| P3 post-#1313 renderer; browser-only acceptance | §6.2 is written against the keyed renderer, with an outcome for each `renderMsgs` operation. §10.2 makes the recorded manual browser run the gate before implementation approval (CI has no browser). An opaque `document.cookie` may throw `SecurityError`. |

### r2 → r3 (Prism, d7d5834; decision owner via the leader, 2026-10-07)

| Finding | r3 |
|---|---|
| G2's premise is false: Chromium does not parse CSP `webrtc` (its RTC gate reads `Connection-Allowlist`); a no-candidate/throw/timeout probe is not a capability proof (RFC 8828 modes 3/4, slow gathering, unrelated errors) | **The no-network guarantee is withdrawn everywhere** (§1). The §4.3 restrictions are described as best effort, and WebRTC/STUN/TURN and navigation are named as bypasses. **The probe is removed** (no `rtc`, nothing gated). Preview is **off by default on every browser**, with one per-device opt-in (localStorage, revocable, plus a dashboard settings toggle) and the banner "Previews run the agent's HTML in an isolated frame. It cannot use your login, but it may be able to send data out. Only preview content you trust. A preview can slow or freeze this tab." The negative cases are documented in §4.3 and recorded in §10.2 as the reason there is no probe gate. |
| The `preview_origin` mode contradicts an unconditional no-network claim (`/frame?…` reaches the proxy log) | No claim to contradict. §4.3 documents that the shim URL, or a content-made `/frame?…`, may appear in proxy logs, and that AgEnD never puts content in any URL: HTML travels only by `postMessage`, and a test mutation pins it. Q9 is closed. |

The account boundary — G1: the opaque sandbox, Origin+CSRF, the server-set role, the boot fence and the origin
mismatch check — is the guarantee, and it is unchanged.

## 12. Open questions

1. **Q1 — user HTML ever?** Decided no for v1.
2. **Q2 — SSH forwards.** Is the fixed `health_port + 1` default right, so the docs can say "also forward 19281"?
3. **Q3 — same-site.** A same-host port is same-site: cookies are sent (ignored), and process isolation is not
   promised. Default as proposed, with `preview_origin` as the hardened mode? Should `preview_origin` refuse a host
   under the dashboard's registrable domain?
4. **Q4 — `.html` attachments in v1**, or fences only first?
5. **Q6 — `Access-Control-Allow-Origin: *`** on `/api/activity` and the roster: remove here or separately?
6. **Q8 — numbers.** 1 MiB, 4000 px, 10 s, 3 s, 10/s are inferences; adjust after the user's testing.
7. **Q12 — a future network claim?** ([#1326](https://github.com/songsid/AgEnD/issues/1326) tracks browser enforcement of WebRTC blocking.) If a browser ships an enforced WebRTC block (Chromium's experimental
   `Connection-Allowlist`, or CSP `webrtc`), a no-network claim could be reconsidered, on a recorded §10.2 run per
   browser and mode. Not in v1.

Decided (decision owner via the leader, 2026-10-07):
- **r1 Q7:** the browser gate is a recorded manual run.
- **r3, replacing r2 Q10:** there is no no-network guarantee. Preview is off by default on every browser, with one
  per-device opt-in (localStorage, revocable, plus a dashboard settings toggle) and the banner above. There is no
  probe gate.
- **r2 Q11, freezing:** the same-process freeze and memory risk is accepted. Preview is not disabled on a probe
  result, and the banner adds "A preview can slow or freeze this tab".
- **Q9, `preview_origin` logging:** closed. AgEnD does not put HTML in the transport URL; the URL itself may be logged.
- **r1 Q5:** new tab is deferred.

The remaining questions above do not block approval of the design.

## 13. Deferred: Open in new tab

Not in v1. A future design needs:
- **A trusted wrapper:** `/open` must be a trusted static page on a separate hostname, not sandboxed, with its own
  CSP. An opaque `/open` cannot frame the shim (`frame-ancestors`) or address it except as `null`.
- **A bounded one-time transport:** for example a `postMessage` handshake on exact origins that clears `opener`
  before any content exists. A URL fragment would put private HTML into history, bookmarks and sync.
- **Untrusted HTML stays nested** in the opaque sandboxed frame.
- **Its own browser acceptance rows.**
