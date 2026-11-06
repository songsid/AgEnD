/** buttons-v1: durable per-answer choices. A button is data, never a human approval or a fleet-admin capability. */
import type Database from "better-sqlite3";
import { randomUUID, createHash } from "node:crypto";
import { REPLY_BUTTON_TTL_MS, replyButtonClickText } from "../reply-buttons.js";
import { pollCounts, pollResultsText, type PollBallot } from "../reply-polls.js";
import type { ReplyButtonsView } from "../reply-buttons-controller.js";
import type { HubAnswer, HubAuditRecord, HubReceipt, HubRequestContext, HubTx, PersonKey } from "./types.js";
import { buttonsDigest, validHubAnswerButtons } from "./buttons-model.js";
import { personKeyString } from "./identity.js";
import { HubProtocolError } from "./validation.js";
import { exposureOf, grantApplies, grantOf, readExposure, readGrant } from "./catalog.js";
import { readMessage, type MessageRow } from "./policy.js";
import { personFromString, type HubCore } from "./http/core.js";
export { buttonsDigest } from "./buttons-model.js";

export const HUB_BUTTONS_MIGRATION = Object.freeze({ component: "s8-buttons", version: 1, up(db: Database.Database) {
  db.exec(`CREATE TABLE hub_answer_buttons (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, message_id TEXT NOT NULL UNIQUE, answer_id TEXT NOT NULL,
    digest TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('open','chosen','closed','expired')), revision INTEGER NOT NULL DEFAULT 1,
    chosen_index INTEGER, closed_at INTEGER, ballot_ref TEXT,
    result_state TEXT NOT NULL CHECK(result_state IN ('none','owed','held','queued','cancelled')),
    result_key TEXT NOT NULL, result_message_id TEXT, retry_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX hub_buttons_due ON hub_answer_buttons(state, expires_at);
  CREATE INDEX hub_buttons_results ON hub_answer_buttons(result_state, retry_at);
  CREATE TABLE hub_button_operations (
    room_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, set_id TEXT NOT NULL, digest TEXT NOT NULL,
    receipt TEXT NOT NULL, PRIMARY KEY(room_id, idempotency_key)
  );`);
} });

type Row = { id: string; room_id: string; message_id: string; answer_id: string; digest: string; created_at: number; expires_at: number;
  state: "open" | "chosen" | "closed" | "expired"; revision: number; chosen_index: number | null; closed_at: number | null;
  ballot_ref: string | null; result_state: "none" | "owed" | "held" | "queued" | "cancelled"; result_key: string; result_message_id: string | null; retry_at: number };
type Room = { id: string; asker: string; exposure_id: string; grant_id: string; owner_at_creation: string; state: string };
export interface HubButtonQuestion {
  roomId: string; asker: PersonKey; idempotencyKey: string; text: string; requestId: string;
  actor: HubAuditRecord["actor"];
}
export interface HubButtonsQueue {
  /** The SAME synchronous insertion/audit/caps path as rooms.ask, inside the supplied transaction. */
  insert(db: Database.Database, tx: HubTx, input: HubButtonQuestion): HubReceipt;
  flush(fleetId: string): void;
}
const receiptOf = (m: MessageRow): HubReceipt => ({ messageId: m.id, contentDigest: m.content_digest, stage: m.stage as HubReceipt["stage"], sequence: m.member_sequence, at: m.stage_at });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RETRY_MS = 30_000;
const BATCH = 32;

export class HubButtonsService {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private draining: Promise<void> | null = null;
  constructor(private readonly core: HubCore, private readonly queue: HubButtonsQueue) {}
  private row(db: Database.Database, id: string): Row | undefined { return db.prepare("SELECT * FROM hub_answer_buttons WHERE id=?").get(id) as Row | undefined; }
  private check(): void { if (this.stopped) throw new HubProtocolError("unavailable"); this.core.check(); }

  /** Called with the accepted answer's own transaction. Metadata has already been bound by its exact release lease. */
  record(db: Database.Database, tx: HubTx, msg: MessageRow, answer: HubAnswer, now: number): void {
    if (!answer.buttons) return;
    if (!validHubAnswerButtons(answer.buttons)) throw new HubProtocolError("invalid");
    const b = answer.buttons;
    db.prepare(`INSERT INTO hub_answer_buttons(id,room_id,message_id,answer_id,digest,created_at,expires_at,state,result_state,result_key)
      VALUES(?,?,?,?,?,?,?,'open','none',?)`).run(b.id, msg.room_id, msg.id, answer.answerId, buttonsDigest(b), now,
        now + (b.poll ? b.poll.seconds * 1000 : REPLY_BUTTON_TTL_MS), randomUUID());
    this.audit(tx, msg, "buttons.offered", "completed", answer.releaseLease.decisionId, { kind: "member", fleetId: msg.fleet_id });
  }

  private source(db: Database.Database, row: Row) {
    const msg = readMessage(db, row.message_id);
    if (!msg || msg.room_id !== row.room_id || msg.answer_id !== row.answer_id || msg.stage !== "answered" || !msg.answer_ref) throw new HubProtocolError("stale");
    const payload = this.core.deps.content.get(msg.answer_ref), b = payload?.buttons;
    if (!b) throw new HubProtocolError("expired");
    if (!validHubAnswerButtons(b) || b.id !== row.id || buttonsDigest(b) !== row.digest) throw new HubProtocolError("uncertain");
    return { msg, buttons: b };
  }
  /** A published answer's continuation has its own bounded lifetime; current source identities/revisions never change. */
  private authorized(db: Database.Database, row: Row, now: number) {
    const data = this.source(db, row), msg = data.msg;
    const room = db.prepare("SELECT * FROM hub_rooms WHERE id=?").get(row.room_id) as Room | undefined;
    const e = readExposure(db, msg.exposure_id), g = readGrant(db, msg.grant_id);
    if (!room || room.state !== "active" || room.asker !== msg.asker || room.exposure_id !== msg.exposure_id || room.grant_id !== msg.grant_id
      || room.owner_at_creation !== msg.owner || !e || !g) throw new HubProtocolError("revoked");
    const exposure = exposureOf(e), grant = grantOf(g);
    if (exposure.revision !== msg.exposure_revision || grant.revision !== msg.grant_revision) throw new HubProtocolError("stale");
    if (exposure.fleetId !== msg.fleet_id || personKeyString(exposure.owner) !== msg.owner || exposure.state !== "published"
      || !grantApplies(grant, exposure, personFromString(msg.asker), now)) throw new HubProtocolError("revoked");
    return data;
  }
  private ballot(row: Row): PollBallot | undefined {
    if (!row.ballot_ref) return undefined;
    const b = this.core.deps.content.get(row.ballot_ref)?.pollBallot;
    if (!b || !Array.isArray(b.options) || !b.options.every(i => Number.isInteger(i) && i >= 0 && i < 10)
      || new Set(b.options).size !== b.options.length || typeof b.voter !== "string" || typeof b.name !== "string" || !Number.isSafeInteger(b.at)) throw new HubProtocolError("expired");
    return b;
  }
  private audit(tx: HubTx, msg: MessageRow, action: string, result: HubAuditRecord["result"], requestId: string,
    actor: HubAuditRecord["actor"], contentRef?: string): void {
    this.core.audit(tx, { requestId, actor, action, result, messageId: msg.id, roomId: msg.room_id, fleetId: msg.fleet_id,
      exposureId: msg.exposure_id, ownerAtEvent: personFromString(msg.owner), grantId: msg.grant_id, grantRevision: msg.grant_revision,
      ...(contentRef ? { contentRef } : {}) });
  }

  view(db: Database.Database, messageId: string): ReplyButtonsView | undefined {
    const row = db.prepare("SELECT * FROM hub_answer_buttons WHERE message_id=?").get(messageId) as Row | undefined;
    if (!row) return undefined;
    let data: ReturnType<HubButtonsService["source"]>;
    try { data = this.source(db, row); } catch { return undefined; } // retention never reconstructs choices from a browser
    const b = data.buttons, ballot = this.ballot(row), now = this.core.now();
    if (!b.poll) return { id: b.id, labels: [...b.labels], state: row.state === "open" && now >= row.expires_at ? "expired" : row.state,
      ...(row.chosen_index !== null ? { chosen: row.chosen_index } : {}) };
    const closed = row.state !== "open", ballots = ballot?.options.length ? [ballot] : [];
    return { id: b.id, labels: [...b.labels], state: closed ? "closed" : "open", poll: {
      deadline: row.expires_at, answered: ballots.length, multi: b.poll.multi, reveal: b.poll.reveal, rev: row.revision,
      ...(closed || b.poll.reveal === "live" ? { counts: pollCounts(b.labels.length, ballots) } : {}),
      ...(closed && b.poll.showVoters ? { voters: b.labels.map((_, i) => ballots.filter(v => v.options.includes(i)).map(v => v.name)) } : {}),
    } };
  }

  async click(ctx: HubRequestContext, roomId: string, input: Record<string, unknown>): Promise<HubReceipt> {
    this.check();
    if (Object.keys(input).some(k => !["setId", "index", "options", "idempotencyKey"].includes(k))
      || typeof input.setId !== "string" || !/^[a-f0-9]{32}$/.test(input.setId) || typeof input.idempotencyKey !== "string" || !uuid.test(input.idempotencyKey)) throw new HubProtocolError("invalid");
    const setId = input.setId, key = input.idempotencyKey;
    const asker = await ctx.requirePerson(), me = personKeyString(asker);
    this.check();
    const first = this.core.atomic(db => {
      const row = this.row(db, setId); if (!row || row.room_id !== roomId) throw new HubProtocolError("not-found");
      const data = this.source(db, row); if (data.msg.asker !== me) throw new HubProtocolError("denied"); return data.msg;
    });
    if (!(await this.core.eligible(personFromString(first.owner)))) throw new HubProtocolError("revoked");
    const actor = await ctx.current();
    if (actor.kind !== "directory" || personKeyString(actor.person) !== me) throw new HubProtocolError("denied");
    const auditActor = { kind: "person" as const, person: asker };
    this.check();
    const out = this.core.atomic((db, tx) => {
      const row = this.row(db, setId); if (!row || row.room_id !== roomId) throw new HubProtocolError("not-found");
      const { msg, buttons: b } = this.authorized(db, row, this.core.now());
      if (msg.asker !== me) throw new HubProtocolError("denied");
      const options = input.options;
      let picked: number[];
      if (b.poll) {
        if (input.index !== undefined || !Array.isArray(options) || options.length > b.labels.length || !options.every(i => Number.isInteger(i) && i >= 0 && i < b.labels.length)
          || new Set(options).size !== options.length || !b.poll.multi && options.length !== 1) throw new HubProtocolError("invalid");
        picked = [...options as number[]].sort((a, b) => a - b);
      } else {
        if (options !== undefined || !Number.isInteger(input.index) || (input.index as number) < 0 || (input.index as number) >= b.labels.length) throw new HubProtocolError("invalid");
        picked = [input.index as number];
      }
      const digest = createHash("sha256").update(JSON.stringify([setId, !!b.poll, picked])).digest("hex");
      const dup = db.prepare("SELECT * FROM hub_button_operations WHERE room_id=? AND idempotency_key=?").get(roomId, key) as { set_id: string; digest: string; receipt: string } | undefined;
      if (dup) { if (dup.set_id !== setId || dup.digest !== digest) throw new HubProtocolError("conflict"); return { receipt: JSON.parse(dup.receipt) as HubReceipt, fleetId: null }; }
      if (row.state !== "open" || this.core.now() >= row.expires_at) throw new HubProtocolError("expired");
      let receipt: HubReceipt;
      if (!b.poll) {
        receipt = this.queue.insert(db, tx, { roomId, asker, idempotencyKey: key, requestId: ctx.requestId,
          text: replyButtonClickText({ label: b.labels[picked[0]!]!, value: b.values?.[picked[0]!] ?? b.labels[picked[0]!]! }), actor: auditActor });
        db.prepare("UPDATE hub_answer_buttons SET state='chosen',chosen_index=?,closed_at=?,revision=revision+1 WHERE id=? AND state='open'").run(picked[0], this.core.now(), row.id);
        this.audit(tx, msg, "buttons.chosen", "completed", ctx.requestId, auditActor);
      } else {
        const person = db.prepare("SELECT display_name FROM hub_people WHERE person=?").get(me) as { display_name: string } | undefined;
        const ref = this.core.deps.content.put(tx, { pollBallot: { voter: me, name: person?.display_name ?? me, options: picked, at: this.core.now() } });
        this.audit(tx, msg, "poll.voted", "completed", ctx.requestId, auditActor, ref);
        db.prepare("UPDATE hub_answer_buttons SET ballot_ref=?,revision=revision+1 WHERE id=?").run(ref, row.id);
        receipt = receiptOf(msg); // the ballot is durable; a multi-choice poll queues results only at its deadline
        if (!b.poll.multi) {
          this.closeRow(db, tx, row, msg, this.core.now());
          receipt = this.queueResults(db, tx, this.row(db, row.id)!, ctx.requestId);
        }
      }
      db.prepare("INSERT INTO hub_button_operations VALUES(?,?,?,?,?)").run(roomId, key, setId, digest, JSON.stringify(receipt));
      return { receipt, fleetId: msg.fleet_id };
    });
    this.arm();
    if (out.fleetId) this.queue.flush(out.fleetId);
    return out.receipt;
  }

  private closeRow(db: Database.Database, tx: HubTx, row: Row, msg: MessageRow, now: number): void {
    const poll = this.source(db, row).buttons.poll;
    const changed = db.prepare("UPDATE hub_answer_buttons SET state=?,closed_at=?,result_state=?,revision=revision+1 WHERE id=? AND state='open'")
      .run(poll ? "closed" : "expired", now, poll ? "owed" : "none", row.id).changes;
    if (changed) this.audit(tx, msg, poll ? "poll.closed" : "buttons.expired", "completed", randomUUID(), { kind: "local-host" });
  }
  private queueResults(db: Database.Database, tx: HubTx, row: Row, requestId: string): HubReceipt {
    const { msg, buttons: b } = this.authorized(db, row, this.core.now());
    if (!b.poll || row.closed_at === null || !["owed", "held"].includes(row.result_state)) throw new HubProtocolError("conflict");
    const ballot = this.ballot(row);
    const choices = b.labels.map((label, i) => ({ label, value: b.values?.[i] ?? label }));
    let text = pollResultsText({ id: row.id, buttons: choices, createdAt: row.created_at, expiresAt: row.expires_at }, b.poll,
      ballot?.options.length ? [ballot] : [], row.closed_at);
    if (!b.poll.multi && ballot && row.closed_at < row.expires_at) {
      const lines = text.split("\n"); lines[0] = lines[0]!.replace(/closed early by close_poll after \d+ s/, "closed after the asker's vote"); text = lines.join("\n");
    }
    const receipt = this.queue.insert(db, tx, { roomId: row.room_id, asker: personFromString(msg.asker), idempotencyKey: row.result_key, text, requestId, actor: { kind: "local-host" } });
    db.prepare("UPDATE hub_answer_buttons SET result_state='queued',result_message_id=? WHERE id=?").run(receipt.messageId, row.id);
    this.audit(tx, msg, "poll.results", "completed", requestId, { kind: "local-host" });
    return receipt;
  }

  /** Synchronous closure/arming is independent of LDAP, delivery and every previous poll's pending result. */
  async sweep(): Promise<void> {
    this.check();
    this.core.atomic((db, tx) => {
      const due = db.prepare("SELECT * FROM hub_answer_buttons WHERE state='open' AND expires_at<=? ORDER BY expires_at,id LIMIT ?").all(this.core.now(), BATCH) as Row[];
      for (const row of due) {
        const msg = readMessage(db, row.message_id);
        if (!msg) throw new HubProtocolError("uncertain");
        // Missing retained content becomes inert. It is never reconstructed from untrusted input.
        if (!msg.answer_ref || !this.core.deps.content.get(msg.answer_ref)?.buttons) {
          db.prepare("UPDATE hub_answer_buttons SET state='expired',closed_at=?,result_state='cancelled',revision=revision+1 WHERE id=?").run(this.core.now(), row.id);
          this.audit(tx, msg, "buttons.expired", "completed", randomUUID(), { kind: "local-host" });
        } else this.closeRow(db, tx, row, msg, this.core.now());
      }
    });
    this.arm();
    if (this.draining) return this.draining;
    const run = this.drainResults(); this.draining = run;
    try { await run; } finally { if (this.draining === run) this.draining = null; if (!this.stopped && this.core.live()) this.arm(); }
  }
  private async drainResults(): Promise<void> {
    const rows = this.core.atomic(db => db.prepare("SELECT * FROM hub_answer_buttons WHERE result_state IN ('owed','held') AND retry_at<=? ORDER BY closed_at,id LIMIT ?").all(this.core.now(), BATCH) as Row[]);
    for (const first of rows) {
      this.check();
      try {
        const msg = this.core.atomic(db => this.source(db, first).msg);
        if (!(await this.core.eligible(personFromString(msg.asker))) || !(await this.core.eligible(personFromString(msg.owner)))) throw new HubProtocolError("unavailable");
        this.check();
        const fleetId = this.core.atomic((db, tx) => {
          const row = this.row(db, first.id)!;
          if (!["owed", "held"].includes(row.result_state)) return null;
          this.queueResults(db, tx, row, randomUUID()); return msg.fleet_id;
        });
        if (fleetId) this.queue.flush(fleetId);
      } catch (err) {
        this.check();
        const code = err instanceof HubProtocolError ? err.code : "unavailable";
        this.core.atomic((db, tx) => {
          const row = this.row(db, first.id); if (!row || !["owed", "held"].includes(row.result_state)) return;
          const cancelled = ["expired", "revoked", "stale", "denied", "not-found"].includes(code);
          const msg = readMessage(db, row.message_id); if (!msg) throw new HubProtocolError("uncertain");
          if (cancelled || row.result_state !== "held") this.audit(tx, msg, "poll.results", "held", randomUUID(), { kind: "local-host" });
          db.prepare("UPDATE hub_answer_buttons SET result_state=?,retry_at=? WHERE id=?").run(cancelled ? "cancelled" : "held", this.core.now() + RETRY_MS, row.id);
        });
      }
    }
  }

  arm(): void {
    if (this.stopped || !this.core.live()) return;
    if (this.timer) clearTimeout(this.timer);
    const next = this.core.atomic(db => db.prepare(`SELECT MIN(at) AS at FROM (
      SELECT MIN(expires_at) AS at FROM hub_answer_buttons WHERE state='open'
      UNION ALL SELECT MIN(retry_at) FROM hub_answer_buttons WHERE result_state IN ('owed','held') AND ?=0)`).get(this.draining ? 1 : 0) as { at: number | null });
    this.timer = next.at === null ? null : setTimeout(() => {
      this.timer = null;
      void this.sweep().catch(() => {
        if (!this.stopped && this.core.live()) this.timer = setTimeout(() => { this.timer = null; void this.sweep().catch(() => {}); }, RETRY_MS);
      });
    }, Math.min(2_147_483_647, Math.max(1, next.at - this.core.now())));
    this.timer?.unref();
  }
  start(): void { this.arm(); void this.sweep().catch(() => {}); }
  async close(): Promise<void> { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = null; await this.draining; }
}
