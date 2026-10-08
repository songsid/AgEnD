# #1408 — One app shell for /ui, /view and /settings (design)

Status: design for review. Milestone 2.2.0. Stack: vanilla JS + ES modules, no framework or build step (§0). The user's direction (2026-10-08):
- one production-style shell;
- typography, type and layout modelled on ChatGPT's web UI, **design language only**: no OpenAI code, font, icons, logo or brand assets;
- Discord stays the place people act; the web presents.

Baseline: `/tmp/web22-shots/` (main `2d432413`). The rough edges listed there are mapped to steps in §8.

## 0. Tech stack (decided 2026-10-08, the user agreed)

- **No frontend framework.** The app is vanilla JS with native **ES modules** (`<script type="module" src="/ui/js/app.js">`, which `import`s the panels). The browser loads the files as they are in `src/ui/`.
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
  - **Inter**, variable, latin subset, **bundled locally** as `/assets/inter.woff2` (SIL OFL 1.1, licence file shipped next to it). The CSP already allows `font-src 'self'`; nothing is loaded from outside.
  - Fallback is the system stack (`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`).
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
| `/ui#instance=<name>` | → `replaceState` to `/ui/chat/<name>` | #1386 / tour links keep working |
| `/ui/fleet[/tasks\|schedules\|teams\|config]` | Fleet | new |
| `/ui/needs` | Needs you (#1386 part b) | new |
| `/ui/org` | Org chart (#1389, later) | reserved |
| `/view`, `/view/<instance>` | View | |
| `/settings`, `/settings/<section>` | Settings | sections: agents, bots, general, advanced … |

- **Server:** every path in the table serves the **same** `app.html`, and the gate and its sign-in fallback apply unchanged.
  - `serveSigninPage` now also covers `/ui/…`, `/view/…` and `/settings/…` navigations.
  - signin.js's `nextTarget` already allows `^/(ui|view|settings)(/|$)`.
  - `/view` keeps its `web.view_access` semantics: the **shell** is gated like `/ui`. With `view_access: open`, an anonymous visitor to `/view` gets a View-only shell: no sidebar entries that need a session, and a "Sign in" link. That is what the open `/view` is today.
- **No clash with data routes.** `/ui/` already holds data GETs: `/ui/instance/<x>`, `/ui/instances`, `/ui/tasks`, `/ui/schedules`, `/ui/teams`, `/ui/config`, `/ui/poll`, `/ui/history`, `/ui/file/<id>`, `/ui/prompts`, `/ui/backends`, `/ui/js/*`.
  - Client routes use only the new first segments `chat`, `fleet`, `needs` and `org`, and the server serves the shell for exactly those patterns (plus `/ui`, `/view[/<x>]`, `/settings[/<section>]`), never as a prefix fallback.
  - A test asserts that no shell pattern matches any existing data route, in both directions.
  - The public link's manifest (`isPublicWebRoute`) gets the same exact patterns.
  - #1398's test that `GET /ui/needs` is not a data route stays true: from step 4 it serves the shell HTML (a navigation, not a read of the list), and the list still arrives only over SSE `needs` and `/ui/poll`.
- **Client:** links are real `<a href>`s; clicks are intercepted (with modifier-click and middle-click left alone), then `pushState` and `popstate`. A route change runs `unmount` on the outgoing panel and `mount`/`update` on the incoming one, focuses the new view's heading (for screen readers), updates `document.title`, and sets `aria-current` on the nav.

## 4. Panels: modules with a lifecycle

Each panel is an ES module (`/ui/js/panel-chat.js`, `panel-fleet.js`, `panel-view.js`, `panel-settings.js`, `panel-needs.js`) that exports `{ mount(root, route, ctx), update(route), unmount() }`. The router in `/ui/js/app.js` imports them; modules scope their names, which ends the global collisions of §1. Shared components are flat files beside them (`/ui/js/ui-dialog.js`, `ui-composer.js`, `ui-menu.js`, `ui-states.js` …). The existing `/ui/js/` route and the public-link manifest accept only flat `[a-z0-9_-]+.js` names, so no route change is needed. Module scripts are served as `application/javascript` from `'self'`, as today. The rules, enforced by tests:
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
| Stream `/ui/events` (status, messages, ticks, prompts, `needs`) | **the app**: one EventSource for the whole session, with the 5 s `/ui/poll` fallback as today | kept: one connection whatever the panel. Chat, the Needs badge and the instance list all read it. Never one per panel. |
| Chat messages, drafts, pending files, ticks | app store (by instance) | kept: switching away and back restores the draft and scroll |
| View pane poll (800 ms) and roster poll (5 s) | the View panel, via `ctx.interval` | **stopped on leave**, started on return; also paused while the tab is hidden (`visibilitychange`) |
| View usage panel (60 s) | the View panel, only while the usage drawer is open | stopped on leave |
| Settings data | loaded on mount; nothing recurring | dropped on leave (unsaved edits prompt before leaving) |
| Settings apply job (1 s watcher, ≤ 10 min) | **the app** (a job in progress must finish and report wherever you are) | kept; the result is a toast in any panel |
| Theme, language, sidebar collapsed, tour seen | `localStorage` (as today) | app-wide |

- **#1374:** no new timer and no new endpoint. Panels use the same passive reads (`/ui/poll`, `/ui/events`, `/api/pane/*`, `/api/profiles`, `/api/ai-usage`). Switching panels issues **no** request that counts as use (route changes are client-side). Mounting Settings issues its normal reads, which are a person's action, as today. A test asserts the allowlist is unchanged and that a route switch makes no non-passive request.
- **No leaks:** a test mounts and unmounts each panel 50 times, then asserts zero live intervals, timeouts and listeners from panels, and still exactly one EventSource.

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
| **1. Shell + Chat** | `app.html`, `app.js` (router, lifecycle, app stream, store, i18n, theme), `app.css` (tokens, Inter, components), sidebar + bottom tabs + Session/theme/language in the sidebar; the **Chat** and **Fleet** panels ported from dashboard.html into modules. `/ui` and `/ui/*` serve the shell. View and Settings remain their old pages for now, reached by normal links from the sidebar (a full load, styled by the new tokens as far as shared classes go). | 1 (Chat/Fleet side), 2 (/ui), **4** (the composer's control becomes "Stop reply" and shows only while the agent works; the instance's Stop moves into the header ⋯ menu as "Stop instance"), **6** (name and badge on two lines, never truncated to one letter), **7** (state-aware actions in ⋯: Start for a stopped instance, Stop/Restart only when running, Delete last behind a confirm; the phone header is one row), **9** (dark-mode text tokens meet AA; code wraps on phones and scrolls with a fade on desktop), 10 (delivery ticks visible; sign-in copy) |
| **2. View** | View panel module: roster as a sidebar section or the phone drawer, the terminal at full width on phones, labelled icon buttons with tooltips, light and dark. `/view` serves the shell. | **3**, 2 (/view), 10 (View icon labels; "Edit" clarified) |
| **3. Settings** | Settings panel module: sections become sub-routes; the same buttons, inputs and checkboxes as everywhere (`font: inherit`); SVG icons; **one create-instance component** shared with Chat's "New instance"; dialogs become sheets on phones (with ×); the version shown from the running release. | **1** (closed), 2 (/settings), **8**, 10 ("not probed yet" → "Detected when it starts"; version chip) |
| **4. Needs you** | #1386 part (b) built here: the Needs you panel, the sidebar badge and bottom-tab badge, Acknowledge, `#instance` links, desktop notifications (#1386 §6). | — (#1386) |
| **5. Clean-up** | Sign-in page on the same tokens (light and dark); the tour retargeted to the new shell; old page files removed; shell.js and shell.css retired. | 2 (sign-in), 10 |

Baseline item 5 (the permission prompt's wording) is the separate small issue the leader asked for. It is fixed at the shared prompt text, so Discord benefits too, as a small PR between steps.

## 9. Tests

- **Router (vm harness on `app.js`):** every URL in §3, the `#instance=` migration, back/forward, modifier-click untouched, title, focus, `aria-current`.
- **Lifecycle:**
  - mount/unmount ×50 per panel leaves nothing behind;
  - one EventSource across all switches;
  - View's pollers stop on leave and when hidden, and restart on return;
  - the Settings apply job survives a switch.
- **Keyboard scoping:** Esc in Settings or View never stops an agent's reply; "/" focuses View's filter only in View; a dialog's Esc wins over the panel's.
- **#1374:** the allowlist is unchanged, and a route switch issues no non-passive request.
- **#1300:** no style attribute and no inline handler anywhere; the CSP is unchanged except that external `/assets/app.css` and `/assets/inter.woff2` are served under `'self'`.
- **Visual:** the screenshot set per step. Contrast computed from the token pairs.
- **Existing suites:** the vm harnesses that load `dashboard.html`'s inline script (web-chat-c1…c4, web-csp-1268, web-preview-card-1306, web-ui-tour-1366, sidebar-instance-identity, …) move to loading `panel-chat.js` and `app.js` in step 1. This is the bulk of step 1's test work. What they assert stays the same.

## 10. Open questions for review

1. **Step 1 keeps View and Settings as separate pages** (full-load links) for one step. Acceptable as an interim, or should step 1 frame them in the shell from day one (an iframe would bring back a second CSP context, so I'd rather not)?
2. **Inter bundled** (about 300 KB woff2 for the latin variable subset) or **system font only**? Bundling gives the same look everywhere. The system stack is zero bytes and native on each OS.
3. **Anonymous `/view`** (`view_access: open`): a View-only shell (proposed), or keep a separate minimal page for anonymous readers?
4. **The URL scheme:** `/ui/chat/<instance>` etc. (proposed), or keep everything under hash fragments to avoid any server route changes?
