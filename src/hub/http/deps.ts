/**
 * AgEnD Hub P1, slice 3 (server side): what S5's server factory hands `createHubHttp` (docs/design/hub-composition.md §5
 * step 5, agreed with S5 on cid-hub-s3b-deps). Types only — importing this file creates no state.
 */
import type Database from "better-sqlite3";
import type { HubAskerEnvelope, HubAuditSink, HubDirectory, HubMode, HubServerTransport, HubTx, HubUnitOfWork, PersonKey } from "../types.js";
import type { HubPairingService } from "../pairing.js";
import type { HubTransportStore } from "../store.js";
import type { HubAnswerButtons } from "../types.js";
import type { HubPollBallot } from "../types.js";

/** The `hub` section the sealed manifest covers — frozen, validated, never re-read from a request. */
export interface HubHttpConfig {
  readonly hubId: string;
  readonly name: string;
  readonly memberOrigin: string;
  readonly webOrigin: string;
  readonly administrator: PersonKey;
}
/** S1's `signAsker` over `hub/keys/issuer-key.pem`; S3 never opens a key file. */
export interface HubIssuer {
  readonly keyId: string;
  sign(envelope: Omit<HubAskerEnvelope, "signature">): HubAskerEnvelope;
}
/** Encrypted question/answer payloads (S5, under content.key). One payload per record; S5 chooses the ref. */
export interface HubContentStore {
  put(tx: HubTx, payload: { question?: string; answer?: string; buttons?: HubAnswerButtons; pollBallot?: HubPollBallot }): string;
  /** S3's own room projection only, after its audience check. Undefined: retention removed it (shown as expired). */
  get(ref: string): { question?: string; answer?: string; buttons?: HubAnswerButtons; pollBallot?: HubPollBallot } | undefined;
}
export interface HubHttpDeps {
  /** Track A's optional host adapter; absent means the room assistant is disabled. */
  roomAssistant?: import("../rooms/types.js").RoomAssistantPort;
  /** Structural admin port until the host service's typed DTO module lands; it owns validation and worker drain. */
  assistantAdmin?: {
    settings(): Promise<unknown>; configure(value: unknown): Promise<unknown>;
    usage(): Promise<unknown>; stopRoom(roomId: string): Promise<void>;
  };
  directorySettings?: () => Promise<import("../settings-directory-control.js").HubDirectorySettingsControl>;
  uow: HubUnitOfWork;
  audit: HubAuditSink;
  directory: HubDirectory;
  /** One physical admission owner shared with policy, management and mount reads. */
  directoryReads?: import("../directory/admission.js").HubDirectoryReads;
  pairing: HubPairingService;
  companyJoin?: import("../join/service.js").HubCompanyJoin;
  /** Server-owned group permits; absent only in legacy injected compositions. */
  groups?: import("../group-policy/authorization.js").HubGroupAuthorization;
  management?: Pick<import("../roles/authority.js").HubManagementAuthority, "require">;
  /**
   * #3298 S-89: Administration → Group permissions and the signed-in welcome. Composed only with S-88's complete control; absent,
   * the routes answer 404 and the session carries no "group-policy-v1" mark (the pages show nothing of it).
   */
  groupHttp?: import("../group-policy/admin-api.js").GroupHttpDeps;
  /** Owner-grant suggestions and membership share the existing physical group-read admission. */
  grantDirectory?: {
    policy(): import("../group-policy/store.js").HubGroupPolicyStore;
    binding(): import("../group-policy/store.js").HubGroupPolicyBinding;
  };
  /** S-90: durable credential-transaction outbox, independent of a group's current operational allowance. */
  pairingNotices?: import("../pairing-notices.js").HubPairingNotices;
  /** Original security-notice recipients; independent of operational group or administrator permissions. */
  memberAddressNotices?: import("../settings-member-address-notices.js").HubMemberAddressNotices;
  directoryNotices?: Pick<import("../settings-directory-notices.js").HubDirectoryNotices, "forSession" | "acknowledgeSession">;
  store: HubTransportStore;
  /** Reconnect member links only after a committed authorization-version change. Absent: no resumable sharing. */
  refreshAuthorization?(): void;
  config: HubHttpConfig;
  /** M-2682: Administration → This Hub — what it is (read-only) and, with the host's writer, its rename. Absent: 404. */
  hubSettings?: Readonly<Omit<import("../settings-api.js").HubSettingsHttpDeps, "name">>;
  preview?: Readonly<import("../preview.js").HubPreviewView>;
  issuer: HubIssuer;
  /** Re-read on every use: null before HubServer exists and after fence/close — then work is unavailable, never queued. */
  transport(): Pick<HubServerTransport, "send"> | null;
  content: HubContentStore;
  /** attachments-v1 files (absent: this Hub stores none, and offers no upload). */
  attachments?: import("../attachments/store.js").HubAttachmentStore;
  /** The server's mode (S5): `serverEnabled()` false once fenced — every request and continuation refuses from then on. */
  current(): HubMode;
  now?: () => number;
  /** Private listener resource ownership; carries no session or directory authority. */
  directoryResponse?: import("../compose/server.js").HubHttpDeps["directoryResponse"];
}
/**
 * S5's `hubTxDatabase(tx)` (db.ts): the DB behind a tx, valid only while that tx's `atomic` callback runs. Passed in
 * until S5's db.ts lands, then imported by compose.ts.
 */
export type HubTxDatabase = (tx: HubTx) => Database.Database;
