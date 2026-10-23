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
import { effectTrialOffer, type EffectTrialOffer } from "./web-effect-trials.js";
import { webTextLinks, type TextLink } from "./topic-link.js";
import { WEB_REACTIONS_MAX, webReactionsOf } from "./web-reactions.js";

/** A file shown with a message: an id the dashboard can fetch, never a path. */
export interface WebChatAttachment { id: string; kind: "photo" | "document"; name: string; size: number; mime: string; width?: number; height?: number }
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
  state: "open" | "chosen" | "expired" | "closed";
  chosen?: number;
  by?: string;
  /** #1823: a poll (ReplyButtonsView's `poll`). */
  poll?: WebChatPoll;
}
export interface WebChatPoll {
  deadline: number; answered: number; multi: boolean; reveal: "close" | "live"; rev: number;
  counts?: number[]; voters?: string[][];
}
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function webChatPoll(raw: unknown, options: number): WebChatPoll | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  if (!count(p.deadline) || !count(p.answered) || !count(p.rev) || typeof p.multi !== "boolean") return undefined;
  const counts = Array.isArray(p.counts) && p.counts.length === options && p.counts.every(count) ? p.counts as number[] : undefined;
  const voters = Array.isArray(p.voters) && p.voters.length === options && p.voters.every(v => Array.isArray(v))
    ? (p.voters as unknown[][]).map(v => v.slice(0, 200).map(n => String(n).slice(0, 80))) : undefined;
  return {
    deadline: p.deadline, answered: p.answered, multi: p.multi, reveal: p.reveal === "live" ? "live" : "close", rev: p.rev,
    ...(counts ? { counts } : {}), ...(voters ? { voters } : {}),
  };
}
function webChatButtons(raw: unknown): WebChatButtons | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const b = raw as Record<string, unknown>;
  if (typeof b.id !== "string" || !/^[0-9a-f]{32}$/.test(b.id) || !Array.isArray(b.labels)) return undefined;
  const labels = b.labels.slice(0, 10).map(l => String(l).slice(0, 80));
  const poll = webChatPoll(b.poll, labels.length);
  const state = b.state === "chosen" || b.state === "expired" || (poll && b.state === "closed") ? b.state : "open";
  return {
    id: b.id, labels, state, ...(poll ? { poll } : {}),
    ...(state === "chosen" && typeof b.chosen === "number" ? { chosen: b.chosen } : {}),
    ...(state === "chosen" && typeof b.by === "string" ? { by: b.by.slice(0, 64) } : {}),
  };
}

export interface WebChatMessage {
  /** Files shown with the message (absent when none); a restored one that cannot be served again is `gone` (#1565). */
  attachments?: Array<WebChatAttachment | WebChatGoneAttachment>;
  /** #1266: an agent reply's buttons (agent messages only). */
  buttons?: WebChatButtons;
  /** #1629: host display metadata only; volatile and never restored from disk. */
  effectTrial?: Readonly<EffectTrialOffer>;
  /**
   * A person's click on a reply button (user messages only): the page shows the button's label as a chip instead of
   * `text` — the line the agent was given, value and all. `of`: the buttons' set id, to link to the reply (live only).
   */
  click?: WebChatClick;
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
  /** #1990: a status line's names that open another instance's chat — ranges of `text` with an in-app route. */
  links?: TextLink[];
  /**
   * #1920 §5.2: this message reached the instance's platform channel (its topic or room) — what a member of that channel
   * already saw, so a guest may see it too. Set by the code path that knows (an inbound platform message; an agent reply
   * that landed there; a web message once its channel copy was sent); absent: not shown to guests.
   */
  channel?: true;
  /** #1920: the account that wrote it (`<connection id>:<user id>`), for a person's message — a guest sees its own. */
  from?: string;
  /**
   * #1920 (#2085 review): when it became the channel's after it was recorded (its copy was sent later) — a sequence
   * number from its boot's id counter, so a cursor handed out after that moves past it and a guest's next poll is sent
   * the row it could not see before. Kept on disk with the row (#2085 review): a page that held a cursor of that boot
   * across a restart is still sent it. #1774: likewise when it was recorded late at a reserved place (an agent's reply
   * whose files were being copied) — every replay and cursor counts it there.
   */
  seenSeq?: number;
  /**
   * #2272: the message a person's message replies to — its row (`boot`, `id`) and what the bubble quotes: who wrote it
   * and its first words, taken by the server from that row when the reply was sent (never from the page). `media`: a
   * row with files and no text. A person's messages only.
   */
  replyTo?: WebChatReplyRef;
  /**
   * #2305: the instance's reactions to this message — its minimal reply ("OK" answered with 👍), as on the platforms.
   * Distinct emojis of the web set (web-reactions.ts), at most WEB_REACTIONS_MAX, in the order they were added.
   */
  reactions?: string[];
  /**
   * #2341 review: a status line that names task board cards (the board's daily summary) — their numbers, so the public
   * link withholds the line while one of them is hidden there (web-api.ts visibleMessages). Kept on disk with the row.
   */
  cards?: string[];
}

/** #2341: a status line's card numbers (M-3, S-34), each once, at most this many; anything else is dropped. */
const CARD_CODE = /^[MS]-\d{1,9}$/;
export const WEB_CHAT_CARDS_MAX = 500;
/**
 * #2341 review r2: a line that names more cards than WEB_CHAT_CARDS_MAX keeps this one marker instead — the public link
 * withholds it whole (it cannot check every card), rather than keeping a truncated list that may drop a hidden one.
 */
export const WEB_CHAT_CARDS_OVERFLOW = "*";
function webCardCodes(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  if (v.includes(WEB_CHAT_CARDS_OVERFLOW)) return [WEB_CHAT_CARDS_OVERFLOW];           // restored from disk as it was saved
  const codes = [...new Set(v.filter((c): c is string => typeof c === "string" && CARD_CODE.test(c)))];
  if (codes.length > WEB_CHAT_CARDS_MAX) return [WEB_CHAT_CARDS_OVERFLOW];               // fail closed, never truncate
  return codes.length ? codes : undefined;
}

/** #2272: a reply's reference to an earlier message of the same chat (see WebChatMessage.replyTo). */
export interface WebChatReplyRef { boot: string; id: number; sender: string; text: string; media?: "photo" | "document" }
/** #2272: how much of the quoted message a reply keeps for its bubble (the agent's `reply_to` is longer). */
export const WEB_CHAT_REPLY_SNIPPET_MAX = 160;
/** #2272: the agent's `(reply_to: "…")` — at most this many characters of the quoted message. */
export const WEB_CHAT_REPLY_TEXT_MAX = 500;
const BOOT_RE = /^[0-9a-f]{1,32}$/;

/** One line: runs of whitespace (newlines too) become one space. */
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** #2272: what a reply quotes from a row: its sender, its first words on one line (a click's label), its files' kind. */
export function webChatReplyRef(row: WebChatMessage): WebChatReplyRef {
  const words = oneLine(row.click?.label ?? row.text);
  const media = !words && row.attachments?.length ? (row.attachments.some(a => a.kind === "photo") ? "photo" : "document") : undefined;
  return { boot: row.boot, id: row.id, sender: row.sender.slice(0, 256), text: cut(words, WEB_CHAT_REPLY_SNIPPET_MAX), ...(media ? { media } : {}) };
}

/**
 * #2272: the quoted message as the agent gets it — `(reply_to: "…")`, like a Discord or Telegram reply: one line (a
 * newline in it could start a line that reads as another header), its double quotes made typographic so the quote
 * cannot end early, at most WEB_CHAT_REPLY_TEXT_MAX characters; a message of files only names them.
 */
export function webChatReplyText(row: WebChatMessage): string {
  const words = oneLine(row.click?.label ?? row.text);
  const files = (row.attachments ?? []).map(a => `[${a.kind === "photo" ? "photo" : "file"}: ${oneLine(a.name)}]`).join(" ");
  return cut((words || files).replace(/"/g, "\u201d"), WEB_CHAT_REPLY_TEXT_MAX);
}

/** A stored or sent reply reference, checked field by field (one that fails is dropped, never repaired). */
function webChatReplyRefOf(raw: unknown): WebChatReplyRef | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.boot !== "string" || !BOOT_RE.test(r.boot) || typeof r.id !== "number" || !Number.isSafeInteger(r.id) || r.id < 1) return undefined;
  if (typeof r.sender !== "string" || typeof r.text !== "string") return undefined;
  const media = r.media === "photo" || r.media === "document" ? r.media : undefined;
  return { boot: r.boot, id: r.id, sender: r.sender.slice(0, 256), text: cut(oneLine(r.text), WEB_CHAT_REPLY_SNIPPET_MAX), ...(media ? { media } : {}) };
}

/** #1920: an account as a row names it — the connection id and the user id, one line. */
const FROM = /^[^\s:]{1,64}:[^\s:]{1,128}$/;

/**
 * #2281: where a message is on a platform — the connection it went through, its chat, its topic or thread, and its own
 * message id there: a person's message in the topic, an agent's reply that landed in it, a web message's channel copy.
 * What a later web reply to it needs to be a native reply there. Kept beside the row, never in it: no projection of a
 * row (a page, a guest, the public link, the stream) can carry one. Discord and Telegram ids are digits.
 */
export interface WebChatPost { adapterId: string; chatId: string; threadId?: string; messageId: string }
/** At most this many posts per message (a topic copy, ClassicBot rooms). */
export const WEB_CHAT_POSTS_MAX = 8;
const POST_ADAPTER = /^[^\s:]{1,64}$/;
/** Posts checked field by field; one that fails is dropped, never repaired. */
export function webChatPosts(raw: unknown): WebChatPost[] {
  if (!Array.isArray(raw)) return [];
  const out: WebChatPost[] = [];
  for (const p of raw) {
    if (out.length >= WEB_CHAT_POSTS_MAX) break;
    if (!p || typeof p !== "object") continue;
    const v = p as Record<string, unknown>;
    if (typeof v.adapterId !== "string" || !POST_ADAPTER.test(v.adapterId)) continue;
    if (typeof v.chatId !== "string" || !/^-?\d{1,32}$/.test(v.chatId) || typeof v.messageId !== "string" || !/^\d{1,32}$/.test(v.messageId)) continue;
    if (v.threadId !== undefined && (typeof v.threadId !== "string" || !/^\d{1,32}$/.test(v.threadId))) continue;
    const post: WebChatPost = { adapterId: v.adapterId, chatId: v.chatId, ...(v.threadId ? { threadId: v.threadId as string } : {}), messageId: v.messageId };
    if (!out.some(o => o.adapterId === post.adapterId && o.chatId === post.chatId && o.messageId === post.messageId)) out.push(post);
  }
  return out;
}
export function webChatFrom(adapterId: unknown, userId: unknown): string | undefined {
  if (typeof adapterId !== "string" || typeof userId !== "string") return undefined;
  const v = `${adapterId}:${userId}`;
  return FROM.test(v) ? v : undefined;
}

export interface WebChatClick { label: string; of?: string }
const CLICK_LABEL_MAX = 200;
/** A click as kept: a non-empty label (bounded), and the set id when it is one. Anything else: none. */
function webChatClick(raw: unknown): WebChatClick | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  if (typeof c.label !== "string" || !c.label.trim()) return undefined;
  return { label: c.label.slice(0, CLICK_LABEL_MAX), ...(typeof c.of === "string" && /^[0-9a-f]{32}$/.test(c.of) ? { of: c.of } : {}) };
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
  /** The label of a person's button click (what the page shows for it; the buttons themselves are not kept). */
  click?: { label: string };
  /** #1990: a status line's links (validated again when read back). */
  links?: TextLink[];
  /** #1920: reached the platform channel; and who wrote it (see WebChatMessage). */
  channel?: true;
  from?: string;
  /** #1920: when, in its boot's id sequence, it became the channel's (see WebChatMessage). */
  seenSeq?: number;
  /** #2272: what a person's reply quotes (see WebChatMessage). */
  replyTo?: WebChatReplyRef;
  /** #2305: the instance's reactions (see WebChatMessage). */
  reactions?: string[];
  /** #2341: a status line's card numbers (see WebChatMessage). */
  cards?: string[];
  /** #2281: where it is on a platform (see WebChatPost) — on disk only, never in a row. */
  posts?: WebChatPost[];
}

/** #1565: what the history needs of the file ledger (web-upload.ts). */
export interface WebChatFiles {
  /** The path to keep with a file id (null: not served, or an upload no message took — never kept). */
  storablePath(id: string): string | null;
  /** Serve a kept file again under its id if it passes every check; null: it does not (shown as unavailable). */
  restore(entry: { id: string; path: string; name: string; mime: string; kind: string }, instance: string): { id: string; kind: "photo" | "document"; size: number; mime: string; width?: number; height?: number } | null;
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
  /** #2281: each row's platform posts, beside it (never a field of it). Gone with the row. */
  private readonly posts = new WeakMap<WebChatMessage, WebChatPost[]>();

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
    this.store.schedule(instance, () => (this.byInstance.get(instance)?.messages ?? []).filter(m => !m.effectTrial).map((m) => this.stored(m)));
  }

  /** #1565: a message as kept on disk: no buttons, no delivery, no message id; a file with the path it is served from. */
  private stored(m: WebChatMessage): StoredWebChatMessage {
    const row: StoredWebChatMessage = { boot: m.boot, id: m.id, instance: m.instance, role: m.role, sender: m.sender, text: m.text, ts: m.ts, ...(m.click ? { click: { label: m.click.label } } : {}), ...(m.links ? { links: m.links } : {}),
      ...(m.channel ? { channel: true as const } : {}), ...(m.from ? { from: m.from } : {}), ...(m.seenSeq !== undefined ? { seenSeq: m.seenSeq } : {}),
      ...(m.replyTo ? { replyTo: m.replyTo } : {}), ...(m.reactions?.length ? { reactions: [...m.reactions] } : {}), ...(m.cards?.length ? { cards: [...m.cards] } : {}) };
    const posts = this.posts.get(m);
    if (posts?.length) row.posts = posts.map(p => ({ ...p }));
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
    const out: Array<{ message: WebChatMessage; files: RestoredFile[]; posts: WebChatPost[] }> = [];
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
    const kept = out.slice(from).map((r) => {
      const message = this.restoreFiles(r, instance);
      if (r.posts.length) this.posts.set(message, r.posts);
      return message;
    });
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
      return { id: served.id, kind: served.kind, name: f.name, size: served.size, mime: served.mime, ...drawnSize(served) };
    });
    return r.message;
  }

  /**
   * #2179: when the instance last replied to a person — its newest kept `agent` message (a reply through the reply tool,
   * shown in a channel or the web chat; a cross-instance line is never one), restored history included. Null when none
   * is kept.
   */
  lastAgentReply(instance: string): string | null {
    const slot = this.byInstance.get(instance);
    if (!slot) return null;
    for (let i = slot.messages.length - 1; i >= 0; i--) if (slot.messages[i]!.role === "agent") return slot.messages[i]!.ts;
    return null;
  }

  /** The id the next message will get minus one: the newest id handed out so far (0 when none). */
  get lastId(): number { return this.nextId - 1; }

  /** Record one message; returns it with its id. Text beyond WEB_CHAT_TEXT_MAX is cut. */
  record(msg: { instance: string; sender: string; text: string; ts: string; attachments?: WebChatAttachment[]; messageId?: string; role?: string; buttons?: unknown; click?: unknown; effectTrial?: unknown; links?: unknown; channel?: unknown; from?: unknown; replyTo?: unknown; cards?: unknown; posts?: unknown; reserved?: unknown }): WebChatMessage {
    return this.recordEntry(msg, null);
  }

  /**
   * #1774: a message's place, taken now, for one recorded later (an agent's reply whose files are still being copied):
   * `record({ …, reserved })` puts it there — after what came before the reply, before what came while it waited.
   */
  reserve(): number { return this.nextId++; }

  /** Host-only producer seam. Generic records cannot promote sender/role strings into a Try action. */
  recordEffectTrial(instance: string, offer: unknown, ts: string): WebChatMessage | null {
    const trial = effectTrialOffer(offer);
    if (typeof instance !== "string" || !instance.length || instance.length > 128 || !trial) return null;
    return this.recordEntry({ instance, sender: "agend", role: "status", text: "", ts }, trial);
  }

  private recordEntry(msg: Parameters<WebChatHistory["record"]>[0], trial: ReturnType<typeof effectTrialOffer>): WebChatMessage {
    // #1774: a reserved place (this boot's, not yet used) — else the next. A late one is recorded where it was reserved,
    // and counts as seen now (seenSeq): a cursor handed out while it waited moves past it, and is still sent it.
    const reserved = typeof msg.reserved === "number" && Number.isSafeInteger(msg.reserved) && msg.reserved > 0 && msg.reserved < this.nextId
      && !this.byInstance.get(String(msg.instance))?.messages.some(m => m.boot === this.boot && m.id === msg.reserved) ? msg.reserved : null;
    const entry: WebChatMessage = {
      boot: this.boot,
      id: reserved ?? this.nextId++,
      instance: String(msg.instance),
      // Anything not one of the three — or absent — is a person's message.
      role: typeof msg.role === "string" && ROLES.has(msg.role) ? msg.role as WebChatRole : "user",
      sender: String(msg.sender),
      text: String(msg.text ?? "").slice(0, WEB_CHAT_TEXT_MAX),
      ts: String(msg.ts),
      ...(msg.attachments && msg.attachments.length ? { attachments: msg.attachments.slice(0, 20).map(a => ({ id: a.id, kind: a.kind, name: a.name, size: a.size, mime: a.mime, ...drawnSize(a) })) } : {}),
      ...(typeof msg.messageId === "string" && msg.messageId ? { messageId: msg.messageId.slice(0, 64) } : {}),
    };
    const buttons = msg.role === "agent" ? webChatButtons(msg.buttons) : undefined;
    if (buttons) entry.buttons = buttons;
    if (trial) entry.effectTrial = trial;
    const click = entry.role === "user" ? webChatClick(msg.click) : undefined;
    if (click) entry.click = click;
    // #1990: only a status line (the server's own text) links; never an agent's or a person's message.
    const links = entry.role === "status" ? webTextLinks(msg.links, entry.text) : undefined;
    if (links) entry.links = links;
    // #2341: only a status line (the server's own text) names board cards.
    const cards = entry.role === "status" ? webCardCodes(msg.cards) : undefined;
    if (cards) entry.cards = cards;
    // #1920: only `true` marks a channel's message; only a person's message names its account.
    if (msg.channel === true) entry.channel = true;
    if (entry.role === "user" && typeof msg.from === "string" && FROM.test(msg.from)) entry.from = msg.from;
    // #2272: only a person's message replies to another.
    const replyTo = entry.role === "user" ? webChatReplyRefOf(msg.replyTo) : undefined;
    if (replyTo) entry.replyTo = replyTo;
    // #2281: where it is on a platform, beside the row (the caller that sent or received it knows).
    const posts = webChatPosts(msg.posts);
    if (posts.length) this.posts.set(entry, posts);
    let slot = this.byInstance.get(entry.instance);
    if (!slot) { slot = { messages: [], chars: 0 }; this.byInstance.set(entry.instance, slot); }
    // Always seen now, even with nothing recorded meanwhile: a poll's cursor may already have counted the reserved id.
    if (reserved !== null) {
      entry.seenSeq = this.nextId++;
      let at = slot.messages.length;
      while (at > 0 && slot.messages[at - 1]!.boot === this.boot && slot.messages[at - 1]!.id > reserved) at--;
      slot.messages.splice(at, 0, entry);
    } else slot.messages.push(entry);
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
      if (m.buttons?.id !== next.id) continue;
      // #1823: a poll's views can arrive out of order; the newest (by rev) stands, and closed is final.
      const had = m.buttons.poll;
      if (had && next.poll && (m.buttons.state === "closed" && next.state !== "closed" || (m.buttons.state === next.state && had.rev > next.poll.rev))) return m;
      m.buttons = next; this.persist(instance); return m;
    }
    return null;
  }

  /**
   * #1920: a web message's channel copy was sent — it is now what the channel saw. Returns the message when this changed
   * it (the caller tells the guests), null otherwise.
   */
  /**
   * #2305: the instance reacted to one of its web chat's messages (by the id it was handed). Returns the message and
   * whether this added the emoji (an emoji it already has, or a full list, changes nothing); null when the chat has
   * no such message. `emoji` is already the web set's spelling (web-reactions.ts webReactionEmoji).
   */
  addReaction(instance: string, messageId: string, emoji: string): { message: WebChatMessage; added: boolean } | null {
    const m = this.findByMessageId(instance, messageId);
    if (!m) return null;
    const list = m.reactions ?? [];
    if (list.includes(emoji) || list.length >= WEB_REACTIONS_MAX) return { message: m, added: false };
    m.reactions = [...list, emoji];
    this.persist(instance);
    return { message: m, added: true };
  }

  /** #2305: every kept message's reactions (what a poll sends, as it sends the ticks): its row, and the list. */
  reactionStates(): Array<{ instance: string; boot: string; id: number; reactions: string[] }> {
    const out: Array<{ instance: string; boot: string; id: number; reactions: string[] }> = [];
    for (const [instance, slot] of this.byInstance) for (const m of slot.messages) if (m.reactions?.length) out.push({ instance, boot: m.boot, id: m.id, reactions: [...m.reactions] });
    return out;
  }

  markChannel(instance: string, messageId: string): WebChatMessage | null {
    const m = this.findByMessageId(instance, messageId);
    if (!m || m.channel) return null;
    m.channel = true;
    if (m.boot === this.boot) m.seenSeq = this.nextId++;
    this.persist(instance);
    return m;
  }


  /** #1920: a kept message by the `message_id` the agent was given (a web message, a web click). */
  /** #2272: one kept message of an instance's chat by its row (`boot`, `id`), or undefined (never sent, or no longer kept). */
  find(instance: string, boot: string, id: number): WebChatMessage | undefined {
    return this.byInstance.get(instance)?.messages.find(m => m.boot === boot && m.id === id);
  }

  /** #2281: where this message is on a platform (empty when nowhere known). Never sent to a page. */
  postsOf(row: WebChatMessage): readonly WebChatPost[] {
    return this.posts.get(row) ?? [];
  }
  /** #2281: a web message's channel copies, once sent (by its message id); kept on disk with it. */
  addPosts(instance: string, messageId: string, raw: readonly WebChatPost[]): void {
    const m = this.findByMessageId(instance, messageId);
    if (!m) return;
    const posts = webChatPosts([...(this.posts.get(m) ?? []), ...raw]);
    if (!posts.length) return;
    this.posts.set(m, posts);
    this.persist(instance);
  }

  findByMessageId(instance: string, messageId: string): WebChatMessage | undefined {
    const messages = this.byInstance.get(instance)?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.messageId === messageId) return messages[i];
    return undefined;
  }

  /** #1920: a kept reply by its buttons' set id. */
  findByButtons(instance: string, buttonsId: string): WebChatMessage | undefined {
    const messages = this.byInstance.get(instance)?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.buttons?.id === buttonsId) return messages[i];
    return undefined;
  }

  /** #1266: every kept reply whose buttons have ended — what a polling page applies (a stream page hears it live). */
  buttonStates(): Array<{ instance: string; buttons: WebChatButtons }> {
    const out: Array<{ instance: string; buttons: WebChatButtons }> = [];
    for (const [instance, slot] of this.byInstance) {
      // #1823: an open poll too — its count of answers changes while it is open.
      for (const m of slot.messages) if (m.buttons && (m.buttons.state !== "open" || m.buttons.poll)) out.push({ instance, buttons: m.buttons });
    }
    return out;
  }

  /** The instances that have a history (#2293: the search backfill). */
  instances(): string[] { return [...this.byInstance.keys()]; }

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
    // #1774/#2085: a row recorded late, or made the channel's late, is newer than its id says (seenSeq).
    return this.collect((m) => (m.boot === this.boot ? this.at(m) > lastId : lastId === 0));
  }

  /**
   * The retained messages that pass `keep`, across instances, in boot order then in the order they were published
   * (#1774: `at` — a late row where it was seen), at most replayMax (the newest published). A replay's cursors so only
   * rise: a stream cut after any frame resumes from it without losing one. Pages show them in id order.
   */
  private collect(keep: (m: WebChatMessage) => boolean): WebChatMessage[] {
    const out: WebChatMessage[] = [];
    for (const slot of this.byInstance.values()) {
      for (const m of slot.messages) if (keep(m)) out.push(m);
    }
    const r = this.bootRanks();
    out.sort((a, b) => (r(a.boot) - r(b.boot)) || (this.at(a) - this.at(b)));
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

  /** The SSE cursor for one message: `<boot>-<n>`, n its place in its boot's sequence (id, or seenSeq once later). */
  cursorOf(m: WebChatMessage): string { return `${m.boot}-${this.at(m)}`; }
  /** #1774/#2085: where a row stands in its boot's sequence — its id, or when it was seen later (seenSeq). */
  private at(m: WebChatMessage): number { return Math.max(m.id, m.seenSeq ?? 0); }

  /**
   * The cursor a poll hands out: the newest message its answer accounts for. This process's newest id once it has
   * recorded one. Before that (#1577), the newest retained message in boot order — after a restart, the last restored
   * one: `<boot>-0` would be read back as after(0), which is everything retained, so a polling page was sent the whole
   * restored history every 5 s. Nothing retained at all: `<boot>-0`, as before.
   */
  pollCursor(): string {
    if (this.lastId > 0 || this.restoredBoots.size === 0) return `${this.boot}-${this.lastId}`;
    const rank = this.bootRanks();
    // #2085 review: a restored row made the channel's later counts at its seenSeq — else that row would be sent again.
    const at = (m: WebChatMessage) => Math.max(m.id, m.seenSeq ?? 0);
    let newest: WebChatMessage | null = null;
    for (const slot of this.byInstance.values()) {
      for (const m of slot.messages) {
        if (!newest || rank(m.boot) > rank(newest.boot) || (m.boot === newest.boot && at(m) > at(newest))) newest = m;
      }
    }
    return newest ? `${newest.boot}-${at(newest)}` : `${this.boot}-0`;
  }

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
    return this.collect((m) => { const r = rank(m.boot); return r > at || (r === at && this.at(m) > cursor.id); });
  }
}

/** #1565: a stored file, as read back (served again only if the ledger's checks pass). */
interface RestoredFile { id?: string; path?: string; kind: "photo" | "document"; name: string; size: number; mime: string }

/**
 * #1565: one stored row as a restored message (and its files, to serve again), or null when it is not ours in shape.
 * Only what was said comes back: no buttons, no delivery tick, no message id — whatever a row carries of those. #2305:
 * and the instance's reactions (what was answered). With no id, a message from before the restart takes no new one.
 */
function restoredRow(raw: unknown, instance: string, thisBoot: string): { message: WebChatMessage; files: RestoredFile[]; posts: WebChatPost[] } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.boot !== "string" || !/^[0-9a-f]{1,32}$/.test(r.boot) || r.boot === thisBoot) return null;
  if (typeof r.id !== "number" || !Number.isSafeInteger(r.id) || r.id < 1) return null;
  if (r.instance !== instance || typeof r.sender !== "string" || typeof r.text !== "string" || typeof r.ts !== "string") return null;
  // The role as stored — a person's message unless it is one of the three; never upgraded to `agent`.
  const role: WebChatRole = typeof r.role === "string" && ROLES.has(r.role) ? r.role as WebChatRole : "user";
  const message: WebChatMessage = { boot: r.boot, id: r.id, instance, role, sender: r.sender.slice(0, 256), text: r.text.slice(0, WEB_CHAT_TEXT_MAX), ts: r.ts.slice(0, 64) };
  // A click comes back as its label only (the link to its buttons belonged to the process that ended).
  const click = role === "user" ? webChatClick(r.click) : undefined;
  if (click) message.click = { label: click.label };
  const links = role === "status" ? webTextLinks(r.links, message.text) : undefined;
  if (links) message.links = links;
  const cards = role === "status" ? webCardCodes(r.cards) : undefined;
  if (cards) message.cards = cards;
  // #1920: as recorded — a row from before these were written has neither, so a guest is never shown it.
  if (r.channel === true) message.channel = true;
  if (role === "user" && typeof r.from === "string" && FROM.test(r.from)) message.from = r.from;
  // #2085 (made the channel's late) and #1774 (recorded late): either way, where it stands in its boot's sequence.
  if (typeof r.seenSeq === "number" && Number.isSafeInteger(r.seenSeq) && r.seenSeq > r.id) message.seenSeq = r.seenSeq;
  const replyTo = role === "user" ? webChatReplyRefOf(r.replyTo) : undefined;
  if (replyTo) message.replyTo = replyTo;
  const reactions = webReactionsOf(r.reactions);
  if (reactions) message.reactions = reactions;
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
  return { message, files, posts: webChatPosts(r.posts) };
}

/** A photo's drawn size as the page gets it (both positive integers), or nothing. Measured from the file, never kept. */
function drawnSize(a: { width?: unknown; height?: unknown }): { width?: number; height?: number } {
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= 65535;
  return ok(a.width) && ok(a.height) ? { width: a.width, height: a.height } : {};
}

/** `Last-Event-ID` as `<boot>-<id>`, or null when absent or not that shape. */
export function parseLastEventId(header: string | string[] | undefined): { boot: string; id: number } | null {
  const raw = (Array.isArray(header) ? header[0] : header)?.trim();
  const m = raw === undefined ? null : /^([0-9a-f]{1,32})-(\d{1,15})$/.exec(raw);
  return m ? { boot: m[1]!, id: Number(m[2]) } : null;
}
