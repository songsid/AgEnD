# Web UI reland: roadmap

Design only. Nothing here is implemented, and no feature PR has been opened. Base is main `82017873` (v2.1.11 shipped). For the leader and the user to review before deciding when to slot it in.

## 0. In one paragraph

The parked web stack (C1 → U1 → U2 → U3 → C2 → C3 → C4, 15 commits on top of C1) is in **better shape to reland than its age suggests**. I trial-relanded the whole stack onto `82017873` in a scratch worktree:
- **C1 comes back cleanly** by reverting the revert (#1187). The only conflict is the CHANGELOG.
- **15 commits on top:** 14 apply with no conflict at all, or only in the CHANGELOG. The one real conflict is in `docs/commands.md`, against #1194's menu rewrite.
- **Typecheck:** a single error. C3 and main's #1212 both add `state` to `getUiStatus`.
- **Tests:** all 20 web test files pass (679 tests).

So relanding is mostly review time, not merge work. I recommend:
- **Trio first:** three small security fixes against main, before any web-stack PR.
- **MVP reland:** five PRs (C1, U1, U2, U3, C2+C3).
- **Later:** C4, then everything parked behind open questions (gateway, kanban, agent buttons, live steps).
- **Release line:** keep the web line on its own release line, so it never competes with 2.1.12's bug-fix sprint.

## 1. Where things stand

### Branches

All of these are on origin. Each branch contains the one above it, so a row's "ahead" count includes the rows above it.

| Branch | Head | Ahead of main | Content |
|---|---|---|---|
| `feat/web-unification` | `6c26791a` | 6 | **U1**, on C1. Prism r2 APPROVED `6c26791a`. Same commits as PR #1186. |
| `feat/web-u2-view` | `7552315a` | 9 | **U2**: `/view` writes need a session; `web.view_access`; the `?token=` scrub |
| `feat/web-u3-shell` | `c1ab902b` | 11 | **U3**: shared nav + Session menu, `/` → `/ui`, CSP on every response, no CDN fonts, `/ui/poll` fallback |
| `feat/web-c2-upload` | `37e62608` | 13 | **C2**: files and images both ways (upload → instance inbox; agent reply files shown by id) |
| `feat/web-c3-progress` | `db97e571` | 14 | **C3**: delivery ticks, "working…" line, Stop (`/ui/cancel`) |
| `feat/web-c4-prompts` | `36f7f797` | 15 | **C4**: the fleet's hang / exit / interactive prompts answerable on the web; replies on a web-only fleet |

All of them are based on `988eaf51`, which is C1 merged into main (PR #1184). Main reverted C1 in #1187 (`69febd9c`) when the scope became "2.1.11 is bug-fix only". That revert is why C1 has to be relanded first: everything above it builds on it.

### Open PRs

- **#1186 (U1, one-time-code sign-in, sessions, CSRF):** OPEN, Prism-approved at r2. It is **held only by the scope decision**, not by review: "2.1.11 bug-fix only, the web line moves to the next version". It was never rebased past that point.
- **#1018 (WIP web unification, `web-unification-impl`):** OPEN. This is the original monolith built from design #1014. The track has been landing it phase by phase:
  - P0 landed as #1090;
  - P1a became U1 (#1186);
  - P1b became U2;
  - P2 became U3, re-landed onto C1's chat history in place of #1018's own message log.

  What remains only in #1018 is **P3a (gateway listener) and D5**, which is U4 and waits on the user's D2. After this roadmap, #1018 should be closed as superseded, with a pointer to this document. Its review history stays linked.

### What main changed underneath (17 commits since the fork)

Nothing touched the web files themselves. The overlap is:
- `daemon.ts` (+569 lines, delivery/transcript work);
- `fleet-manager.ts` (+116 lines);
- `topic-commands.ts` (#1194: the Telegram menus now come from the command table);
- `locale.ts`;
- #1212's presentation state in `getUiStatus`.

### Trial reland (scratch worktree, nothing pushed)

| Step | Result |
|---|---|
| C1: revert the revert (`69febd9c`) | CHANGELOG conflict only |
| U1 first commit (P1a) | **`docs/commands.md` conflict** (#1194 menu docs) |
| The other 14 commits | clean, or CHANGELOG-only |
| `tsc -p .` | **1 error**: `getUiStatus` sets `state` twice. C3 added it, and main's #1212 now sets `state: presentationState(…)`. |
| 20 web test files | **679 passed**, exit 0 |

**Adaptation points at reland:**
- **#1212 state:** C3's `state` and its SSE `activity` events should use #1212's presentation state, so "waiting for input" shows too, rather than its own execution state.
- **Command menus:** `docs/commands.md`, plus any Telegram menu entries U1 touches, should go through the command table (#1194).
- **Full suite:** CI runs the full suite on each PR. The trial only ran the web files.

## 2. First: the cherry-pick trio (three small fixes against main)

These are real bugs on today's main. The web stack fixed them in its own new code; on main the old code still has them. **Land these first, before any web-stack PR.** Each is its own small PR and none depends on the web stack.

| # | Bug on main | Where on main | Fix | Size |
|---|---|---|---|---|
| T1 | **Telegram cancel button has no nonce and no user check**: anyone who can see `cancel:<instance>` can interrupt that instance. | `fleet-manager.ts` `handleCancelClick` (~:9776), dispatched at ~:8963 on the bare prefix | Arm the cancel button through `postNonceButtonPromptOrThrow`, or at least require the click to come from the bound adapter, the bound chat, and a fleet admin or the original sender. 🔒 Prism. | S–M (keep the existing button lifecycle) |
| T2 | **Web `message_id` collision**: `web-${Date.now()}` repeats for two sends in the same millisecond, and delivery reports and reconciliation key on message ids. | `web-api.ts:711` | `web-<b36 time>-<8 hex>` (C3's `newWebMessageId`). | XS |
| T3 | **Prototype names pass the instance lookups**: `/ui/stop/constructor`, `/ui/start/…` and `/ui/instances/…/delete` pass `instances[name]`. | `web-api.ts:318, 337, 358, 384` | `Object.hasOwn(instances, name)`, one helper for all four routes. | XS |

T2 and T3 are each a few lines plus a test. T1 needs a Prism review.

## 3. The reland: segments, order, and one PR each

Every segment is one PR off the previous one. Each must be green, reviewed and merged before the next is rebased onto main and opened, as the stack has done all along. 🔒 marks Prism security review.

| # | Segment | What it does | Depends on | Review | Feature flag |
|---|---|---|---|---|---|
| R0 | **C1 reland** (revert #1187) | Chat basics: escape-first Markdown, multi-line composer, `WebChatHistory` + `/ui/history` + SSE `Last-Event-ID` replay, failed-send keeping | main | already reviewed in #1184. Re-review only the revert-of-revert diff and the CHANGELOG. | none needed (UI-compatible) |
| R1 | **U1** (#1186, rebased) | One-time-code sign-in (`agend web` prints a code and opens `/signin`), server-side sessions, CSRF; `?token=` is never a credential | R0 | 🔒 Prism r2 already APPROVED. Re-review the rebase delta: the `docs/commands.md` conflict and fleet-manager context. | **`web.sign_in: code \| token`**, default `code`. `token` keeps today's `?token=` for one release so scripts and bookmarks don't break overnight, with a warning; remove it in the next release. |
| R2 | **U2** | `/view` writes need a session; `web.view_access: open \| session`; every panel scrubs a leftover `?token=` | R1 | 🔒 | `web.view_access`, default `session`; `open` keeps today's behaviour |
| R3 | **U3** | Shared nav + Session menu, `/` → `/ui`, CSP on every response, no CDN fonts, `/ui/poll` fallback | R2 | 🔒 (CSP) | none: CSP only tightens. Verify every panel in a real browser (playwright harness exists). |
| R4 | **C2** | Files and images both ways: ≤10 MB per file, ≤5 files, ≤25 MB per message, type sniffed from bytes, stored only in the instance's inbox; reply files by id | R3 | 🔒 | **`web.uploads: on \| off`**, default `on`. `off` hides 📎 and refuses `/ui/upload`. |
| R5 | **C3** | Delivery ticks, "working…" line, Stop (`/ui/cancel`) | R3 (independent of C2) | normal, plus 🔒 for `/ui/cancel` | none. **Adapt to #1212 presentation state.** |
| R6 | **C4** (C-1 + C-3) | Hang / exit / interactive prompts answerable on the dashboard (same nonce, first answer wins); a web-only fleet gets replies | R5 | 🔒 (a click is a fleet-admin action) | **`web.prompts: on \| off`**, default `on` |

C2 and C3 are independent: either can go first or they can be reviewed in parallel. They are serialized only because each PR is rebased on the merged previous one.

## 4. MVP versus later

**MVP reland, "the web is usable and safe": R0–R5.**
- Sign in without a URL token.
- `/view` behind a session.
- One shell with CSP.
- Chat that survives a reload.
- Files.
- The agent visibly working, with Stop.

This is what the user asked for in the multi-instance web design.

**Later, after the MVP has run for a release:**
- **R6 C4 (dashboard prompts).** Reviewed in design, built. It holds the only new privileged web action, so it gets its own release window.
- **C-2, agent-supplied buttons (`reply` gets `buttons`).** Needs the user's decision on widening the agent protocol across all backends.
- **U4, gateway / tunnel (remote access).** Waits on D2. See §6.
- **T-line kanban (task board).** Design done (`/tmp/t-line-kanban-design.md`); Q1 and Q2 wait on the user.
- **#1218 live step stream.** Spike done (§5).
- **C5** (slash commands via the web, reply/quote, export, notifications). Not designed yet.

## 5. How #1218 (live steps) fits the new shell

The #1218 spike (`feat/1218-live-transcript-spike`) is built on **main's current dashboard**. Its parts move over unchanged:
- **Daemon side, unchanged.** `StepBatcher` hooks the existing `TranscriptMonitor` handlers and sends IPC `instance_steps`.
- **Fleet side, unchanged.** `InstanceStepLog` keeps a ring of 300 per instance, sends SSE `steps`, and serves `GET /ui/steps`. In the new shell `/ui/steps` sits behind U1's session gate like every `/ui` route; nothing to add.
- **Page side.** The **Steps** tab becomes a tab of the U3 shell's instance view, next to Chat and Detail. Its `ingestSteps`, `collapseSteps` and `renderSteps` move as they are, since they already build DOM nodes and never markup.
  - **Polling:** the U3 `/ui/poll` fallback should carry steps too, via a `steps_after` cursor per instance, or the tab freezes when SSE is unavailable. C3 had the same issue with delivery ticks.
- **Per-instance SSE subscription.** Fix 5 in the spike findings is easier in the new shell, which already knows the open instance: `/ui/events?steps=<instance>`.
- **Order.** #1218 production work goes **after R3**, because it needs the shell. Its fixes that don't touch the UI can land on main any time, independently:
  - transcript partial-line loss;
  - ordered source events with outputs;
  - opt-in config.

## 6. Risks and dependencies

- **Token scope (S5).** The web token stays full-fleet, and a signed-in session equals a fleet admin.
  - Fine on loopback: that is today's model, made safer by U1.
  - **Not fine over a tunnel.** No remote exposure (U4) until there is a tiered session: read-only `/view` versus write, plus D5's recent sign-in for privileged actions.
  - Every reland PR keeps S1–S6. No PR may add a power the web token didn't already have, and C4's prompt answers are exactly what a Telegram admin can do.
- **Upload limits.** ≤10 MB per file, ≤5 files, ≤25 MB per message. Eng-approved and enforced server-side (`UPLOAD_LIMITS`), with the type sniffed from bytes. Changing a limit is a config-plus-review decision, not a constant edit.
  - **Inbox growth is already covered.** C2 stores uploads in `workspaces/<inst>/inbox`, which main's `rotateInboxes` already prunes (7-day retention, `fleet-manager.ts` ~:4748). R4 should state this in its PR, and add one test that an upload older than the retention window is removed.
- **Gateway / tunnel (U4, D2 open).**
  - Cloudflare Quick Tunnels don't carry SSE. The U3 poll fallback already covers this, so the MVP is tunnel-ready on that front.
  - The decision is the user's: whether they have a Cloudflare account and domain, and whether a managed quick tunnel is wanted at all. I recommended against building a managed tunnel.
  - Until decided, the web is loopback or LAN only, and the docs say so.
- **Sign-in transition.** U1 makes `?token=` URLs stop working.
  - Mitigation: the `web.sign_in: token` escape hatch for one release, plus a CHANGELOG upgrade note.
  - Users with `agend web` muscle memory get a code instead of a URL.
- **Competing with 2.1.12.** 2.1.12 is a bug-fix sprint with active review load on Prism, dev-claude and muse.
  - The reland is about 7 PRs; 4 of them are 🔒 Prism reviews.
  - **Recommendation: run the web line on its own release line.** Land R0–R5 on main behind the flags, with the defaults above. Ship them in a **2.2.0 beta** rather than a 2.1.12 patch, and keep 2.1.12 bug-fix only.
  - Review cadence: one web PR in review at a time, so Prism is never holding two web reviews against the 2.1.12 queue.
- **Drift while waiting.** Every week of waiting adds conflicts; main is moving fastest in `daemon.ts` and `fleet-manager.ts`.
  - The trial shows it is still cheap today: 1 doc conflict and 1 type error.
  - Re-run the same trial, scripted (revert the revert, cherry-pick 15, tsc, web tests), before each segment. It takes about 2 minutes and tells you whether the next rebase is trivial.

## 7. Suggested schedule

| When | What |
|---|---|
| Now (2.1.12 window) | Trio T2 + T3 (XS, normal review). T1 (🔒 Prism, when a slot is free). |
| Web line opens (2.2.0-beta) | R0 → R1 → R2 → R3, one at a time; each is mostly re-review of an already approved design. |
| Next | R4 (C2) and R5 (C3) in either order; then a 2.2.0-beta with the MVP. |
| After a release of use | R6 (C4); then #1218 production; T-line kanban once Q1/Q2 are answered; U4 only after D2 plus tiered sessions. |

**Effort, roughly.**
- **Trio:** about 1 day in total.
- **R0–R5:** the code already exists. Each PR is a rebase, the adaptation points (#1212 state, the commands.md conflict, the CHANGELOG), the flags and a full CI run: about half a day to a day each, plus review time, which is the real cost.
- **R6:** about half a day.
