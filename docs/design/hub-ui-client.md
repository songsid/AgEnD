# AgEnD Hub P1 — the web UI's client interface (slice 3)

Status: **draft for alignment with slice 0** (`docs/design/hub.md`). Fleet decision 7e5b8a8f; design #3095 and its
addenda. The Hub is experimental and **off by default**; nothing below appears or loads while it is off.

## Where the UI is

| Instance | What the web shows when the Hub is on |
| --- | --- |
| The Hub (`hub` mode) | The shell's brand reads **AgEnD Hub · <name>**. The navigation is **Ask**, **My exposures** and **Administration** (`/ui/hub`, `/ui/hub/exposures`, `/ui/hub/admin`). It has no fleet overview, Needs you or agent list, because the Hub runs no agents. Settings and the session menu stay. |
| A member fleet (`member` mode) | The brand keeps the fleet's own name. Once paired, a **My fleet ↔ Hub** switcher under it opens the Hub's own web in a new tab. The member never proxies Hub sign-in. **Settings → Access & security → Connect to a Hub**: the pairing form and states, then the exposure list. |

## The off switch (server → page)

The app shell's `<body>` carries the mark **only when the Hub is on**:

- `data-hub="member"`: this fleet may connect to a Hub.
- `data-hub="hub"` plus `data-hub-name="<name>"`: this instance is a Hub.

With no mark:
- the shell renders exactly what it does today;
- no Hub module is requested (`hub-client.js`, `hub-switcher.js`, `panel-hub.js`, `settings-hub.js`, `/assets/hub.css`);
- `/ui/hub*` answers 404 (not mounted).

**Interim source of the mark (until S0):** `web.experimental.hub: { mode: member | hub, name?: string }` in
fleet.yaml. S0 replaces it with its own: `agend hub init` for a Hub, and the member's Connect-to-a-Hub switch.
Only the mark is the contract; where it comes from is S0's to decide.

## The client (`src/ui/hub-client.js`)

Every Hub page reads and writes through one object, `hubClient()`. Today it is a stub held in the page's memory. S0
re-points it by replacing the method bodies with requests; the pages don't change. All methods are async.

### Member

| Method | Answer |
| --- | --- |
| `pairing()` | `HubPairing` (below) |
| `connect({ address, code })` | `{ ok: true, pairing }`, or `{ ok: false, error: "address" \| "code" \| "busy" \| "unreachable" \| "refused" }` |
| `cancel()` | withdraws a pending request; answers `HubPairing` |
| `disconnect()` | leaves the Hub; every exposure is withdrawn with it. Answers `HubPairing` |
| `exposures()` | `HubExposure[]`: each of this fleet's agents |
| `setExposed(agent, on)` | `{ ok: true }`, or `{ ok: false, error: "not_paired" \| "unknown_agent" \| "not_enforceable" }`. Withdrawing always succeeds. |
| `subscribe(fn)` | pairing changes (S0: from the status frame); returns an unsubscribe function |

`HubPairing` is one of the following. `address` is HTTPS only:

```
{ state: "unpaired" }
{ state: "pending",     hub: { address }, fingerprint, expiresAt }
{ state: "paired",      hub: { address, name, url, fingerprint } }
{ state: "key_changed", hub: { address, name, url, fingerprint }, offered }
```

- `fingerprint` is the hex the page shows in four groups of four for a person to compare with the Hub's screen (§4 Pair). It is bound to the Hub key, the member key and this pairing attempt.
- `key_changed`: the Hub presented a key other than the pinned one, so nothing connects until it is re-paired. The page shows both fingerprints and offers only **Re-pair** or **Disconnect**.

`HubExposure`:

```
{ agent, display, exposed, enforceable, reason? }
```

- `enforceable`: slice 4's restricted execution can hold this agent (§5). An agent that can't be isolated is shown but can't be switched on.
- `reason` explains why it can't; the stub says `restricted_execution_pending` for every agent.

### Hub mode (placeholders until slices 2, 3 and 5)

- `askable()`: the exposures this person may ask, each with the grant and role that allows it.
- `myExposures()`: what this person publishes, and who may ask it.
- `administration()`: `{ fleets, grants, audit }`.

The panels show their empty states for now.

## Stale tabs (rule 3)

- The Hub modules are lazy, live under `/ui/js/` (behind the session), and import only names every shell has had since #1408: `register`/`t`, `html`/hooks, `appStore`, `Icon`, `Dialog`.
- Their words register themselves (`register("hub", …)`). Their stylesheet is their own (`/assets/hub.css`, linked by the modules).
- A shell from before this change ignores `data-hub`, and a new shell never imports a Hub module while the mark is absent.

## Not in this slice

- Directory sign-in (slice 2).
- Grants and the Ask room (slice 3's server side).
- Restricted execution (slice 4).
- Audit and administration data (slice 5).
- `agend hub init`.

This slice is the UI over the stub, plus the server's mark and its 404.
