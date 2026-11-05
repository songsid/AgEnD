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

- **On a Hub's own listener (slice 1):** `<body data-hub="hub" data-hub-name="…">`. It passes `serveAppShell(…, { hubWorkspace: { name } })`. The name is escaped, one line, at most 60 characters.
- **On the fleet's own listener:** `data-hub="member"` when `hub_member.enabled` is exactly `true`, and nothing otherwise. `hub.enabled` makes no mark here.
- **The fleet's listener never mounts the Hub's pages.** It answers `/ui/hub*` with the ordinary not-found.
- **Guests:** a guest's page never carries a mark.
- **No mark:** no Hub module is requested (`hub-client.js`, `hub-strings.js`, `hub-switcher.js`, `panel-hub.js`, `settings-hub.js`, `/assets/hub.css`).

Until slice 1's `HubMode` exists, `src/hub-mode.ts` reads `hub_member.enabled` directly. Slice 1 replaces it with `HubMode.memberEnabled()`, which also requires a valid initialization. There's no alias and no third switch.

## The client (`src/ui/hub-client.js`): UI projections, not wire records

Every Hub page reads and writes through one object, `hubClient()`. Its answers are **projections** (`HubPairingView`, `HubExposureView`), deliberately separate from `hub.md`'s signed protocol and model records. The real client reads the member's local status through authenticated member APIs. The browser never holds the machine credential or sees WSS frames, and the server re-checks membership, config and session after every body read and every await; the public gateway and guests can't reach member management. Today the client is a stub in the page's memory (its pages say so in a preview note), and re-pointing it replaces `createStubClient`, including its `control` object.

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
- **Hub workspace placeholders** until slices 2, 3 and 5: `askable()`, `myExposures()`, `administration()`. Room polls (S3 server side) are bounded by hub.md: one per 10 s, one in flight, stopped while hidden.

## Stale tabs (rule 3)

- **Lazy modules only:** the Hub modules are lazy, under `/ui/js/` (behind the session). They import only names every shell has had since #1408 (`register`/`t`, `html`/hooks, `appStore`, `Icon`, `Empty`, `PanelHeader`/`setTitle`, `confirmDialog`).
- **Own words and stylesheet:** the words are their own (`hub-strings.js`, `register("hub", …)`), and so is the stylesheet (`/assets/hub.css`, linked by the modules).
- **The shell's part:** the Hub sidebar (`hubShell.*` words) and two lazy slots, all drawn only under a mark.
- **Old shells:** a shell from before this change ignores `data-hub`.

## Not in this slice

- Slice 1's Hub listener, origin and cookies (`__Host-agend_hub_<hubId>`).
- Directory sign-in (slice 2).
- Grants, rooms and the Ask room's server side (S3 integration).
- Restricted execution (slice 4).
- Audit, administration and `agend hub init` (slice 5).
- No live API routes before their service and audit composition exist.
