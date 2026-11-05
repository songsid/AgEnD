# AgEnD Hub P1: module and interface contract

Status: **interface design for the experimental alpha implementation**, subject to this document's review. Implements the approved P1 direction in [#3095](https://github.com/songsid/AgEnD/issues/3095), including its web-entry, installation and same-machine addenda. Fleet decision **7e5b8a8f** approves the new Hub-only roles/mode and alpha P1; it does not change ordinary fleet-role capabilities. The issue's earlier “not authorized” discussion labels are superseded by the subsequent P1 approval. This PR adds documentation only.

The directory identifies people; a fleet belongs to a person; its owner chooses which agents, data views and tools other people may use. An asker needs a browser and a grant, not their own fleet. P1 supports explicit personal grants and one-asker/one-exposure rooms. Organizational roles, shared rooms and deputies are P2; organization-wide operational visualization is P3. Basic management, audit and owner notification are P1 requirements.

The Hub is an approved **new directory-backed multi-user mode**, not a change to ordinary fleets' single-host-owner model. It runs no agents. A paired runtime is a machine executing agents for one fleet; a Hub member is an independent fleet. Hub identity, Hub administration and a manager's question **never become member-local human go-ahead**.

## 1. Package, module ownership and enable boundaries

Same repository/package/version line. New implementation lives below `src/hub/`; ordinary fleet code uses narrow adapters rather than importing Hub internals throughout the daemon.

| Module / slice | Owns | Must not own |
| --- | --- | --- |
| `types.ts`, `protocol.ts`, `mount.ts`; S1 | Shared DTOs/validators, mount gate, pairing, keys, listeners, WSS, member journal and outbox adapter | Directory authorization decisions, executing agents |
| `directory/`; S2 | Lazy LDAPS driver, immutable directory key, sign-in and fresh eligibility | HTTP routes, browser sessions, grants, config publication |
| `sessions.ts`, `catalog.ts`, `policy.ts`, `rooms.ts`, `http/`; S3 | Hub web principal/middleware, exposure mirror, grants, rooms, Ask page and workspace switcher | LDAP driver internals, direct terminal input |
| `execution/`, member-local exposure adapter; S4 | Local exposure consent, isolated restricted contexts, data/tool enforcement, local approval proposals | Hub-wide grants, forging local human receipts |
| `store.ts`, `audit/`, `notifications/`, `init.ts`; S5 | Shared Hub DB/migration composition, audit, notification, minimal admin, initialization wizard | Permitting access merely because a record exists |

`types.ts` and `protocol.ts` must have no initialization side effects. Server composition lazily imports the directory client only after enabling the Hub. Existing runtime primitives may be factored/reused with their current behavior preserved. Do not add Hub frames, credentials or permissions to `/runtime/v1/*`; these are separate protocol namespaces and principals.

### Configuration contract

```yaml
hub:
  enabled: false
  # The initializer supplies name, webOrigin, memberOrigin and listener/TLS settings.
  # directory: HubDirectoryConfig plus bindPasswordRef (never a cleartext password)
  # retention: explicitly chosen contentDays and eventDays
  coexistence: dedicated
hub_member:
  enabled: false
  # hubId/webOrigin/memberOrigin are populated only after local-owner pairing.
```

Both switches default to false. Effective server enablement also requires a valid, locally confirmed initialization manifest; setting YAML alone cannot generate keys, convert a fleet or mount a partially initialized Hub. `hub.enabled` governs the server; `hub_member.enabled` independently governs a personal fleet's member adapter. A member does not enable a Hub server. No environment variable may silently widen either switch in P1.

When `hub.enabled` is false, do not mount `/hub`, `/hub/v1/*`, Hub WebSocket upgrades or a Hub TLS listener; do not create Hub stores/keys, load LDAP, or start Hub timers. Existing fleet `/web` and auth behavior stay unchanged. Unknown Hub paths return the ordinary not-found response. A pure Settings schema/feature description may remain so an operator can initialize deliberately.

When `hub_member.enabled` is false, do not connect, publish, reconcile, admit or execute Hub work, or mount member mutation handlers. “Connect to a Hub” uses the existing local-owner Settings confirmation path to enable/configure it. Member handlers, when enabled, are local-owner-only and unavailable through the public gateway. Off synchronously invalidates live contexts and input admission, closes the link, and holds/cancels pending Hub work before asynchronous cleanup. Ordinary local agents continue unaffected. Disabling the server similarly fences all outstanding Hub continuations and member sessions before cleanup. Failed persistence is an explicit failure; it must not restore an older enabled/authorized generation silently after restart.

### Web entry and same-machine trust

At the enabled Hub's distinct `webOrigin`, `/web` opens the Hub shell: operator-chosen “AgEnD Hub” name; **Ask**, **My exposures**, **Administration**. Directory users get only their current views. The local host owner retains a separate local sign-in for Hub administration/repair. Hub sessions use a distinct `__Host-agend_hub_<hubId>` cookie name with Secure, HttpOnly, Path=/, no Domain and same-origin/CSRF checks; session records and token epochs are separate from fleet sessions and machine credentials. Each side ignores and never authenticates the other's cookie names, including any legacy cookie fallback. **Cookies are not isolated by port**: a distinct `hub.webOrigin` is required, even on one host, and different ports do not replace these name/acceptance rules. A member's host code is not a Hub directory sign-in.

The member keeps its own brand/pages. “My fleet ↔ Hub” opens the paired, validated `webOrigin`, with no token or identity in the URL and no sign-in proxy. Use safe link handling; do not turn agent-supplied text into a workspace destination. Askers without fleets open the Hub directly.

Default placement is a dedicated machine or OS service account. `coexistence: same-user-pilot` is allowed only after explicit local-owner confirmation when an existing personal fleet is detected. In the one-process pilot, keep the original personal fleet listener and `/web` unchanged; mount the Hub web listener/router at its own distinct `webOrigin`, where `/web` opens the Hub shell. Do not replace the personal dashboard, select an authority mode from an untrusted query parameter, or share authentication middleware state between the listeners. Even in the one-process pilot, the personal fleet pairs over the same authenticated loopback member protocol; there is no privileged in-process bypass. The Hub component starts no agents. Same UID means the person's ordinary full-tool agents can read Hub keys/DB: exposed-agent restrictions do **not** isolate that account. Separate accounts need private OS permissions/ACLs; separate machines give the cleanest boundary. Initialization must never silently convert or mix an existing personal fleet.

## 2. Pairing, TLS and member protocol (S1)

### Origins, keys and bootstrap

Keep a browser-facing HTTPS origin separate from the member transport origin. The browser needs a trusted HTTPS deployment; pinning by member software does not make a self-signed certificate trusted by browsers. Corporate CA and Tailscale are optional, not prerequisites. Directory login is never sent through an untrusted bootstrap connection.

S1 provisions a Hub TLS key/self-signed certificate with the configured transport address in its SAN, a stable random `hubId`, and an Ed25519 envelope-signing key with `issuerKeyId`. They are distinct from web tokens, runtime machine credentials and member-local owner keys. Store private keys privately; never invoke a caller-selected shell command to provision them. P1 has no automatic key rotation.

1. A current Hub administrator creates an expiring, single-use pairing code for a freshly resolved prospective owner `PersonKey`. The member's current local owner explicitly starts the pairing. No unbound or name-only owner association is accepted.
2. The initial restricted TLS bootstrap may observe the offered self-signed certificate, but it supports only bounded pairing requests. It cannot send passwords, normal API credentials, exports or questions. Never set a process-global TLS verification bypass or allow redirects.
3. `POST /hub/v1/pair` consumes the code and creates a pending claim. Reuse the alpha runtime's code → pending claim → compare → administrator approval → claim flow, including hashed secrets, bounded TTL/attempts and single use. Pairing/claim expiry is ten minutes; code generation retains at least the runtime's 48 random bits and claim credentials use 256 bits. Rate limits persist and cannot be bypassed by forwarding headers.
4. Both screens display the same fingerprint derived from the **whole binding**: protocol label, Hub ID, transport origin, TLS SPKI hash, issuer public key, browser origin, pairing ID, prospective owner key and claim nonce/digest. Hash a fixed-order JSON tuple with SHA-256; show at least 128 comparison bits, with the full digest available. It is a comparison value, not a password. The person confirms ownership from their current Hub directory session; the Hub administrator approves the exact fingerprint/binding. One person may meet both requirements, but neither requirement is inferred from possession of the code.
5. `POST /hub/v1/claim` releases a distinct member credential only for that approved, unexpired claim. Save the credential, Hub identity, both origins, TLS SPKI pin and issuer public key atomically before connecting. The Hub stores only credential/claim/code hashes. A lost or unsaved claim result holds pairing for explicit reconciliation/re-pair; it never mints another usable identity or begins work speculatively.
6. Normal connection is outbound WSS to `/hub/v1/connect`: exact pinned origin, TLS validity/address checks plus SPKI pin, and the member credential in an Authorization header. No browser Origin/Cookie, URL credentials, cleartext remote mode or redirects. Each connection gets a new link epoch; replacing one fences the old socket and outstanding operations.

A changed SPKI, issuer key, Hub ID or origin stops automatic connection. P1 requires explicit re-pair/key-change confirmation by the local owner and Hub administrator; never TOFU again during reconnect. Same-key certificate renewal still requires a valid address and validity period. Revoke/unpair immediately retires the credential and link epoch and invalidates queued work. Revocation commits durably before success; failed save remains fail-closed and visible. Pairing establishes a person association, not permission to publish or to ask.

### Frames and versioning

One strict JSON object per WebSocket text message. Reject binary frames, duplicate object keys, unknown fields/types, unsafe numbers, invalid UTF-8 and over-limit frames **before dispatch**. Version is `1`; first exchange is `hello`/`welcome` with supported versions and required capabilities. No common version or required capability means incompatible/held, never a silent fallback to runtime or generic fleet messaging. The authenticated initial `hello` uses link epoch zero; only its matching `welcome` assigns the nonzero current epoch. All subsequent frames must match it.

P1 limits: 256 KiB/frame, 64 KiB UTF-8 question, 128 KiB final answer; 32 pending request/replies per link, bounded send queue of 1 MiB. Refuse/backpressure visibly rather than drop messages. Use 15-second heartbeat and terminate a link that misses the next check; reconnect uses bounded exponential backoff with jitter and never extends authorization. P1 returns final answers, not live token streams; add streaming only with a versioned contract.

```ts
export type HubId = string;       // random UUID, canonical lowercase
export type FleetId = string;     // same; names never substitute for IDs
export type ExposureId = string;
export type GrantId = string;
export type RoomId = string;
export type MessageId = string;
export type Epoch = number;       // nonnegative safe integer; never rolls back
export type Millis = number;      // integer UTC epoch milliseconds
export type Sha256 = string;      // 64 lowercase hex characters
export type PersonKey = { readonly realm: string; readonly objectId: string };
export type PersonId = string;    // personKeyString(key), not a login/name
export interface HubFrame<T extends string, P> {
  v: 1; type: T; requestId: string; linkEpoch: Epoch; payload: P;
}
export interface HubHello {
  supportedVersions: readonly number[];
  capabilities: readonly string[]; // P1: identity-v1, receipts-v1, reconcile-v1
  memberBootId: string;
}
export interface HubWelcome {
  selectedVersion: 1; hubId: HubId; fleetId: FleetId;
  linkEpoch: Epoch; revocationVersion: Epoch;
}
export interface HubExposureSnapshot {
  revision: Epoch; exposures: readonly HubExposure[];
}
export interface HubQuestion {
  text: string; identity: HubAskerEnvelope;
}
export type HubReceiptStage =
  | "queued" | "delivered" | "consumed" | "answered"
  | "rejected" | "cancelled" | "failed" | "uncertain";
export interface HubReceipt {
  messageId: MessageId; contentDigest: Sha256; stage: HubReceiptStage;
  sequence: Epoch; at: Millis; memberDeliveryId?: string;
  reasonCode?: string; // closed, bounded public error codes; no raw exceptions
}
export interface HubAnswer {
  messageId: MessageId; answerId: string; text: string; contentDigest: Sha256;
  releaseLease: HubAuthorizationLease; // binds this exact answer, not another answer in the room
}
export interface HubReconcile {
  afterReceiptSequence: Epoch;
  messages: readonly { messageId: MessageId; contentDigest: Sha256 }[];
}
export interface HubAuthorizationScope {
  messageId: MessageId; operationId: string; exposureRevision: Epoch;
}
export type HubAuthorizationRequest = HubAuthorizationScope & (
  | { phase: "admit" | "begin" }
  | { phase: "tool"; tool: { name: string; argumentsDigest: Sha256 } }
  | { phase: "release-answer"; answer: { answerId: string; contentDigest: Sha256 } }
);
export interface HubAuthorizationLease {
  decisionId: string; messageId: MessageId; operationId: string;
  phase: HubAuthorizationRequest["phase"]; operationDigest: Sha256;
  revocationVersion: Epoch; exposureRevision: Epoch; linkEpoch: Epoch;
  expiresAt: Millis; // at most five seconds; one exact operation, not a session grant
}
export interface HubReconcileReply {
  receipts: readonly HubReceipt[]; nextReceiptSequence: Epoch; more: boolean;
}
export type HubAuthorizationResult =
  | { ok: true; lease: HubAuthorizationLease }
  | { ok: false; reasonCode: string };
export interface HubProtocolError { code: string; retryable: boolean }
export type HubRevocationScope =
  | { kind: "person"; personId: PersonId }
  | { kind: "fleet"; fleetId: FleetId }
  | { kind: "exposure"; exposureId: ExposureId }
  | { kind: "grant"; grantId: GrantId };
export interface HubRevocation {
  revocationVersion: Epoch;
  scope: HubRevocationScope;
  reasonCode: string;
}
```

Wire directions are closed unions; a member cannot inject a server question/revocation or vice versa:

```ts
export type HubMemberFrame =
  | HubFrame<"hello", HubHello>
  | HubFrame<"exposure.snapshot", HubExposureSnapshot>
  | HubFrame<"receipt", HubReceipt>
  | HubFrame<"answer", HubAnswer>
  | HubFrame<"reconcile", HubReconcile>
  | HubFrame<"authorize.request", HubAuthorizationRequest>
  | HubFrame<"error", HubProtocolError>;
export type HubServerFrame =
  | HubFrame<"welcome", HubWelcome>
  | HubFrame<"question", HubQuestion>
  | HubFrame<"receipt", HubReceipt> // acknowledgment of durably retained member evidence
  | HubFrame<"reconcile", HubReconcileReply>
  | HubFrame<"authorize.result", HubAuthorizationResult>
  | HubFrame<"revoke", HubRevocation>
  | HubFrame<"error", HubProtocolError>;
export interface HubServerTransport {
  start(): Promise<void>;
  send(fleetId: FleetId, frame: HubServerFrame): Promise<void>;
  close(): Promise<void>;
}
export declare class HubAuthorizationError extends Error {
  readonly code: "denied" | "unavailable" | "stale";
  readonly reasonCode: string;
}
export interface HubMemberTransport {
  start(): Promise<void>;
  send(frame: HubMemberFrame): Promise<void>;
  authorize(request: HubAuthorizationRequest): Promise<HubAuthorizationLease>;
  close(): Promise<void>;
}
```

Transport construction takes injected validated pairing/store/service dependencies; `start` is never called with its mode off. Successful `send` means socket acceptance only, not durable remote receipt or consumption. `authorize` maps wire refusal to a rejected `HubAuthorizationError` with a bounded reason code; timeout/lost link is `unavailable`, not a lease or implicit allow. Callers hold/refuse without input or tool dispatch.

Allowed frame types are exactly `hello`, `welcome`, `exposure.snapshot`, `question`, `receipt`, `answer`, `reconcile`, `authorize.request`, `authorize.result`, `revoke`, `error`; request/reply payload schemas and directions are fixed in `protocol.ts`. A successful `authorize.result` carries the lease above, a refusal a bounded reason code. Leases are server-owned records, returned only on the authenticated current link, and checked online at the use boundary; the DTO alone is not authority. Other payloads are the named types above; `error` contains only an enum code and retryability. `reconcile` is paged, at most 128 IDs/receipts per page. `exposure.snapshot` is bounded to 64 active exposures/member in P1 and is accepted only from that member, after local-owner consent; no instance inventory or credentials are published.

### Durable delivery and reconnect

Hub routing uses a stable message ID and an atomic question/audit transaction before reporting `queued`. A duplicate ID with identical immutable destination/body returns the existing record; any changed destination/body is a conflict. On the member, source key `hub:<hubId>:<messageId>` binds exactly one restricted outbox row. Only a committed row yields `queued`; only existing delivery/consumption evidence yields those stages. `answered` is separate from consumed. Never call an ordinary full-tool daemon's paste API from the transport.

Before admission, begin, each data/tool access and answer disclosure, authorize the same asker, owner, grant, exposure and room **now**. An expired admission envelope can be refreshed for the same immutable question only after fresh authorization; changed ownership/exposure consent or a revoked grant cancels the old question instead. Updating a signature is not authorization to execute again.

Persist input-intent boundaries before any input mutation. An unknown/lost ACK after input begins is `uncertain`, surfaced to the owner; never retry input because the socket reconnected. Receipt sequences advance monotonically and cannot downgrade known evidence. Persist member receipt/answer records until the Hub acknowledges them, then retain dedup tombstones for at least the maximum question lifetime. A Hub acceptance ACK means the answer/audit committed, not that a browser read it.

After reconnect, negotiate, fetch the current revocation version, publish the current approved exposure snapshot and reconcile known message IDs/receipt cursors **before** new work. A known never-admitted question may be resubmitted to admission with the same ID only after fresh authorization; a delivered/consumed/uncertain question must not be re-executed. Answers may be retransmitted by answer ID, after renewed disclosure authorization, not regenerated. Missing/corrupt journals, unknown operation outcomes or unavailable authority hold visibly in Needs-you. Receipt sequence is monotonic within a member journal, scoped by its authenticated Fleet ID; the Hub echoes a retained sequence to ACK it. Sequence zero is reserved for the Hub UI's provisional queued state before member admission and never presented as member evidence. P1 question lifetime is at most 24 hours; dedup tombstones survive beyond that deadline and are not deleted while unresolved. No offline execution from an old envelope or lease.

## 3. Signed asker identity and the member admission fence

```ts
export interface HubAskerEnvelope {
  v: 1; issuer: HubId; issuerKeyId: string; messageId: MessageId;
  asker: PersonKey; owner: PersonKey;
  destinationFleetId: FleetId; exposureId: ExposureId; roomId: RoomId;
  grantId: GrantId; grantRevision: Epoch; exposureRevision: Epoch;
  revocationVersion: Epoch; contentDigest: Sha256;
  issuedAt: Millis; expiresAt: Millis; nonce: string;
  signature: string; // Ed25519 detached signature, unpadded base64url
}
```

Signature bytes are UTF-8 `JSON.stringify` of this fixed-order tuple, with no whitespace/newline or post-hash normalization:

```text
["agend-hub-ask-v1", v, issuer, issuerKeyId, messageId,
 asker.realm, asker.objectId, owner.realm, owner.objectId,
 destinationFleetId, exposureId, roomId, grantId, grantRevision,
 exposureRevision, revocationVersion, contentDigest, issuedAt, expiresAt, nonce]
```

All strings/numbers are strictly validated before signing/verifying; no unpaired surrogates, unsafe integers or alternate ID casing. Digest is SHA-256 of the exact UTF-8 question text, not of display text. Envelope admission TTL is at most 120 seconds. Reject future issue times beyond five seconds, expired envelopes and clocks that cannot establish a valid window; do not expand the window on reconnect. Signing keys are not directory passwords or TLS/session secrets.

Operation leases use a second fixed-order tuple, SHA-256 of its UTF-8 JSON representation:

```text
["agend-hub-operation-v1", messageId, operationId, phase, exposureRevision,
 toolNameOrNull, argumentsDigestOrNull, answerIdOrNull, answerContentDigestOrNull]
```

Tool fields are required only for `tool`, answer fields only for `release-answer`, and absent fields become literal `null` in this tuple. Runtime validators reject extraneous or missing phase fields. The member records the exact operation ID/intent before requesting a lease. Compute the digest from the actual validated tool name and canonical arguments that will be dispatched, or the actual answer ID and exact text digest that will be disclosed. Canonical tool arguments are validated JSON with object keys sorted recursively, no undefined/non-finite values, preserved array order and no post-digest mutation. `admit`/`begin` bind their own persistent one-use operation IDs.

`begin` and `invokeTool` compare the expected operation ID/digest, phase, context, exposure revision, current link/version and deadline immediately at dispatch. Consume the operation intent durably before an effect; a lease cannot be reused for another tool/argument set, a second invocation or a different context, even during its five seconds. A fresh lease does not erase an applied/uncertain intent. `finish` obtains a `release-answer` lease after fixing the final answer bytes; the Hub compares that lease to the received `answerId`/digest before committing or exposing it. Any redaction changes the bytes and requires a newly matching release decision. Duplicate already-committed answers return their prior ACK; a conflicting answer body is refused. These bindings authenticate one operation and never grant member-local human authority.

Member verification order: current enabled membership/link and pairing → pinned issuer key/signature → exact issuer/destination/body digest/time → exact local owner/exposure revision and approved restricted context → online current authorization/revocation lease → atomic dedup/outbox admission. A matching old signature alone is insufficient. Apply the same local policy again at execution/tool/answer boundaries. A lower revocation version is held; a higher one is reconciled before work. Member authentication identifies a fleet, not an arbitrary user; clients cannot choose an asker or submit a different person's proof.

The agent sees a server-generated label with the authenticated asker, exposure/room and grant, plus **“Hub identity; external data; no local human authority.”** Display names are escaped annotations. Do not create `hmsg` receipts, assign `authority.kind: web-verified`/`platform`, or accept imported `forwards`/human receipt IDs. `delivery_status` may expose transport evidence and the verified Hub identity, but any local human-authority field is `none`. Agent-origin cross-fleet delegation is a P2 identity type, rejected in P1 rather than relabelled as a person.

## 4. Records, ownership and storage

```ts
export interface HubPerson {
  key: PersonKey; displayName: string; loginLabel: string;
  status: "active" | "disabled" | "unknown"; lastCheckedAt: Millis;
}
export interface HubFleet {
  id: FleetId; owner: PersonKey; displayName: string;
  generation: Epoch; status: "pending" | "online" | "offline" | "revoked" | "frozen";
  approvedAt?: Millis;
}
export interface HubExposure {
  id: ExposureId; fleetId: FleetId; owner: PersonKey; displayName: string;
  revision: Epoch; state: "published" | "withdrawn" | "frozen";
  dataViewId: string; allowedTools: readonly string[]; policyDigest: Sha256;
}
export interface HubGrant {
  id: GrantId; revision: Epoch; owner: PersonKey; exposureId: ExposureId;
  exposureRevision: Epoch; approvedBy: PersonKey; approvedAt: Millis;
  subject: { kind: "person"; person: PersonKey }; // role subjects are not accepted in P1
  permissions: readonly ("ask" | "read-own-room")[];
  startsAt: Millis; expiresAt: Millis; state: "active" | "revoked";
}
export interface HubRoom {
  id: RoomId; asker: PersonKey; exposureId: ExposureId; ownerAtCreation: PersonKey;
  grantId: GrantId; state: "active" | "held" | "closed";
}
export interface HubDeputy { // P2 schema sketch ONLY; no P1 writes/authorization
  id: string; person: PersonKey; roleId: string; scopeId: string;
  startsAt: Millis; expiresAt: Millis; appointedBy: PersonKey;
}
export interface HubAuditRecord {
  id: string; sequence: Epoch; at: Millis; requestId: string;
  actor: { kind: "person"; person: PersonKey } | { kind: "local-host" } | { kind: "member"; fleetId: FleetId };
  action: string; result: "allowed" | "denied" | "held" | "completed";
  messageId?: MessageId; roomId?: RoomId; fleetId?: FleetId; exposureId?: ExposureId;
  ownerAtEvent?: PersonKey; grantId?: GrantId; grantRevision?: Epoch;
  policyVersion: Epoch; contentRef?: string; reasonCode?: string;
}
```

The Hub is authoritative for pairing, immutable person associations, explicit grants, rooms, routing, authorization versions and audit. Its `hub/hub.sqlite` stores those records, session/credential hashes, idempotency records and encrypted question/answer payloads referenced by `contentRef`. S5 composes schema migrations; slice-specific repositories use its transaction interface. Successful mutations append audit in the same transaction. If required audit cannot commit, do not accept a question, disclose an answer or claim a successful policy change. Key material is separate under `hub/keys/`; payload-encryption keys are not put in ordinary logs/config. Backup creation must be private from its first byte and obey retention, not just protect the live DB.

The member keeps `hub-member/<hubId>/` for its private credential/pins, immutable owner binding, locally approved exposure policy/context mappings and reconciliation journal. Hub metadata never names a host filesystem path to execute. Revocation scopes must name exactly one target (or use a distinct, explicitly confirmed Hub-wide admin operation), never interpret a malformed empty scope as global authority. Member outbox rows/tombstones and restricted context state remain member-local. Hub exposure rows are a mirror of owner-approved member policy: Hub admin edits cannot widen it. Upward grant widening requires current owner consent, tied to the exact exposure revision; withdrawal can always narrow immediately. Network partitions fail closed for Hub work, not for ordinary local work.

Directories are private (`0700`), files and SQLite/WAL/SHM are private (`0600`); Windows needs a verified private ACL, not a claim based on POSIX mode bits. Missing or rolled-back authorization state must not revive previous credentials, sessions or queued decisions: use a persisted monotonic version floor alongside retained journal evidence, freeze on inconsistency and require local recovery. Do not import source-system credentials, raw LDAP DNs, group lists or private instance inventory into member DTOs.

Account disable/gone immediately denies the next request and work boundary, terminates affected sessions, and freezes owned exposures; existing source event support can accelerate notification, but no polling promise replaces the per-request check. P1 has no org-role cache or inferred manager privilege. Ownership hand-over is explicit, audited, freezes work, rotates credentials and reapproves exposure/grant policy with a locally confirmed successor. Do not rewrite historical ownership or automatically give the successor private history. Audit content is available to the asked person within their authorized tenure and to separately assigned security auditors; all audit access/export is itself recorded. Retention periods are required initialization choices, not implicitly approved permanent defaults.

## 5. Slice integration interfaces

These are named TypeScript boundaries, not JSON schemas or forgeable capabilities. `mount.ts`/HTTP validators create contexts and leases on the server; calling code must not trust an object merely because it has this shape. Keep public DTO projection separate from server-only LDAP/person/session data.

### S2: directory provider (agreed with its author)

```ts
export interface HubDirectoryConfig {
  realm: string; url: string; // ldaps: ONLY in P1; reject ldap:/StartTLS/plaintext
  caPem?: string; baseDn: string; bindDn: string; bindPasswordRef?: string;
  profile: "ad" | "openldap"; loginAttribute?: string; userFilter?: string; timeoutMs?: number;
}
export interface DirectoryPerson {
  key: PersonKey; login: string; dn: string; displayName?: string;
  email?: string; department?: string; groups: readonly string[];
}
export type SignInResult = { ok: true; person: DirectoryPerson }
  | { ok: false; reason: "invalid-credentials" | "not-eligible" | "unavailable" | "bad-input" };
export type Eligibility = { eligible: true; person: DirectoryPerson }
  | { eligible: false; reason: "gone" | "disabled" | "unavailable" };
export interface HubDirectory {
  readonly realm: string;
  signIn(login: string, password: string): Promise<SignInResult>;
  checkEligibility(key: PersonKey): Promise<Eligibility>;
  close(): Promise<void>;
}
export declare function personKeyString(key: PersonKey): PersonId;
export declare function createHubDirectory(
  config: HubDirectoryConfig, secrets: { bindPassword: string }
): HubDirectory;
```

Realm is a stable configured ID matching `[a-z][a-z0-9_-]{0,63}`; object ID is lowercase canonical UUID from validated directory `entryUUID` or decoded `objectGUID`. Neither component contains `/`. `personKeyString` is exactly `realm/objectId`. A recreated account with the same login is a different person. DNs, logins and display names may change. Raw groups are attributes, never P1 grants. LDAP filter values must be escaped; an administrator's configured filter cannot replace the immutable-ID/eligibility checks. Verify certificate chains/hostnames; network timeout is bounded (default five seconds, maximum ten), referrals cannot forward credentials outside the configured trust boundary.

No eligibility allow-cache. Every protected Hub request and each queued dispatch/tool/answer boundary invokes a fresh check for the asker and exposure owner. Unreachable/ambiguous status is denied/held. Do not cache user passwords; the service bind secret is resolved from `hub.directory.bindPasswordRef` by composition and supplied only to S2. Browser errors are generic; bounded audit reason codes distinguish operational failure without logging the credential, DN or LDAP exception. P1 claims only directory account eligibility, not unintegrated HR truth.

### S1/S3: mounting, sessions and policy

```ts
export interface HubMode {
  serverEnabled(): boolean; memberEnabled(): boolean; epoch(): Epoch;
}
export type HubActor =
  | { kind: "directory"; person: PersonKey; sessionId: string }
  | { kind: "local-host"; sessionId: string; directoryBinding: PersonKey | null };
export interface HubRequestContext {
  readonly requestId: string;
  current(): Promise<HubActor>; // authenticates again, checks mode/session/body continuation
  requirePerson(): Promise<PersonKey>; // fresh directory eligibility; host repair is not an asker
  requireAdmin(): Promise<HubActor>; // current local host or explicit Hub admin assignment
}
export interface HubCatalog {
  publish(ctx: HubRequestContext, exposure: HubExposure): Promise<HubExposure>;
  withdraw(ctx: HubRequestContext, id: ExposureId, revision: Epoch): Promise<void>;
  grant(ctx: HubRequestContext, grant: HubGrant): Promise<HubGrant>;
  revokeGrant(ctx: HubRequestContext, id: GrantId, revision: Epoch): Promise<void>;
  visible(ctx: HubRequestContext): Promise<readonly HubExposure[]>;
}
export interface HubPolicy {
  authorize(request: HubAuthorizationRequest): Promise<HubAuthorizationLease>;
  revoke(ctx: HubRequestContext, scope: HubRevocation["scope"]): Promise<HubRevocation>;
}
export interface HubRooms {
  open(ctx: HubRequestContext, exposureId: ExposureId, grantId: GrantId): Promise<HubRoom>;
  ask(ctx: HubRequestContext, roomId: RoomId, idempotencyKey: string, text: string): Promise<HubReceipt>;
  read(ctx: HubRequestContext, roomId: RoomId, after: Epoch): Promise<readonly HubRoomEntry[]>;
}
export interface HubRoomEntry {
  messageId: MessageId; sequence: Epoch; receipt: HubReceipt;
  question?: string; answer?: string; // projected only for the currently permitted audience
}
export interface HubMemberAdmission {
  admit(question: HubQuestion): Promise<HubReceipt>;
  reconcile(input: HubReconcile): Promise<readonly HubReceipt[]>;
  fence(revocation: HubRevocation): Promise<void>;
}
```

S3 owns browser session creation and middleware, using S2 without adding routes to the directory driver. All mutations require current same-origin/CSRF/session checks and a second check after body/await; do not accept ordinary fleet guest/public-link sessions, fleet bearer tokens or member machine credentials as Hub people/admins. Local-host repair is a server-owned, verified local session path, not an IP/header assertion or a way to ask without directory eligibility. The wizard binds the administrator to a tested directory identity; local repair may restore connectivity/revoke access without impersonating that identity or reading protected questions while directory eligibility is unavailable.

`HubPolicy.authorize` resolves all actor/destination/grant facts from the persisted message, current authenticated link and server context, not caller-supplied person fields. Catalog methods verify ownership and member-local consent; a structurally valid object cannot grant itself permissions. Revision preconditions make stale tabs return conflict. A room is keyed by immutable asker/exposure/grant context; no shared audiences or history inheritance in P1. Retention expiry, disabled owner/asker and revoked grant also fence reads, polls and subscriptions. P1 room polling is at most once per ten seconds with one request in flight, paused for hidden/inactive rooms; it does not manufacture a fresh eligibility result from a prior poll. P1 has no persistent room-answer stream; `subscribe` for local member pairing is a different surface. Bound authenticated per-person/session request and directory-work concurrency before expensive LDAP calls; excess reads get 429/Retry-After rather than a cached allow. A policy mutation/stop can still invalidate a pending poll. Each accepted room poll freshly checks both asker and exposure owner, so pilot sizing must count at least two directory lookups per active room per poll.

P1 browser API is mounted only with the server: `/hub/v1/session`, `/hub/v1/exposures`, `/hub/v1/grants`, `/hub/v1/rooms`, `/hub/v1/rooms/:id/messages`, `/hub/v1/audit`, `/hub/v1/admin/*`; methods are explicitly enumerated by S3/S5, never prefix-authorized. Pair/claim/connect live only on the member listener; browser sessions cannot authenticate them. Hub routes are not added to the ordinary public tunnel allowlist in P1. No route is usable before its service and audit dependency are installed: early slices return unavailable while the experimental switch remains off for normal installs.

### S4: restricted member execution

```ts
export interface HubExecutionPolicy {
  dataViewId: string; policyDigest: Sha256; allowedTools: readonly string[];
  readOnly: true; // P1 cannot widen this from Hub or prompt input
}
export interface HubRestrictedContext {
  id: string; messageId: MessageId; exposureId: ExposureId;
  owner: PersonKey; exposureRevision: Epoch; policy: HubExecutionPolicy;
}
export interface HubRestrictedExecution {
  prepare(question: HubQuestion, policy: HubExecutionPolicy): Promise<HubRestrictedContext>;
  begin(context: HubRestrictedContext, lease: HubAuthorizationLease): Promise<void>;
  invokeTool(context: HubRestrictedContext, name: string, args: unknown, lease: HubAuthorizationLease): Promise<unknown>;
  finish(context: HubRestrictedContext): Promise<HubAnswer>;
  hold(context: HubRestrictedContext, reasonCode: string): Promise<void>;
  proposeLocalAction(context: HubRestrictedContext, proposal: HubLocalProposal): Promise<void>;
}
export interface HubLocalProposal {
  id: string; action: string; argumentsDigest: Sha256; consequences: string;
}
```

The transport submits only to the restricted outbox adapter. S4 prepares a separate process/context/workspace/credential scope, never the owner's normal conversation or its implicit tools. Local policy resolves the data view; no remote paths, arbitrary shell/SQL/network or whole-home reads. “Read-only” cannot mean all private data is readable. Approved read connectors enforce data scope outside the model; if the provider cannot enforce the restriction, that exposure stays unavailable. Tool allowlist checks happen on actual dispatch with current authorization, not on model-declared tool names alone. Child/native CLI tools and ambient credentials must not bypass the allowlist.

Each `begin` and actual tool call checks the actual operation ID/digest as well as lease/link/context ownership, intent dedup and local policy; `finish` does not bypass Hub disclosure authorization. A high-risk request is a proposal to the **member owner's local Needs-you**, with exact action/arguments/consequences; it cannot execute in the Hub context. Any separately approved local execution uses ordinary local receipt/current-permission/replay checks and creates a new operation, not an upgraded Hub envelope. No imported receipt or Hub admin click satisfies it. Replies expose only the permitted result.

### S5: audit, notifications, administration and init

```ts
export interface HubTx { readonly id: string } // opaque, issued only by the store
export interface HubUnitOfWork {
  atomic<T>(work: (tx: HubTx) => T): T; // synchronous DB changes only; no network awaits
}
export interface HubAuditContent {
  recordId: string; question?: string; answer?: string; audience: readonly PersonKey[];
}
export interface HubAuditSink {
  append(tx: HubTx, record: HubAuditRecord): void;
  read(ctx: HubRequestContext, scope: { exposureId?: ExposureId; after?: Epoch }): Promise<readonly HubAuditRecord[]>;
  readContent(ctx: HubRequestContext, recordId: string): Promise<HubAuditContent>;
}
export interface HubNotifications {
  owner(event: { messageId: MessageId; exposureId: ExposureId; code: "asked" | "answered" | "held" | "revoked" }): Promise<void>;
}
export interface HubInitPlan {
  name: string; webOrigin: string; memberOrigin: string;
  directory: HubDirectoryConfig; bindPasswordRef: string; administrator: PersonKey;
  retention: { contentDays: number; eventDays: number };
  coexistence: "dedicated" | "same-user-pilot";
  memberListen: { host: string; port: number }; webListen: { host: string; port: number };
  webTls: { certFile: string; keyFile: string }; // confirmed source PEMs; private copies are config outputs
}
export interface HubInitializer {
  inspect(): Promise<{ existingFleet: boolean; existingHub: boolean }>;
  validate(plan: HubInitPlan): Promise<void>;
  prepareConfirmation(plan: HubInitPlan, secrets: { bindPassword: string }): Promise<{ reference: string; planDigest: string; summary: string }>;
  commit(plan: HubInitPlan, localOwnerConfirmation: string): Promise<{ hubId: string; spkiSha256: string; issuerKeyId: string; configPath: string }>;
}
```

The runtime type definitions are re-exported from `src/hub/directory/` and `src/hub/init/types.ts`. The initialization manifest uses a canonical UTC ISO timestamp with milliseconds for `committedAt`; the issuer seal binds that exact value and plan digest. S1 supplies a lazy identity provider; S5b separately owns FleetManager lifecycle and complete server/member composition. Until that composition is available, these library interfaces do not mount a partial Hub.

`agend hub init` and quickstart's “personal fleet / team Hub” choice share S5 validation/composition. Steps: name/stable addresses → generate transport and issuer keys/certificate → separately configure browser HTTPS → configure **LDAPS** and test the operator's sign-in → bind local host owner as Hub administrator → choose retention and confirm any same-account pilot warning → install the existing supported service wrapper with explicit confirmation → provide member pairing instructions. Supported placement follows existing service tooling (including Windows through the supported WSL path), not an invented native Windows service. The Hub needs no AI CLI installation/sign-in. No install/service action occurs just by opening a wizard or toggling a YAML field.

Initialization stages private files and config under an operation receipt, validates before enabling, and commits `hub.enabled` last. Failure leaves off or a visible repair state; repeat/restart cannot overwrite another Hub identity, repoint credentials or silently reinstall a service. `localOwnerConfirmation` is an opaque server-created confirmation reference bound to the exact plan, not a caller-chosen string that grants authority.

Audit includes actual question/answer references, immutable asker and owner-at-event, destination, time, audiences, exact grant/revisions, decision and outcome, including rejected attempts. Read access is asked-owner scope or separately assigned security-auditor scope, checked afresh; Hub infrastructure admin is not automatically a content auditor. Both metadata and `readContent` enforce asked-owner/auditor scope; `contentRef` is an internal lookup key, never a bearer read capability. Audit access/export and manual hand-over/recovery are audited. Notifications carry IDs/minimal context and cannot change authorization; notification failure is retried by event ID without replaying the question. Retention deletes encrypted payloads and relevant backups under chosen policy, while preserving required unresolved dedup/revocation evidence. No unconditional “keep forever” or unapproved numeric retention default.

## 6. Threats, required acceptance and slice order

| Slice | Threat and acceptance evidence required before review |
| --- | --- |
| S1 transport | Both switches off: no routes/imports/listeners/timers/state creation; personal fleet unaffected. Pair code/claim expiry and reuse; wrong fingerprint/owner, key/origin swap, missing approval, pin mismatch and redirects refused. Revoke and interrupted-save/restart cannot restore credentials. Frame/schema/size/version/connection-epoch tests; duplicate IDs/conflicting digests, lost receipts, reconnect before/after input, corrupt journal, backpressure and uncertain holds. A fake member must never reach ordinary fleet tools or `/agent`. |
| S2 directory | Fake directory in an unprivileged container only. LDAPS CA/hostname failure and plaintext refused; invalid credentials, disabled/deleted/recreated account and rename; fresh check on every call, network timeout/referral/filter injection and fail-closed outage; logs/results contain no passwords or raw diagnostic secrets. No real organization service without separate approval. |
| S3 policy/web | Owner opt-in, immutable-ID/name collision, private-agent non-enumeration, wrong asker/exposure/room/grant, stale tab/body/session/mode changes, CSRF and cookie separation, including a Hub and fleet on the same hostname with different ports (both cookies presented), and the one-process pilot preserving the personal `/web`. Withdraw/revoke/disabled account between queue/dispatch/read/reply; one-asker history isolation and no role/deputy grant accepted in P1. Workspace link cannot forward credentials; ordinary guest/public/member credential cannot reach owner/admin/content endpoints. Web acceptance includes a pre-upgrade stale tab. |
| S4 execution | Adversarial questions cannot access private files/data/credentials, non-allowlisted tools, shell, network or another exposure's context. Actual provider isolation (or exposure refused), no ordinary full-tool session reuse, exact local policy revisions, revoked lease at each boundary, no duplicated input/action on restart. High-risk proposal makes local Needs-you, no remote approval; signed/forged/imported human receipts never create local authority. Swap tool/arguments/answer ID or content under a lease, reuse a consumed intent, or change context: all refuse before effect/disclosure. Any delivery-path implementation also owes real Claude and Codex idle/busy/just-resumed evidence in isolated rigs. |
| S5 audit/init | Full accepted/denied question/answer provenance, owner/auditor separation and audit of reads/exports. Disk-full/audit failure rejects acceptance/disclosure; notification retry doesn't rerun work. Private DB/keys/backups/ACLs; configured retention; init interrupted at every durable step, same-account warning/confirmation and no silent fleet conversion; service installation requires exact confirmation. Missing/rolled-back state holds visibly. |

Use scratch homes, private tmux sockets only where a later real-CLI test requires them, and fake-directory containers with **no privileged mode, no binfmt changes and no host-network changes**. This documentation PR needs interface/type, link, privacy and documentation checks, not a real fleet or account run. Implementation PRs post exact-head acceptance before their parity review; a safety hold appears in Needs-you instead of silently stalling. The feature must not block an unrelated release: unfinished slices stay off.

Order: this contract → S1 transport/composition (owner then takes S4) while S2 can build its isolated driver → S3 integration using these interfaces → S4 restricted execution → S5 audit/init composition and whole-flow acceptance. Audit-dependent actions remain unavailable until their sink is present. Slices may prepare in parallel but merge individually behind the switches. Do not broaden P1 through a placeholder role, runtime-tool passthrough, shared room or auto-rotation.

## 7. Reserved P2 organization and messaging extension points

This section names future contracts only: **no P2 routes, tables, permissions or handlers are enabled by P1**. Its closed v1 validators continue to reject role grants, additional audience fields and new purpose types. P2 requires an explicitly negotiated protocol/envelope version and separate implementation approval. The existing P1 signature tuple, one-person rooms and authorization interfaces remain unchanged.

### Organization, appointments and resource consent

Use separate administrative and project relations. Units may nest (for example, department → team); membership and reporting relations allow multiple managers, acting roles and cross-unit appointments. Do not encode the organization as one `boss` field or impose a fixed three-level limit. Function groups and convenors can be displayed without granting any capability. Project lead/deputy appointments are independent of the administrative tree, and one person can belong to several projects.

```ts
export type HubP2Scope = { kind: "unit"; unitId: string } | { kind: "project"; projectId: string };
export type HubLevel = "head" | "deputy-head" | "lead" | "member";
export interface HubUnit {
  id: string; parentId?: string; displayName: string; revision: Epoch;
}
export interface HubMembership {
  id: string; person: PersonKey; unitId: string; level: HubLevel;
  roleId: string; managerMembershipIds: readonly string[];
  acting: boolean; startsAt: Millis; expiresAt?: Millis; sourceRevision: string;
}
export interface HubProject {
  id: string; displayName: string; revision: Epoch;
  members: readonly PersonKey[]; roles: readonly HubProjectRole[];
}
export interface HubProjectRole {
  id: string; projectId: string; person: PersonKey; role: "lead" | "deputy";
  startsAt: Millis; expiresAt?: Millis; appointedBy: PersonKey;
  deputy?: HubDeputy; // required for deputy: bounded dates, exact role/scope and appointing principal
}
export interface HubRoleCapability {
  id: string; revision: Epoch; roleId: string; scope: HubP2Scope;
  actions: readonly ("chat" | "ask" | "broadcast" | "announce" | "read-room")[];
  audience: "unit-members" | "unit-subtree" | "project-members" | "project-representatives";
  approvedBy: PersonKey;
}
export interface HubP2ResourceGrant {
  id: GrantId; revision: Epoch; owner: PersonKey;
  resource: { kind: "exposure"; exposureId: ExposureId } | { kind: "room"; roomId: RoomId };
  subject: { kind: "person"; person: PersonKey } | { kind: "role"; roleId: string; scope: HubP2Scope };
  actions: readonly ("chat" | "ask" | "broadcast" | "announce" | "read-room")[];
  startsAt: Millis; expiresAt: Millis; approvedBy: PersonKey;
}
export interface HubProjectRepresentative {
  id: string; revision: Epoch; projectId: string; member: PersonKey;
  exposureId: ExposureId; exposureRevision: Epoch; dataViewId: string;
  ownerConsentId: string; state: "active" | "withdrawn";
}
```

The Hub stores these records and provenance from an **authoritative organization feed**, joined through immutable directory/person/unit/project IDs. It does not create a second manually maintained personnel directory. Local resource consent and role-to-capability policy remain separately owned and audited. The member remains authoritative for its exposure and data view. Exactly one active representative is allowed per project/member; that member's fleet owner designates an exposed agent and opts in to its project-specific view. A project admin cannot appoint another person's agent, widen its view or infer exposure from a title.

`HubRoleCapability` is an explicit, inspectable mapping, not an automatic privilege of `HubLevel`. A configured mapping might let a head broadcast to their unit, a team lead ask their team, or a project lead/deputy ask project representatives. Defaults grant nothing. An agent-directed request needs **all** of current directory eligibility, current scoped role capability, an applicable owner-managed resource grant and current exposure/representative consent. Capabilities never replace the owner's grant. Each decision needs one matching chain: the same role and scope (or an explicit personal grant), resource and action must connect the capability, grant and consent; a capability from role A cannot combine with a role-B-only grant. `read-room` names the same action on both mapping and grant; room admission also checks this permission. The owner-facing resource settings are the entry point for granting a person or scoped role access. Person-to-person messaging separately requires an explicit room/recipient policy; it does not manufacture an exposure.

Administrative and project grants are separately identified and audited. Multiple active roles contribute a union of their valid grants, while every view/decision shows which exact role, appointment and grant permits it. Transfers, expiry, withdrawals and leavers invalidate affected queued dispatches and future reads immediately; unavailable or stale authoritative role data holds rather than preserving an old allow. A deputy/acting appointment requires start/end, appointing principal and exact scope; it cannot outlive its source appointment. Ownership transfer and similar principal-reserved acts are excluded from delegated capability mappings and keep their separate local-owner confirmation boundary.

### Messaging purposes, audiences and collected answers

The four patterns are: **1:1 chat** (person ↔ representative agent or person ↔ person); **1→N broadcast/ask** by a project admin; **1→N free-form announcement** initiated by a member or representative to an authorized project or selected people; and **N:N project rooms**. An announcement is sender-initiated text, without a schedule or fixed content fields. None of these patterns grants access to another representative's data or the owner's private conversation.

```ts
export type HubP2Purpose =
  | { kind: "chat"; conversationId: string }
  | { kind: "ask"; questionId: string; broadcastId?: string; representativeId?: string }
  | { kind: "broadcast"; broadcastId: string; projectId: string }
  | { kind: "announce"; announcementId: string; projectId?: string };
export type HubP2Sender =
  | { kind: "person"; person: PersonKey }
  | { kind: "representative"; representativeId: string; owner: PersonKey; consentId: string };
export type HubP2Recipient =
  | { kind: "person"; person: PersonKey }
  | { kind: "representative"; representativeId: string; exposureId: ExposureId };
export interface HubP2MessageIntent {
  messageId: MessageId; sender: HubP2Sender; purpose: HubP2Purpose;
  audience: readonly HubP2Recipient[]; audienceDigest: Sha256; contentDigest: Sha256;
  projectRevision?: Epoch; authorizationRefs: readonly { id: string; revision: Epoch }[];
}
export interface HubBroadcast {
  id: string; projectId: string; initiatedBy: PersonKey; questionDigest: Sha256;
  children: readonly { messageId: MessageId; representativeId: string; state: "pending" | "answered" | "held" }[];
}
export interface HubCollectedAnswerView {
  broadcastId: string;
  answers: readonly { representativeId: string; state: "pending" | "answered" | "held";
    answerId?: string; highlights?: string; blockers?: string }[];
}
export interface HubP2Messaging { // reserved composition boundary, not a P1 service
  submit(ctx: HubRequestContext, intent: HubP2MessageIntent): Promise<{ messageId: MessageId }>;
  collected(ctx: HubRequestContext, broadcastId: string): Promise<HubCollectedAnswerView>;
}
export type HubP2AuditKind =
  | "unit.changed" | "membership.changed" | "project.changed" | "appointment.changed"
  | "capability.changed" | "resource-grant.changed" | "representative.consented" | "representative.withdrawn"
  | "chat.sent" | "broadcast.created" | "broadcast.child-admitted" | "broadcast.child-answered"
  | "broadcast.collected-read" | "announcement.sent" | "room.membership-changed" | "message.held";
```

These are server-validated intent/view sketches, **not signed wire envelopes**. A future versioned envelope must sign the complete purpose, sender type, project/appointment/grant revisions, exact audience digest, destination and parent/child correlation as well as the existing content/time/revocation fields. Resolve groups into immutable recipient IDs before committing a fan-out; persist one child message ID and digest per recipient. Reconnect reconciles those IDs, never repeats an uncertain send. Re-check current eligibility, audience and exact operation leases at admission, execution and disclosure. A representative sender is an explicitly consented machine actor, never an invented human asker or imported local receipt.

The project admin's collected view contains answered/pending/held states, answers, highlights and blockers synthesized from that reader's authorized free-form answers. Representatives are not required to submit structured fields. Each representative sees **only its own question/answer**, not other representatives' answers or the collected view. Current project-admin capability is required to read the collection; each child's exposure owner can inspect who asked and its own audit. Any synthesis uses only that reader's authorized answers in a separately restricted context. A private ask/reply is not automatically posted into an N:N room. An announcement's audience is fixed and authorized at send time, with current access checked again on delivery/read; membership changes do not silently widen past content visibility. Project-room history/audience policy must be explicit before shared rooms are enabled.

Extend the audit sink with these named kinds and immutable actor, appointment, capability, grant, project, representative and audience revisions. Record fan-out and per-recipient outcomes, consent/revocation and collection reads; keep content access scoped to participants, the relevant asked owner and separately authorized security auditors. Title holders or infrastructure administrators do not gain all-message visibility. P2 tests must prove transfer/deputy expiry at dispatch and read, multi-role provenance, cross-unit scope isolation, owner opt-out, fan-out dedup, representative-only child visibility, collected-view access and stale room membership.

Explicit non-goals: name/substring identity joins; IP-as-person sign-in; magic ranks, bit strings or hard-coded people as permissions; one-manager-only modeling; unbounded deputies; display-group authority; title-implies-access; manually duplicated personnel truth; and default everyone-sees-everything. P3 operational dashboards consume the same authorization/audit boundaries rather than introducing a privileged shortcut.

## 8. Decisions deliberately left outside the interface freeze

- Pilot people and the first approved read-only data view must be selected before S3 is enabled for actual users.
- Operator/organization choices still include permitted directory schema, browser HTTPS trust, retention, security-auditor assignments and explicit hand-over procedure; the wizard/service interfaces carry these without inventing organizational policy.
- P2 adds authoritative organizational feeds, separately audited department/project grants, deputies with expiry and shared-room audience/history rules. P3 adds the full central dashboard. Each requires its own schema/protocol capability and tests; P1 must reject rather than infer those privileges.

Related existing foundations: [paired runtimes](../remote-runtime.md), [verified web sessions](1939-verified-web-sessions.md), `src/runtime-protocol.ts`, `src/runtime-coordinator.ts`, `src/delivery-outbox.ts`. Reuse their isolation and durable-evidence patterns; none makes cross-fleet Hub identity a local human receipt.
