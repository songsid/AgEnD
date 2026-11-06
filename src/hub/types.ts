/** Pure P1 interfaces from docs/design/hub.md; no initialization or runtime authority. */
export type HubId = string;       // random UUID, canonical lowercase
export type FleetId = string;     // same; names never substitute for IDs
export type ExposureId = string;
export type GrantId = string;
export type RoomId = string;
export type MessageId = string;
export type Epoch = number;       // nonnegative safe integer; never rolls back
export type Millis = number;      // integer UTC epoch milliseconds
export type Sha256 = string;      // 64 lowercase hex characters
import type { PersonKey } from "./directory/index.js";
export type { PersonKey, DirectoryPerson, SignInResult, Eligibility, HubDirectory, HubDirectoryConfig } from "./directory/index.js";
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
  capabilities?: readonly string[]; // only when the hello offered welcome-caps-v1
}
/** attachments-v1: a file carried with a question (Hub → member) or an answer (member → Hub). */
export interface HubAttachmentRef { id: string; name: string; size: number; mime: string; sha256: Sha256 }
export interface HubAttachmentChunk { id: string; offset: number; total: number; sha256: Sha256; data: string }
export interface HubExposureSnapshot {
  revision: Epoch; exposures: readonly HubExposure[];
}
/** quota-band-v1: member-derived, coarse and ephemeral. Exact usage never crosses the link. */
export interface HubQuota {
  band: "available" | "near_limit" | "exhausted" | "unknown";
  resetsAt?: Millis; // exhausted only; nearest reset rounded to five minutes
}
export interface HubExposureQuota { exposureId: ExposureId; quota: HubQuota }
export interface HubQuestion {
  text: string; identity: HubAskerEnvelope;
  attachments?: readonly HubAttachmentRef[]; // attachments-v1 links only
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
  attachments?: readonly HubAttachmentRef[]; // attachments-v1 links only; bound through contentDigest
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

export type HubMemberFrame =
  | HubFrame<"hello", HubHello>
  | HubFrame<"exposure.snapshot", HubExposureSnapshot>
  | HubFrame<"receipt", HubReceipt>
  | HubFrame<"answer", HubAnswer>
  | HubFrame<"reconcile", HubReconcile>
  | HubFrame<"authorize.request", HubAuthorizationRequest>
  | HubFrame<"error", HubProtocolError>
  | HubFrame<"attachment.get", { id: string; offset: number }>
  | HubFrame<"attachment.put", HubAttachmentChunk>
  | HubFrame<"exposure.quota", HubExposureQuota>;
export type HubServerFrame =
  | HubFrame<"welcome", HubWelcome>
  | HubFrame<"question", HubQuestion>
  | HubFrame<"receipt", HubReceipt> // acknowledgment of durably retained member evidence
  | HubFrame<"reconcile", HubReconcileReply>
  | HubFrame<"authorize.result", HubAuthorizationResult>
  | HubFrame<"revoke", HubRevocation>
  | HubFrame<"error", HubProtocolError>
  | HubFrame<"attachment.chunk", HubAttachmentChunk>
  | HubFrame<"attachment.ack", { id: string; offset: number }>;
export interface HubServerTransport {
  start(): Promise<void>;
  send(fleetId: FleetId, frame: HubServerFrame): Promise<void>;
  close(): Promise<void>;
}

export interface HubMemberTransport {
  start(): Promise<void>;
  send(frame: HubMemberFrame): Promise<void>;
  authorize(request: HubAuthorizationRequest): Promise<HubAuthorizationLease>;
  close(): Promise<void>;
}

export interface HubAskerEnvelope {
  v: 1; issuer: HubId; issuerKeyId: string; messageId: MessageId;
  asker: PersonKey; owner: PersonKey;
  destinationFleetId: FleetId; exposureId: ExposureId; roomId: RoomId;
  grantId: GrantId; grantRevision: Epoch; exposureRevision: Epoch;
  revocationVersion: Epoch; contentDigest: Sha256;
  issuedAt: Millis; expiresAt: Millis; nonce: string;
  signature: string; // Ed25519 detached signature, unpadded base64url
}

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
export type { HubInitPlan, HubInitializer, HubInitInspection, HubInitSecrets, HubInitConfirmation, HubInitResult,
  HubListen, HubIdentityProvider, HubIdentitySummary, HubCoexistence } from "./init/types.js";
