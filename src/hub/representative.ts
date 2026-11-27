import {requestHubQuestionMatches} from "../request-hub-output.js";
import {freezeHubRequestSnapshot,type HubRequestSnapshotV1} from "../request-hub-context.js";
import type { HubHeldCloseOutcome } from "./question-close-model.js";
import { HUB_QUESTION_CLOSE_CAPABILITY, questionCloseResultSchema } from "./question-close-model.js";
/**
 * Hub P1 representative agent (docs/design/hub-representative-agent.md): the member's only execution path. An admitted
 * Hub question goes to the existing fleet agent the owner published, through ordinary cross-instance delivery; the
 * agent answers with report_result on the Hub-issued correlation id. No sandbox, provider, view or per-asker session.
 *
 * The adapter is S1's journal outbox (the source row is written in the journal's own admission transaction) and the
 * driver after it: begin lease + input intent immediately before the IPC hand-off (FleetManager's beforeInput), delivery
 * evidence, the frozen answer under the exact release lease, and the receipts/answer frames back over the member link.
 * Never a resend: an interrupted or uncertain hand-off holds in Needs-you.
 */
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { canonicalArguments, messageContentDigest, personKeyString, sha256 } from "./identity.js";
import { HubFileRefusal, type HubMemberFiles } from "./member/attachments.js";
import { questionContextDigest, type HubMemberJournal, type HubRestrictedOutbox } from "./member-journal.js";
import { answerSchema, questionSchema } from "./protocol.js";
import { buttonsDigest, prepareHubAnswerButtons } from "./buttons-model.js";
import { HubProtocolError, plain, validated } from "./validation.js";
import type { HubAnswer, HubAuthorizationLease, HubAuthorizationRequest, HubQuestion, HubReceipt, HubServerFrame, HubMemberFrame } from "./types.js";
import type { HubLocalExposure, HubExecutionReadiness } from "./execution/service.js";
import type { HubExecutionAttentionInput } from "../needs-you.js";

/** The S3 agent tuple (one copy, S3c's): routing, readiness and the store can never disagree. */
export { HUB_AGENT_MODE as HUB_AGENT_PROVIDER, agentPolicyDigest, isAgentDescriptor as isAgentTuple } from "./member/agent-mode.js";
import { isAgentDescriptor as isAgentTuple } from "./member/agent-mode.js";
/** The reserved report_result target for Hub answers. Only a live Hub-issued correlation id from its agent matches. */
export { HUB_REPORT_TARGET, type HubReportOutcome } from "../hub-report-target.js";
import { HUB_ANSWER_HELD, HUB_ANSWER_SENDING, HUB_ANSWER_USED, HUB_REPORT_TARGET, type HubReportExtras, type HubReportOutcome } from "../hub-report-target.js";
export const HUB_ANSWER_MAX = 128 * 1024;
const HELD_MAX = 256;
/** M-3632: waits before asking the Hub again after it could not answer before input; one more try each, then a hold. */
export const HUB_BEGIN_RETRY_MS: readonly number[] = [2_000, 10_000, 30_000];
/** M-3632: holds that may be tried again from Needs you: nothing reached the agent, so asking the Hub again is safe. */
const RETRYABLE_HOLDS: ReadonlySet<string> = new Set(["unavailable", "stale", "files-unavailable"]);
/**
 * M-3632: a refusal before input that asking again can change — the Hub (or its link) could not answer just now. A Hub
 * refusal that is a decision (revoked, denied, expired, not found, conflict, invalid) is not.
 */
function transientBeforeInput(err: unknown): boolean {
  const e = err as { code?: unknown; reasonCode?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (e.code === "unavailable" || e.code === "stale") return true;            // no ready link / the link changed under it
  if (e.code === "denied") return e.reasonCode === "unavailable" || e.reasonCode === "backpressure";
  return e instanceof HubProtocolError && ["unavailable", "backpressure", "timeout"].includes(e.code);
}
class HubButtonRefusal extends Error {}

export function migrateHubRepresentative(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS hub_representative_questions(
      source TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, message_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL,
      exposure_id TEXT NOT NULL, revision INTEGER NOT NULL, consent_id TEXT NOT NULL, agent TEXT NOT NULL, token TEXT NOT NULL,
      state TEXT NOT NULL, cid TEXT UNIQUE, answer TEXT, reason TEXT, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hub_representative_consents(consent_id TEXT PRIMARY KEY, agent TEXT NOT NULL, token TEXT NOT NULL);`);
}
export const HUB_REPRESENTATIVE_MIGRATION = Object.freeze({ component: "s5-representative", version: 1, up: migrateHubRepresentative });

type State = "queued" | "dispatching" | "input" | "delivered" | "answering" | "answered" | "released" | "held";
interface Row {
  source: string; id: string; message_id: string; digest: string; exposure_id: string; revision: number; consent_id: string;
  agent: string; token: string; state: State; cid: string | null; answer: string | null; reason: string | null; at: number;
}
const LIVE: readonly State[] = ["queued", "dispatching", "input", "delivered", "answering"];
/** A saved answer whose transmission or acknowledgement failed is held too (visible), never resent. */
const HOLDABLE: readonly State[] = [...LIVE, "answered"];

/** The member binding as createMemberBinding() hands it out (captured per call). */
export interface HubRepresentativeBinding {
  fleetId: string; owner: { realm: string; objectId: string }; linkEpoch: number; revocationVersion: number; current(): boolean;
}
export interface HubRepresentativeLink {
  linkEpoch: number; current(): boolean;
  /** The link's enabled optional features (attachments-v1 …); absent or empty: none. */
  readonly features?: ReadonlySet<string>;
  exchange(frame: HubMemberFrame, responseType: HubServerFrame["type"]): Promise<HubServerFrame>;
}
export interface HubRepresentativeDelivery {
  agent: string; correlationId: string; text: string;
  contactLimit?: boolean;
  /** G: immutable accepted identity only; never a live turn or permission. */
  acceptedHubRequest?: HubRequestSnapshotV1;
  /** M-3122: internal room-only generation; a daemon confirms the actual input independently of IPC acceptance. */
  roomContextGeneration?: string;
  /** Signed historical room author, not authority or an active-turn claim. */
  verifiedHubAsker?: import("./room-asker-identity-model.js").VerifiedHubAsker;
  roomAskerMessageId?: string;
  roomAskerDestination?: import("./room-asker-identity-model.js").RoomAskerDestination;
  /** Run by the fleet immediately before the IPC hand-off; false sends nothing. */
  beforeInput(): Promise<boolean>;
  /** Final owned input may run after IPC handoff; this is distinct from the pre-handoff dispatch fence. */
  inputCurrent?():boolean;
  /** The fleet's own fence through wake/idle/hand-off. */
  stillCurrent(): boolean;
}
export interface HubRepresentativeOptions {
  hubId?:string;
  db: Database.Database;
  journal: HubMemberJournal;
  binding(): HubRepresentativeBinding;
  /** The committed local mapping (null: none or withdrawn). */
  localExposure(id: string): HubLocalExposure | null;
  /** The agent's current lifecycle token (name generation, backend, folder…); null: not a deliverable agent now. */
  agentToken(agent: string): string | null;
  authorize(request: HubAuthorizationRequest): Promise<HubAuthorizationLease>;
  /** The member link, once a handshake completed on it (null: offline). */
  link(): HubRepresentativeLink | null;
  deliver(input: HubRepresentativeDelivery): Promise<boolean>;
  /** S-244: while an update barrier is up, a queued question stays queued. No begin lease and no input intent. */
  updateHeld?: () => boolean;
  /** attachments-v1 files: into the agent's inbox for a question, out of the agent's own paths for an answer. */
  files?: HubMemberFiles;
  audit(event: { action: string; result: "completed" | "held" | "denied"; messageId?: string; exposureId?: string; reasonCode?: string }, db: Database.Database): void;
  attentionChanged(): void;
  log(level: "info" | "warn", message: string, meta?: Record<string, unknown>): void;
  now?: () => number;
  /** M-3632: the waits before asking the Hub again after it could not answer before input (default HUB_BEGIN_RETRY_MS). */
  beginRetryMs?: readonly number[];
  /** M-3594: the asker's display name the Hub sent with this question (asker-name-v1), if it is still in memory. */
  askerName?(messageId: string): string | undefined;
  directRooms?:import("./member/direct-rooms.js").HubDirectRooms;
}

/** M-3594: the Hub's display names for 1:1 askers, by message id, in memory only (bounded; a restart forgets them and the
 * header falls back to the id alone). Never persisted: the journal keeps the question as older builds parse it. */
export class HubAskerNames {
  private readonly names = new Map<string, string>();
  constructor(private readonly max = 1024) {}
  remember(messageId: string, name: string): void {
    this.names.delete(messageId);
    while (this.names.size >= this.max) this.names.delete(this.names.keys().next().value!);
    this.names.set(messageId, name);
  }
  get(messageId: string): string | undefined { return this.names.get(messageId); }
}


export class HubRepresentativeExecution {
  private closed = false;
  private recovered = false;
  private readonly running = new Set<string>();
  /** M-3632: automatic re-asks so far by row id, and the wait before the next (memory only; a restart starts over). */
  private readonly retries = new Map<string, { attempts: number; timer: NodeJS.Timeout | null }>();
  private receiptsTail: Promise<void> = Promise.resolve();
  constructor(private readonly options: HubRepresentativeOptions) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private row(where: "source" | "cid" | "message_id" | "id", value: string): Row | null {
    return (this.options.db.prepare(`SELECT * FROM hub_representative_questions WHERE ${where}=?`).get(value) as Row | undefined) ?? null;
  }
  private setState(row: Row, state: State, from: readonly State[], extra: { reason?: string | null; cid?: string | null; answer?: string } = {}): boolean {
    const db = this.options.db;
    const result = db.prepare(`UPDATE hub_representative_questions SET state=?, at=?${extra.reason !== undefined ? ", reason=@reason" : ""}${extra.cid !== undefined ? ", cid=@cid" : ""}${extra.answer !== undefined ? ", answer=@answer" : ""}
      WHERE id=@id AND state IN (${from.map(s => `'${s}'`).join(",")})`)
      .run(state, this.now(), { id: row.id, ...(extra.reason !== undefined ? { reason: extra.reason } : {}), ...(extra.cid !== undefined ? { cid: extra.cid } : {}), ...(extra.answer !== undefined ? { answer: extra.answer } : {}) });
    if (result.changes !== 1) return false;
    row.state = state; if (extra.cid !== undefined) row.cid = extra.cid; if (extra.reason !== undefined) row.reason = extra.reason;
    return true;
  }

  /** The exposure, consent and agent lifecycle the question was admitted under — all still exactly current. */
  private currentFor(row: Row): boolean {
    if (this.closed) return false;
    const b = this.options.binding();
    if (!b.current()) return false;
    const local = this.options.localExposure(row.exposure_id);
    if (!local || local.exposure.state !== "published" || local.exposure.revision !== row.revision || local.consentId !== row.consent_id
      || local.agent !== row.agent || !isAgentTuple(local) || local.exposure.fleetId !== b.fleetId || personKeyString(local.exposure.owner) !== personKeyString(b.owner)) return false;
    return this.consentToken(row.consent_id) === row.token && this.options.agentToken(row.agent) === row.token;
  }
  private consentToken(consentId: string): string | null {
    return (this.options.db.prepare("SELECT token FROM hub_representative_consents WHERE consent_id=?").get(consentId) as { token: string } | undefined)?.token ?? null;
  }
  private fenceOf(row: Row): { current(): boolean; linkEpoch: number; revocationVersion: number } {
    const b = this.options.binding();
    return { current: () => b.current() && this.currentFor(row), linkEpoch: b.linkEpoch, revocationVersion: b.revocationVersion };
  }

  /** Readiness for a published mapping: the agent tuple, this owner/fleet, the agent deliverable now. */
  readiness(exposureId: string, expectedRevision: number): HubExecutionReadiness {
    const local = this.options.localExposure(exposureId);
    if (!local || local.exposure.state !== "published" || local.exposure.revision !== expectedRevision) return { ok: false, reasonCode: "stale" };
    return this.ready(local);
  }
  /**
   * Capability check for a candidate. S3c asks it again inside the atomic publish transaction: there (only), the agent's
   * current lifecycle token is recorded against the candidate's consent id, so a later replacement, retarget or mode
   * change no longer matches it and needs an explicit republish.
   */
  readinessCandidate(candidate: HubLocalExposure): HubExecutionReadiness {
    if (candidate.exposure.state !== "withdrawn") return { ok: false, reasonCode: "policy-unavailable" };
    const ready = this.ready(candidate);
    if (ready.ok && this.options.db.inTransaction) {
      this.options.db.prepare("INSERT INTO hub_representative_consents VALUES(?,?,?) ON CONFLICT(consent_id) DO UPDATE SET agent=excluded.agent, token=excluded.token")
        .run(candidate.consentId, candidate.agent, this.options.agentToken(candidate.agent));
    }
    return ready;
  }
  private ready(local: HubLocalExposure): HubExecutionReadiness {
    if (!isAgentTuple(local)) return { ok: false, reasonCode: "policy-unavailable" };
    const b = this.options.binding();
    if (local.exposure.fleetId !== b.fleetId || personKeyString(local.exposure.owner) !== personKeyString(b.owner)) return { ok: false, reasonCode: "stale" };
    if (this.options.agentToken(local.agent) === null) return { ok: false, reasonCode: "provider-unavailable" };
    return { ok: true, policyDigest: local.exposure.policyDigest, exposureRevision: local.exposure.revision };
  }
  /** No provider exists in P1: nothing to explain. */
  providerReason(): null { return null; }

  /** S1's journal outbox: the unique source row, in the journal's own admission transaction. */
  restrictedOutbox(): HubRestrictedOutbox {
    const db = this.options.db;
    const checkSource = (q: HubQuestion, source: string) => {
      if (source !== `hub:${q.identity.issuer}:${q.identity.messageId}`) throw new HubProtocolError("denied");
    };
    return {
      insert: (tx, question, source) => {
        if (this.closed || !this.recovered) throw new HubProtocolError("unavailable");
        if (tx !== db || !db.inTransaction) throw new HubProtocolError("denied");
        const q = validated(questionSchema, question); checkSource(q, source);
        const local = this.options.localExposure(q.identity.exposureId);
        if (!local || local.exposure.state !== "published" || local.exposure.revision !== q.identity.exposureRevision || !isAgentTuple(local)) throw new HubProtocolError("denied");
        const token = this.options.agentToken(local.agent);
        if (token === null || this.consentToken(local.consentId) !== token) throw new HubProtocolError("denied");
        if ((db.prepare("SELECT COUNT(*) AS n FROM hub_representative_questions WHERE state IN ('queued','dispatching','input','delivered','answering')").get() as { n: number }).n >= 4096) {
          throw new HubProtocolError("backpressure");
        }
        const id = randomUUID();
        db.prepare("INSERT INTO hub_representative_questions(source,id,message_id,digest,exposure_id,revision,consent_id,agent,token,state,at) VALUES(?,?,?,?,?,?,?,?,?,'queued',?)")
          .run(source, id, q.identity.messageId, questionContextDigest(q), local.exposure.id, local.exposure.revision, local.consentId, local.agent, token, this.now());
        this.options.audit({ action: "representative.queued", result: "completed", messageId: q.identity.messageId, exposureId: local.exposure.id }, db);
        // Delivery starts only after the admission transaction commits (a rolled-back insert leaves no row to find).
        setImmediate(() => this.pump());
        return id;
      },
      lookup: (tx, question, source) => {
        if (tx !== db) throw new HubProtocolError("denied");
        checkSource(question, source);
        const row = this.row("source", source);
        if (row && row.digest !== questionContextDigest(question)) throw new HubProtocolError("conflict");
        return row?.id ?? null;
      },
    };
  }

  /**
   * Startup. The journal's own recovery runs first (queued + input intent → uncertain). Then a row that was dispatching
   * goes back to the queue ONLY if the journal still has it queued with no input intent (a crash between the intent and
   * the representative's own transition is uncertain and held, never a fresh queue item); anything past it is held.
   */
  recover(): void {
    if (this.recovered) throw new HubProtocolError("conflict");
    const db = this.options.db;
    this.options.journal.recoverInterruptedInputs();
    for (const row of db.prepare("SELECT * FROM hub_representative_questions WHERE state IN ('dispatching','input','delivered','answering','answered')").all() as Row[]) {
      let untouched = false;
      if (row.state === "dispatching") { try { this.question(row); untouched = true; } catch { untouched = false; } }
      if (untouched) db.prepare("UPDATE hub_representative_questions SET state='queued', cid=NULL WHERE id=? AND state='dispatching'").run(row.id);
      else this.hold(row, "uncertain");
    }
    this.recovered = true;
    this.options.attentionChanged();
  }

  /**
   * Deliver queued questions the link can authorize now (after commits, on each completed handshake, and again as each
   * dispatch settles, so a backlog larger than one page keeps draining). Input-bearing work is never picked up again.
   */
  pump(): void {
    if (this.closed || !this.recovered || !this.options.link() || this.options.updateHeld?.()) return;
    let rows: Row[];
    try { rows = this.options.db.prepare("SELECT * FROM hub_representative_questions WHERE state='queued' ORDER BY at LIMIT 64").all() as Row[]; }
    catch (err) { this.options.log("warn", "Hub question queue could not be read", { err: String(err) }); return; }
    for (const row of rows) {
      if (this.running.has(row.id) || this.retries.get(row.id)?.timer) continue;   // M-3632: still waiting to ask again
      this.running.add(row.id);
      void this.dispatch(row).catch((err: unknown) => {
        this.options.log("warn", "Hub question delivery failed", { messageId: row.message_id, err: String(err) });
        this.uncertain(row, err);
      }).finally(() => {
        this.running.delete(row.id);
        if (!this.closed) setImmediate(() => this.pump());
      });
    }
  }

  /** The row's current state from the database (another path — fence, report — may have moved it). */
  private refresh(row: Row): State {
    const now = this.row("id", row.id);
    row.state = now?.state ?? "held";
    return row.state;
  }

  private async dispatch(row: Row): Promise<void> {
    if (this.options.updateHeld?.()) return;
    if (!this.currentFor(row)) { this.hold(row, "stale"); return; }
    const cid = `hub-${randomUUID()}`;
    if (!this.setState(row, "dispatching", ["queued"], { cid })) return;
    const question = this.question(row);
    const e = question.identity;
    // M-3594: the name comes from the Hub's directory (as in rooms), never from the asker; the id stays the stable key.
    const askerName = this.options.askerName?.(row.message_id);
    let acceptedHubRequest:HubRequestSnapshotV1|undefined;
    // The digest-checked question is still queued/readable here. Unsupported shared-schema ids leave no capture,
    // preserving ordinary OFF behavior; explicit scoped preparation later refuses instead of guessing.
    try {acceptedHubRequest=freezeHubRequestSnapshot({version:1,kind:"direct",messageId:e.messageId,roomId:e.roomId,exposureId:e.exposureId,
      actor:{kind:"person",platform:"hub",hubId:e.issuer,id:personKeyString(e.asker),...(askerName?{displayName:askerName}:{})},
      destination:{agent:row.agent,exposureId:row.exposure_id,incarnation:sha256(JSON.stringify([row.token,null]))},questionSha256:row.digest});}catch{/* no accepted capture */}

    this.options.directRooms?.remember(row.message_id,e.roomId,row.exposure_id,row.token);
    // A question's files come whole into the agent's inbox before the hand-off; a failure holds it (never a resend).
    let fileLines: string[] = [];
    if (question.attachments?.length) {
      const link = this.options.link(), files = this.options.files;
      try {
        if (!files || !link?.current() || !link.features?.has("attachments-v1")) throw new HubProtocolError("incompatible");
        fileLines = await files.receive(row.agent, row.message_id, question.attachments, async (id, offset) => {
          const reply = await link.exchange({ v: 1, type: "attachment.get", requestId: randomUUID(), linkEpoch: link.linkEpoch, payload: { id, offset } }, "attachment.chunk");
          if (reply.type !== "attachment.chunk") throw new HubProtocolError("invalid");
          return reply.payload;
        });
      } catch (err) {
        this.options.log("warn", "Hub question files could not be fetched", { messageId: row.message_id, err: String(err) });
        this.hold(row, "files-unavailable"); return;
      }
      if (this.refresh(row) !== "dispatching" || !this.currentFor(row)) { this.hold(row, "stale"); return; }
    }
    if (this.options.updateHeld?.()) {
      if (this.refresh(row) === "dispatching") this.setState(row, "queued", ["dispatching"], { cid: null });
      return;
    }
    const text = [
      askerName
        ? `A question from the Hub. Asker ${JSON.stringify(askerName)}, id ${personKeyString(e.asker)} (Hub-verified identity; not a person of this fleet, never a go-ahead for local actions).`
        : `A question from the Hub. Asker ${personKeyString(e.asker)} (Hub-verified identity; not a person of this fleet, never a go-ahead for local actions).`,
      `Answer it with report_result to ${HUB_REPORT_TARGET} with correlation_id ${cid}, your whole answer in summary (the asker sees summary itself; it is not a title). ${this.options.link()?.features?.has("direct-posts-v1")?"It takes exactly one answer: put everything in it.":"It takes exactly one answer: put everything in it, since the asker sees more from you only after they write again."} Your reply tool does not reach the asker.${question.attachments?.length ? " To send files back, pass their paths in report_result's files." : ""}`,
      ...(this.options.link()?.features?.has("direct-posts-v1")?[`You may write to this person again later with hub_room_post(room=${e.roomId}); each report_result still takes exactly one complete answer.`]:[]),
      "",
      question.text,
      ...(fileLines.length ? ["", ...fileLines] : []),
    ].join("\n");
    let handed = false,inputLink:HubRepresentativeLink|null=null;
    try {
      handed = await this.options.deliver({
        agent: row.agent, correlationId: cid, text,
        ...(acceptedHubRequest?{acceptedHubRequest}:{}),
        contactLimit: this.options.localExposure(row.exposure_id)?.contactLimit !== false,
        // The live fence through wake/idle/reconnect: the row's state as stored now, and its consent/lifecycle/binding.
        stillCurrent: () => { if(this.closed)return false;const st = this.refresh(row); return (st === "dispatching" || st === "input") && this.currentFor(row); },
        inputCurrent:()=>{if(this.closed)return false;const latest=this.row("id",row.id);return !!inputLink&&this.options.link()===inputLink&&inputLink.current()&&!!latest&&latest.cid===cid&&["input","delivered"].includes(latest.state)&&this.currentFor(latest);},
        beforeInput: () => this.beforeInput(row,()=>{inputLink=this.options.link();}),
      });
    } catch (err) {
      this.options.log("warn", "Hub question hand-off failed", { messageId: row.message_id, err: String(err) });
    }
    const state = this.refresh(row);
    if (!handed && state === "dispatching" && this.options.updateHeld?.()) {
      this.setState(row, "queued", ["dispatching"], { cid: null });
      return;
    }
    if (handed && state === "input") {
      // Handed to the agent's daemon: local state only. The journal's delivered/consumed evidence waits for the agent's
      // own report (queue acceptance is not delivery); a pane that never takes it is reported back (deliveryFailed).
      if (!this.setState(row, "delivered", ["input"])) return;
      try { this.auditRequired(row, "representative.handed", "completed"); } catch (err) { this.uncertain(row, err); }
      return;
    }
    if (handed) return; // already answering (the report overtook the hand-off result)
    if (state === "input") this.uncertain(row, new Error("the hand-off after the input intent did not complete"));
    else if (state === "dispatching") this.hold(row, "unavailable");
  }

  /** The fleet's last step before input (at the connected hand-off): consent and lifecycle again, the begin lease, spent at once. */
  private async beforeInput(row: Row,entered?:()=>void): Promise<boolean> {
    try {
      if (this.options.updateHeld?.()) return false;
      if (this.refresh(row) !== "dispatching" || !this.currentFor(row)) { this.hold(row, "stale"); return false; }
      const request: HubAuthorizationRequest = { messageId: row.message_id, operationId: randomUUID(), exposureRevision: row.revision, phase: "begin" };
      const lease = await this.options.authorize(request);
      if (this.refresh(row) !== "dispatching" || !this.currentFor(row)) { this.hold(row, "stale"); return false; }
      // authorize is the Hub round trip. The fence can rise during that await. Re-read it with no await before the
      // intent write. The row stays dispatching, so the caller queues it again: no input intent, and not uncertain.
      if (this.options.updateHeld?.()) return false;
      this.options.journal.markInputIntent(row.message_id, request, lease, this.fenceOf(row));
      if (!this.setState(row, "input", ["dispatching"])) throw new HubProtocolError("uncertain");
      this.forgetRetry(row.id);
      entered?.();
      return true;
    } catch (err) {
      // After the intent was written, a failed transition is uncertain (never re-queued); before it, a plain hold.
      let intent = false;
      try { this.question(row); } catch { intent = true; }
      if (intent) { this.uncertain(row, err); this.options.log("warn", "Hub question held before input", { messageId: row.message_id, err: String(err) }); return false; }
      // M-3632: nothing reached the agent. When the Hub only could not answer, ask it again later (it re-checks everything);
      // a Hub decision, or still no answer after the last wait, is a hold the owner sees.
      const tried = this.retries.get(row.id)?.attempts ?? 0;
      const waits = this.options.beginRetryMs ?? HUB_BEGIN_RETRY_MS;
      if (transientBeforeInput(err) && tried < waits.length && this.setState(row, "queued", ["dispatching"], { cid: null })) {
        const delay = waits[tried]!, wait = { attempts: tried + 1, timer: null as NodeJS.Timeout | null };
        wait.timer = setTimeout(() => { wait.timer = null; if (!this.closed) this.pump(); }, delay); wait.timer.unref?.();
        this.retries.set(row.id, wait);
        this.options.log("info", "Hub question will ask the Hub again", { messageId: row.message_id, attempt: tried + 1, inMs: delay, err: String(err) });
        return false;
      }
      // A Hub decision is "refused" (Try again would only be refused again); anything else that never got an answer is "unavailable".
      const decided = (err as { code?: unknown } | null)?.code === "denied" && !transientBeforeInput(err);
      this.hold(row, decided ? "refused" : "unavailable");
      this.options.log("warn", "Hub question held before input", { messageId: row.message_id, attempts: tried, err: String(err) });
      return false;
    }
  }

  private directFollowUp(row:Row):string|undefined {
    if(!this.currentFor(row)||!this.options.link()?.current()||!this.options.link()?.features?.has("direct-posts-v1"))return;
    const room=this.options.directRooms?.room(row.message_id);
    return room?`To send this person a new message, use hub_room_post(room=${room}).`:undefined;
  }

  /**
   * The outbound hook: a report_result to HUB_REPORT_TARGET. Returns null when the correlation id is not a live Hub id
   * issued to this caller (the call then takes its ordinary route); otherwise consumes it once and releases the answer.
   * callerCurrent: the reporting daemon generation is still the agent's current one (asked again before every release step).
   */
  report(input: { correlationId: string; caller: string; text: string; callerCurrent?: () => boolean; requestScope?:import("../request-hub-output.js").RequestHubOutputScope; extras?: HubReportExtras }): Promise<HubReportOutcome> | null {
    if (this.closed || !input.correlationId.startsWith("hub-")) return null;
    const row = this.row("cid", input.correlationId);
    if (!row || row.agent !== input.caller) return null;
    const scopeCurrent=()=>requestHubQuestionMatches(input.requestScope,this.options.hubId,row.message_id,row.agent);
    if(!scopeCurrent())return Promise.resolve({ok:false,message:"Not sent: this reply must stay in its original Hub conversation."});
    const was = row.state;
    // Consume once, synchronously: a second report on the same id finds it no longer live.
    if (!this.setState(row, "answering", ["input", "delivered"])) {
      const state=this.refresh(row),hint=this.directFollowUp(row);
      return Promise.resolve({ok:false,message:state==="answering"?HUB_ANSWER_SENDING:state==="held"?HUB_ANSWER_HELD:hint?`Not sent: this Hub question already has its one answer. ${hint}`:HUB_ANSWER_USED});
    }
    return this.release(row, was, input.text, () => scopeCurrent() && (input.callerCurrent?.() ?? true), input.extras ?? {});
  }

  private async release(row: Row, was: State, raw: string, callerCurrent: () => boolean, extras: HubReportExtras): Promise<HubReportOutcome> {
    let saved = false, evidenced = false, disclosed = false;
    const live = () => {
      if (!callerCurrent() || this.refresh(row) !== (saved ? "answered" : "answering") || !this.currentFor(row)) throw new HubProtocolError("stale");
    };
    try {
      const text = validated(plain(HUB_ANSWER_MAX), raw);
      if (!text.trim()) throw new HubProtocolError("invalid");
      live();
      // Snapshot choices before any file or authorization await. They are part of the exact released answer.
      const buttons = prepareHubAnswerButtons(extras.buttons, extras.poll);
      const buttonLink = buttons ? this.options.link() : null;
      if (buttons && (!buttonLink?.current() || !buttonLink.features?.has("buttons-v1"))) throw new HubButtonRefusal();
      // The agent's files (D): copied under the reply tool's rule, then pushed to the Hub before the answer names them.
      let attachments: HubAnswer["attachments"];
      if (extras.files?.length) {
        const link = this.options.link(), files = this.options.files;
        if (!files || !link?.current() || !link.features?.has("attachments-v1")) throw new HubFileRefusal("this Hub can't receive files yet; answer with text only");
        const prepared = await files.prepare(row.agent, extras.files);
        live();
        for (const file of prepared) await files.send(file, async (chunk) => {
          live();
          const ack = await link.exchange({ v: 1, type: "attachment.put", requestId: randomUUID(), linkEpoch: link.linkEpoch, payload: chunk }, "attachment.ack");
          if (ack.type !== "attachment.ack" || ack.payload.id !== chunk.id || ack.payload.offset !== chunk.offset) throw new HubProtocolError("uncertain");
        });
        attachments = prepared.map(f => f.ref);
        live();
      }
      if (buttons && (!buttonLink?.current() || this.options.link() !== buttonLink || !buttonLink.features?.has("buttons-v1"))) throw new HubProtocolError("stale");
      evidenced = true;
      const journal = this.options.journal;
      // The agent's own report is the evidence that the question reached it and was taken up.
      journal.recordEvidence(row.message_id, "delivered");
      journal.recordEvidence(row.message_id, "consumed");
      // F: buttons/poll join here (their payload field and buttonsDigest into messageContentDigest).
      // Freeze the answer's id, bytes and digest before asking for the release lease for exactly them.
      const answerId = randomUUID(), contentDigest = messageContentDigest("answer", text, { attachments, buttonsDigest: buttonsDigest(buttons) });
      this.options.db.prepare("UPDATE hub_representative_questions SET answer=? WHERE id=?").run(JSON.stringify({ answerId, contentDigest }), row.id);
      live();
      const request: HubAuthorizationRequest = { messageId: row.message_id, operationId: randomUUID(), exposureRevision: row.revision, phase: "release-answer", answer: { answerId, contentDigest } };
      const releaseLease = await this.options.authorize(request);
      live();
      if (buttons && (!buttonLink?.current() || this.options.link() !== buttonLink || !buttonLink.features?.has("buttons-v1"))) throw new HubProtocolError("stale");
      const answer: HubAnswer = validated(answerSchema, { messageId: row.message_id, answerId, text, contentDigest, releaseLease,
        ...(attachments?.length ? { attachments } : {}), ...(buttons ? { buttons } : {}) });
      // Required audit BEFORE anything is saved or disclosed: its failure stops the release (held, nothing sent).
      this.auditRequired(row, "representative.release", "completed");
      journal.saveAnswer(answer, request, this.fenceOf(row));
      saved = true;
      if (!this.setState(row, "answered", ["answering"])) throw new HubProtocolError("stale");
      live();
      const link = this.options.link();
      if (!link || !link.current()) throw new HubProtocolError("unavailable");
      disclosed = true;
      const reply = await link.exchange({ v: 1, type: "answer", requestId: randomUUID(), linkEpoch: link.linkEpoch, payload: answer }, "receipt");
      if (reply.type !== "receipt" || reply.payload.messageId !== row.message_id || reply.payload.stage !== "answered") throw new HubProtocolError("uncertain");
      // The answered state and its audit commit together; a failure leaves a visible hold, never a silent success.
      this.options.db.transaction(() => {
        if (!this.setState(row, "released", ["answered"])) throw new HubProtocolError("stale");
        this.options.audit({ action: "representative.answered", result: "completed", messageId: row.message_id, exposureId: row.exposure_id }, this.options.db);
      }).immediate();
      this.pushReceipts();
      return { ok: true, message: "Delivered to the Hub asker." };
    } catch (err) {
      const code = err instanceof HubProtocolError ? err.code : "uncertain";
      if (!saved && !evidenced && err instanceof HubButtonRefusal) {
        this.setState(row, was === "input" ? "delivered" : was, ["answering"]);
        return { ok: false, message: "Not sent: this Hub can't send buttons yet. Report text only with the same correlation_id." };
      }
      if (!saved && !evidenced && err instanceof HubFileRefusal) {
        // A file the agent can fix (a state-dir path, a refused type, too large): the question stays open on the same id.
        this.setState(row, was === "input" ? "delivered" : was, ["answering"]);
        return { ok: false, message: `Not sent: ${err.message}. Report again with the same correlation_id.` };
      }
      if (!saved && code === "invalid" && !evidenced) {
        // A malformed report (empty or oversized) is the agent's to fix: the question stays open on the same id.
        this.setState(row, was === "input" ? "delivered" : was, ["answering"]);
        return { ok: false, message: `Not sent: the answer must be 1 to ${HUB_ANSWER_MAX} bytes of plain text. Report again with the same correlation_id.` };
      }
      this.uncertain(row, err);
      return { ok: false, message: disclosed
        ? "Sent to the Hub, but its acknowledgement is uncertain; it is not sent again. The owner sees it in Needs you."
        : "Not delivered to the Hub asker: the question is no longer open (withdrawn, revoked, replaced, or the Hub is unreachable). The owner sees it in Needs you." };
    } finally { this.options.attentionChanged(); }
  }

  /** Local evidence to the Hub, in order, each ACK recorded. A failure waits for the next handshake (it sends the rest). */
  private pushReceipts(): void {
    this.receiptsTail = this.receiptsTail.then(async () => {
      const link = this.options.link();
      if (!link || !link.current()) return;
      for (;;) {
        const page = this.options.journal.unackedReceipts({});
        if (!page.receipts.length) return;
        for (const receipt of page.receipts) {
          const reply = await link.exchange({ v: 1, type: "receipt", requestId: randomUUID(), linkEpoch: link.linkEpoch, payload: receipt }, "receipt");
          if (reply.type !== "receipt" || canonicalArguments(reply.payload) !== canonicalArguments(receipt)) throw new HubProtocolError("conflict");
          this.options.journal.acknowledge(receipt as HubReceipt);
        }
      }
    }).catch((err: unknown) => this.options.log("info", "Hub receipts wait for the next handshake", { err: String(err) }));
  }

  private question(row: Row): HubQuestion {
    // The journal's encrypted copy is the only question text this side keeps (readable only while queued, before input).
    const question = this.options.journal.queuedQuestion(row.message_id);
    if (questionContextDigest(question) !== row.digest) throw new HubProtocolError("uncertain");
    return question;
  }
  /** A required audit record (its own transaction): a failure throws to the caller. */
  private auditRequired(row: Row, action: string, result: "completed" | "held" | "denied", reasonCode?: string): void {
    this.options.db.transaction(() => this.options.audit({ action, result, messageId: row.message_id, exposureId: row.exposure_id, ...(reasonCode ? { reasonCode } : {}) }, this.options.db)).immediate();
  }
  /** A hold always lands (state first); its audit record is attempted and a failure is logged. */
  private hold(row: Row, reason: string): void {
    this.forgetRetry(row.id);
    if (!this.setState(row, "held", HOLDABLE, { reason })) return;
    try { this.auditRequired(row, "representative.held", "held", reason); }
    catch (err) { this.options.log("warn", "Hub audit append failed", { action: "representative.held", err: String(err) }); }
    this.options.attentionChanged();
  }
  private uncertain(row: Row, err: unknown): void {
    this.options.log("warn", "Hub question uncertain", { messageId: row.message_id, err: String(err) });
    // The journal can mark uncertain only before an answer was saved; a saved-but-unacknowledged answer stays answered there.
    try { if (["dispatching", "input", "delivered", "answering"].includes(this.refresh(row))) this.options.journal.recordEvidence(row.message_id, "uncertain"); }
    catch { /* already past the stages the journal can mark uncertain */ }
    this.hold(row, "uncertain");
    this.pushReceipts();
  }

  /** The agent's daemon could not get the question into its pane after accepting it: uncertain, never resent. */
  deliveryFailed(correlationId: string, agent: string): void {
    const row = correlationId.startsWith("hub-") ? this.row("cid", correlationId) : null;
    if (!row || row.agent !== agent || !["input", "delivered"].includes(row.state)) return;
    this.uncertain(row, new Error("the agent's pane did not take the question"));
  }

  /** Off / withdraw / revoke / link replacement for one message: its correlation id stops being live at once. */
  fence(messageId: string, reasonCode = "revoked"): void {
    const row = this.row("message_id", messageId);
    if (row) this.hold(row, reasonCode);
  }
  /** Already handed-off model work only; future queued asks must not deadlock the room-person input ahead of them. */
  /**
   * M-3660: whether this agent's question on `correlationId` is no longer being answered — held (withdrawn, revoked,
   * expired, replaced, uncertain) or released. null: not a question of this agent here. A held question asked again
   * (Needs you → Try again) is open again.
   */
  questionSettled(correlationId: string, agent: string): boolean | null {
    if (this.closed || !correlationId.startsWith("hub-")) return null;
    const row = this.row("cid", correlationId);
    if (!row || row.agent !== agent) return null;
    return row.state === "held" || row.state === "released";
  }
  hasOpenQuestion(agent:string):boolean {
    return !this.closed && !!this.options.db.prepare("SELECT 1 FROM hub_representative_questions WHERE agent=? AND state IN ('input','delivered','answering') LIMIT 1").get(agent);
  }
  attentionItems(): HubExecutionAttentionInput[] {
    const rows = this.options.db.prepare(`SELECT * FROM hub_representative_questions WHERE state='held' ORDER BY at DESC LIMIT ${HELD_MAX}`).all() as Row[];
    return rows.map(r => ({ id: `hold:${r.id}`, kind: "hold" as const, agent: r.agent, messageId: r.message_id, exposureId: r.exposure_id, since: r.at,
      close: true, ...(this.retryable(r) ? { retry: true } : {}) }));
  }
  /** M-3632: a held question that never reached the agent (the journal still holds it, no input intent) and was held for a reason asking again can change. */
  private retryable(row: Row): boolean {
    if (row.state !== "held" || !RETRYABLE_HOLDS.has(row.reason ?? "")) return false;
    try { this.question(row); return true; } catch { return false; }
  }
  /**
   * M-3632: Needs you → "Try again" on a held question. It goes back to the queue and through the whole hand-off again:
   * consent and lifecycle here, then the Hub's begin lease (the Hub re-checks the asker, grant and message). Nothing is
   * delivered without that lease; a real refusal is held again.
   */
  retryHeld(attentionId: string): "queued" | "not-found" | "not-retryable" {
    const id = attentionId.startsWith("hold:") ? attentionId.slice(5) : attentionId;
    const row = this.row("id", id);
    if (!row || row.state !== "held") return "not-found";
    if (!this.retryable(row) || !this.currentFor(row)) return "not-retryable";
    if (!this.setState(row, "queued", ["held"], { reason: null, cid: null })) return "not-found";
    this.forgetRetry(row.id);
    try { this.auditRequired(row, "representative.retry", "completed"); }
    catch (err) { this.options.log("warn", "Hub audit append failed", { action: "representative.retry", err: String(err) }); }
    this.options.attentionChanged();
    this.pump();
    return "queued";
  }
  private readonly closing = new Map<string, Promise<HubHeldCloseOutcome>>();
  /** Owner confirmation only. A missing acknowledgement keeps the card; a repeat asks the Hub about the same id. */
  closeHeld(attentionId: string): Promise<HubHeldCloseOutcome> {
    const id = attentionId.startsWith("hold:") ? attentionId.slice(5) : attentionId;
    const pending = this.closing.get(id); if (pending) return pending;
    const run = this.closeHeldOnce(id).finally(() => this.closing.delete(id));
    this.closing.set(id, run); return run;
  }
  private async closeHeldOnce(id: string): Promise<HubHeldCloseOutcome> {
    const row = this.row("id", id);
    if (!row || row.state !== "held") return "not-found";
    const binding = this.options.binding(), link = this.options.link();
    if (this.closed || !binding.current() || !link?.current()) return "unavailable";
    if (!link.features?.has(HUB_QUESTION_CLOSE_CAPABILITY)) return "unsupported";
    try {
      this.options.db.transaction(() => {
        this.options.audit({ action: "representative.close-requested", result: "completed", messageId: row.message_id, exposureId: row.exposure_id }, this.options.db);
        if (!this.setState(row, "held", ["held"], { reason: "owner-close-pending" })) throw new HubProtocolError("stale");
      }).immediate();
      this.forgetRetry(row.id); this.options.attentionChanged();
      const result = await link.exchange({ v: 1, type: "question.close", requestId: randomUUID(), linkEpoch: link.linkEpoch,
        payload: { messageId: row.message_id, exposureId: row.exposure_id } }, "question.close-result");
      if (this.closed || !binding.current() || !link.current() || this.options.link() !== link || result.type !== "question.close-result") return "unavailable";
      const reply = validated(questionCloseResultSchema, result.payload);
      if (reply.messageId !== row.message_id) throw new HubProtocolError("conflict");
      this.options.db.transaction(() => {
        this.options.audit({ action: "representative.closed", result: "completed", messageId: row.message_id, exposureId: row.exposure_id, reasonCode: reply.outcome }, this.options.db);
        if (!this.setState(row, "released", ["held"], { reason: "owner-declined" })) throw new HubProtocolError("stale");
      }).immediate();
      this.options.attentionChanged(); return reply.outcome;
    } catch {
      // No blind question/answer resend; the next explicit close is idempotent on the Hub.
      this.options.attentionChanged(); return "unavailable";
    }
  }
  private forgetRetry(id: string): void {
    const wait = this.retries.get(id);
    if (wait?.timer) clearTimeout(wait.timer);
    this.retries.delete(id);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const id of [...this.retries.keys()]) this.forgetRetry(id);
    await this.receiptsTail;
  }
}
