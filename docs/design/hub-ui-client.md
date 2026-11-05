# AgEnD Hub P1: the web UI's client interface (slice 3)

The frozen contract is `docs/design/hub.md` (S0 #3096; fleet decision 7e5b8a8f; design #3095 and its addenda). This note covers only the web UI's side of it. The Hub is experimental and **off by default**; while it's off, nothing below appears or loads.

## Where the UI is

| Workspace | What the web shows |
| --- | --- |
| **A Hub**, served by its own listener and origin (slice 1) | The brand reads **AgEnD Hub · <name>**. The navigation is **Ask** (`/ui/hub`), **My exposures** (`/ui/hub/exposures`) and **Administration** (`/ui/hub/admin`). It has no fleet overview, Needs you or agent list, because the Hub runs no agents; `/ui` opens Ask. |
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
- **On a member fleet's Settings card** it is still a stub in the page's memory (the card says so in a preview note) until S5's member composition exists; re-pointing it replaces `createStubClient`, including its `control` object. The member's publish step then follows the order agreed with S1/S4 (cid-hub-s3-readiness): stage the owner-approved candidate unpublished, ask S4 `readiness(exposureId, expectedRevision)`, re-check owner, mode and the exact local policy, then publish only that unchanged revision in S1's snapshot.

### `HubPairingView`

| state | fields | what the page shows |
| --- | --- | --- |
| `unpaired` | | the form: Hub address (https://) and one-time code |
| `pending` | `memberOrigin`, `fingerprint` (kind `pairing`), `expiresAt`, `ownerConfirmed`, `adminApproved` | the pairing fingerprint to compare, and both confirmations, each marked as done |
| `paired` | `hub: { hubId, name, memberOrigin, webOrigin, fingerprint (kind hub-key) }`, `link: online \| offline` | the approved Hub key's fingerprint, Open the Hub, Disconnect, and the agents to share |
| `key_changed` | `hub` (the approved one) and `offered` (kind `hub-key`) | both keys, labelled, never compared with a pairing fingerprint; only Pair again or Disconnect; the offered key is never accepted automatically and nothing connects |
| `held` | `hold`, `memberOrigin?` | a visible safety hold, never shown as paired or as a successful unpair |

Notes on the fields:
- **Confirmations (`pending`):** the owner's comes from a current Hub directory session, and the administrator approves the exact fingerprint. Possession of the code alone proves neither.
- **Origins (`paired`):** `memberOrigin` is the pinned transport origin and `webOrigin` the separately approved browser origin. They may differ. The switcher uses only a paired `https:` `webOrigin` without credentials, and never one offered after a key change.
- **Holds:** the codes are `unknown_outcome`, `expired`, `unsaved`, `refused` and `revoked`.

**Fingerprints:** `{ kind: "pairing" | "hub-key", digest }`.
- The digest is the full SHA-256 (64 hex). The page shows its first 128 bits (32 hex, 8 groups of 4) for comparison, and the whole digest on request.
- A `pairing` fingerprint binds the whole pairing transcript of that attempt (hub.md §2 step 4). It is never computed in the browser and never derived from the address and code; the stub's values are placeholders.

**Address and code checks** in the browser are for the person only (an `https://` origin; a code of the shape people type, with no fixed length). Parsing and canonicalization are the server's.

### `HubExposureView`

```
{ agent, display, exposureId, revision, state: "published" | "withdrawn" | "frozen", policy: { dataView, tools } | null, enforceable, reason? }
```

- **`agent`:** the stable local agent name. The list is the local owner's own agents, never the Hub's inventory.
- **`revision`:** the revision the page shows. Enabling sends it (`setExposed(agent, on, expectedRevision)`), so a stale tab gets `conflict`, never a silent widening.
- **`policy`:** summarises the approved data view and tools.
- **`enforceable`:** slice 4's restricted-context result, not a model's claim. It is false until slice 4 exists, and then the agent can't be shared. True never means the owner's normal session is exposed.

### Results

```
connect   → { ok: true, pairing } | { ok: false, error: "address" | "code" | "busy" | "unreachable" | "refused" }
setExposed(on)  → { ok: true, view } | { ok: false, error: "not_paired" | "unknown_agent" | "not_enforceable" | "conflict" | "unsaved" }
setExposed(off), disconnect → { ok: true, remote: "confirmed" | "pending" } | { ok: false, error: "unsaved" | "conflict" }
```

- **Withdrawal and disconnect** fence locally at once, even offline. They answer `ok` only once the local restrictive state is saved. If the Hub's acknowledgement is unknown, `remote: "pending"` is shown as a warning.
- **`subscribe(fn)`:** the local status projection's changes, through slice 1's member status; no direct connection from the page.
## The Hub workspace (S3b): `/hub/v1/*` and its session

`src/hub/http/compose.ts` `createHubHttp(deps)` (S5's lazy entry: it exports `createHubHttp` and `migrations`) serves the Hub web listener: `/hub/v1/*`, the Hub-only pages (`/`, `/web`, `/ui`, `/ui/hub*`), the three Hub modules under `/ui/js/` and the public `/assets/`. Anything else is S5's not-found.

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

## Not in this slice

- S5 composition (`createServer` registering this entry, the Hub web listener, DB, audit and content store) — S5b.
- The member side of the Settings card (pairing through S1's client, publishing through S4 readiness) — after S5's member composition.
- Restricted execution (slice 4) and owner notifications (S5).
