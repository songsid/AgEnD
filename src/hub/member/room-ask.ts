/** Track C / seam2: injectable Fleet adapter. Track R owns the negotiated wire schemas and socket routing. */
import type Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { epoch, HubProtocolError, plain, uuid, validated } from "../validation.js";
import { HUB_LIMITS } from "../protocol.js";
import type { HubRepresentativeDelivery } from "../representative.js";
import type { HubReportExtras, HubReportOutcome } from "../../hub-report-target.js";
export interface RoomContextRow { author: string; text: string; at: number; repliedTo?: true }
export interface RoomAsk {
  messageId: string; roomId: string; roomName: string; exposureId: string;
  asker: { name: string }; text: string; context: readonly RoomContextRow[];
}
export interface RoomAnswer { messageId: string; roomId: string; exposureId: string; answerId: string; text: string }
export interface RoomAnswerAck { messageId: string; answerId: string }
export interface AgentPresence { state: "idle" | "working" | "paused"; note?: string }
export interface AgentStateInput {
  process: "running" | "paused" | "stopped" | "crashed";
  execution: "idle" | "working" | "stuck" | null;
  pauseReason?: "quota" | "auth" | "operator" | "idle" | "warm_cap" | "error" | null;
}
export const ROOM_ASK_CAPABILITY = "room-ask-v1";
export interface RoomExposure { agent: string; consentId: string; revision: number; token: string }
export interface RoomAskLink {
  current(): boolean;
  readonly features?: ReadonlySet<string>;
  sendAnswer(answer: RoomAnswer): Promise<void>;
}
export interface RoomAskOptions {
  db: Database.Database;
  /** Stable immutable Hub issuer / Fleet / owner binding, from the selected member state set. */
  bindingKey: string;
  encryptionKey: Buffer;
  current(): boolean;
  /** Only a published, owner-consented mapping with the agent's current lifecycle token. */
  localExposure(id: string): RoomExposure | null;
  deliver(input: HubRepresentativeDelivery): Promise<boolean>;
  locale?: "en" | "zh-TW";
}
export function migrateRoomAsks(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS hub_room_asks(message_id TEXT PRIMARY KEY,binding TEXT NOT NULL,state TEXT NOT NULL,cid TEXT NOT NULL UNIQUE,value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS hub_room_asks_state ON hub_room_asks(state)`);
}
export const HUB_ROOM_ASK_MIGRATION = Object.freeze({ component: "room-ask-v1", version: 1, up: migrateRoomAsks });
// Persisted payload shape matches Track R #3858. R2 validates frames with its shared roomAskSchema before dispatch.
const askSchema = z.strictObject({ messageId: uuid, roomId: uuid, exposureId: uuid, roomName: plain(120),
  asker: z.strictObject({ name: plain(256) }), text: plain(HUB_LIMITS.question),
  context: z.array(z.strictObject({ author: plain(256), text: plain(HUB_LIMITS.question), at: epoch, repliedTo: z.literal(true).optional() })).max(31)
    .refine(rows => rows.length <= 30 || rows.filter(r => r.repliedTo).length === 1),
});
const savedSchema = z.strictObject({ ask: askSchema,
  local: z.strictObject({ agent: z.string().min(1), consentId: z.string().min(1), revision: epoch, token: z.string().min(1) }),
  cid: z.string().regex(/^hub-room-[a-f0-9-]{36}$/),
  answer: z.strictObject({ messageId: uuid, roomId: uuid, exposureId: uuid, answerId: uuid, text: plain(HUB_LIMITS.answer) }).optional(),
});
type Saved = z.infer<typeof savedSchema>;
type State = "queued" | "dispatching" | "input" | "delivered" | "held" | "answered" | "acked";
interface Row { message_id: string; binding: string; state: State; cid: string; value: string }
const STATES: readonly State[] = ["queued", "dispatching", "input", "delivered", "held", "answered", "acked"];
/** Injectable until Track R's negotiated socket dispatcher and room membership checks are composed. */
export class HubRoomAskAdapter {
  private closed = false;
  private link: RoomAskLink | null = null;
  private readonly binding: string;
  private readonly key: Buffer;
  private readonly admitted = new Map<string, RoomAskLink>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly sending = new Map<string, { link: RoomAskLink; work: Promise<void> }>();
  constructor(private readonly options: RoomAskOptions) {
    if (!options.bindingKey || options.encryptionKey.length !== 32) throw new HubProtocolError("invalid");
    this.key = Buffer.from(options.encryptionKey);
    this.binding = createHash("sha256").update(options.bindingKey).digest("hex");
    // Authenticate the whole retained set before changing any recovery state. Never replace corrupt history.
    const retained = this.rows().map(row => ({ row, saved: this.read(row) }));
    options.db.transaction(() => {
      for (const { row, saved } of retained) {
        if (row.state === "input") this.save(row.message_id, "held", saved);
        else if (row.state === "dispatching") this.save(row.message_id, "queued", saved);
      }
    }).immediate();
  }
  private rows(state?: State): Row[] {
    return (state ? this.options.db.prepare("SELECT * FROM hub_room_asks WHERE state=? ORDER BY rowid").all(state)
      : this.options.db.prepare("SELECT * FROM hub_room_asks ORDER BY rowid").all()) as Row[];
  }
  private row(id: string): Row | undefined { return this.options.db.prepare("SELECT * FROM hub_room_asks WHERE message_id=?").get(id) as Row | undefined; }
  private aad(id: string, state: State): Buffer { return Buffer.from(JSON.stringify(["hub-room-ask-v1", this.binding, id, state])); }
  private read(row: Row): Saved {
    try {
      if (row.binding !== this.binding || !STATES.includes(row.state)) throw Error();
      const bytes = Buffer.from(row.value, "base64");
      if (bytes.length < 28) throw Error();
      const cipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      cipher.setAAD(this.aad(row.message_id, row.state)); cipher.setAuthTag(bytes.subarray(12, 28));
      const saved = savedSchema.parse(JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8")));
      if (saved.ask.messageId !== row.message_id || saved.cid !== row.cid || (saved.answer && (saved.answer.messageId !== row.message_id
        || saved.answer.roomId !== saved.ask.roomId || saved.answer.exposureId !== saved.ask.exposureId))
        || (["answered", "acked"].includes(row.state) !== !!saved.answer)) throw Error();
      return saved;
    } catch { throw new HubProtocolError("uncertain"); }
  }
  private save(id: string, state: State, saved: Saved): void {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.aad(id, state));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(saved), "utf8"), cipher.final()]);
    const value = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
    this.options.db.prepare("INSERT INTO hub_room_asks VALUES(?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET state=excluded.state,value=excluded.value")
      .run(id, this.binding, state, saved.cid, value);
  }
  private usable(source: RoomAskLink | null): source is RoomAskLink {
    return !this.closed && this.options.current() && source !== null && source === this.link && source.current()
      && !!source.features?.has("welcome-caps-v1") && source.features.has(ROOM_ASK_CAPABILITY);
  }
  private current(saved: Saved): boolean {
    const local = this.options.localExposure(saved.ask.exposureId), was = saved.local;
    return !this.closed && this.options.current() && !!local && local.agent === was.agent && local.consentId === was.consentId
      && local.revision === was.revision && local.token === was.token;
  }
  connected(link: RoomAskLink | null): void {
    this.link = link; this.admitted.clear();
    // Reconnection can resend a frozen answer, but cannot itself authorize a queued first input.
  }
  /** Synchronous admission only: callers must not await agent work on the socket's control/ACK queue. */
  accept(input: RoomAsk, source: RoomAskLink): "accepted" | "duplicate" {
    if (!this.usable(source)) throw new HubProtocolError("stale");
    const ask = validated(askSchema, input);
    if (!ask.text.trim() || Buffer.byteLength(JSON.stringify(ask)) > HUB_LIMITS.frame - 1024) throw new HubProtocolError("invalid");
    const old = this.row(ask.messageId);
    if (old) {
      const saved = this.read(old);
      if (JSON.stringify(saved.ask) !== JSON.stringify(ask)) throw new HubProtocolError("conflict");
      if (!this.current(saved)) throw new HubProtocolError("stale");
      this.admitted.set(ask.messageId, source);
      if (old.state === "queued") this.kick(ask.messageId);
      return "duplicate";
    }
    const local = this.options.localExposure(ask.exposureId);
    if (!local) throw new HubProtocolError("denied");
    const pending = this.options.db.prepare("SELECT count(*) AS n FROM hub_room_asks WHERE state NOT IN ('acked','held')").get() as { n: number };
    if (pending.n >= 4096) throw new HubProtocolError("backpressure");
    this.save(ask.messageId, "queued", { ask, local: { ...local }, cid: `hub-room-${randomUUID()}` });
    this.admitted.set(ask.messageId, source); this.kick(ask.messageId);
    return "accepted";
  }
  private kick(id: string): void {
    if (this.running.has(id)) return;
    const work = Promise.resolve().then(() => this.dispatch(id));
    this.running.set(id, work);
    void work.finally(() => { if (this.running.get(id) === work) this.running.delete(id); }).catch(() => {});
  }
  private async dispatch(id: string): Promise<void> {
    const row = this.row(id), source = this.admitted.get(id);
    if (!row || row.state !== "queued" || !source || !this.usable(source)) return;
    const saved = this.read(row);
    if (!this.current(saved)) return;
    this.save(id, "dispatching", saved);
    const current = () => this.usable(source) && this.admitted.get(id) === source && this.current(saved);
    try {
      const delivered = await this.options.deliver({ agent: saved.local.agent, correlationId: saved.cid,
        text: formatRoomAskPrompt(saved.ask, saved.cid, this.options.locale), stillCurrent: current,
        beforeInput: async () => {
          if (!current() || this.row(id)?.state !== "dispatching") return false;
          // Durable first-input intent BEFORE handing bytes to the ordinary Fleet delivery path.
          this.save(id, "input", saved); return current();
        } });
      const latest = this.row(id);
      if (latest?.state === "input") this.save(id, delivered ? "delivered" : "held", this.read(latest));
      else if (latest?.state === "dispatching") this.save(id, "queued", this.read(latest));
    } catch {
      const latest = this.row(id);
      if (latest?.state === "input") this.save(id, "held", this.read(latest));
      else if (latest?.state === "dispatching") this.save(id, "queued", this.read(latest));
    } finally { this.admitted.delete(id); }
  }
  async settled(): Promise<void> { while (this.running.size) await Promise.all([...this.running.values()]); }
  /** R2 calls on connection and retry ticks. No timer or socket is started by this injectable adapter. */
  async flush(): Promise<void> {
    const source = this.link;
    if (!this.usable(source)) return;
    for (const row of this.rows("answered")) {
      if (!this.usable(source)) return;
      const saved = this.read(row);
      if (this.current(saved)) await this.send(saved, source);
    }
  }
  private send(saved: Saved, source: RoomAskLink): Promise<void> {
    const id = saved.ask.messageId, existing = this.sending.get(id);
    if (existing?.link === source) return existing.work;
    const work = Promise.resolve().then(async () => {
      if (!this.usable(source) || !this.current(saved) || this.row(id)?.state !== "answered") return;
      try { await source.sendAnswer(structuredClone(saved.answer!)); } catch { /* The frozen row remains retryable until an exact ACK. */ }
    });
    const flight = { link: source, work }; this.sending.set(id, flight);
    void work.finally(() => { if (this.sending.get(id) === flight) this.sending.delete(id); }).catch(() => {});
    return work;
  }
  report(input: { correlationId: string; caller: string; text: string; callerCurrent?: () => boolean; extras?: HubReportExtras }): Promise<HubReportOutcome> | null {
    if (this.closed || !input.correlationId.startsWith("hub-room-")) return null;
    const row = this.options.db.prepare("SELECT * FROM hub_room_asks WHERE cid=?").get(input.correlationId) as Row | undefined;
    if (!row) return null;
    const saved = this.read(row);
    if (saved.local.agent !== input.caller) return null;
    const no = (message: string) => Promise.resolve<HubReportOutcome>({ ok: false, message });
    if (!this.current(saved) || input.callerCurrent?.() === false) return no("Not sent: this room question is no longer current.");
    if (input.extras && Object.values(input.extras).some(v => v !== undefined)) return no("Not sent: room answers currently support text only.");
    if (!plain(HUB_LIMITS.answer).safeParse(input.text).success || !input.text.trim()) return no("Not sent: enter a text answer within the answer limit.");
    if (saved.answer) {
      if (saved.answer.text !== input.text) return no("Not sent: this question already has a different saved answer.");
    } else {
      if (!["input", "delivered", "held"].includes(row.state)) return no("Not sent: the question has not reached the agent.");
      saved.answer = { messageId: saved.ask.messageId, roomId: saved.ask.roomId, exposureId: saved.ask.exposureId, answerId: randomUUID(), text: input.text };
      this.save(row.message_id, "answered", saved);
    }
    const link = this.link;
    const sent = row.state !== "acked" && this.usable(link) ? this.send(saved, link) : Promise.resolve();
    return sent.then(() => ({ ok: true, message: this.row(row.message_id)?.state === "acked" ? "Delivered to the Hub room." : "Saved for the Hub room; waiting for acknowledgement." }));
  }
  acknowledge(ack: RoomAnswerAck, source: RoomAskLink): boolean {
    if (!this.usable(source)) return false;
    const row = this.row(ack.messageId);
    if (!row || !["answered", "acked"].includes(row.state)) return false;
    const saved = this.read(row);
    if (!this.current(saved) || saved.answer?.answerId !== ack.answerId) return false;
    if (row.state !== "acked") this.save(row.message_id, "acked", saved);
    return true;
  }
  close(): void { this.closed = true; this.link = null; this.admitted.clear(); }
}

export function formatRoomAskPrompt(ask: RoomAsk, correlationId: string, locale: "en" | "zh-TW" = "en"): string {
  const zh = locale === "zh-TW";
  const context = ask.context.map(row => `${row.repliedTo ? (zh ? "[回覆的訊息] " : "[Replied-to message] ") : ""}${row.author}: ${row.text}`).join("\n");
  return [zh ? `Hub 房間「${ask.roomName}」｜${ask.asker.name} 提問` : `Hub room “${ask.roomName}” | Question from ${ask.asker.name}`,
    zh ? "房間裡的每個人都能看到你的回答。請在你目前的對話中處理。" : "Everyone in this room can read your answer. Work in your existing conversation.",
    zh ? `請用 report_result，指定 target_instance="agend-hub" 和 correlation_id="${correlationId}"，把純文字回答送回這個房間。`
      : `Use report_result with target_instance="agend-hub" and correlation_id="${correlationId}" to send your text answer to this room.`,
    context ? `${zh ? "最近的房間對話（由舊到新）" : "Recent room conversation (oldest first)"}:\n${context}` : "",
    `${zh ? "這次的問題" : "Current question"}:\n${ask.text}`].filter(Boolean).join("\n\n");
}
export function agentPresence(input: AgentStateInput, locale: "en" | "zh-TW" = "en"): AgentPresence {
  if (input.process === "running" && (input.execution === "working" || input.execution === "idle")) return { state: input.execution };
  const reason = input.process === "crashed" ? "crashed" : input.process === "stopped" ? "stopped"
    : input.process === "paused" ? input.pauseReason ?? "operator" : input.execution === "stuck" ? "stuck" : "unknown";
  const notes = {
    quota: ["Quota exhausted", "額度用完"], auth: ["Sign-in needed", "需要登入"], operator: ["Paused by owner", "擁有者已暫停"],
    idle: ["Agent sleeping", "Agent 休息中"], warm_cap: ["Waiting for capacity", "等待可用容量"], error: ["Agent needs attention", "Agent 需要處理"],
    crashed: ["Agent stopped unexpectedly", "Agent 意外停止"], stopped: ["Agent stopped", "Agent 已停止"],
    stuck: ["Agent needs attention", "Agent 需要處理"], unknown: ["Checking agent state", "正在確認 Agent 狀態"],
  } as const;
  return { state: "paused", note: notes[reason][locale === "zh-TW" ? 1 : 0] };
}

export interface RoomStateLink {
  current(): boolean;
  readonly features?: ReadonlySet<string>;
  sendState(input: AgentPresence & { exposureId: string }): Promise<void>;
}
/** R2 owns scheduling. This publisher only reads Fleet state and exports bounded room presence. */
export function createRoomStatePublisher(options: {
  exposures(): readonly { exposureId: string; agent: string }[];
  read(agent: string): AgentStateInput | Promise<AgentStateInput>;
  locale?: "en" | "zh-TW";
}) {
  let link: RoomStateLink | null = null, closed = false;
  let sent = new Map<string, string>();
  const running = new Map<RoomStateLink, Promise<void>>();
  const current = (source: RoomStateLink) => !closed && source === link && source.current()
    && !!source.features?.has("welcome-caps-v1") && source.features.has(ROOM_ASK_CAPABILITY);
  async function pass(source: RoomStateLink): Promise<void> {
    if (!current(source)) return;
    const entries = options.exposures();
    const ids = new Set(entries.map(e => e.exposureId));
    for (const id of sent.keys()) if (!ids.has(id)) sent.delete(id);
    for (const entry of entries) {
      let state: AgentStateInput;
      try { state = await options.read(entry.agent); } catch { state = { process: "running", execution: null }; }
      if (!current(source)) return;
      if (!options.exposures().some(e => e.exposureId === entry.exposureId && e.agent === entry.agent)) continue;
      const presence = agentPresence(state, options.locale), value = JSON.stringify([entry.agent, presence]);
      if (sent.get(entry.exposureId) === value) continue;
      await source.sendState({ exposureId: entry.exposureId, ...presence });
      if (!current(source)) return;
      sent.set(entry.exposureId, value);
    }
  }
  return {
    connected(next: RoomStateLink | null): void { if (link !== next) { link = next; sent = new Map(); } },
    refresh(): Promise<void> {
      if (!link || !current(link)) return Promise.resolve();
      const source = link, existing = running.get(source);
      if (existing) return existing;
      const work = pass(source); running.set(source, work);
      void work.finally(() => { if (running.get(source) === work) running.delete(source); }).catch(() => {});
      return work;
    },
    close(): void { closed = true; link = null; sent.clear(); },
  };
}
