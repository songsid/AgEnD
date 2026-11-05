# Hub S3c: the member's exposure store and the owner's publish flow

Card S-55, under M-2401 (#3095). Status: design. The open questions below go to the owners named before code lands.

## Gap

hub.md §4 (l.287) puts "locally approved exposure policy/context mappings" in `hub-member/<hubId>/`. Two readers already exist, but nothing writes these mappings, nothing lets the owner publish them, and nothing sends `exposure.snapshot`:

- **S1 admission** reads `exposure(id): HubExposure | null`.
- **S4 execution** reads `localExposure(id): HubLocalExposure | null`, plus `views`.

S3a's "Connect to a Hub" and My exposures run on a page-memory stub (`src/ui/hub-client.js`).

## What S3c adds (all behind `hub_member.enabled`; off by default)

### 1. The member store (`src/hub/member/exposures.ts`)

**Migration.** `HUB_EXPOSURE_MIGRATION` (`s3c-exposures`, v1) adds tables to the member DB from #3113 (`hub-member/<hubId>/member.sqlite`, 0600, WAL):

- `hub_exposure_meta`: holds the store revision, which is also the snapshot revision. It is an `Epoch` that never rolls back; its floor is `hub-member/<hubId>/floors/s3c-exposures`.
- `hub_exposures`: one row per exposure, holding:
  - the published consent: `id`, `agent`, `providerId`, `consentId`, `generation`, `displayName`, `revision`, `state` (published, withdrawn or frozen), `dataViewId`, `allowedTools`, `policyDigest`;
  - a `staged` candidate (the same fields, at `revision + 1`), or none.

**Writes.** Every write uses the house pattern (check, work, audit in the same transaction, raise the floor, bump the revision; any failure after a write marks the store failed). Audit records go to #3113's `HubAuditStore.append`.

**Readers.** Unchanged signatures:

- **`exposure(id)`** (S1 admission) returns only the committed row. A staged candidate is never visible, so an unpublished question is refused, and a withdrawn row comes back `withdrawn`, so it is fenced (`owns()` requires `published` at the identity's exact revision).
- **`localExposure(id)`** (S4) returns the committed mapping. It returns `null` for withdrawn rows.
- **`stagedLocal(id)`** returns the staged candidate's mapping, for the readiness step only (see question Q1).

**Snapshot.**

- **`snapshot()`** returns `{ revision, exposures }`: every committed row (published, frozen and withdrawn, at most 64 active). Never a partial list, and never staged rows.
- **Limits.** Publishing a 65th active exposure is refused locally.

### 2. The owner's flow (owner-local only)

**Publish or revise**, `POST /api/hub/member/exposures`, with `{ agent, dataViewId, tools, expectedRevision }`:

1. It goes through the existing Settings confirmation: a new `isSettingsMutation` path, a `prepareSettingsEffect` branch, and a fingerprint over agent, view, tools and expected revision.
2. It is refused over the public link. The Hub can never call it: only the local owner's web session or host CLI confirms.
3. On confirm, the server runs the agreed seam:
   - **stage unpublished:** write the candidate at `revision + 1`;
   - **S4 readiness:** `readiness(id, revision + 1)` on the candidate (Q1);
   - **recheck:** the committed revision, the candidate and the view digest are unchanged;
   - **atomic publish:** promote the candidate in one transaction (snapshot revision + 1, audit, raise the floor).
4. Any failure leaves the committed row as it was and drops the candidate. The HTTP answer is `{ ok:false, error:"not_enforceable"|"conflict"|… }`, exactly as the S3a client contract says.

**Withdraw**, `POST /api/hub/member/exposures/<id>/withdraw`, with `{ expectedRevision }`:

- Narrowing needs no confirmation (hub.md: "withdrawal can always narrow immediately").
- The local fence is saved first. The answer is `ok` only once the restrictive state is durable, and it says `remote: "confirmed"|"pending"`.

**Read**, `GET /api/hub/member/exposures`: the S3a `HubExposureView[]` (agent, display, exposureId, revision, state, policy, enforceable, reason). `enforceable` comes from S4 readiness.

### 3. The snapshot to the Hub (through S1)

- **On every (re)connect,** inside `HubClientOptions.reconcile`: `link.send(exposure.snapshot(store.snapshot()))`, before new work, as hub.md l.201 requires.
- **After each publish or withdraw commit,** if the link is ready, it sends the complete newer snapshot. If not, the next reconcile carries it.
- **The member never sends a revision older than one it already sent.** A per-hub "sent" floor in meta enforces this.
- **The Hub mirror (S3b) accepts a snapshot only if `revision >` the last revision it accepted from that member,** and rejects it otherwise as stale (Q3). S3c ships the pure check `acceptExposureSnapshot(last, next)` with its tests, so S3b and the member share one rule.

### 4. The UI

- `hub-client.js` gets a real client on these endpoints. The stub stays only for tests and dev mode.
- **SKEW:** an old tab with the stub, against the new host, must not break; a new tab against an old host gets 404 and is told "not available". Smoke both.

## Questions (to settle before code)

- **Q1 (Cairn, S4 views and policy digest):**
  - **Readiness:** should `readiness(id, rev)` see the candidate through a separate `stagedLocal`, or should readiness accept a candidate `HubLocalExposure` argument? Either way it must not become admissible.
  - **Views:** which `views` map does the member pass to S4, and who owns installing a view, given that `views.ts` only accepts registered `HubDocumentView`s?
- **Q2 (Sol, snapshot frame):**
  - Is a complete snapshot with withdrawn rows included right, or should withdrawn rows be omitted?
  - Is there no ACK frame by design? Then `remote: "confirmed"` means "sent on a ready link" only.
- **Q3 (web-claude, S3b and UI):** S3b's `receive` stale-revision rule (above), the endpoint shapes, and whether S3b already sends something the UI shows.
- **Q4 (dev-claude, S5b composition):**
  - The member factory in #3113's Code PR 2 injects `HubExposureStore` (exposure, localExposure, snapshot) and calls the snapshot sender from `reconcile`.
  - Should S3c stack on #3113, or wait for it to land?

## Tests

- **Publish, revise and withdraw:** revision and snapshot monotonic, audit rows written, floor raised.
- **Unpublished question refused:** a staged candidate is never visible to `exposure()`.
- **Withdrawn exposure fenced:** an in-flight admission turns stale; S4 `localExposure` returns null.
- **Stale snapshot rejected:** `acceptExposureSnapshot`, and the member's sent-floor.
- **Readiness failure** leaves the committed row as it was.
- **Rollback of a newer DB** gives `hub-state-newer`.
- **Endpoints:** refused over the public link; publish needs confirmation; withdraw doesn't.
- **UI client and SKEW smoke.**
