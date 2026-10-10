/**
 * What the web chat has said, kept so that a reload — or a dropped SSE stream — does not leave the chat empty.
 *
 * The browser used to hold the only copy (500 messages per instance, in memory): a reload showed nothing, and a
 * stream that reconnected silently lost whatever was said while it was down. Now every chat message the fleet
 * pushes over SSE is recorded here with a monotonically increasing id: `/ui/history` serves the recent messages
 * of one instance, and an EventSource that reconnects with `Last-Event-ID` is sent what it missed.
 *
 * Bounded by count AND by bytes per instance, so a chatty agent cannot grow the fleet process without limit.
 * #1565: it also survives a fleet restart — the same bounded history is kept on the local disk (web-chat-store.ts)
 * and restored at fleet start, every message with the boot and id it had. What is kept is what was said: the text,
 * who said it, and its files (served again under their ids when they still pass the ledger's checks) — never the
 * interactive state (buttons, delivery ticks), which belonged to the process that ended.
 *
 * Ids count from 1 in every fleet process, so an id alone is not an identity across a restart: each history
 * has a random `boot` generation, every message carries it, and the SSE cursor is `<boot>-<id>`. Restored messages
 * keep their boot and id, so a page that stayed open across the restart already holds them (it keeps one entry per
 * boot+id); the server knows the order of the boots it holds, and a cursor of a restored boot is sent only what came
 * after it.
 */
import { randomBytes } from "node:crypto";

/** A file shown with a message: an id the dashboard can fetch, never a path. */
export interface WebChatAttachment { id: string; kind: "photo" | "document"; name: string; size: number; mime: string }
/**
 * #1565: a file shown with a message from before the fleet restarted that could not be served again (missing, moved,
 * or failing one of the ledger's checks): no id — the page shows the name as unavailable, and nothing can be fetched.
 */
export interface WebChatGoneAttachment { gone: true; kind: "photo" | "document"; name: string; size: number; mime: string }

/**
 * How far a message the web user sent has got (web track C3) — the ticks under it. The same lifecycle a
 * Telegram message shows as reactions: waiting behind another message, handed to the agent, taken up by it,
 * or not delivered; and `cancelled` when a Stop dropped it while it was still waiting.
 */
export type WebDeliveryState = "queued" | "processing" | "delivered" | "failed" | "cancelled";

/**
 * Ranks for the order a message moves through. Events can arrive late or twice (a queued after the spawn
 * settles, a retry): a tick never moves back. `delivered` and `failed` are final; `cancelled` is not, since
 * a Stop races a delivery already under way — what the agent actually got wins.
 */
const DELIVERY_RANK: Record<WebDeliveryState, number> = { queued: 1, processing: 2, cancelled: 3, delivered: 4, failed: 4 };

/** The state after `next` arrives at a message in `prev`; `prev` itself when `next` would move it back. */
export function nextDeliveryState(prev: WebDeliveryState | undefined, next: WebDeliveryState): WebDeliveryState | undefined {
  // Own keys only: "__proto__" or "constructor" is in every object, and is no state.
  if (!Object.hasOwn(DELIVERY_RANK, next)) return prev;
  if (prev === undefined || !Object.hasOwn(DELIVERY_RANK, prev)) return next;
  return DELIVERY_RANK[next] > DELIVERY_RANK[prev] ? next : prev;
}

export type WebChatRole = "agent" | "user" | "status";
const ROLES: ReadonlySet<string> = new Set(["agent", "user", "status"]);

/** #1266: an agent reply's buttons as the page shows them (labels only — never the values). */
export interface WebChatButtons {
  id: string;
  labels: string[];
  state: "open" | "chosen" | "expired";
  chosen?: number;
  by?: string;
}
function webChatButtons(raw: unknown): WebChatButtons | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const b = raw as Record<string, unknown>;
  if (typeof b.id !== "string" || !/^[0-9a-f]{32}$/.test(b.id) || !Array.isArray(b.labels)) return undefined;
  const state = b.state === "chosen" || b.state === "expired" ? b.state : "open";
  return {
    id: b.id, labels: b.labels.slice(0, 10).map(l => String(l).slice(0, 80)), state,
    ...(state === "chosen" && typeof b.chosen === "number" ? { chosen: b.chosen } : {}),
    ...(state === "chosen" && typeof b.by === "string" ? { by: b.by.slice(0, 64) } : {}),
  };
}

export interface WebChatMessage {
  /** Files shown with the message (absent when none); a restored one that cannot be served again is `gone` (#1565). */
  attachments?: Array<WebChatAttachment | WebChatGoneAttachment>;
  /** #1266: an agent reply's buttons (agent messages only). */
  buttons?: WebChatButtons;
  /** The fleet process generation the id belongs to. */
  boot: string;
  /** Where a web user's message has got (absent: nothing reported yet, or not the web user's). */
  delivery?: WebDeliveryState;
  id: number;
  instance: string;
  /** The `message_id` the agent was given for a web user's message — what delivery reports name it by. */
  messageId?: string;
  /**
   * Who the server says wrote it (#1306), set by the code path that emitted it — never read from the text or the
   * sender name: `agent` (a delivered reply), `user` (a person, on any surface; the default), `status` (a daemon
   * status line on a web-only fleet). Only `agent` messages may get HTML preview cards.
   */
  role: WebChatRole;
  sender: string;
  text: string;
  ts: string;
}

export interface WebChatHistoryOptions {
  /** Messages kept per instance. */
  perInstance?: number;
  /** Bytes of text kept per instance (UTF-16 length × 2 is close enough for a bound). */
  perInstanceChars?: number;
  /** Most messages one SSE reconnect is sent. */
  replayMax?: number;
  /** The generation id (tests); random otherwise. */
  boot?: string;
  /** #1565: where the history is kept between fleet processes (web-chat-store.ts); none: memory only. */
  store?: WebChatPersistence | null;
  /** #1565: the file ledger, so a kept message's files are served again after a restart; none: they are not. */
  files?: WebChatFiles | null;
}

/** #1565: a message as it is kept on disk — what was said, never the interactive state; files with their paths. */
export interface StoredWebChatMessage {
  boot: string;
  id: number;
  instance: string;
  role: WebChatRole;
  sender: string;
  text: string;
  ts: string;
  attachments?: Array<{ id?: string; path?: string; kind: "photo" | "document"; name: string; size: number; mime: string }>;
}

/** #1565: what the history needs of the file ledger (web-upload.ts). */
export interface WebChatFiles {
  /** The path to keep with a file id (null: not served, or an upload no message took — never kept). */
  storablePath(id: string): string | null;
  /** Serve a kept file again under its id if it passes every check; null: it does not (shown as unavailable). */
  restore(entry: { id: string; path: string; name: string; mime: string; kind: string }, instance: string): { id: string; kind: "photo" | "document"; size: number; mime: string } | null;
  /** These ids are no longer shown: nothing is served under them. */
  drop(ids: string[]): void;
}

/** #1565: what the history needs of its disk store. */
export interface WebChatPersistence {
  schedule(instance: string, snapshot: () => StoredWebChatMessage[]): void;
  remove(instance: string): Promise<void>;
}

export const WEB_CHAT_TEXT_MAX = 16_000;

/**
 * The `message_id` a message from the web chat is delivered under. Unique (two sends in one millisecond used
 * to share `web-<ms>`), and never a platform id: Telegram and Discord ids are digits only.
 */
export function newWebMessageId(): string {
  return `web-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/** Whether a delivery report is about a message from the web chat rather than one on a platform. */
export function isWebMessageId(messageId: string): boolean {
  return messageId.startsWith("web-");
}

export class WebChatHistory {
  private nextId = 1;
  /** This process's generation: ids are only unique within it. */
  readonly boot: string;
  private readonly byInstance = new Map<string, { messages: WebChatMessage[]; chars: number }>();
  private readonly perInstance: number;
  private readonly perInstanceChars: number;
  private readonly replayMax: number;
  private store: WebChatPersistence | null;
  private files: WebChatFiles | null;
  /** #1565: the boots of restored messages, by the time of their first message — older processes, in order. */
  private readonly restoredBoots = new Map<string, string>();

  constructor(opts: WebChatHistoryOptions = {}) {
    this.perInstance = opts.perInstance ?? 500;
    this.perInstanceChars = opts.perInstanceChars ?? 1_000_000;
    this.replayMax = opts.replayMax ?? 500;
    this.boot = opts.boot ?? randomBytes(6).toString("hex");
    this.store = opts.store ?? null;
    this.files = opts.files ?? null;
  }

  /** #1565: keep this history on disk from now on (the fleet sets it at start, once its home is known). */
  setStore(store: WebChatPersistence | null): void { this.store = store; }

  /** #1565: the file ledger (set at fleet start, before restore()). */
  setFiles(files: WebChatFiles | null): void { this.files = files; }

  private persist(instance: string): void {
    if (!this.store) return;
    this.store.schedule(instance, () => (this.byInstance.get(instance)?.messages ?? []).map((m) => this.stored(m)));
  }

  /** #1565: a message as kept on disk: no buttons, no delivery, no message id; a file with the path it is served from. */
  private stored(m: WebChatMessage): StoredWebChatMessage {
    const row: StoredWebChatMessage = { boot: m.boot, id: m.id, instance: m.instance, role: m.role, sender: m.sender, text: m.text, ts: m.ts };
    if (m.attachments?.length) {
      row.attachments = m.attachments.map((a) => {
        const base = { kind: a.kind, name: a.name, size: a.size, mime: a.mime };
        const path = "id" in a && this.files ? this.files.storablePath(a.id) : null;
        return path && "id" in a ? { id: a.id, path, ...base } : base;
      });
    }
    return row;
  }

  /** #1565: the file ids these messages show that no message still kept for the instance shows: no longer served. */
  private dropFiles(instance: string, gone: readonly WebChatMessage[]): void {
    if (!this.files) return;
    const ids = new Set<string>();
    for (const m of gone) for (const a of m.attachments ?? []) if ("id" in a) ids.add(a.id);
    if (!ids.size) return;
    for (const m of this.byInstance.get(instance)?.messages ?? []) for (const a of m.attachments ?? []) if ("id" in a) ids.delete(a.id);
    if (ids.size) this.files.drop([...ids]);
  }

  /**
   * The order of the boots this history holds: older processes first (by their first restored message), this process
   * last. rank(boot) is its place, or -1 for a boot this history does not hold.
   */
  private bootRanks(): (boot: string) => number {
    const order = [...this.restoredBoots.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : 1)).map(([b]) => b);
    const at = new Map(order.map((b, i) => [b, i]));
    return (boot) => (boot === this.boot ? Number.MAX_SAFE_INTEGER : at.get(boot) ?? -1);
  }

  /**
   * #1565: the messages this instance had in an earlier fleet process, as stored (web-chat-store.ts) — validated
   * here, never trusted: a row that is not ours in shape is dropped; text is cut; the role is kept as stored and is
   * never made `agent` (anything else is a person's message); nothing interactive comes back (no buttons, no ticks).
   * Bounds as for record(). Then each kept message's files are served again under their ids, by the file ledger's
   * checks; a file that fails one — or is missing — is `gone` (its name shown as unavailable). Returns how many
   * messages it restored. Only for an instance with nothing recorded yet in this process.
   */
  restore(instance: string, rows: unknown[] | null): number {
    if (!Array.isArray(rows) || this.byInstance.has(instance)) return 0;
    const seen = new Set<string>();
    const out: Array<{ message: WebChatMessage; files: RestoredFile[] }> = [];
    for (const raw of rows) {
      const r = restoredRow(raw, instance, this.boot);
      if (!r) continue;
      const key = `${r.message.boot}:${r.message.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
    // The newest within the bounds, in their order.
    let chars = 0, from = out.length;
    while (from > 0 && out.length - from < this.perInstance && chars + out[from - 1]!.message.text.length <= this.perInstanceChars) chars += out[--from]!.message.text.length;
    const kept = out.slice(from).map((r) => this.restoreFiles(r, instance));
    if (!kept.length) return 0;
    this.byInstance.set(instance, { messages: kept, chars });
    for (const m of kept) {
      const first = this.restoredBoots.get(m.boot);
      if (first === undefined || m.ts < first) this.restoredBoots.set(m.boot, m.ts);
    }
    return kept.length;
  }

  /** #1565: a restored row's files served again (only the rows kept: an older one's file is never registered). */
  private restoreFiles(r: { message: WebChatMessage; files: RestoredFile[] }, instance: string): WebChatMessage {
    if (!r.files.length) return r.message;
    const seen = new Set<string>();
    r.message.attachments = r.files.map((f) => {
      const gone: WebChatGoneAttachment = { gone: true, kind: f.kind, name: f.name, size: f.size, mime: f.mime };
      // One id, one file: a second row naming an id again is shown as unavailable rather than served twice.
      if (!f.id || !f.path || !this.files || seen.has(f.id)) return gone;
      const served = this.files.restore({ id: f.id, path: f.path, name: f.name, mime: f.mime, kind: f.kind }, instance);
      if (!served || served.id !== f.id) return gone;
      seen.add(f.id);
      return { id: served.id, kind: served.kind, name: f.name, size: served.size, mime: served.mime };
    });
    return r.message;
  }

  /** The id the next message will get minus one: the newest id handed out so far (0 when none). */
  get lastId(): number { return this.nextId - 1; }

  /** Record one message; returns it with its id. Text beyond WEB_CHAT_TEXT_MAX is cut. */
  record(msg: { instance: string; sender: string; text: string; ts: string; attachments?: WebChatAttachment[]; messageId?: string; role?: string; buttons?: unknown }): WebChatMessage {
    const entry: WebChatMessage = {
      boot: this.boot,
      id: this.nextId++,
      instance: String(msg.instance),
      // Anything not one of the three — or absent — is a person's message.
      role: typeof msg.role === "string" && ROLES.has(msg.role) ? msg.role as WebChatRole : "user",
      sender: String(msg.sender),
      text: String(msg.text ?? "").slice(0, WEB_CHAT_TEXT_MAX),
      ts: String(msg.ts),
      ...(msg.attachments && msg.attachments.length ? { attachments: msg.attachments.slice(0, 20).map(a => ({ id: a.id, kind: a.kind, name: a.name, size: a.size, mime: a.mime })) } : {}),
      ...(typeof msg.messageId === "string" && msg.messageId ? { messageId: msg.messageId.slice(0, 64) } : {}),
    };
    const buttons = msg.role === "agent" ? webChatButtons(msg.buttons) : undefined;
    if (buttons) entry.buttons = buttons;
    let slot = this.byInstance.get(entry.instance);
    if (!slot) { slot = { messages: [], chars: 0 }; this.byInstance.set(entry.instance, slot); }
    slot.messages.push(entry);
    slot.chars += entry.text.length;
    const evicted: WebChatMessage[] = [];
    while (slot.messages.length > 1 && (slot.messages.length > this.perInstance || slot.chars > this.perInstanceChars)) {
      const old = slot.messages.shift()!;
      slot.chars -= old.text.length;
      evicted.push(old);
    }
    // #1565: a file leaves with its message — nothing is served under its id any more.
    if (evicted.length) this.dropFiles(entry.instance, evicted);
    this.persist(entry.instance);
    return entry;
  }

  /**
   * #1266: a reply's buttons ended (or changed): the recorded message shows it too, so a page that loads the history
   * later, or polls it (the public link), sees the same state. Returns the message it changed, if it is still kept.
   */
  updateButtons(instance: string, raw: unknown): WebChatMessage | null {
    const next = webChatButtons(raw);
    const slot = this.byInstance.get(instance);
    if (!next || !slot) return null;
    for (let i = slot.messages.length - 1; i >= 0; i--) {
      const m = slot.messages[i]!;
      if (m.buttons?.id === next.id) { m.buttons = next; this.persist(instance); return m; }
    }
    return null;
  }

  /** #1266: every kept reply whose buttons have ended — what a polling page applies (a stream page hears it live). */
  buttonStates(): Array<{ instance: string; buttons: WebChatButtons }> {
    const out: Array<{ instance: string; buttons: WebChatButtons }> = [];
    for (const [instance, slot] of this.byInstance) {
      for (const m of slot.messages) if (m.buttons && m.buttons.state !== "open") out.push({ instance, buttons: m.buttons });
    }
    return out;
  }

  /** The most recent `limit` messages of one instance, oldest first. */
  list(instance: string, limit = this.perInstance): WebChatMessage[] {
    const slot = this.byInstance.get(instance);
    if (!slot) return [];
    const n = Math.max(0, Math.min(Math.floor(limit), this.perInstance));
    return n === 0 ? [] : slot.messages.slice(-n);
  }

  /**
   * Every message newer than `lastId`, across instances, oldest first, at most `replayMax` (the newest ones).
   * Ids are this boot's: a cursor from another boot goes through replayFor(), never straight here.
   */
  after(lastId: number): WebChatMessage[] {
    if (!Number.isFinite(lastId) || lastId < 0) return [];
    // #1565: only this boot's ids compare with `lastId`; 0 (no cursor yet) is everything retained, restored too.
    return this.collect((m) => (m.boot === this.boot ? m.id > lastId : lastId === 0));
  }

  /** The retained messages that pass `keep`, across instances, in boot order then id order, at most replayMax (newest). */
  private collect(keep: (m: WebChatMessage) => boolean): WebChatMessage[] {
    const out: WebChatMessage[] = [];
    for (const slot of this.byInstance.values()) {
      for (const m of slot.messages) if (keep(m)) out.push(m);
    }
    const r = this.bootRanks();
    out.sort((a, b) => (r(a.boot) - r(b.boot)) || (a.id - b.id));
    return out.length > this.replayMax ? out.slice(-this.replayMax) : out;
  }

  /**
   * A delivery report for one of this instance's messages. Returns the message when its state changed (so the
   * caller tells the pages), null when there is no such message or the report would move it back.
   */
  setDelivery(instance: string, messageId: string, state: WebDeliveryState): WebChatMessage | null {
    const messages = this.byInstance.get(instance)?.messages ?? [];
    let m: WebChatMessage | undefined;
    for (let i = messages.length - 1; i >= 0 && !m; i--) if (messages[i]!.messageId === messageId) m = messages[i];
    if (!m) return null;
    const next = nextDeliveryState(m.delivery, state);
    if (next === m.delivery) return null;
    m.delivery = next;
    this.persist(instance);
    return m;
  }

  /**
   * A Stop on this instance: the web user's messages still waiting (nothing reported, or queued) were dropped
   * from the queue. The queue is first in, first out, so nothing older than a message that got further can
   * still be waiting: the walk goes back from the newest and stops there. Returns the messages it changed.
   */
  /**
   * Where every retained web message got — the ticks — in one list. A delivery report has no cursor of its own and
   * changes a message already sent, so a page that missed one (a dropped stream, a poll) catches up from this:
   * the stream sends it on every (re)connect and each poll carries it (#1253 review). Ticks only move forward on
   * the page, so receiving it twice changes nothing.
   */
  deliveries(): Array<{ instance: string; messageId: string; delivery: WebDeliveryState }> {
    const out: Array<{ instance: string; messageId: string; delivery: WebDeliveryState }> = [];
    for (const [instance, slot] of this.byInstance) {
      for (const m of slot.messages) if (m.messageId !== undefined && m.delivery !== undefined) out.push({ instance, messageId: m.messageId, delivery: m.delivery });
    }
    return out;
  }

  cancelPending(instance: string): WebChatMessage[] {
    const changed: WebChatMessage[] = [];
    const messages = this.byInstance.get(instance)?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.messageId === undefined) continue;
      if (m.delivery !== undefined && m.delivery !== "queued") break;
      m.delivery = "cancelled";
      changed.push(m);
    }
    if (changed.length) this.persist(instance);
    return changed.reverse();
  }

  /** Forget an instance (deleted) — and its file (#1565): a later instance of the same name starts empty. */
  forget(instance: string): void {
    const messages = this.byInstance.get(instance)?.messages ?? [];
    this.byInstance.delete(instance);
    this.dropFiles(instance, messages);
    if (this.store) void this.store.remove(instance);
  }

  /** The SSE cursor for one message: `<boot>-<id>`. */
  cursorOf(m: WebChatMessage): string { return `${m.boot}-${m.id}`; }

  /**
   * What a reconnecting stream with this `Last-Event-ID` should be sent. A cursor of this boot replays what came
   * after it. #1565: a cursor of a restored boot (a page that stayed open across the restart) gets what came after
   * it in that boot and everything of the later boots — never a message it already has. A cursor of a boot this
   * process does not hold gets everything retained (the page keeps one entry per boot+id, so nothing doubles). No
   * cursor, or one that is not ours in shape, gets nothing.
   */
  replayFor(cursor: { boot: string; id: number } | null): WebChatMessage[] {
    if (!cursor) return [];
    if (cursor.boot === this.boot) return this.after(cursor.id);
    const rank = this.bootRanks();
    const at = rank(cursor.boot);
    if (at < 0) return this.collect(() => true);
    return this.collect((m) => { const r = rank(m.boot); return r > at || (r === at && m.id > cursor.id); });
  }
}

/** #1565: a stored file, as read back (served again only if the ledger's checks pass). */
interface RestoredFile { id?: string; path?: string; kind: "photo" | "document"; name: string; size: number; mime: string }

/**
 * #1565: one stored row as a restored message (and its files, to serve again), or null when it is not ours in shape.
 * Only what was said comes back: no buttons, no delivery tick, no message id — whatever a row carries of those.
 */
function restoredRow(raw: unknown, instance: string, thisBoot: string): { message: WebChatMessage; files: RestoredFile[] } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.boot !== "string" || !/^[0-9a-f]{1,32}$/.test(r.boot) || r.boot === thisBoot) return null;
  if (typeof r.id !== "number" || !Number.isSafeInteger(r.id) || r.id < 1) return null;
  if (r.instance !== instance || typeof r.sender !== "string" || typeof r.text !== "string" || typeof r.ts !== "string") return null;
  // The role as stored — a person's message unless it is one of the three; never upgraded to `agent`.
  const role: WebChatRole = typeof r.role === "string" && ROLES.has(r.role) ? r.role as WebChatRole : "user";
  const message: WebChatMessage = { boot: r.boot, id: r.id, instance, role, sender: r.sender.slice(0, 256), text: r.text.slice(0, WEB_CHAT_TEXT_MAX), ts: r.ts.slice(0, 64) };
  const files = !Array.isArray(r.attachments) ? [] : r.attachments.slice(0, 20).flatMap((a): RestoredFile[] => {
    if (!a || typeof a !== "object" || Array.isArray(a)) return [];
    const f = a as Record<string, unknown>;
    if (typeof f.name !== "string") return [];
    return [{
      ...(typeof f.id === "string" ? { id: f.id } : {}), ...(typeof f.path === "string" ? { path: f.path } : {}),
      kind: f.kind === "photo" ? "photo" : "document", name: f.name.slice(0, 255),
      size: typeof f.size === "number" && Number.isSafeInteger(f.size) && f.size >= 0 ? f.size : 0, mime: typeof f.mime === "string" ? f.mime.slice(0, 128) : "",
    }];
  });
  return { message, files };
}

/** `Last-Event-ID` as `<boot>-<id>`, or null when absent or not that shape. */
export function parseLastEventId(header: string | string[] | undefined): { boot: string; id: number } | null {
  const raw = (Array.isArray(header) ? header[0] : header)?.trim();
  const m = raw === undefined ? null : /^([0-9a-f]{1,32})-(\d{1,15})$/.exec(raw);
  return m ? { boot: m[1]!, id: Number(m[2]) } : null;
}
