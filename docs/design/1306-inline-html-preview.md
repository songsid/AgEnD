# #1306: interactive inline HTML in the web chat

**Status:** design for review (🔒 Prism) — no code yet. Milestone 2.2.1, branch `feature/2.2-web`.
**Inputs:** the leader's decision on #1306 (2026-10-07, delegated by the user, to be adjusted after testing) and
claude-fable's *AgEnD web chat design study*, section 3. Every claim about today's code below was re-read at
`feature/2.2-web` **fcc7e7ec**; external references (CVEs, specs) are the study's and are cited, not re-verified.

## 1. What we are building

When an agent's reply contains a fenced ` ```html ` block — or attaches a `.html` file — the web chat shows a card
under it. Nothing runs until the person clicks **Preview**. The preview runs in a sandboxed frame served by a
*separate listener*, so the HTML never executes with the dashboard's authority: the dashboard origin holds the
session cookie, can read the CSRF value, and fronts every write (stop, restart, delete instances, config, send,
approve prompts).

Decided (not up for review here, only their realisation):

1. A dedicated **preview listener on a separate port**, loopback by default; optional `web.preview_origin` (a
   separate hostname) for the strongest isolation. Never a same-origin `/ui/preview` route.
2. **No network** in the preview in v1 (`connect-src 'none'`); libraries must be inlined.
3. **Source:** only ` ```html ` fences in messages the **server** marks `role: "agent"`. HTML from users (web,
   Telegram, Discord, other members) is never rendered.
4. **Limits:** 1 MiB of HTML, 4000 px height cap, rate-limited resize, 10 s watchdog.
5. **Click to run**, always. Controls: Preview / Source / Download; Open in new tab only with `web.preview_origin`.
6. **postMessage:** accept only `event.source === iframe.contentWindow`, one fixed resize shape; the listener is
   connected to nothing that sends, approves or calls an API.
7. When the dashboard is reached through a tunnel/gateway exposing one port and no `web.preview_origin` is set,
   preview is **disabled** — Source and Download only.

## 2. Today (verified at fcc7e7ec)

| Fact | Where |
|---|---|
| `reply.format` is `"text" \| "markdown"`; there is no HTML format. | `src/outbound-schemas.ts:14`, `:25` |
| An agent reply reaches the web chat only through `afterReplyRouted`, which emits `message` with `instance, sender, text, ts, attachments` — no format, no role. Text is cut at `WEB_CHAT_TEXT_MAX`. | `src/fleet-manager.ts:6694`, `:6717-6722` |
| `WEB_CHAT_TEXT_MAX` is 16,000 characters; the history cuts again on record. | `src/web-chat-history.ts:70`, `:105-111` |
| The same `message` event carries **people's** messages: a platform user to an instance (`sender: msg.username`), the same for General, and the dashboard's own sends (`sender: "web-user"`). A daemon status line on a web-only fleet also arrives as `message` with the instance as sender. | `src/fleet-manager.ts:6437-6440`, `:6321-6324`; `src/web-api.ts:915`; `src/fleet-manager.ts:6652-6655` |
| `emitSseEvent("message")` records a fixed field list (`instance, sender, text, ts, attachments, messageId`) and broadcasts the *recorded* copy, so a new field is dropped unless `record()` copies it. | `src/fleet-manager.ts:11594-11607`; `src/web-chat-history.ts:105-115` |
| The dashboard decides "user or agent" from `sender` by heuristic (`web-user`, starts with `agend`, equals the instance, `general`). A platform user can pick any username, so this decides styling only and is **not** a trust boundary. | `src/ui/dashboard.html:635` |
| `renderMarkdown` escapes everything first; fenced code becomes `<pre><code>` (highlighted only for known languages, `html` is not one). The fence regex also accepts an **unterminated** fence (`(?:```\|$)`), which is what a 16,000-character cut produces. | `src/ui/chat-render.js:1-8`, `:225-228`, `:246-262` (regex `:250`) |
| `renderMsgs` rebuilds the whole list with `innerHTML` on every change, so any live element inside a message (an iframe) would be destroyed and re-created each time a message arrives. | `src/ui/dashboard.html:630-641` |
| The R6 prompt cards are built from DOM nodes with `textContent` — the pattern the HTML card follows. | `src/ui/dashboard.html:669-692` |
| Every response from the web listener gets `X-Frame-Options: DENY` and a CSP with **no `frame-src`** (so frames fall back to `default-src 'self'`) and `frame-ancestors 'none'`. Panels add a per-response script nonce. | `src/web-host-guard.ts:65-76` (`:75`), `:112-121` (`:116`), `:124-138` |
| `/ui` is served by `sendPanelHtml`. | `src/web-api.ts:252-258` |
| Session cookie `agend_session` / `__Host-agend_session`, `HttpOnly; SameSite=Strict`. | `src/web-auth.ts:24-25`, `:194`, `:198` |
| A request whose `Origin` does not match `Host` is refused — including the opaque `null` a sandboxed frame sends. A cookie write also needs `Origin`, `Sec-Fetch-Site: same-origin` (when sent) and `X-Agend-CSRF`. | `src/web-auth.ts:160-172`, `:244-249` |
| Any script on the dashboard origin can obtain the CSRF value (`/auth/session`). HttpOnly protects the cookie's value, not its authority. | `src/ui/shared/agend-auth.js:29-39` |
| The web listener binds **127.0.0.1** only (default port 19280). Remote use goes through a proxy/tunnel whose name must be `hostname` or in `web.allowed_hosts`; loopback names are `localhost`, `127.0.0.1`, `[::1]`. | `src/fleet-manager.ts:4782`, `:15995`, `:16003`; `src/web-host-guard.ts:23`, `:84-95` |
| `WebConfig` has no preview settings today. | `src/types.ts:325-344` |
| A `.html` file is not in `MIME_BY_EXT` → `application/octet-stream`; `/ui/file/<id>` serves anything but four image types as an attachment with `sandbox` CSP. Upload cap 10 MiB per file. | `src/web-upload.ts:129-133`, `:290`, `:18-25`; `src/web-api.ts:416-432` |
| A loopback side listener already exists as a precedent (`127.0.0.1:0` per web-terminal session). | `src/web-terminal-http.ts:2-4` |
| `/api/activity` and the roster answer with `Access-Control-Allow-Origin: *`; `/view` reads bypass the gate unless `web.view_access: session`. | `src/fleet-manager.ts:15798`, `:15830`; `src/auth-api.ts:95` |

So today an agent's HTML is shown as escaped text and runs nowhere. That is the baseline every change below must
keep for anything not explicitly opted in.

## 3. Architecture

```
 dashboard origin (http://127.0.0.1:19280, or the tunnel host)        preview origin (separate port or host)
 ┌───────────────────────────────────────────────┐                   ┌──────────────────────────────┐
 │ /ui  CSP …; frame-src <preview origin>        │  iframe src=      │ GET /frame  → static shim    │
 │  chat card ── click Preview ──────────────────┼──────────────────▶│  CSP sandbox allow-scripts;  │
 │  <iframe sandbox="allow-scripts" allow=""     │                   │  default-src 'none' …        │
 │          referrerpolicy="no-referrer">        │◀── postMessage ───│  frame-ancestors <dashboard> │
 │  message listener: resize/heartbeat only      │  {resize,height}  │ GET /open   (preview_origin  │
 │  ── postMessage {render, html} ──────────────▶│                   │              only)           │
 └───────────────────────────────────────────────┘                   │ everything else → 404        │
                                                                      └──────────────────────────────┘
```

### 3.1 The preview listener

- A second `http.Server`, created with the web listener and closed with it. It serves **only**:
  - `GET /frame` — the shim page (§4): built once from config at start (it embeds the dashboard origins, §4), then identical for every request;
  - `GET /open` — the new-tab shim, only when `web.preview_origin` is set (§7);
  - everything else, every other method: `404`, empty body.
- No `/ui`, `/api`, `/auth`, `/assets` routes; no session lookup; it never parses, logs or reflects `Cookie`,
  `Authorization` or any query string. Because cookies are not isolated by port (RFC 6265 §8.5), a same-host preview
  port **will** receive `agend_session`; ignoring it is a requirement, and the test plan checks it.
- Its own `Host` allow-list: the loopback names, plus the `web.preview_origin` host when set. Anything else → 403.
- It does **not** call `applyWebSecurityHeaders` (that sets `X-Frame-Options: DENY` and `frame-ancestors 'none'`,
  which would make the shim unframeable). It sets its own headers (§5.1).
- **Address.** Proposed new config, all optional:

  | key | default | meaning |
  |---|---|---|
  | `web.preview` | `true` | Master switch. `false`: no listener, cards show Source/Download only. |
  | `web.preview_port` | `health_port + 1` (19281) | Port of the preview listener; bound to `127.0.0.1`. A fixed default (not `:0`) so an SSH user can forward it alongside the dashboard (open question Q2). |
  | `web.preview_origin` | — | Full origin (`https://preview.example.net`) of a **separate hostname** that a proxy maps to the preview listener. Must be https when the dashboard is reached over https (mixed content), must not equal any dashboard origin, and must not share the dashboard's registrable domain unless the user accepts same-site (Q3). |

  The validator rejects a `preview_origin` with a path, query, credentials or wildcard, and one whose host is in the
  dashboard's allowed names (`allowedHostNames`) — that would be a same-origin preview by another name.

### 3.2 When preview is available

Decided per **page load** by the server, from the request that loads `/ui`, and handed to the page with the panel
(e.g. a `data-preview-origin` attribute on `<body>`, empty when disabled):

| Dashboard `Host` | `web.preview_origin` | Preview |
|---|---|---|
| loopback name | not set | `http://<same loopback name>:<preview_port>` |
| any | set | `web.preview_origin` |
| not loopback (tunnel, proxy, `hostname`, `allowed_hosts`) | not set | **disabled**: only one port is reachable; Source + Download only, with a one-line note saying why |

This is exactly decision 7: a remote browser can only reach the preview listener through a separately configured
origin. The same value builds the `/ui` response's `frame-src` (§5.2), so the page cannot frame anything the server
did not choose.

A loopback `Host` does not prove the preview port is reachable: an SSH tunnel may forward only 19280 (Q2). The card
therefore treats "no `ready` from the shim within 3 s" as **unreachable**, removes the frame and shows Source/Download
with "Preview unavailable from this browser".

## 4. The shim and the postMessage protocol

The shim is one static HTML document with one inline script, served from the preview listener. It knows nothing
about chats, users or instances; the HTML arrives over `postMessage` (the web.dev "shim" pattern), so the listener
stays stateless and never receives content in a URL or log.

**Parent → frame** — exactly one message, sent after the frame says `ready`:

```js
{ v: 1, type: "render", ch: "<per-frame random id>", html: "<the HTML, ≤ 1 MiB>" }
```

- `targetOrigin` is `"*"`: the sandboxed shim has an opaque origin, so no other value can address it. The message
  carries only the HTML itself — no ids, tokens, user names or CSRF — so "anyone could read it" costs nothing.
- `ch` lets the parent tell its own frames apart; it is **not** authentication (the content can read it).

**Shim, on load:** posts `{v:1, type:"ready", ch:null}` to `parent`; then accepts **one** `render` message whose
`event.source === window.parent` and whose `event.origin` is one of the configured dashboard origins (the server
writes that list into the shim's `frame-ancestors`; the shim reads it from a `<meta>` it was served with). It then
`document.open()`s, writes a prologue (heartbeat + height reporter) followed by the HTML, and `close()`s. Later
`render` messages are ignored.

**Frame → parent** — the only accepted shapes:

```js
{ v: 1, type: "ready",     ch: null }
{ v: 1, type: "resize",    ch: "<id>", height: <integer> }
{ v: 1, type: "heartbeat", ch: "<id>" }
```

**Parent listener** (one `window` `message` listener for all cards):

| Rule | |
|---|---|
| Source | `event.source === card.iframe.contentWindow` for a live card; otherwise dropped silently. `event.origin` must be `"null"` (the opaque sandbox) — checked *in addition*, never instead: any sandboxed or `data:` frame says `"null"`. |
| Shape | A plain object with exactly the keys above, `v === 1`, `type` in the set, `ch` equal to the card's (for `resize`/`heartbeat`), `height` a finite integer. Anything else — extra keys, other types, strings — is dropped. |
| Effect | `ready` → send `render` once. `resize` → set the frame's height (rules below). `heartbeat` → reset the watchdog. **Nothing else**: the listener has no reference to `api()`, `sendMsg`, `answerPrompt`, the composer, navigation or storage, and the test plan asserts it (the Open WebUI CVE-2026-54007 class: a message type that reaches a privileged handler). |
| Height | Clamp to [40, 4000] px; apply at most once per animation frame and at most 10 times per second; ignore changes < 2 px; after 5 consecutive increases within 2 s, freeze the height and let the frame scroll (breaks the `100vh` grow loop). |
| Watchdog | The prologue posts `heartbeat` every 1 s. If the card is on screen (IntersectionObserver) and no heartbeat arrived for **10 s**, the iframe is removed: "Preview stopped: it stopped responding". Off-screen frames are throttled by browsers, so the watchdog pauses while the card is not visible and asks for a fresh height when it returns. A busy-looping page cannot post heartbeats, so it is unloaded; content that fakes heartbeats can only keep alive a frame that is still yielding. |

## 5. Content Security Policy

### 5.1 The preview listener (header CSP on `/frame` and `/open`)

```
Content-Security-Policy:
  default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
  img-src data: blob:; font-src data:; media-src data: blob:;
  connect-src 'none'; worker-src 'none'; frame-src 'none'; child-src 'none';
  form-action 'none'; base-uri 'none'; manifest-src 'none'; object-src 'none';
  webrtc 'block';
  frame-ancestors <every dashboard origin: http://localhost:19280 http://127.0.0.1:19280 http://[::1]:19280 + configured https origins>;
  sandbox allow-scripts
Permissions-Policy: camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), usb=(), serial=(), hid=(), bluetooth=(), payment=(), display-capture=(), fullscreen=()
Referrer-Policy: no-referrer
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
Cache-Control: no-store
(no X-Frame-Options)
```

- `default-src 'none'` is required, not decoration: directives without their own fetch directive (prefetch and the
  like) fall back to it (CSP3 §8.6). `webrtc 'block'` because WebRTC is outside `connect-src`. `worker-src 'none'`
  so a page cannot move work off the main thread where the watchdog can see it.
- `sandbox allow-scripts` in the **header** makes the document opaque-origin even if it is ever loaded without the
  iframe attribute (opened directly, or by a future bug) — the iframe attribute and the header are two independent
  layers.
- `/open` gets `frame-ancestors 'none'` (it is a top-level page) and `frame-src 'self'` for its nested frame (§7).

### 5.2 The dashboard (`/ui` only)

`panelContentSecurityPolicy` gains one directive **for `/ui`, and only when preview is available on this page
load**: `frame-src <the preview origin chosen in §3.2>`. Nothing else changes: `X-Frame-Options: DENY`,
`frame-ancestors 'none'`, the nonce, `connect-src 'self'` stay. Other panels (`/view`, `/settings`, sign-in) are
untouched. With preview disabled, `/ui` has no `frame-src` and keeps today's `default-src 'self'` fallback — which
already forbids a frame to any other origin.

### 5.3 The iframe

```html
<iframe sandbox="allow-scripts" allow="" referrerpolicy="no-referrer" loading="eager"
        src="<preview origin>/frame" title="Untrusted HTML preview"></iframe>
```

Never `allow-same-origin`, `allow-top-navigation*`, `allow-popups*`, `allow-forms`, `allow-modals`,
`allow-downloads`, `allow-pointer-lock`, `allow-presentation`. Created by **one** function (`mountPreview`), the only
place in `src/ui/` that writes `sandbox`; a test fails if any other code creates an `iframe` or writes `sandbox`.

## 6. Where the HTML comes from: `role: "agent"`

**Server.** `afterReplyRouted` — the one place an agent's delivered `reply` reaches the chat — adds
`role: "agent"` to its `message`. The other emitters set `role: "user"` (platform and web users) or
`role: "status"` (the web-only status line). `WebChatHistory.record()` copies `role` (it already drops unknown
fields, `web-chat-history.ts:105-115`), and messages recorded without one (none after this change; a guard for
replayed old shapes) are treated as `user`. The role is set by the code path, never read from message text,
`sender`, or anything an agent or user supplies.

**Client.** `renderMarkdown(text, { htmlCards: true })` is called only for `role === "agent"`. With the option,
the fence loop (`chat-render.js:250-262`) emits, for a fence whose language is exactly `html` (case-insensitive)
**and that is terminated**, the same escaped `<pre><code>` as today plus an empty placeholder
`<div class="html-card" data-card="<n>"></div>`. No HTML text goes into an attribute. An unterminated fence (the
16,000-character cut) gets no card, and a note: "Truncated — ask the agent to send it as a .html file".

`.html` / `.htm` **attachments** on a `role:"agent"` message get the same card. Preview fetches
`/ui/file/<id>` (same-origin, authenticated, already served as an attachment with `sandbox` CSP), reads it as
text, and refuses beyond 1 MiB. Nothing about how `/ui/file` serves the file changes.

**Rendering must stop destroying frames.** `renderMsgs` rebuilds the list with `innerHTML`
(`dashboard.html:630-641`), and moving an iframe in the DOM reloads it. The implementation changes `renderMsgs` to
append new messages and re-render a message only when it changed, keyed by `boot:id`, and to mount cards into the
placeholders with DOM nodes (`textContent`, as `renderPrompts` does). Switching instance unloads every preview.

## 7. The card

Built with DOM nodes; labels via `textContent`.

| Control | Behaviour |
|---|---|
| **Source** (default) | The existing code block. |
| **Preview** | Creates the iframe (§5.3). One running preview per page: starting another stops the first. A frame banner drawn by the **parent**: "Untrusted preview — it cannot reach your account or instances, and has no network." |
| **Stop** | Removes the iframe. |
| **Download** | A `Blob` of the source text with type `application/octet-stream`, saved through `<a download="reply.html">`, URL revoked at once. The `blob:` URL belongs to the dashboard origin, so it is **only** ever used for a download — never navigated to, never opened in a tab. |
| **Open in new tab** | Only when `web.preview_origin` is set. Opens `<preview_origin>/open` with `noopener,noreferrer`. `/open` is a top-level shim with a fixed warning bar and the content in a **nested** `sandbox="allow-scripts"` frame of the same shim, so the content never owns the top document. The HTML travels in the URL **fragment** (never sent to the server). Above a fragment budget (Q5) the button is disabled with a reason. Without a separate origin there is no safe new-tab: a `blob:` or same-port page would carry the dashboard's or same-site context. |

A per-browser **kill switch** ("Never preview HTML on this device", in `sessionStorage`) hides Preview on every card.
**Click to run is always required**; there is no auto-run setting.

## 8. Limits

| Limit | Value | Enforced |
|---|---|---|
| HTML size | 1 MiB (UTF-8 bytes) | Parent before `render`; the shim drops a larger `render`. Fences are additionally bounded by the 16,000-character message cut. |
| Height | 40–4000 px, then scroll | Parent (§4) |
| Resize rate | ≤ 1 per animation frame, ≤ 10/s, Δ ≥ 2 px, growth freeze | Parent |
| Watchdog | 10 s without heartbeat while visible → unload | Parent |
| Ready timeout | 3 s → "unavailable", unload | Parent |
| Concurrency | one running preview per page | Parent |
| Network | none (`connect-src 'none'`, `webrtc 'block'`, no forms) | Preview CSP + sandbox |

## 9. Threat model

| Threat | Precedent | Mitigation here |
|---|---|---|
| Preview runs with dashboard authority: reads the CSRF value and calls writes | Open WebUI file preview CVE-2026-70486 and port preview CVE-2026-87995: same-origin content plus `allow-same-origin` | Content is never served by the dashboard listener; no `/ui/preview` route; never `allow-same-origin`; header `sandbox` as a second layer; single `mountPreview` with a test that pins the attribute set. |
| CSRF write from the frame to `/ui/*` | — | `connect-src 'none'`, `form-action 'none'`, no `allow-forms`; and independently, today's checks refuse `Origin: null` and need `X-Agend-CSRF` the frame cannot read (`web-auth.ts:160-172`, `:244-249`). |
| Reading open GET endpoints (`/view` reads, `/api/activity` with `ACAO: *`) | — | `connect-src 'none'`; images only `data:`/`blob:`. (`ACAO: *` at `fleet-manager.ts:15798`/`:15830` is a separate clean-up — Q6.) |
| Exfiltration by request (fetch, img, beacon, websocket, prefetch, WebRTC, CSS) | Image-markdown exfiltration in Bard/M365 Copilot; sandbox without CSP escapes via `data:` navigation (Willison) | Header CSP `default-src 'none'`, `img-src data: blob:`, `webrtc 'block'`; meta CSP is not relied on. |
| Exfiltration by navigation (frame navigates itself, or a click) | `navigate-to` never shipped | Not preventable by CSP. The frame holds **no secret**: only the HTML, which the agent wrote. Click-to-run means a human looked first; no `allow-top-navigation*`/`allow-popups*`. |
| Agent writes a secret into the HTML | Pluto: agents published env values in 10/85 runs | Click-to-run + Source view; nothing in the preview can reach the network to send it. |
| Phishing UI inside the frame | Open WebUI GHSA-9wj4-mcm3-ppj6 | Parent-drawn banner and frame border; no `allow-modals`, no fullscreen; separate hostname keeps password managers from offering dashboard credentials. |
| Top navigation, popups, tabnabbing | — | Flags not granted; new tab only on a separate origin with `noopener`, content nested. |
| CPU / memory exhaustion, mining | No resource quota for sandboxes; process isolation only for cross-site or (desktop Chromium ≥ 127) opaque frames | Click-to-run, one running preview, 10 s watchdog, unload off-instance, no network for a pool, no workers. Same-host-port previews are same-site (no cross-site process isolation) — Q3. |
| Resize loop / layout bomb | Open WebUI's uncapped height | §4 clamps, rate limit, hysteresis, freeze. |
| postMessage type confusion driving a privileged action | Open WebUI CVE-2026-54007 (`input:prompt` → `action:submit`) | Three shapes, one effect each; the listener holds no reference to any API/send/approve function; source check by window identity. |
| Card XSS (fence language, file name, the HTML) | #1306 acceptance | The fence still goes through `escapeHtml`; the card is DOM + `textContent`; HTML only ever travels by `postMessage`. |
| Preview listener receives the session cookie | Cookies are not port-isolated | Listener never parses/logs cookies or reflects anything; static responses; `web.preview_origin` removes it. |
| Cross-user injection (a Telegram/Discord user or shared-group member posts HTML) | Their messages reach the web chat (`fleet-manager.ts:6437-6440`, `:6321-6324`) | Only server-marked `role:"agent"` is ever rendered; the `sender` heuristic is not used for trust. |
| A future regression frames the dashboard itself | — | Dashboard keeps `X-Frame-Options: DENY` + `frame-ancestors 'none'`; only the preview listener omits XFO. |

## 10. Test plan

No real fleet, CLI, tmux or browser network (bd0c88aa). Headers and routing in Node; the page code in a vm with a
minimal DOM (as the Settings tests do); browser-only facts (sandbox behaviour, CSP enforcement) with a headless
browser against a scratch listener on loopback, if the CI image has one (open question Q7) — otherwise documented
manual checks.

1. **Preview listener:** only `GET /frame` (and `/open` with `preview_origin`) answer; every other path/method 404;
   foreign `Host` 403; exact header set (§5.1), **no** `X-Frame-Options`; a request carrying `Cookie:
   agend_session=…` gets byte-identical output and the cookie appears in no log; bound to 127.0.0.1.
2. **Dashboard CSP:** `/ui` has `frame-src <origin>` iff preview is available for that `Host`; `/view`, `/settings`,
   sign-in unchanged; XFO DENY and `frame-ancestors 'none'` still on every dashboard response.
3. **Availability (§3.2):** loopback Host → same-host preview port; non-loopback Host without `preview_origin` →
   disabled (no `frame-src`, cards without Preview); `preview_origin` set → used; validator rejects a
   `preview_origin` equal to/under a dashboard host, with a path, or http behind https.
4. **Role:** `afterReplyRouted` emits `role:"agent"`; platform users, General, `/ui/send` emit `user`; the web-only
   status line emits `status`; `record()` keeps `role` through `/ui/history` and SSE replay; a platform user named
   like the instance (or `agend-*`) still gets `user`.
5. **Detection:** cards only for `role:"agent"` + terminated ` ```html `; not for `HTML5`, `xhtml`, ` ```htm `,
   user messages, or an unterminated fence; `.html` attachment only on agent messages; XSS probes in the language
   tag, file name and body render as text.
6. **Sandbox (`mountPreview`):** the only iframe creator in `src/ui/`; attribute set exactly `allow-scripts`;
   `allow=""`; `referrerpolicy="no-referrer"`; no code path adds `allow-same-origin`.
7. **postMessage:** wrong `source`, wrong `ch`, extra keys, unknown `type`, non-integer/negative/huge `height`,
   string payloads → ignored; heights clamped; rate limit and growth freeze; the listener module imports/references
   no API helper (static assertion); `render` sent once and only after `ready`.
8. **Watchdog / ready:** no heartbeat for 10 s while visible → unloaded; off-screen pauses; no `ready` in 3 s →
   "unavailable".
9. **Browser (if available):** inside the frame `document.cookie === ""`, `parent.document` throws,
   `fetch("/ui/send", {method:"POST"})` and an `<img src="http://127.0.0.1:19280/…">` are blocked by CSP, a
   `<form>` submit sends nothing, `window.open` returns null, `top.location =` throws.
10. **Rendering stability:** a new message arriving does not recreate a running preview's iframe.
11. **Mutations:** adding `allow-same-origin`; dropping the `source` check; accepting `role` from the client; letting
    `user` messages get cards; removing `frame-src` gating by Host; adding XFO to the preview listener — each red.

## 11. Open questions

1. **Q1 — user HTML ever?** Decided no for v1. Revisit only with a separate opt-in per message?
2. **Q2 — SSH forwards.** A loopback dashboard reached via an SSH forward of only 19280 cannot load the preview; the
   3 s ready-timeout degrades it. Is the fixed `health_port + 1` default right, so the docs can say "also forward
   19281"?
3. **Q3 — same-site.** A same-host port is same-site: cookies are sent (ignored), and there is no cross-site process
   isolation in browsers other than desktop Chromium ≥ 127 for opaque frames. Is that acceptable as the default, with
   `web.preview_origin` as the hardened mode? Should `preview_origin` refuse a host under the dashboard's
   registrable domain?
4. **Q4 — `.html` attachments in v1** (§6), or fences only first?
5. **Q5 — new-tab transport.** URL fragments are limited (browser-dependent); measure, and pick a budget, or use a
   one-time `postMessage` handshake with `opener` cleared — which reopens the opener question.
6. **Q6 — `Access-Control-Allow-Origin: *`** on `/api/activity` and the roster: remove in this work or separately?
   The preview cannot read it (no network), but a separate origin makes the cleanup cheaper now.
7. **Q7 — browser tests.** Is a headless browser acceptable in CI for §10.9, or are those manual checks for review?
8. **Q8 — numbers.** 1 MiB, 4000 px, 10 s, 3 s, 10/s are the study's inferences; no vendor publishes inline-preview
   limits. Adjust after the user's testing.
