# #1408 — One app shell for /ui, /view and /settings (design)

Status: design for review. Milestone 2.2.0. Stack: vanilla JS + ES modules, no framework or build step (§0). The user's direction (2026-10-08):
- one production-style shell;
- typography, type and layout modelled on ChatGPT's web UI, **design language only**: no OpenAI code, font, icons, logo or brand assets;
- Discord stays the place people act; the web presents.

Baseline: `/tmp/web22-shots/` (main `2d432413`). The rough edges listed there are mapped to steps in §8.

## 0. Tech stack (decided 2026-10-08, the user agreed)

- **No frontend framework.** The app is vanilla JS with native **ES modules** (`<script type="module" src="/assets/app.js">`, which `import`s the shared modules and, by mode, the panels; see §4 for which file lives where). The browser loads the files as they are in `src/ui/`.
- **No build step and no new npm dependency**: no bundler, transpiler, CSS preprocessor or UI library. The release copies `src/ui/` into `dist/` as it does today.
- **Shared pieces are ours:**
  - design tokens as CSS custom properties, in one stylesheet;
  - a small set of shared components: shell, sidebar, dialog/sheet, composer, menu, empty/loading/error states.

  Each component is an ES module exporting plain functions that build DOM (`el()`-style, as Settings does now), with no templating library.
- **The #1300 CSP stays as it is:** `script-src 'self'` (module scripts from `'self'` need nothing new), `style-src 'self'`, no inline style attribute, no inline handler, no `eval`/`new Function`. Inter is a local file under `font-src 'self'`.
- **Tests:** vitest imports the modules directly (they are ES modules) against the small DOM fakes the vm harnesses use now; no jsdom or happy-dom is added. Screenshots use the existing Playwright harness outside the repo.

## 1. Where we start (survey of main)

| | /ui (dashboard.html) | /view (view.html) | /settings (settings.html) |
|---|---|---|---|
| Size | 1850 lines | 1164 | 2231 |
| Script | top-level globals (`api`, `esc`, `toast`, `sel`, `renderList`, `cur`, `ACTIONS`, …) | one IIFE | one IIFE |
| Theme | light + dark tokens, `theme.js` | dark only | light only |
| Tokens | `--text`, `--text-sec`, `--accent #2aabee` … | `--fg`, `--dim`, `--accent #58a6ff` | `--fg`, `--muted`, `--accent #2563eb` |
| Background work | EventSource `/ui/events` (never closed) + `/ui/poll` fallback | `setInterval` 800 ms pane + 5 s roster (never cleared) | apply-job watcher (1 s, ≤ 10 min) |
| Page-wide listeners | click delegation (`[data-act]`), keydown (Esc stops the agent's reply) | keydown "/" and Esc | keydown Esc (modal) |
| i18n | `UI_TEXT`, `agend_lang` read once, no switch | `I18N` + switch; `applyI18n` scans the **whole document** | `I18N` + switch; scans the whole document |

Shared today:
- `shell.js`: the nav link strip and Session menu. It adds new document listeners on every mount.
- `theme.js`
- `agend-auth.js`: wraps `fetch` once, adds `X-Agend-CSRF`, and shows the 401 banner.
- `shell.css`

Served by `sendPanelHtml`, whose CSP allows only `'self'`, plus a nonce for the inline script and style. Deep links: none.

The three cannot simply share one document:
- top-level name collisions (`api`, `esc`, `renderList`, `select`, `I18N`, `lang`, `state`);
- duplicate ids (`sidebar`, `langBtn`, `help*`);
- whole-document i18n scans that overwrite each other;
- unscoped CSS (`button`, `label`, `input`, `textarea`, `header`, `main`, `.card`, `.msg`, `.dot*` mean different things);
- page-wide keyboard handlers (on /ui, Esc on `document.body` can **stop an agent's reply**);
- timers and streams that never stop.

The shell therefore needs panel modules with a lifecycle, not three pages pasted together.

## 2. The look: ChatGPT's design language, our own assets

- **Layout:**
  - a left sidebar like a conversation history: one row per instance, the current one highlighted, metadata on hover. It collapses.
  - The main area is a centred column (`--col: 768px`).
  - A large rounded composer is pinned to the bottom, with attach, send and stop inside the box.
  - The header is light: instance name and status on the left, actions in a ⋯ menu.
- **Surfaces:** neutral greys with very few borders; areas are told apart by background tone. Whitespace is generous.
- **Messages:**
  - the user's on the right, in bubbles;
  - the agent's at full column width with no bubble;
  - message actions (Copy …) appear on hover and focus, and always on touch.
- **Type:**
  - **Inter, bundled locally** (decided, §10):
    - one variable woff2, Latin subset, served same-origin as `/assets/inter.woff2` with `font-display: swap`;
    - the CSP's `font-src 'self'` already allows it, and nothing is loaded from outside;
    - its licence (SIL OFL 1.1) is added to the repo as `src/ui/assets/fonts/OFL.txt`, and the release ships it beside the font;
    - `/assets/*` is a fixed map today, so `inter.woff2` and `app.css` are added to that map and to the public link's manifest, with correct types (`font/woff2`, `text/css`).
  - Chinese text falls back to the system CJK fonts, in this order: `"PingFang TC", "Noto Sans TC", "Microsoft JhengHei"`. After those comes the system stack (`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`). The full stack:
    `font-family: Inter, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`.
  - Code uses `ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace`.
  - Not OpenAI's font.
- **Icons:** one consistent set, our existing line SVGs, extended in the same 24-px / 2-px-stroke style. Settings' emoji icons are retired. No third-party brand assets.
- **Tokens** (one stylesheet, `/assets/app.css`, light and dark):
  - colours: `--bg`, `--bg-sidebar`, `--surface`, `--surface-2`, `--text`, `--text-2`, `--text-3`, `--border` (rare), `--accent`, `--danger`, `--warn`, `--ok`, `--focus`;
  - spacing scale `--s-1`…`--s-8` (4, 8, 12, 16, 20, 24, 32, 48);
  - type scale `--fs-xs` 12, `--fs-sm` 13, `--fs-md` 15, `--fs-lg` 17, `--fs-xl` 22, with line heights;
  - radii `--r-sm` 8, `--r-md` 12, `--r-lg` 16, `--r-full`;
  - shadows `--shadow-1`, `--shadow-2`; durations `--t-fast` 120 ms, `--t-med` 200 ms.
  - Every text/surface pair meets WCAG AA (4.5:1), checked by a test.
  - `theme.js` sets `data-theme` before first paint, for every panel.

### Desktop (≥ 900 px)

```
┌─────────────────────┬──────────────────────────────────────────────────────────────┐
│ ◧  AgEnD        ✎   │  web-dev ● working                                    ⋯     │  header: name + status, actions in ⋯
│                     │                                                              │
│  ⌕ Search           │              ┌──────────────────────────────────────┐        │
│                     │              │ Can you add a dark mode toggle…      │ ◀ user │
│  Needs you      (2) │              └──────────────────────────────────────┘        │
│  Fleet              │   Done — the toggle lives in Settings → General …            │  agent: full width, no bubble
│  View               │   ```ts                                                      │
│  Org chart          │   export function applyTheme(…)                    Copy Wrap │
│ ─────────────       │   ```                                                        │
│  INSTANCES          │   ⧉ Copy                                     (hover actions) │
│ ▌web-dev   ●        │                                                              │
│  api-server ● needs │   ● web-dev is working… 0:42                                 │
│  docs-writer        │  ┌────────────────────────────────────────────────────────┐ │
│  qa-bot  ⏸          │  │ 📎  Message web-dev…                              ■ Stop│ │  composer: rounded, pinned
│                     │  └────────────────────────────────────────────────────────┘ │
│  ⚙ Settings         │        Enter to send · Shift+Enter new line · Esc stops       │
│  ◐ Theme  文 Lang   │                                                              │
│  ● Session (you)    │                                                              │
└─────────────────────┴──────────────────────────────────────────────────────────────┘
```

### Phone (< 900 px)

```
┌──────────────────────────────┐
│ ☰  web-dev ● working     ⋯   │   header; ☰ opens the sidebar as a drawer
│                              │
│   ┌────────────────────────┐ │
│   │ Can you add a dark…    │ │
│   └────────────────────────┘ │
│ Done — the toggle lives in … │
│ ```ts (wraps by default) ``` │
│ ┌──────────────────────────┐ │
│ │ 📎 Message…        ■ Stop│ │   composer pinned above the tabs
│ └──────────────────────────┘ │
├──────────────────────────────┤
│  💬Chat  ▣View  ◉Needs  ⚙Set │   bottom tabs (nav, aria-current), badge on Needs
└──────────────────────────────┘
```

The bottom tabs hide while the keyboard is open, using `visualViewport` (the composer gets the space). Safe-area insets are respected.

## 3. Routing (history API; deep links keep working)

| URL | Panel | Notes |
|---|---|---|
| `/ui` | Chat (last instance, or the empty "pick an instance" state) | |
| `/ui/chat/<instance>` | Chat with that instance | new |
| `/ui#instance=<name>` | → `/ui/chat/<name>` | old deep links keep working. The fragment never reaches the server, so the shell does this with `history.replaceState` before the first render. |
| `/ui/fleet[/tasks\|schedules\|teams\|config]` | Fleet | new |
| `/ui/needs` | Needs you (#1386 part b) | new |
| `/ui/org` | Org chart (#1389, later) | reserved |
| `/view`, `/view/<instance>` | View | |
| `/settings`, `/settings/<section>` | Settings | sections: agents, bots, general, advanced … |

- **Server:** every path in the table serves the **same** `app.html`, and the gate and its sign-in fallback apply unchanged.
  - **One exact navigation classifier**, `shellRoute(method, path)` in a new `src/web-shell-routes.ts`, returns the panel and a validated instance or section, or `null`. Four places use it:
    - the route that serves the shell;
    - the gate's sign-in fallback (`serveSigninPage` for HTML GETs with no credential, today hard-coded to `/ui`, `/settings` and `/view`);
    - the public link's manifest (`isPublicWebRoute`);
    - the anonymous `/view` bypass (`isViewPath`, which gains `/view/<instance>` and nothing else).

    No copy of the pattern list exists anywhere else. signin.js cannot import TypeScript, so a test runs its `nextTarget` over the classifier's case table.
  - **Bootstrap attributes (the server's decision, read by `app.js` on boot).** Today `/ui` alone gets `data-web-transport` and the #1306 preview attributes (`data-dashboard-origin`, `data-preview-origin`, `data-preview-boot`, `data-preview-reason`), plus the conditional CSP `frame-src <preview origin>/frame`. From step 1, **every signed-in shell entry** (`/ui…`, `/view…`, `/settings…`) is built by the same function and gets the same attributes and the same conditional `frame-src`. Entering at `/settings` or `/view` and then switching to Chat is identical to entering at `/ui`. The three modes:

    | Entry | `data-mode` | Stream | Previews |
    |---|---|---|---|
    | local, signed in | `full` | **1 EventSource** `/ui/events`, falling back to `/ui/poll` every 5 s only while it is down (as today) | as /ui today (Host-only origin, boot, reason, conditional `frame-src`) |
    | public link (#1367), signed in | `full` + `data-web-transport="poll"` | **0 EventSource**; `/ui/poll` from the start (the manifest still has no `/ui/events`) | off: no preview origin, no `frame-src`, the reason given as today |
    | anonymous View-only (`view_access: open`) | `view-only` | **neither**: no `/ui/events` and no `/ui/poll` | off |

    "One connection" in §5 means *at most* one, by these modes. The public-link regression tests (no SSE, immediate polling) stay as they are.
  - **Sign-in keeps the legacy fragment** (`/ui#instance=alpha` signed out). The sign-in page is served at the requested URL, so `location.hash` is still there. Today `nextTarget()` (signin.js) drops it, and both return paths use `nextTarget()`: the code login and the cookie-probe bounce.

    From step 1, `nextTarget()` keeps exactly one form: a hash of `#instance=<name>`, where the name passes the same name rule as the server. It converts that **itself** to `/ui/chat/<encoded name>`. Any other hash is dropped.

    The existing guards stay:
    - `token` is stripped from the query;
    - only same-origin targets the classifier accepts;
    - no backslash;
    - the fallback is `/ui`.

    Tests cover both return paths with a valid fragment, an invalid one (`#instance=../x`, `#instance=a&token=…`, `#next=//evil`) and none.
  - **Instance names in paths** (decided, §10):
    - written by the client with `encodeURIComponent`;
    - decoded and validated by the server against the same name rule that instance creation uses. A malformed name (bad encoding, `/`, characters outside the rule) gets the 400 that other routes use.
    - A **well-formed but unknown** name still gets the shell (200, same CSP). The Chat panel shows a "No instance called *x*" empty state with a link back to the list, not an error page.
    - The server does not tell anonymous callers which names exist: the shell is identical for known and unknown names, and only the signed-in client learns from its own list.
  - **Anonymous `/view` (`view_access: open`)**, decided in §10: a **View-only shell**. It looks the same as the signed-in shell. The nav holds only **View** and **Sign in**.
    - Chat, Fleet, Settings, Needs you, Org chart and the Session menu are **not rendered at all** (absent from the DOM, not disabled).
    - Their panel modules are not imported. The page makes no request to a session-only endpoint: no `/ui/events`, `/ui/poll`, `/ui/instances`, `/api/settings/*`.
    - The server marks the mode on the shell (`data-mode="view-only"`), from the same decision that lets the request in today.
    - Test: render the shell anonymously with `view_access: open` and assert that the nav has exactly View + Sign in, that no session-only link or panel module appears in the HTML or the DOM, and that the recorded requests stay within the View-only set.
- **Known and unknown names:** the test compares the response **body** and the CSP **with the nonce masked**; each response has a fresh nonce, so the headers cannot be compared raw.
- **No clash with data routes.** `/ui/` already holds data GETs: `/ui/instance/<x>`, `/ui/instances`, `/ui/tasks`, `/ui/schedules`, `/ui/teams`, `/ui/config`, `/ui/poll`, `/ui/history`, `/ui/file/<id>`, `/ui/prompts`, `/ui/backends`, `/ui/js/*`.
  - Client routes use only the new first segments `chat`, `fleet`, `needs` and `org`, and the server serves the shell for exactly those patterns (plus `/ui`, `/view[/<x>]`, `/settings[/<section>]`), never as a prefix fallback.
  - A test asserts that no shell pattern matches any existing data route, in both directions.
  - The public link's manifest (`isPublicWebRoute`) uses the same classifier.
  - #1398's test that `GET /ui/needs` is not a data route stays true: from step 4 it serves the shell HTML (a navigation, not a read of the list), and the list still arrives only over SSE `needs` and `/ui/poll`.
- **Client:** links are real `<a href>`s; clicks are intercepted (with modifier-click and middle-click left alone), then `pushState` and `popstate`. A route change runs `unmount` on the outgoing panel and `mount`/`update` on the incoming one, focuses the new view's heading (for screen readers), updates `document.title`, and sets `aria-current` on the nav.

## 4. Panels: modules with a lifecycle

Each panel is an ES module that exports `{ mount(root, route, ctx), update(route), unmount() }`. Modules scope their names, which ends the global collisions of §1.

**Where modules live: one public closure, private panels behind the gate.**
- The entry `app.js`, everything it imports **statically**, and `panel-view.js` with its own static imports form the **public closure**. All of it is served from `/assets/`.
  - `/assets/*` is already outside the session gate (`isAuthPath`) and is a **fixed map** of exact names (`ASSETS` in auth-api.ts). Each closure file is added to that map by name, with no pattern and no directory. The same names go in the public manifest.
  - These files are static code with no data, like `shell.js` and `signin.js` today.
  - The closure is: `app.js`, `app-router.js`, `app-store.js`, `app-stream.js`, `app-i18n.js`, `ui-dialog.js`, `ui-menu.js`, `ui-states.js`, `ui-icons.js`, `panel-view.js`, `app.css`, `inter.woff2`.
- `panel-chat.js`, `panel-fleet.js`, `panel-settings.js`, `panel-needs.js` and their helpers (`ui-composer.js`, `chat-render.js`, `preview.js`, …) stay under `/ui/js/`, behind the session gate as today.
  - `app.js` reaches them **only** with a dynamic `import()`, and only when `data-mode="full"`.
  - The View-only shell never imports them, eagerly or lazily.
- **Test over real HTTP**, with no module injection: an `http.Server` runs `FleetManager.dispatchWebHttp` on an ephemeral port from a scratch FleetManager. No fleet, no tmux, no instances (decision bd0c88aa).
  - With no credential and `view_access: open`, the test fetches `/view` and parses its module entry. It then walks every **static** `import` specifier recursively and asserts each one is 200 with a JavaScript type.
  - It asserts the closure contains no `/ui/` URL.
  - It asserts that `/ui/js/panel-chat.js`, `/ui/js/panel-settings.js`, `/ui/events`, `/ui/poll` and `/ui/instances` are still 401 anonymously.
  - With `view_access: session`, anonymous `/view` gets the sign-in page as today.

**Navigation generations: async ownership.** An `AbortController` cancels a fetch, but not a continuation that already has its result, nor a dynamic `import()`. So:
- Every navigation, mount and update gets a **generation** from the router.
- `ctx.current()` is true only while that generation is the latest and the panel is still mounted.
- The panel calls `ctx.current()` after **every** `await`: after the `import()`, after the response headers, after the body. It also calls it before any DOM write, `document.title` change, focus move, or action published to the app (store write, toast, navigation). If it is false, the continuation returns without doing anything.
- `update()` on the same panel (View A → B, Settings section → section, Chat instance → instance) bumps the generation, so work started for A cannot land on B.
- A mount that is superseded or fails disposes its `ctx` at once, which clears its timers, listeners, subscriptions and fetches. The router mounts only the latest.
- Language change and the error state's Retry are themselves navigations with a new generation.
- Tests:
  - import of A resolving after import of B → only B renders;
  - View A → B → A with the A1 response arriving last → shows A2's data;
  - leave and re-enter during a load;
  - a late Settings load after leaving → no DOM write and no title;
  - a language switch and Retry mid-load.

**Previews (#1306) are not `ctx`-owned today, so Chat handles them explicitly.** `preview.js` keeps its own timers (ready 3 s, watchdog, resize rAF), its window `message`/`storage` listeners, and `onChange` callbacks that cannot be removed.
- `preview.init` and its two window listeners belong to the **app**, once per page, since they are page-wide by nature. `onChange` returns an unsubscribe function, and Chat registers it through `ctx`, so it is removed on dispose.
- Before Chat leaves, re-renders a message, or moves a card, it calls `Preview.stopAll("leave")`. That removes every live frame and clears its timers.
- A live preview iframe is **never cached, hidden or re-parented** across a switch. Coming back shows the card in its "stopped — Preview again" state, as a re-render does today.
- Tests:
  - a frame's late `ready`/resize message after Chat unmounted → ignored, no timer left;
  - 50 Chat mounts with a preview started each time → zero live frames, timers and `onChange` callbacks afterwards.

**The rules, enforced by tests:**
- **Scoped DOM:** a panel queries only inside its `root` (`root.querySelector`), with no `getElementById` on the document. Ids are prefixed by panel if needed, and a test asserts no duplicate ids exist in the mounted app.
- **No page-wide listeners of its own:**
  - keyboard: `ctx.on("key", handler)` is called only while the panel is mounted and the focus is inside its root, or nothing else is focused (`body`), never while a dialog or the drawer is open. Example: Esc stopping the reply is registered by Chat for its root only.
  - clicks: delegation through `ctx.actions({...})`, scoped to the panel's root. The single document listener belongs to the app, which routes by the closest panel root.
- **Owned work:**
  - `ctx.interval(fn, ms)`, `ctx.timeout`, `ctx.fetch`: an `AbortController` per mount;
  - `ctx.subscribe(eventName, handler)` on the app's stream.

  All of these are cleared automatically by `unmount`; a panel cannot leak a timer it got from `ctx`. Raw `setInterval` and `new EventSource` are banned in panel code (static test).
- **i18n:** one dictionary, namespaced (`chat.*`, `view.*`, `settings.*`, `app.*`), from today's three. `ctx.t()` resolves keys, and `applyI18n(root)` touches only that root. The language toggle lives in the sidebar and re-renders the mounted panel.
- **CSS:** one `/assets/app.css`, external (`style-src 'self'`; no nonce'd inline `<style>` is needed). Panel rules are namespaced under `.p-chat`, `.p-view` … There are **no bare-element rules** outside the reset, and components (`.btn`, `.card`, `.dot`, `.menu`, `.sheet`) are defined once. The #1300 CSP stays: no style attribute, classes only.

## 5. State and connections across switches

| What | Lives in | Across a switch |
|---|---|---|
| Stream (status, messages, ticks, prompts, `needs`) | **the app**, by mode (§3): local = one `/ui/events` with the `/ui/poll` fallback; public link = `/ui/poll` only; View-only = none | kept across switches; never one per panel |
| Chat messages, drafts, pending files, ticks | app store (by instance) | kept: switching away and back restores the draft and scroll |
| View pane poll (800 ms) and roster poll (5 s) | the View panel, via `ctx.interval` | **stopped on leave**, started on return; also paused while the tab is hidden (`visibilitychange`) |
| View usage panel (60 s) | the View panel, only while the usage drawer is open | stopped on leave |
| Settings data | loaded on mount; nothing recurring | dropped on leave (unsaved edits prompt before leaving) |
| Settings **Apply operation**: the staged writes, the `POST /api/settings/apply`, and the job watcher | **the app**, from the confirmation onward (below) | kept; progress and result show in any panel |
| Theme, language, sidebar collapsed, tour seen | `localStorage` (as today) | app-wide |

**Settings Apply is owned by the app before the first write.** Today `applyPendingChanges` (settings.html):
1. runs every confirmation;
2. performs the staged writes **one by one**;
3. only then makes the idempotency key and `POST /api/settings/apply`;
4. watches the job.

If only the watcher moved to the app, an unmount between steps 2 and 4 would lose an accepted write's follow-up, the key, or the job ID. So:
- When the person confirms, the panel builds an **operation**: the list of staged changes as **data** (method, URL, body, label; no DOM closures), plus an idempotency key generated **now**. It hands the operation to the app's single `settingsApply` runner **before the first write**.
- The runner performs the writes, the POST (reusing the key on retry, as today) and the one watcher. It publishes progress to the app store. It never touches panel DOM.
  - A mounted Settings panel renders from the store, and a re-mounted one re-attaches by the operation's ID.
  - Apply is disabled while an operation exists, so returning never starts a second job.
  - 409 and failures are reported as today.
- Navigation away is free once the operation is handed over.
  - **Before that**, with staged but unapplied changes, leaving asks "Discard N pending changes?". Cancel keeps you on the page; Discard runs each change's cleanup, which today clears entered secrets, and drops them.
  - `beforeunload` warns while an operation is still before its POST.
- Secret values live only inside the operation and are dropped as each write finishes or the operation fails.
- Tests:
  - a switch while each write is in flight, accepted, and while the POST is in flight or accepted → one job, the same key, progress continues, no write to the old DOM;
  - a dirty navigation Cancel, and Discard (secrets cleared);
  - returning during a job → attached, Apply disabled, no second POST.

**#1374: what counts as use.** No new timer and no new endpoint, and the passive allowlist is unchanged. Requests fall into three classes:
- **Background reads that no person caused** must be passive reads, exactly as today: the stream, its reconnects, the 5 s poll fallback, View's pane and roster timers, the usage drawer refresh.
- **Loads caused by a person's navigation** count as use, as they do today when the same click happens on the old pages. They are **not** made passive:
  - the first selection of an instance in Chat (`GET /ui/history`);
  - mounting a Fleet tab (`/ui/tasks`, `/ui/schedules`, `/ui/teams`, `/ui/config`);
  - mounting Settings (`/api/settings/*`).
- **Actions** (send, stop, apply …) count as use, as today.

The router itself sends nothing. A cached return, such as Chat for an instance whose history is already in the store, sends no request at all. Tests, separately:
- first selection → one `/ui/history`, which counts;
- cached return → zero requests;
- a Fleet mount and a Settings mount → their loads, which count;
- with no interaction, background SSE reconnect and poll → only allowlisted passive reads, and the session's last-use time does not move.
- **No leaks:** a test mounts and unmounts each panel 50 times, then asserts zero live intervals, timeouts, listeners, preview frames and `onChange` callbacks from panels, and the mode's stream count unchanged (local 1, public link 0 EventSource, View-only 0).

## 6. Empty, loading and error states (every panel)

One component set:
- `skeleton(lines)` while loading (no spinner flashes under 300 ms);
- `empty(icon, title, hint, action?)`;
- `error(message, retry)`, with a Retry that re-mounts the panel.

Per panel:
- **Chat:** no instance → "Pick an instance to start"; a new conversation → "No messages yet"; send failed → the message's own "!" plus Put back.
- **Fleet tabs:** "No tasks / schedules / teams yet" with the create action.
- **View:** no instances; pane unreachable → "This instance's terminal isn't available (stopped?)".
- **Settings:** each section's load error, with Retry.
- **Needs you:** "Nothing needs you right now".

The stream itself: a slim status line at the top of the main area when it falls back to polling ("Live updates paused — refreshing every 5 s"), and a reconnecting state.

## 7. Accessibility

- Landmarks: `nav` (sidebar, bottom tabs) and `main` (the panel), plus a skip link to the composer or the main content.
- `aria-current="page"` on the active nav item; the instance list is a `nav` list, not a grid.
- Focus moves to the new view's heading on route change. The drawer and dialogs trap focus, Esc closes them, and focus returns to the opener.
- Live region announcements stay as today (an agent replies, finishes, stops).
- Tap targets ≥ 44 px on phones. The ⋯ menus are `button` + `menu`, with arrow-key navigation.
- Contrast per §2, tested; `prefers-reduced-motion` is respected.

## 8. Migration: steps, each shippable, each with a screenshot set

**After every step:** a screenshot set at desktop 1440 and phone 390, light and dark, in `/tmp/web22-shots-step<N>/`, same harness and fixtures as the baseline. The user can tick the rough edges off as they go.

| Step | What | Rough edges closed (baseline #) |
|---|---|---|
| **1. Shell + Chat** | `app.html`, `app.js` (router, lifecycle, app stream, store, i18n, theme), `app.css` (tokens, Inter, components), sidebar + bottom tabs + Session/theme/language in the sidebar; the **Chat** and **Fleet** panels ported from dashboard.html into modules. The shell patterns of §3 serve the shell. View and Settings remain their old pages for now, reached by normal links from the sidebar (a full load, styled by the new tokens as far as shared classes go). | 1 (Chat/Fleet side), 2 (/ui), **4** (the composer's control becomes "Stop reply" and shows only while the agent works; the instance's Stop moves into the header ⋯ menu as "Stop instance"), **6** (name and badge on two lines, never truncated to one letter), **7** (state-aware actions in ⋯: Start for a stopped instance, Stop/Restart only when running, Delete last behind a confirm; the phone header is one row), **9** (dark-mode text tokens meet AA; code wraps on phones and scrolls with a fade on desktop), 10 (delivery ticks visible; sign-in copy) |
| **2. View** | View panel module: roster as a sidebar section or the phone drawer, the terminal at full width on phones, labelled icon buttons with tooltips, light and dark. `/view` serves the shell. | **3**, 2 (/view), 10 (View icon labels; "Edit" clarified) |
| **3. Settings** | Settings panel module: sections become sub-routes; the same buttons, inputs and checkboxes as everywhere (`font: inherit`); SVG icons; **one create-instance component** shared with Chat's "New instance"; dialogs become sheets on phones (with ×); the version shown from the running release. | **1** (closed), 2 (/settings), **8**, 10 ("not probed yet" → "Detected when it starts"; version chip) |
| **4. Needs you** | #1386 part (b) built here: the Needs you panel, the sidebar badge and bottom-tab badge, Acknowledge, `#instance` links, desktop notifications (#1386 §6). | — (#1386) |
| **5. Clean-up** | Sign-in page on the same tokens (light and dark); the tour retargeted to the new shell; old page files removed; shell.js and shell.css retired. | 2 (sign-in), 10 |

Baseline item 5 (the permission prompt's wording) is the separate small issue the leader asked for. It is fixed at the shared prompt text, so Discord benefits too, as a small PR between steps.

## 9. Tests

- **Router (vm harness on `app.js`):** every URL in §3, the `#instance=` migration, back/forward, modifier-click untouched, title, focus, `aria-current`.
- **Server routes:**
  - each shell pattern returns `app.html` with the panel CSP;
  - encoded names round-trip (`%E4%B8%AD`, `a%20b` if the name rule allows it);
  - malformed names → 400;
  - an unknown well-formed name → the shell, whose response is byte-identical to the one for a known name;
  - no shell pattern overlaps a data route.
- **View-only shell:** the anonymous `view_access: open` test of §3.
- **Font:** `/assets/inter.woff2` is served as `font/woff2` under `font-src 'self'`; `OFL.txt` is present in `dist/`; `@font-face` has `font-display: swap`.
- **Module admission:** the real-HTTP import walk of §4, anonymous and signed in.
- **Bootstrap modes:** the three entries of §3. Each signed-in entry (`/ui`, `/view`, `/settings/general`) carries the same preview attributes and conditional `frame-src`; the public link and View-only carry none; the public-link no-SSE regression is kept.
- **Sign-in return:** the legacy fragment through both the code login and the cookie-probe bounce (§3).
- **Generations, Preview, Settings Apply, #1374 classes:** as listed in §4 and §5.
- **Lifecycle:**
  - mount/unmount ×50 per panel leaves nothing behind;
  - the mode's stream count (local 1 EventSource, public link 0 plus polling, View-only none) across all switches;
  - View's pollers stop on leave and when hidden, and restart on return;
  - the Settings apply job survives a switch.
- **Keyboard scoping:** Esc in Settings or View never stops an agent's reply; "/" focuses View's filter only in View; a dialog's Esc wins over the panel's.
- **#1374:** the allowlist is unchanged; the request classes of §5.
- **#1300:** no style attribute and no inline handler anywhere; the CSP is unchanged except that external `/assets/app.css` and `/assets/inter.woff2` are served under `'self'`.
- **Visual:** the screenshot set per step. Contrast computed from the token pairs.
- **Existing suites:** the vm harnesses that load `dashboard.html`'s inline script (web-chat-c1…c4, web-csp-1268, web-preview-card-1306, web-ui-tour-1366, sidebar-instance-identity, …) move to loading `panel-chat.js` and `app.js` in step 1. This is the bulk of step 1's test work. What they assert stays the same.

## 10. Decisions (leader, 2026-10-08)

1. **Step 1 keeps View and Settings as separate pages** reached by full-load links, with no iframe. Steps 2 and 3 move them into the shell.
2. **Inter bundled locally:** variable woff2, Latin subset, `font-display: swap`, same-origin `/assets`, OFL in the repo. CJK falls back to PingFang TC → Noto Sans TC → Microsoft JhengHei (§2).
3. **Anonymous `/view`:** a View-only shell. The nav is View + Sign in only, and nothing that needs a session is rendered or requested; tested (§3).
4. **Paths:** `/ui/chat/<instance>`. The server returns the shell with the same CSP; `/ui#instance=` is redirected client-side; names are URL-encoded and validated by the server; an unknown instance gets a "not found" empty state (§3).
