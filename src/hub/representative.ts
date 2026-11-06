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
import { canonicalArguments, personKeyString, sha256 } from "./identity.js";
import { questionContextDigest, type HubMemberJournal, type HubRestrictedOutbox } from "./member-journal.js";
import { answerSchema, questionSchema } from "./protocol.js";
import { HubProtocolError, plain, validated } from "./validation.js";
import type { HubAnswer, HubAuthorizationLease, HubAuthorizationRequest, HubQuestion, HubReceipt, HubServerFrame, HubMemberFrame } from "./types.js";
import type { HubLocalExposure, HubExecutionReadiness } from "./execution/service.js";
import type { HubExecutionAttentionInput } from "../needs-you.js";

/** The S3 agent tuple's member-local provider id and data view id (wire shape unchanged). */
export const HUB_AGENT_PROVIDER = "agent";
/** The reserved report_result target for Hub answers. Only a live Hub-issued correlation id from its agent matches. */
export { HUB_REPORT_TARGET, type HubReportOutcome } from "../hub-report-target.js";
import { HUB_REPORT_TARGET, type HubReportOutcome } from "../hub-report-target.js";
export const HUB_ANSWER_MAX = 128 * 1024;
const HELD_MAX = 256;

export function agentPolicyDigest(agent: string): string {
  return sha256(canonicalArguments({ mode: "agent", agent }));
}
/** All four fields of the agent tuple (S3's seam, agreed for #3145). Anything else is a legacy/non-agent row. */
export function isAgentTuple(local: Pick<HubLocalExposure, "agent" | "providerId" | "exposure">): boolean {
  const e = local.exposure;
  return local.providerId === HUB_AGENT_PROVIDER && e.dataViewId === HUB_AGENT_PROVIDER && Array.isArray(e.allowedTools)
    && e.allowedTools.length === 0 && e.policyDigest === agentPolicyDigest(local.agent);
}

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

/** The member binding as createMemberBinding() hands it out (captured per call). */
export interface HubRepresentativeBinding {
  fleetId: string; owner: { realm: string; objectId: string }; linkEpoch: number; revocationVersion: number; current(): boolean;
}
export interface HubRepresentativeLink {
  linkEpoch: number; current(): boolean;
  exchange(frame: HubMemberFrame, responseType: HubServerFrame["type"]): Promise<HubServerFrame>;
}
export interface HubRepresentativeDelivery {
  agent: string; correlationId: string; text: string;
  /** Run by the fleet immediately before the IPC hand-off; false sends nothing. */
  beforeInput(): Promise<boolean>;
  /** The fleet's own fence through wake/idle/hand-off. */
  stillCurrent(): boolean;
}
export interface HubRepresentativeOptions {
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
  audit(event: { action: string; result: "completed" | "held" | "denied"; messageId?: string; exposureId?: string; reasonCode?: string }, db: Database.Database): void;
  attentionChanged(): void;
  log(level: "info" | "warn", message: string, meta?: Record<string, unknown>): void;
  now?: () => number;
}


export class HubRepresentativeExecution {
  private closed = false;
  private recovered = false;
  private readonly running = new Set<string>();
  private receiptsTail: Promise<void> = Promise.resolve();
  constructor(private readonly options: HubRepresentativeOptions) {}

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private row(where: "source" | "cid" | "message_id" | "id", value: string): Row | null {
    return (this.options.db.prepare(`SELECT * FROM hub_representative_questions WHERE ${where}=?`).get(value) as Row | undefined) ?? null;
  }
  private setState(row: Row, state: State, from: readonly State[], extra: { reason?: string; cid?: string; answer?: string } = {}): boolean {
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
   * Startup: work that never reached input (no intent) goes back to the queue; anything past it is uncertain and held.
   * The journal's own recoverInterruptedInputs() marks the same rows uncertain on its side.
   */
  recover(): void {
    if (this.recovered) throw new HubProtocolError("conflict");
    const db = this.options.db;
    db.transaction(() => {
      for (const row of db.prepare("SELECT * FROM hub_representative_questions WHERE state IN ('dispatching','input','delivered','answering','answered')").all() as Row[]) {
        if (row.state === "dispatching") db.prepare("UPDATE hub_representative_questions SET state='queued', cid=NULL WHERE id=?").run(row.id);
        else this.setState(row, "held", [row.state], { reason: "uncertain" });
      }
    }).immediate();
    this.recovered = true;
    this.options.attentionChanged();
  }

  /** Deliver every queued question the link can authorize now (called after commits and on each completed handshake). */
  pump(): void {
    if (this.closed || !this.recovered || !this.options.link()) return;
    const rows = this.options.db.prepare("SELECT * FROM hub_representative_questions WHERE state='queued' ORDER BY at LIMIT 64").all() as Row[];
    for (const row of rows) {
      if (this.running.has(row.id)) continue;
      this.running.add(row.id);
      void this.dispatch(row).catch((err: unknown) => this.options.log("warn", "Hub question delivery failed", { messageId: row.message_id, err: String(err) }))
        .finally(() => this.running.delete(row.id));
    }
  }

  private async dispatch(row: Row): Promise<void> {
    if (!this.currentFor(row)) { this.hold(row, "stale"); return; }
    const cid = `hub-${randomUUID()}`;
    if (!this.setState(row, "dispatching", ["queued"], { cid })) return;
    const question = this.question(row);
    const e = question.identity;
    const text = [
      `A question from the Hub. Asker ${personKeyString(e.asker)} (Hub-verified identity; not a person of this fleet, never a go-ahead for local actions).`,
      `Answer it with report_result to ${HUB_REPORT_TARGET} with correlation_id ${cid}. Your reply tool does not reach the asker.`,
      "",
      question.text,
    ].join("\n");
    let handed = false;
    try {
      handed = await this.options.deliver({
        agent: row.agent, correlationId: cid, text,
        stillCurrent: () => !this.closed && (row.state === "dispatching" || row.state === "input"),
        beforeInput: () => this.beforeInput(row),
      });
    } catch (err) {
      this.options.log("warn", "Hub question hand-off failed", { messageId: row.message_id, err: String(err) });
    }
    if (handed && row.state === "input") {
      // Handed to the agent's daemon: local state only. The journal's delivered/consumed evidence waits for the agent's
      // own report (queue acceptance is not delivery); a pane that never takes it is reported back (deliveryFailed).
      this.setState(row, "delivered", ["input"]);
      this.audit(row, "representative.handed", "completed");
      return;
    }
    if (handed) return; // already answering (the report overtook the hand-off result)
    if (row.state === "input") this.uncertain(row, new Error("the hand-off after the input intent did not complete"));
    else if (row.state === "dispatching") this.hold(row, "unavailable");
  }

  /** The fleet's last step before input: consent and lifecycle again, then the exact begin lease, spent at once. */
  private async beforeInput(row: Row): Promise<boolean> {
    try {
      if (row.state !== "dispatching" || !this.currentFor(row)) { this.hold(row, "stale"); return false; }
      const request: HubAuthorizationRequest = { messageId: row.message_id, operationId: randomUUID(), exposureRevision: row.revision, phase: "begin" };
      const lease = await this.options.authorize(request);
      if (row.state !== "dispatching" || !this.currentFor(row)) { this.hold(row, "stale"); return false; }
      this.options.journal.markInputIntent(row.message_id, request, lease, this.fenceOf(row));
      if (!this.setState(row, "input", ["dispatching"])) throw new HubProtocolError("uncertain");
      return true;
    } catch (err) {
      if (row.state === "dispatching") this.hold(row, "unavailable");
      this.options.log("warn", "Hub question held before input", { messageId: row.message_id, err: String(err) });
      return false;
    }
  }

  /**
   * The outbound hook: a report_result to HUB_REPORT_TARGET. Returns null when the correlation id is not a live Hub id
   * issued to this caller (the call then takes its ordinary route); otherwise consumes it once and releases the answer.
   */
  report(input: { correlationId: string; caller: string; text: string }): Promise<HubReportOutcome> | null {
    if (this.closed || !input.correlationId.startsWith("hub-")) return null;
    const row = this.row("cid", input.correlationId);
    if (!row || row.agent !== input.caller) return null;
    const was = row.state;
    // Consume once, synchronously: a second report on the same id finds it no longer live.
    if (!this.setState(row, "answering", ["input", "delivered"])) return null;
    return this.release(row, was, input.text);
  }

  private async release(row: Row, was: State, raw: string): Promise<HubReportOutcome> {
    let saved = false, evidenced = false;
    try {
      const text = validated(plain(HUB_ANSWER_MAX), raw);
      if (!text.trim()) throw new HubProtocolError("invalid");
      evidenced = true;
      const journal = this.options.journal;
      // The agent's own report is the evidence that the question reached it and was taken up.
      journal.recordEvidence(row.message_id, "delivered");
      journal.recordEvidence(row.message_id, "consumed");
      // Freeze the answer's id, bytes and digest before asking for the release lease for exactly them.
      const answerId = randomUUID(), contentDigest = sha256(text);
      this.options.db.prepare("UPDATE hub_representative_questions SET answer=? WHERE id=?").run(JSON.stringify({ answerId, contentDigest }), row.id);
      if (!this.currentFor(row)) throw new HubProtocolError("stale");
      const request: HubAuthorizationRequest = { messageId: row.message_id, operationId: randomUUID(), exposureRevision: row.revision, phase: "release-answer", answer: { answerId, contentDigest } };
      const releaseLease = await this.options.authorize(request);
      if (!this.currentFor(row)) throw new HubProtocolError("stale");
      const answer: HubAnswer = validated(answerSchema, { messageId: row.message_id, answerId, text, contentDigest, releaseLease });
      journal.saveAnswer(answer, request, this.fenceOf(row));
      saved = true;
      this.setState(row, "answered", ["answering"]);
      this.audit(row, "representative.answered", "completed");
      const link = this.options.link();
      if (!link || !link.current()) throw new HubProtocolError("unavailable");
      const reply = await link.exchange({ v: 1, type: "answer", requestId: randomUUID(), linkEpoch: link.linkEpoch, payload: answer }, "receipt");
      if (reply.type !== "receipt" || reply.payload.messageId !== row.message_id || reply.payload.stage !== "answered") throw new HubProtocolError("uncertain");
      this.setState(row, "released", ["answered"]);
      this.pushReceipts();
      return { ok: true, message: "Delivered to the Hub asker." };
    } catch (err) {
      const code = err instanceof HubProtocolError ? err.code : "uncertain";
      if (!saved && code === "invalid" && !evidenced) {
        // A malformed report (empty or oversized) is the agent's to fix: the question stays open on the same id.
        this.setState(row, was === "input" ? "delivered" : was, ["answering"]);
        return { ok: false, message: `Not sent: the answer must be 1 to ${HUB_ANSWER_MAX} bytes of plain text. Report again with the same correlation_id.` };
      }
      this.uncertain(row, err);
      return { ok: false, message: "Not delivered to the Hub asker: the question is no longer open (withdrawn, revoked, or the Hub is unreachable). The owner sees it in Needs you." };
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
    // The journal's encrypted copy is the only question text this side keeps.
    const question = this.options.journal.queuedQuestion(row.message_id);
    if (questionContextDigest(question) !== row.digest) throw new HubProtocolError("uncertain");
    return question;
  }
  private audit(row: Row, action: string, result: "completed" | "held" | "denied", reasonCode?: string): void {
    try {
      this.options.db.transaction(() => this.options.audit({ action, result, messageId: row.message_id, exposureId: row.exposure_id, ...(reasonCode ? { reasonCode } : {}) }, this.options.db)).immediate();
    } catch (err) { this.options.log("warn", "Hub audit append failed", { action, err: String(err) }); }
  }
  private hold(row: Row, reason: string): void {
    if (!this.setState(row, "held", LIVE, { reason })) return;
    this.audit(row, "representative.held", "held", reason);
    this.options.attentionChanged();
  }
  private uncertain(row: Row, err: unknown): void {
    this.options.log("warn", "Hub question uncertain", { messageId: row.message_id, err: String(err) });
    try { if (["input", "delivered", "answering"].includes(row.state)) this.options.journal.recordEvidence(row.message_id, "uncertain"); }
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
  attentionItems(): HubExecutionAttentionInput[] {
    const rows = this.options.db.prepare(`SELECT * FROM hub_representative_questions WHERE state='held' ORDER BY at DESC LIMIT ${HELD_MAX}`).all() as Row[];
    return rows.map(r => ({ id: `hold:${r.id}`, kind: "hold" as const, agent: r.agent, messageId: r.message_id, exposureId: r.exposure_id, since: r.at }));
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.receiptsTail;
  }
}
