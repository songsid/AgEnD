# One instance sidebar, an instance view switch, one top bar

Status: design for review (r2: Prism's r1 — row destinations per PR, one identity rule for both lanes). Nothing here is merged yet.
Source: user feedback on 2.2 alpha.2 (via the leader, 2026-10-10):
- "I want Fleet and View to have the same left sidebar, including the filter."
- "Or, once I'm in an instance, switch between Fleet and View right next to its name."
- "View's usage and text-size controls should be in Fleet's top bar too."

The leader asked for all three, in one direction.

## 1. What exists (survey of `main` at 839f1a81)

| Piece | Today |
|---|---|
| Shell sidebar (`app-shell.js` `Sidebar`) | Nav (Needs you, Fleet, View), then `app.instances` in **server order**: no groups, no filter, no drag. The row dot comes from live state (`statusClass`: busy, warn, bad, off or ok), and the row has a needs-you badge. Every row links to **Chat**. The row is highlighted only on Chat. Used by Chat, Fleet, Settings and Needs. |
| View roster (`panel-view.js` `ViewRoster`) | Replaces the shell list on View through `setSideSection`. Data: `GET /api/profiles` every 5 s. **Groups** by tag (Classic / first tag / Other), collapse, **drag to reorder** (saved in `agend_view_sidebar_order`), and a **filter** (name, alias, model, backend; not status). The dot knows only running, crashed or off. It adds context % and a backend icon. Rows link to **View**. |
| Top bars (`PanelHeader`) | Chat: name, status, model and effort chips, ⋯ menu (details, start/restart/stop, delete). View: name, status, **text size** (`fit / comfortable / compact`, `agend_view_density`, terminal only), **usage** (`UsageDialog`, `/api/ai-usage`, hidden when that is a 404), help. Fleet: the title only. |
| Per-instance summary | Chat's `DetailsDialog` (`GET /ui/instance/:name`): backend, model, effort, cost, context, 5h/7d limits, recent activity. Settings → Agents rows and `AgentDialog`: config and pause/wake/start/stop. Fleet has **no per-instance page**. |
| Routes | `/ui/chat/:name`, `/view/:name` (public under `web.view_access: open`), `/ui/fleet/<tab>`. Client and server tables must match (`web-shell-routes-1408.test.ts`). The public `/assets` closure must not import `/ui/` modules (`web-app-modules-1408.test.ts`). |
| Phone (< 900 px) | The sidebar is a drawer, bottom tabs are Chat, Needs, Fleet, View and Settings, and there are no top tabs. |

So there are two different lists with different data, dots, order and links. There is a filter on only one of them, and the text-size and usage controls exist only on View.

## 2. Layout

### 2.1 Desktop (≥ 900 px): Chat, View or Details of one instance

```
┌───────────────────────┬──────────────────────────────────────────────────────────────────────────┐
│ AgEnD           ▣  ✎ │ web-dev · Web developer   ● working    [ Chat | View | Details ]   Aa  ◔  ⋯ │
│ ◎ Needs you        2 │──────────────────────────────────────────────────────────────────────────│
│ ▤ Fleet              │                                                                          │
│ ▸ View               │   (the selected view of web-dev: the conversation, the terminal,         │
│ ─────────────────────│    or its details — same instance, the sidebar does not move)            │
│ INSTANCES      12/24 │                                                                          │
│ ▾ Platform         4 │                                                                          │
│   ● general     12%  │                                                                          │
│   ◐ web-dev ▸   82% ◆│  ← active row (highlighted on all three views)                           │
│   ! api-server  38% ◇│  ← needs you                                                             │
│ ▸ Classic          8 │                                                                          │
│ ▾ Other            3 │                                                                          │
│   ○ qa-bot       —  ✦│                                                                          │
│ ─────────────────────│                                                                          │
│ 🔍 Filter…       [×] │                                                                          │
│ ⚑ Status ▾ ⚙ CLI ▾   │  ← status / backend chips; shown "12 / 24 (filtered)"                    │
│ ─────────────────────│                                                                          │
│ ⚙ Settings · ◑ · 文  │                                                                          │
└───────────────────────┴──────────────────────────────────────────────────────────────────────────┘
  Aa = text size (shared)   ◔ = usage (shared)   ⋯ = instance actions (details, start/stop, …)
```

### 2.2 Desktop: Fleet's own tabs (no instance chosen)

```
┌───────────────────────┬──────────────────────────────────────────────────────────────────────────┐
│ (the same sidebar)    │ Fleet   [ Tasks | Schedules | Teams | Org | Cache | Config ]       Aa  ◔ │
│                       │──────────────────────────────────────────────────────────────────────────│
│                       │   (the tab)                                                              │
└───────────────────────┴──────────────────────────────────────────────────────────────────────────┘
```

Clicking an instance in the sidebar from a Fleet tab opens **its Details** (the Fleet side of that instance). The Details header has the same switch (§3.2).

### 2.3 Phone (< 900 px)

```
┌──────────────────────────────────────┐
│ ☰  web-dev  ● working        Aa ◔ ⋯ │
│ ┌──────────┬──────────┬────────────┐ │   ← the switch becomes top tabs under the header
│ │   Chat   │   View   │  Details   │ │
│ └──────────┴──────────┴────────────┘ │
│                                      │
│   (the selected view)                │
│                                      │
├──────────────────────────────────────┤
│ Chat  Needs  Fleet  View  Settings   │   ← bottom tabs as today
└──────────────────────────────────────┘
☰ opens the same sidebar as a drawer: groups, filter, status/CLI chips. A row keeps the current view.
```

## 3. Design

### 3.1 One sidebar component: `InstanceNav`

- **Where it lives:** in `/assets` (`shared/instance-nav.js`), because View is public. The shell renders it on every page. `setSideSection` stays for other uses, but View no longer replaces the list.
- **Data:** the live `appStore.instances` (SSE/poll status frames) for state, dots and needs-you, which is already pushed with no extra polling.
  - View's 5 s `/api/profiles` poll stays only for what View shows elsewhere (avatars and the card). The sidebar no longer depends on it.
  - In view-only mode (anonymous reader, no SSE), the list comes from `/api/profiles` as today.
- **One row, one rule (review r1).** Both lanes, the status frame (SSE and poll) and `/api/profiles`, carry the same identity fields, resolved by **one server function** (`resolveInstanceIdentity`, `view-api.ts`) that both call. Today they differ: the status frame's alias is the config value only, and it has no description. So an alias set on a profile would be lost from search and the tooltip outside View. The canonical row:

  | Field | Source, in priority order |
  |---|---|
  | `name` (status) / `instance_name` (profiles) | the instance's key: `fleet.yaml` `instances`, plus ClassicBot rooms. The client reads either (`nameOf`). |
  | `display_name` | profile DB → `fleet.yaml` `display_name` → ClassicBot room `displayName` → none |
  | `description` | profile DB → `fleet.yaml` `description` → none |
  | `role` | profile DB → none |
  | `tags` | `fleet.yaml` `tags`; a ClassicBot room without its own is `["classic"]`; otherwise `[]` (strings only) |
  | `status`, `backend`, `model`, `model_source`, `effort`, `effort_source`, `context_pct` | as today (the same resolvers in both lanes) |

  The status frame reads the profile DB only when `profiles.db` already exists, so a status read never creates it. This also changes what Chat's header and the shell show as an instance's alias: the profile's alias, as View already shows. That is deliberate: one name per instance on every page.
- **Rows** (one row component, replacing both today):
  - The dot uses the shell's richer `statusClass`.
  - Name, then alias (#1366 identity rules unchanged), the needs-you badge, context %, and the backend icon.
  - The tooltip is the current `instanceTooltip`.
- **Groups and order:** View's model (tag groups, collapse, drag within a group, groups among groups) applied to every page.
  - **One saved order** under `agend_instance_order`. View's `agend_view_sidebar_order` is read once as the starting value, so nobody loses their arrangement.
  - Collapsed groups are remembered per device (`agend_instance_collapsed`).
- **Filter:** the text box (name, alias, model, backend, as today), plus two chip menus:
  - **Status:** working, needs you, idle, stopped/paused, crashed.
  - **CLI:** each backend present.
  - The whole filter (`{ q, status[], cli[] }`) is kept **per device** (`agend_instance_filter`) and **carries across pages**.
  - "/" focuses it and Esc clears it, as on View today. Drag is off while a filter is active, as today.
  - The count reads "12 / 24 (filtered)".
- **Where a row goes:** **the view you are in**, always to a route that exists in that PR (review r1).
  - **N1:** on View it opens View; everywhere else (Chat, the Fleet tabs, Settings, Needs) it opens Chat, as today.
  - **N2** (only once Q4 is decided, and in the same PR that adds the Details route to both route tables and its panel): on Details it opens Details; from a Fleet tab, per Q4.
  - The row's `href` is that path, so a middle-click or a copied link goes to the same place.
- **The active row** is highlighted on all three views, with `aria-current="page"`.
- **Scroll:** the list is never remounted on navigation, and `keepActiveInView` (#1515) nudges only its `scrollTop`. Its scroll position is kept per page load.

### 3.2 The instance view switch

- **In the header,** next to the name and status: a segmented control **Chat | View | Details** (`role="tablist"` on a phone, links on desktop). Each segment is an `<a>` to that view's URL for the **same instance**, so switching keeps the instance and the sidebar.
- **URLs** (shareable; a reload keeps the view):
  - `/ui/chat/:name`, as today;
  - `/view/:name`, as today (public under `view_access: open`);
  - **`/ui/fleet/agent/:name`**, new: the Details view, added to both route tables.
- **The anonymous View reader** (view-only mode) sees no switch. Chat and Details need a session.
- **Phone:** the same three as top tabs under the header (§2.3).

### 3.3 Details: "the Fleet side of one instance"

A new panel at `/ui/fleet/agent/:name` (a `/ui/js` module). What it holds is decision **Q1** (§4). The proposed default, option B:
- **Runtime**, today's `DetailsDialog` moved into a page: backend, model, effort, cost, context, 5h/7d limits, recent activity.
- **Config summary:**
  - working directory, binding (channel, topic or room), tags, description, ClassicBot room if any;
  - "Edit in Settings" opens that agent's `AgentDialog`;
  - nothing is edited on this page.
- **Actions** from the ⋯ menu, carried over with their existing calls and confirmations: start/restart/stop (Chat's ⋯) and pause/wake (Settings' rows). A ClassicBot room keeps Classic's split: pause/wake only, and "Edit in Settings" opens its ClassicBot dialog. Deletion stays where it already lives, in Chat's ⋯ and Settings (scope check, 2026-10-10).

Chat's ⋯ → "Details" goes here instead of the dialog.

### 3.4 One top bar

`InstanceHeader` (`/assets`) is used by Chat, View and Details. `PanelHeader` keeps its slot API, and Fleet tabs and Settings use it with the shared actions.
- **Left:** name · alias, status dot and label, the switch (§3.2). Chat keeps its model/effort chips here.
- **Right, in the same order on every page:**
  - **Aa** text size;
  - **◔** usage, hidden when `/api/ai-usage` is a 404, as today; `UsageDialog` moves to its own `/assets` module;
  - **⋯** instance actions on an instance page;
  - View's help stays View's.
- **Text size, shared per device** (`agend_text_size`, read once from `agend_view_density`): **S / M / L**, decision **Q2**.
  - It sets one CSS custom property on the app root through the CSSOM (#1300: no style attribute).
  - Chat's thread, Details, and Fleet tables read it.
  - View's terminal multiplies its fitted size by it, as `DENSITY` does today. View keeps **Fit** as its own extra choice, since "fit the terminal's width" has no meaning elsewhere.

### 3.5 What does not change

- Bottom tabs on a phone, and Settings' own sections and guard.
- The public link's limits.
- `/assets` keeps its manifest (new files are added there; nothing under `/ui/` becomes public).
- The CSP: no style attributes, no inline handlers.
- Background reads stay passive (#1374). The sidebar adds **no** new poll; its data rides the existing status frames.

## 4. Decisions for the user

Decided by the user on 2026-10-10 ("照建議"): Q1 = B, Q2 = A, Q4 = A. Q3 = A and Q5 were decided earlier.

| # | Question | Options | Decided |
|---|---|---|---|
| Q1 | What does **Details** (the Fleet side of one instance) show? | A: the current details dialog as a page (runtime + recent activity) · B: A + a read-only config summary (directory, binding, tags, description) with "Edit in Settings", + start/stop/pause actions · C: B + the full config editor inline | **B** |
| Q2 | **Text size** steps, shared by Chat, View and Fleet | A: S / M / L everywhere; View also keeps "Fit" · B: View's current three (fit / comfortable / compact) everywhere · C: a slider (90–130 %) | **A** |
| Q3 | **Groups** in the sidebar on every page (View's tag groups, collapse, drag), or a flat list with grouping as an option | A: groups everywhere (View's model) · B: flat by default, "Group by tag" toggle | **A** |
| Q4 | A sidebar click while on a **Fleet tab** (Tasks, Org, …) | A: opens that instance's Details · B: opens Chat (as today) | **A** |
| Q5 | **Status chips**: which states | working · needs you · idle · stopped/paused · crashed (five) | as listed |

## 5. Pull requests

| PR | Scope | Size | Depends on |
|---|---|---|---|
| N1 | `InstanceNav`: one list on every page; the canonical row (§3.1) in the status frame through the shared resolver; groups, View's saved order (same key), filter with status/CLI chips kept per device; rows to View on View, to Chat elsewhere (existing routes only); scroll kept. Tests: one component on Chat, View and Fleet; a Fleet row's href is the existing Chat route; filter carried across pages and reloads; a profile alias that differs from the config, a profile description overriding the config's, and ClassicBot tags, all the same in both lanes and on every page; the anonymous View reader; no new poll | M (1–2 days) | #1515 |
| N2 | The view switch and Details: `/ui/fleet/agent/:name` in both route tables and its panel per Q1, in the same PR; then rows on Details open Details and, per Q4, rows from a Fleet tab; ⋯ → Details; phone top tabs. Tests: the switch keeps the instance; URL round-trip; the anonymous reader sees no switch; Details read-only | M (1–2 days) | N1, Q1, Q4 |
| N3 | `InstanceHeader`: usage and text size on Chat, View, Details and Fleet; shared `agend_text_size` (migrated); Chat/Fleet font scaling via one custom property. Tests: the same controls in the same order on every page; one setting across views and reloads; no style attribute | S–M (1 day) | N1 |

Each PR includes a real-browser sweep (desktop and phone, light and dark) through the whole-app harness, and extends it with "the sidebar is the same component on Chat, View and Fleet" and "the filter survives a page change and a reload".
