# Hub member-address operation (#3429 backend)

繁中摘要：主機擁有者可準備 Hub 傳輸位址變更，確認前取得受影響 Fleet 清單。提交會保留 Hub ID、issuer 及 TLS 金鑰，必要時重發符合新主機名稱的憑證，撤銷舊連接憑證，並留下給各擁有者、Hub 管理員及主機的持久通知。UI 暫緩；後續統一使用「重新連接」，使用者只需要看到瀏覽器的「Hub 位址」。

## Scope and vocabulary

Read #3658 at `94abbb6e71a203a890eba761d37ba9c4e698963a`, §§4 Phase A/recovery/wording and A.6, before defining projections. Public action names use Connect / 連接, Remove connection / 移除連接, Revoke / 撤銷 on the Hub, and Reconnect / 重新連接. Technical member origin belongs to host-only configuration/advanced diagnostics. No UI controls or new click sequence are built here; the owner has not yet approved the whole UX proposal.

#3615 provides existing exact-binding Disconnect and recovery guidance, not an atomic reconnect API. #3644 permits a new company Start after a definitely unissued expiry, while unknown issuance remains blocking. This backend will not clear TOFU, silently follow a changed identity, delete an ambiguous company journal, re-publish withdrawn Agents, invent a prior Fleet label or infer that two Fleet rows belong to the same computer. The report's old-row supersession would require a separate proof/quota change; it is not implied by this address operation. Existing explicit local identity repair and fresh company sign-in remain the recovery authority.

## Prepared change and one decision

Consume D3's exact host launch session, owner object/authority epoch and current continuation. Accept a bare HTTPS member origin distinct from the web origin, with an explicit non-wildcard listener. Probe changed candidate endpoints without binding the running web listener or preview. Capture the full sealed image, identity material, member-address head and transport state. Return the affected active credential-bearing Fleet IDs, owners and available labels before the one confirmation; no fresh directory fan-out or synthesized people.

Keep the issuer files, Hub ID and TLS private key/SPKI unchanged. Version only the member certificate: legacy identity v1 selects its fixed certificate; identity v2 atomically selects an operation-owned immutable certificate plus its new origin. Every reader uses one validated snapshot. A port-only move may retain certificate bytes; a new hostname requires a matching SAN certificate using the existing private key.

The shared sealed-settings writer owns a distinct member-address operation/journal. Stage exact private material, selected identity metadata, next config, signed manifest and receipt and flush ancestor entries. The single root SQL decision uses one transport mutation to revoke old active credentials, increment generations/global revocation version, retire old pairing codes/claims and incompatible company browser flows, and retain the operation, complete notice recipients and required audit. Existing transport floor semantics remain fail-closed: an advanced independent floor without the SQL decision is uncertainty, never a reason to reset the floor or reopen old credentials.

An independent member-address head fences old mounted pair/claim/connect/browser continuations before files/remount. Unchanged Hub web sessions can read their notices after remount; session continuity confers no enrollment permission. Issued/acknowledged company delivery retains the same original ≤10-minute protection as #3428.

## Completion and recovery

Install the atomic identity selector, manifest and configuration only against the captured before/after images. Cold recovery may read the internally coherent selected identity without imposing the temporarily old config origin, but must match its hashes to the exact SQL operation before writing. Normal mount still requires exact configured origin, selected certificate/key/SAN, issuer/Hub ID and the derived member-address marker. Third images, missing/newer decisions, changed key/material or a raised unmatched transport floor refuse without overwriting.

After the decision, failure is saved-but-unavailable, never a restore of old credentials or a reopened old endpoint. Rollback is a new forward operation to the previous address, with fresh generations/revocations; never an old DB/floor restore. Cleanup durably removes the journal before its staging inputs.

## Notices and future reconnect

Persist one bounded operation notice with exact owner/admin/host recipients in the same transaction as revocation. The unchanged Hub web origin is the reliable read/ACK surface; old revoked sockets cannot guarantee delivery. Reads do not ACK; pagination reaches retained history, ACK checks exact recipient independent of the current page, and owner projections contain only their affected Fleets. Notifications do not grant enrollment or supply a credential.

Expose `reconnect` as the future recovery action, carrying only the already-known browser-facing Hub origin, plus an exact operation/Fleet identity. The future held UI may combine existing local actions, but it must preserve old trust, use fresh company identity/policy/quota checks, and stop if identity differs. No unsigned relocation or automatic trust reset is added. Until the UX/core recovery design is approved, existing explicit local repair remains available and is rehearsed as such; this backend makes no one-button UI acceptance claim.

## Backend contract and retained boundaries

D3 routes are `/api/settings/hub/member-address`, `/prepare`, `/commit`, plus host notice history/ACK. Input is only `{origin, listen:{host,port}}`; the server reissues the SAN with the retained TLS key when necessary. Prepared references are single use, five minutes, and bind the original host session object/epoch, exact full sealed image and transport snapshot. Preparation lists every affected active credential-bearing Fleet with immutable owner/generation. The final probe and exact transaction repeat those checks; a changed list requires preparing again.

The required `s5-member-address` component stores an independent head, immutable operations, notices and original recipient rows. Notice history is 100 rows per page with an older cursor, within a 1024-operation retention bound; no unread notice is evicted to admit another change. Exact recipient ACK does not depend on the newest page. Original owners and the configured admin at the change receive person targets; the host receives its own target. Sessions freshly recheck immutable eligibility and current session/mount after await; current group permission is not required to read an original security notice. The browser endpoints are `/hub/v1/security-notices/member-address` and `/<id>/ack`, advertised only when composed. The UI remains held and does not yet render this new notice kind.

The v2 identity metadata selects only `hub/member-address/<operation UUID>/cert.pem`; no arbitrary path or private-key selection is accepted. Fixed TLS and issuer keys never move. Normal mounts always require the configured member origin. Only the private existing-state recovery adapter may read a coherent stored origin while config/identity are different halves of a committed operation, and the writer then compares all exact before/after hashes to the authoritative SQL decision. It never creates/migrates state or treats an advanced floor as an absent decision.

Eleven injected crash steps cover certificate/material/journal, SQL decision, identity selector, manifest, config, receipt and both cleanup boundaries. A valid same-key replacement certificate is still refused if its bytes differ from the committed stage. A later rename remains supported. A forward change back to the old origin advances the operation/version again and never restores revoked credentials. A partially restored old SQL head cannot mount newer sealed files.

The container recipe `scripts/manual/hub-member-address/run.sh` uses a real initialized Hub, verified synthetic LDAPS and a second FleetManager/member runtime, with an empty Agent inventory. It exercises legacy manual pairing, the affected-list preview, actual-browser D3 commit, old-endpoint/old-credential refusal, unchanged browser login, one retained owner notice, exact local Disconnect/Start over, and fresh browser company sign-in under a real group permit. The original revoked Fleet row remains; no automatic row supersession or republishing occurs. Fixture network seams are explicit per-client browser CA/hostname mapping and an exact loopback :636 mapping to the owned ephemeral LDAP peer. No real AD, pilot, native platform, CLI/model, new reconnect UI, or existing-company trust-repair journey is claimed.

Provisional held-UI zh-TW copy: 「Hub 成員連線位址」; 「變更後，下列 Fleet 需要重新連接。」; 「確認變更」; notice 「Hub 的連線位址已變更，請重新連接。」; recovery action 「重新連接」. Normal people keep the browser-facing 「Hub 位址」; transport fields remain host/advanced information. These are review notes, not shipped new controls.


## Online members follow (option B; user decision 11-13) — design r2, before code

The user chose B: members **online** at the change follow an issuer-signed relocation sent over their current link; members offline then use the reconnect path above (with the issuer-signed descriptor repair). Never an unsigned relocation. Only `memberOrigin` moves: Hub ID, issuer key, member TLS key/SPKI and the credential of every member that followed stay as they are. r2 takes in Prism's review 5891171217 and Ridge's review (PR comment 6853367763): D1 (pending ≠ confirmed) and D2 (the company pin moves only on a confirmed relocation).

### Hub: reservation, statement, acknowledgement

- **Reservation.** On commit, before any send, one IMMEDIATE transaction reserves the next **relocation sequence** in a new table of the required `s5-member-address` component (registered; it refuses exhaustion). The reservation binds the immutable attempt id, the base member-address head, `from`, `to`, the SPKI and the signed statement's digest.
  - **Per-Fleet statements:** the signature and digest differ per Fleet (they bind `fleetId`), so the reservation keeps one row per affected Fleet `{sequence, fleetId, digest, exact statement bytes}`. Recovery and ack matching use these rows, never a re-signature.
  - Aborts burn the number.
  - The reservation does **not** advance the committed member-address head, so the running listener isn't fenced before the acks are in.
  - The final operation/journal references the reservation, and recovery reuses its exact bytes and sequence: it never re-signs another target at that sequence.
- **Statement.** Server frame `relocate` (capability `member-relocation-v1`, with `welcome-caps-v1`), payload `{v:1, from, to, spkiSha256, revision, signature}`. The signature is Ed25519 by the **issuer key** over `["agend-hub-member-origin-v1", v, hubId, issuerKeyId, fleetId, from, to, spkiSha256, revision]`, with `revision` = the reserved sequence and `fleetId` the link's authenticated Fleet.
- **Ack.** Member frame `relocate.ack {revision, digest}`, sent only after the member's write is durable (see below). The Hub accepts an ack only when it matches a pending server entry binding all of: the attempt/sequence, the statement digest, the authenticated Fleet, the link object and epoch, the starting generation, the current credential binding and the owner. Late, foreign, duplicate or stale acks are ignored. No browser-supplied kept list is ever accepted.
- **One bounded window.** The sends fan out concurrently, and every ack wait shares **one** deadline (5 s) for the whole attempt, never N × 5 s. After the window, and before the synchronous commit, the Hub rechecks the D3 session/authority/epoch, the material, the affected rows and the bind/certificate probe. Nothing is awaited inside the SQL transaction.

### Hub: the decision (one change to #3660's)

- Inside #3660's single SQL transaction, also after the required audit callbacks, each acked Fleet's proof is rechecked against the current rows. A Fleet still active, with the same generation and credential binding, is **kept**: no revoke, no generation bump, no notice. Every other affected Fleet is revoked and notified as #3660 does (notices go to the revoked set only; the host/admin security accounting is unchanged).
- The **immutable kept and revoked sets** and the reservation reference are persisted in the operation, stage and receipt. Recovery never consults a live link map.
- The present `stateFleets().length === 0` assertion becomes an **exact kept-row image** check.
- Unchanged: the global revocation-version advance, the old member-head mount fence, pairing offer/claim retirement, the original issued/ACKed company-delivery protection and the policy/group holds. Ack auditing must not advance the prepared transport revision (that would make every acked commit stale). Any unrelated snapshot change still means preparing again.

### Member: state (the security surface)

`hub-member/<hubId>/member-origin.json`, beside pairing.json (which stays byte-identical, since its digest is an identity key):

```
{ v: 1, profile: <pairing.json digest>, highWater: n,
  confirmed: [ { statement, digest } ],         // the chain of relocations proven by a welcome at their `to` (≤ 8, oldest first)
  pending:   { statement, digest } | null }     // a received, acked relocation not yet proven
```

- **Anchor** = the last confirmed `to`, else the profile's member origin. The confirmed chain is contiguous: each hop's `from` is the previous hop's `to`, and the first hop's `from` is the profile's. A chain that breaks fails closed. A ninth confirmed hop is refused (it stays pending and is still dialled first; Reconnect re-pairs from scratch), because the chain must start at the profile's own address. It's the identity every consumer uses: the dial fallback, `pinnedHubAgent`'s origin check, the company-join anchor, and #3797's web-origin binding.
- **Absent file:** legacy, the profile's address. **A corrupt or partial file, or one bound to another profile digest:** fail closed (the link holds "key-changed"; recovery is Reconnect), never silently legacy.
- **Accepting a statement** requires all of:
  - it verifies against the issuer key pinned at pairing;
  - `hubId` and `fleetId` are the member's own;
  - `spkiSha256` equals the pinned SPKI;
  - `from` equals the **anchor** (not a pending `to`), so A→B pending, aborted, then A→C is accepted;
  - `to` is validated like a join and differs from the web address and from `from`;
  - `revision > highWater`.

  The same revision with the same digest as the pending one, **or as a statement already in the confirmed chain** (a lost ack, a reconnect), is an identical retry: the same ack, its bytes flushed again, nothing written, and a confirmed statement never reopens a pending state. The same revision with another digest, or a lower one, is refused as equivocation/rollback and audited. A new pending supersedes an unconfirmed one, and `highWater` never decreases.
- **Write order:** audit record committed (`member-origin.pending`) → private CAS write of the file (expects the bytes read at the start) → flush of the file and its parent → **then** the ack. **An identical retry** (the same pending digest is already in the file) re-flushes the retained exact bytes and their parent before acking: a prior write can be visible after its fsync failed, so equality alone isn't proof (as `trust.ts` does).
- **Dial order:** while pending, `to` first, then the anchor, both under the same pinned key and ordinary SAN validation. The TLS/SAN check is always against the origin **actually dialled** (a pending `to` is checked as `to`); the anchor is the member's identity for everything else, and only promotion moves it. With nothing pending, only the anchor. Each link records the origin it actually dialled, and that authenticated endpoint is the link's identity (a fallback link at A is an A link, and its web-origin statements bind A).
- **Promotion** happens only when the **link dialled to the pending `to`** receives a fully validated, current-generation welcome. TCP/TLS success or a stale callback isn't enough. It's a CAS that requires the same pending digest and the same profile digest: `confirmed = pending`, `pending = null`, audited (`member-origin.confirmed`). After promotion the old origin is never dialled again. A confirmation can never carry over to a later statement, because it's bound to the exact digest.
- **A revoked or denied result** at any address is terminal recovery (Reconnect), never a reason to try the other address.

### Member: the company trust pin (D2)

- An aborted or pending relocation never touches TOFU.
- **Order:** promotion first (sidecar CAS + flush), then company-pin migration (pin CAS + flush). The two files are independent, so a crash between them leaves "confirmed, pin behind". **Completion** runs idempotently after every promotion, at every start and before every Reconnect. If the pin is exactly the identity with the `from` of some hop in the confirmed chain (for example pin = B while confirmed = A→B→C and the raw profile says A), the pin is CAS-rewritten to the identity with the current anchor. The proof is that hop's issuer-signed statement and every hop after it. A pin that matches no hop is left alone (no arbitrary mismatch repair), and a pending statement never moves a pin. A pin migration still held never lets the member dial an old address: the confirmed anchor alone decides dialling.
- **Before every Reconnect** (and at start, and after each promotion) completion runs first. So with profile A, confirmed A→B→C and pin B (C's promotion flushed, its pin move not), the pin is moved B→C by exact-byte CAS on B's bytes, proven by the signed B→C hop, before Reconnect captures its anchor. A pin that is newer or foreign (another repair, a join, any identity not equal to a confirmed hop's `from`) loses the CAS or is left alone: no write, and Reconnect then refuses as a changed identity. The anchor and high-water never go back.
- **Reconnect's repair anchor** stays distinct: the identity **in the pin**, plus its exact bytes, captured before retirement, accepted when it's the same Hub/issuer/SPKI/web address with a `memberOrigin` that is the profile's or the confirmed anchor's. So online-follow → Reconnect finds an already-migrated pin, and an aborted follow → Reconnect still uses the descriptor repair from the old pin. Composition with a #3797 web-address move uses the verified web address for both.

### Crash and abort boundaries

| Where it stops | What follows |
|---|---|
| Hub: reservation committed, nothing sent | A burned sequence and its audit; no member state; no address change. |
| Hub: sent/acked, no decision (crash, cancel, D3 expiry while waiting, probe failure) | Old config. Members hold a pending `to`, try it (refused: nothing listens, or not the pinned key), fall back to the anchor and work as before. A later attempt from the same anchor supersedes the pending one. |
| Hub: decision committed, response lost / files not installed | #3660 recovery installs exactly the committed image with its persisted kept/revoked sets. Kept members dial `to` once it listens and promote on its welcome. |
| Hub: installed, remount fails | `saved_unavailable`; kept members keep trying `to` (and the anchor, which is refused). |
| Member: crash before the audit / write / flush | No ack → revoked → the offline path. |
| Member: written, ack lost or late | The Hub didn't count it → revoked. The member dials `to`, is refused as revoked → recovery. Never kept without a matched ack. |
| Member: disconnect or credential replaced during the wait | The proof no longer matches → revoked. |
| Member: promotion write fails / restart before promotion | Still pending: `to` first, then the anchor; promotes on the next welcome at `to`. |
| Member: restart after promotion | Anchor = `to`; the old address is never dialled. |
| Member: promotion flushed, pin migration not | Completion rewrites the pin from the chain at the next start, promotion or Reconnect. |
| Member: pin migration written, flush failed | Completion re-flushes the exact pin bytes (equal is not proof). |

### Old-listener grace: not in this change

Members online at the change follow; everyone else uses Reconnect. A temporary listener on `from` would add a socket lifecycle and crash states inside #3660's fenced remount. Revisit only if rehearsals show the reconnect wave is painful, with its own review.

### Test plan (Prism's six axes; Ridge's (d))

1. **Member state, crash, ack and write/audit durability:**
   - A→B abort→A→C, and abort→A→B across a restart;
   - identical retry vs same-revision equivocation;
   - a stale confirmation after a new proposal;
   - restart before and after promotion;
   - a confirmed origin never falling back;
   - corrupt or partial file vs absent.
2. **Binding lifecycle:** a fallback-A link's identity and its web-origin statements; disconnect or credential replacement during the wait; a lost, duplicate, late or foreign ack.
3. **Real pinned TLS/WSS:** a kept member follows with the same credential; a revoked one is refused at `to`; SAN on the same key.
4. **Parity with #3797:** a pending or confirmed move against the memberOrigin-signed web statement; company Reconnect/Remove/digest after an online follow and after an aborted follow; composition with a web-address move.
5. **SQL:**
   - the reservation sequence and its burn;
   - kept/revoked sets and the exact kept-row image;
   - the floor and recovery with all-kept vs mixed;
   - SQL commit with a lost response;
   - D3 expiry/cancel during the wait;
   - concurrent fan-out with one deadline.
6. **Receipts:** source, build, input, served, audit, and profile + credential bytes; the owned-container rehearsal with a real company-joined member.
