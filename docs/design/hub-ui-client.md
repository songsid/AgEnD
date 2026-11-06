# AgEnD Hub P1: the web UI's client interface (slice 3)

The frozen contract is `docs/design/hub.md` (S0 #3096; fleet decision 7e5b8a8f; design #3095 and its addenda). This note covers only the web UI's side of it. The Hub is experimental and **off by default**; while it's off, nothing below appears or loads.

## Where the UI is

| Workspace | What the web shows |
| --- | --- |
| **A Hub**, served by its own listener and origin (slice 1) | The brand reads **AgEnD Hub · <name>**. Since #3226 B it is a chat app: the sidebar is the person's **conversations** (**New chat**, a filter, one row per room, a waiting question marked; a closed room listed as closed), a room is `/ui/hub?room=<id>` (the fleet chat's own thread and composer, the right-hand panel in the AI usage rail's frame: who the agent answers for, your access, who sees the chat, what is not here), and **My exposures** (`/ui/hub/exposures`) and **Administration** (`/ui/hub/admin`) are in the session row's menu. It has no fleet overview, Needs you or agent list, because the Hub runs no agents; `/ui` opens the chats. |
| **A member fleet** (`hub_member.enabled`) | The brand and pages are the fleet's own. Once paired, a **My fleet ↔ Hub** switcher under the brand opens the Hub's approved `webOrigin` in a new tab: no token or identity in the URL, no opener, no sign-in proxied. **Settings → Access & security → Connect to a Hub** has the form, the pairing states and the agents to share. |

`/ui/hub*` are browser **page** paths. Slice 1's `/hub/v1/*` are its API and wire paths.

## The page's mark (presentation only, never authority)

The listener that serves the page sets the mark; a client can never choose it.

- **On a Hub's own web listener:** `<body data-hub="hub" data-hub-name="…">`, from `serveHubWorkspaceShell` (S3b; `serveAppShell(…, { hubWorkspace })` delegates to it). The name is escaped, one line, at most 60 characters. The page reads nothing of the request (no cookie, session, preference or preview) and leaves out the fleet's fetch wrapper (`agend-auth.js`).
- **On the fleet's own listener:** `data-hub="member"` when `hub_member.enabled` is exactly `true`, and nothing otherwise — never over the public link (member handlers are local-owner-only, hub.md §1). `hub.enabled` makes no mark here.
- **The fleet's listener never mounts the Hub's pages.** It answers `/ui/hub*` with the ordinary not-found.
- **Guests:** a guest's page never carries a mark.
- **No mark:** no Hub module is requested (`hub-client.js`, `hub-strings.js`, `hub-switcher.js`, `panel-hub.js`, `settings-hub.js`, `/assets/hub.css`).

Until slice 1's `HubMode` exists, `src/hub-mode.ts` reads `hub_member.enabled` directly. Slice 1 replaces it with `HubMode.memberEnabled()`, which also requires a valid initialization. There's no alias and no third switch.

## The client (`src/ui/hub-client.js`): UI projections, not wire records

Every Hub page reads and writes through one object, `hubClient()`. Its answers are **projections** (`HubPairingView`, `HubExposureView`), deliberately separate from `hub.md`'s signed protocol and model records. The browser never holds the machine credential or sees WSS frames.

- **On a Hub workspace** (S3b) it is `createHubWebClient()`: `/hub/v1/*` at the page's own origin, with the Hub's own session (below).
- **On a member fleet's Settings card** it is `createMemberClient()` (S3c, #3115/#3146): this fleet's own `/api/hub/member/*`, local owner only and never over the public link. Publishing goes through the existing Settings confirmation, then the order agreed with S1/S4/S5: stage the candidate unpublished, check readiness, re-check owner, mode and the exact descriptor, then publish only that unchanged revision in S1's snapshot. Since #3145 that readiness is the representative agent's, not S4's (below).
- **In tests** it is `createStubClient()`, held in the page's memory, with its `control` object.

### `HubPairingView`

| state | fields | what the page shows |
| --- | --- | --- |
| `unpaired` | | the form: Hub address (https://) and one-time code |
| `pending` | `memberOrigin`, `fingerprint` (kind `pairing`), `expiresAt`, `localConfirmed`, `ownerConfirmed`, `adminApproved` | the pairing fingerprint to compare; "It matches the Hub's screen" until confirmed here; then what is still needed on the Hub |
| `paired` | `hub: { hubId, name, memberOrigin, webOrigin, fingerprint (kind hub-key) }`, `link: online \| offline` | the approved Hub key's fingerprint, Open the Hub, Disconnect, and the agents to share |
| `key_changed` | `hub` (the approved one) and `offered` (kind `hub-key`) | both keys, labelled, never compared with a pairing fingerprint; only Pair again or Disconnect; the offered key is never accepted automatically and nothing connects |
| `held` | `hold`, `memberOrigin?` | a visible safety hold, never shown as paired or as a successful unpair |

Notes on the fields:
- **Confirmations (`pending`):** the owner's comes from a current Hub directory session (the Hub's My exposures), and the administrator approves the exact fingerprint (the Hub's Administration). Possession of the code alone proves neither.
  - **On the member they are unknown:** `ownerConfirmed` and `adminApproved` are `null`. S1 keeps neither, and a claim answer of "pending" doesn't say which is missing. They are never derived from the local Settings approval, `pending.json` or a claim answer. The card then shows both steps as instructions with no done/waiting marks, and says it can't see their progress. `true`/`false` is reserved for a trusted Hub status projection, which P1 doesn't have (agreed with S1 on cid-hub-member-pairing-projection).
  - **`localConfirmed`** is this fleet's own step. The owner compares the fingerprint and confirms it here (`confirmFingerprint(digest)`, through the Settings confirmation), which lets the member claim. It is never the Hub owner's confirmation.
- **Origins (`paired`):** `memberOrigin` is the pinned transport origin and `webOrigin` the separately approved browser origin. They may differ. The switcher uses only a paired `https:` `webOrigin` without credentials, and never one offered after a key change.
- **Holds:** the codes are `unknown_outcome`, `expired`, `unsaved`, `refused`, `revoked` and `disconnected` (after a local disconnect: "Start over" goes back to `unpaired` for a new code; the old pairing never reconnects automatically). `unavailable` is not a hold: an older host answers 404 and the card shows one line, "Not available on this AgEnD version".
- **`key_changed`** is never shown on a member in P1: S1 can't tell a changed key from a failed connection. The card keeps the state for a future trusted projection.

**Fingerprints:** `{ kind: "pairing" | "hub-key", digest }`.
- The digest is the full SHA-256 (64 hex). The page shows its first 128 bits (32 hex, 8 groups of 4) for comparison, and the whole digest on request.
- A `pairing` fingerprint binds the whole pairing transcript of that attempt (hub.md §2 step 4). It is never computed in the browser and never derived from the address and code; the stub's values are placeholders.

**Address and code checks** in the browser are for the person only (an `https://` origin; a code of the shape people type, with no fixed length). Parsing and canonicalization are the server's.

### `HubExposureView`

```
{ agent, display, exposureId, revision, state: "published" | "withdrawn" | "frozen", policy: { dataView, tools } | null,
  enforceable, reason?, choices: { dataViews: { id, label }[], tools: { name, label }[] }, pending: { expiresAt } | null }
```

P1 shares a **representative agent** (decision f619f813, [hub-representative-agent.md](hub-representative-agent.md)). The owner picks one of this fleet's existing agents, and the Hub's questions reach that agent's ordinary conversation through normal delivery. It keeps its own login, folder and Settings tool set, and all its askers share that one conversation. There is no restricted, read-only context and no per-asker session in P1; a narrower tool set (worker/minimal) is chosen in ordinary Settings.

- **`agent`:** the stable local agent name. The list is the local owner's own agents, never the Hub's inventory.
- **`revision`:** the revision the page shows. Enabling sends it (`setExposed(agent, on, expectedRevision, choice)`), so a stale tab gets `conflict`, never a silent widening.
- **`policy`:** what is shared. For a representative agent it is always `{ dataView: "agent", tools: [] }`. The wire descriptor is `dataViewId: "agent"`, `allowedTools: []` and `policyDigest = sha256(canonicalArguments({ mode: "agent", agent }))`. The empty list means no Hub-delegated tool phases; the agent's own Settings tools are unchanged.
- **`choices`:** what the owner may pick. For a shareable agent it is `{ dataViews: [{ id: "agent", label }], tools: [] }`, and the card sends it as the `choice`. Otherwise both lists are empty.
- **`enforceable`:** whether the representative is ready (the configured target accepts normal delivery and the descriptor matches), never a model's claim. False is never publishable. `reason` says why: `delivery_unavailable`, or `republish_required` for a mapping from the older restricted mode, which answers nothing until the owner shares the agent again (never converted silently).
- **`pending`:** a publish waiting for the owner's Settings confirmation. The row says so and the switch stays off until it is answered or expires.

### Results

```
connect, confirmFingerprint → { ok: true, pairing, pendingConfirmation? } | { ok: false, error: "address" | "code" | "busy" | "unreachable" | "refused" | "conflict" | "expired" | "unsaved" | "unavailable" }
setExposed(on, choice) → { ok: true, view } | { ok: true, pending: { expiresAt }, view, settled }
                        | { ok: false, error: "not_paired" | "unknown_agent" | "unknown_view" | "not_enforceable" | "limit" | "conflict" | "unsaved" | "unavailable" }
setExposed(off)        → { ok: true, remote: "pending" } | { ok: false, error: "unsaved" | "conflict" | "unavailable" }
disconnect(shown)      → { ok: true, remote: "pending", pendingConfirmation? } | { ok: false, error: "unsaved" | "conflict" }
cancel()               → HubPairingView (local only: back to unpaired)
```

- **Withdrawal and disconnect** fence locally at once, even offline. They answer `ok` only once the local restrictive state is saved. `remote` is always `"pending"` in P1: S1 has no acknowledgement frame and no remote revoke, so the Hub learns of a withdrawal from the next snapshot, and of a disconnect only when its administrator revokes the fleet. The card shows "pending" as a warning. `"confirmed"` is reserved for a future S1 acknowledgement.
- **`disconnect(shown)`** names exactly the pairing the page showed (its hub and binding). The server refuses any other (`conflict`), such as a replacement or a re-pair.
- **`subscribe(fn)`:** the member's local status, read every 5 s while the card is shown (one request at a time, none while the page is hidden), stopping with the last listener. There is no direct connection from the page.
## The Hub workspace (S3b): `/hub/v1/*` and its session

`src/hub/http/compose.ts` `createHubHttp(deps)` (S5's lazy entry: it exports `createHubHttp` and `migrations`) serves the Hub web listener: `/hub/v1/*`, the Hub-only pages (`/`, `/web`, `/ui`, `/ui/hub*`), the Hub modules under `/ui/js/` (`HUB_UI_MODULES`: `panel-hub.js`, `hub-client.js`, `hub-strings.js`, and since #3226 B `hub-chat-store.js`, `hub-chat-strings.js`, `hub-quota.js`) and the public `/assets/` (the shared chat modules among them). Anything else is S5's not-found.

- **Session:** directory sign-in (S2 `signIn`) → cookie `__Host-agend_hub_<hubId>` (Secure, HttpOnly, SameSite=Strict, Path=/). Only that exact name is read; a fleet cookie, bearer token or member credential is never a Hub person. 8 h absolute, 1 h idle.
- **Mutations:** `Origin` = the Hub's `webOrigin` (and `Sec-Fetch-Site` same-origin when sent) plus `X-AgEnD-Hub-CSRF`, a value derived from the session token that only a same-origin read of `GET /hub/v1/session` learns.
- **Fresh checks:** each protected request re-reads the session and calls the directory (`checkEligibility`) for the person — and, for a room, the exposure's owner too. Bounded per person and in all; over the bound is 429 with `Retry-After`, never a cached allow. An ineligible person's sessions end.
- **Administration** is the configured administrator's current directory identity. Local-host repair sign-in stays reserved (refused in P1).

| Route | Methods | Who |
| --- | --- | --- |
| `/hub/v1/session` | GET, POST (sign in), DELETE | anyone / the session |
| `/hub/v1/exposures`, `/hub/v1/grants` | GET (own exposures with their grants; what is granted to me now) | a person |
| `/hub/v1/grants` · `/hub/v1/grants/:id?revision=` | POST · DELETE | the exposure's owner, at the revision shown |
| `/hub/v1/exposures/:id/freeze` | POST | the owner (narrowing only) |
| `/hub/v1/rooms` · `/hub/v1/rooms/:id/messages` | GET, POST · GET (`after`, paced), POST (`idempotencyKey`, `text`) | the room's asker only |
| `/hub/v1/pairings` · `/hub/v1/pairings/:id/confirm` | GET · POST (fingerprint) | the prospective owner |
| `/hub/v1/audit` | GET | S5's sink decides (owner/auditor) |
| `/hub/v1/admin/overview`, `/admin/pairings`, `/admin/pairings/:id/approve`, `/admin/fleets/:id/revoke`, `/admin/exposures/:id/freeze` | GET, POST | the administrator |

Server rules (hub.md §2, §4, §5; S1/S4 seams):
- **Catalog:** exposure rows mirror each member's complete, monotonic snapshots. An older one is refused, a changed repeat of the same revision conflicts, and absence withdraws only on a newer accepted one. Leaving "published" ends that exposure's grants and rooms (consent never revives from history). The Hub never asks S4 and never infers enforceable from a row.
- **Grants** bind one known person to one exact exposure id and revision. **Rooms** are keyed by asker, exposure and grant.
- **Asking** commits the question (an S5 content ref, never plaintext in S3's tables) with its audit before "queued". It is sent on the member's current, reconciled link with a freshly signed 120-second envelope.
- **Leases** (admit, begin, tool, release-answer) are server records for one exact operation digest on the current link epoch, for at most 5 s, re-resolved from the persisted message and both people's eligibility now. An answer is accepted only under its own unspent release lease.
- **Receipts** are monotonic and never downgrade evidence; reconcile pages through the retained ones.

**Hub-only boot** (`app.js`): a page marked `hub` starts no fleet stream, chat, Needs you, notices, preferences upload, themes, owner CSS or search. Its sidebar's session row is the Hub's own, and it has no bottom tabs, usage rail or fleet lines. Room polls: one per 10 s, one in flight, paused while hidden.

## Stale tabs (rule 3)

- **Lazy modules only:** the Hub modules are lazy, under `/ui/js/` (behind the fleet's session on a member fleet; the Hub listener serves its three). They import only names every shell has had since #1408 (`register`/`t`, `html`/hooks, `appStore`, `Icon`, `Empty`, `PanelHeader`/`setTitle`, `confirmDialog`).
- **Own words and stylesheet:** the words are their own (`hub-strings.js`, `register("hub", …)`), and so is the stylesheet (`/assets/hub.css`, linked by the modules).
- **The shell's part:** the Hub sidebar (`hubShell.*` words) and two lazy slots, all drawn only under a mark.
- **Old shells:** a shell from before this change ignores `data-hub`.

## Elsewhere

- S5 composition: registering this entry, the Hub web listener, DB, audit and content store (S5b). The representative adapter: delivery, the `beforeInput` hand-off and the `report_result` answer bridge (#3147).
- The member side of the Settings card: pairing and the representative picker (S3c, #3115/#3146).
- Owner notifications (S5). The isolated S4 context and container provider stay off and uncomposed in P1 (#3145).
