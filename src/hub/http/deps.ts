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
  uow: HubUnitOfWork;
  audit: HubAuditSink;
  directory: HubDirectory;
  pairing: HubPairingService;
  store: HubTransportStore;
  config: HubHttpConfig;
  issuer: HubIssuer;
  /** Re-read on every use: null before HubServer exists and after fence/close — then work is unavailable, never queued. */
  transport(): Pick<HubServerTransport, "send"> | null;
  content: HubContentStore;
  /** attachments-v1 files (absent: this Hub stores none, and offers no upload). */
  attachments?: import("../attachments/store.js").HubAttachmentStore;
  /** The server's mode (S5): `serverEnabled()` false once fenced — every request and continuation refuses from then on. */
  current(): HubMode;
  now?: () => number;
}
/**
 * S5's `hubTxDatabase(tx)` (db.ts): the DB behind a tx, valid only while that tx's `atomic` callback runs. Passed in
 * until S5's db.ts lands, then imported by compose.ts.
 */
export type HubTxDatabase = (tx: HubTx) => Database.Database;
