/**
 * Waking an instance when someone else changes a card it owns or handed out (step 2, docs/design/task-board.md). The
 * board decides who hears what (TaskBoard's settleWakes); this gathers an instance's news for `gatherMs` (10 s) into
 * one message — dragging five cards, or opening a whole plan, is one wake — checks again that each piece still stands
 * when it goes out (wakeHolds), and hands it to the fleet as a notice from AgEnD: the delivery outbox holds it until
 * the instance can take it, across a restart too. What is gathered but not yet handed over is lost on a stop; the card
 * keeps the news (`task mine`, the comments new to its assignee). #2801: a notice still waiting when one of its cards
 * changes status or assignee again is withdrawn once every card on it has (its key names them). A notice that quotes a comment which
 * is then edited or deleted is withdrawn too while it still waits (its key names the comments it quotes), and what of it still stands
 * is told anew with the comment's words as they are now; delivered, it cannot be called back.
 *
 * What an agent does to a card is told the way what a person does is — after the gather, no later. The board
 * used to hold an agent's change for up to two minutes (#2785 (c), #2801) and drop the line when that agent had sent the
 * instance a message naming the card. A message and a notice are two things: an agent that wants to tell someone something
 * writes a comment with an @mention; the card's change is the board's own notice, and it always goes.
 */
import type { Wake, WakeReason, WakeSkip } from "./scheduler/task-board.js";
import { gapText, oneLine } from "./scheduler/task-board-text.js";
import { confirmerOf, personConfirms, WORD_REASONS, wrapUpGap, type Card } from "./scheduler/task-board.js";

export interface TaskBoardWakerDeps {
  /**
   * Hand `message` to the instance for good (the fleet's durable delivery); false when it could not be taken. `origins`:
   * the writers whose own words the message carries (Wake.principals) with their contact origin as they wrote — the
   * instance inherits each, as from a peer's message.
   */
  deliver(instance: string, message: string, key: string, origins: Record<string, unknown[]>): boolean;
  /**
   * The fleet's contact rules, asked again as the news goes out: whether `source`'s words may reach `instance` (a
   * conversation's origin can be restricted during the gather). What it refuses is left out of the notice — every
   * word reason of that card's wake — and the card keeps it. Absent: always.
   */
  mayReach?(source: string, instance: string): boolean;
  /** Whether the board may wake this name: a fleet instance (an assignee can be any name). */
  isInstance(name: string): boolean;
  /**
   * Whether this instance has the task board switched off (`dashboard.task_board: false`), asked as its news goes out:
   * it has no `task` tool to act on a notice with, so none is sent. The cards keep the news; switching the board back
   * on tells it to start with `task mine`. Absent: no one has it off.
   */
  boardOff?(name: string): boolean;
  /** What of a wake still stands now (TaskBoard.wakeHolds), and the card, to say what it lacks. */
  holds(wake: Wake): Wake | null;
  card(uuid: string): Card | undefined;
  /**
   * #2352: whether the person has this card's Needs you buttons in `instance`'s own channel (it is the card's lane):
   * then a dispatcher's wake says so instead of asking it to tell the person.
   */
  buttonsHere?(instance: string, uuid: string): boolean;
  /**
   * #2801: drop AgEnD's notices still waiting whose key starts with `prefix` and that `stale` judges overtaken (the
   * delivery outbox's withdrawWaitingNotices); returns how many. Absent: a waiting notice is delivered as it is.
   */
  withdraw?(prefix: string, stale: (key: string, createdAt: string) => boolean, reason: string): number;
  /** The state of the notice with this key in the delivery outbox (`cancelled` once withdrawn), or null. Absent: no replacement is sent for a withdrawn notice. */
  noticeState?(key: string): string | null;
  /** #2801: when a card's status or assignee last changed (ISO; TaskBoard.lastChangeAt). */
  changedAt?(uuid: string): string | null;
  /**
   * What became of the news about a card for an instance as it went out — the comment status (docs/design/task-board.md, "Comment
   * status"): handed to delivery under `key` (the outbox's), or not sent (`skip` says why). Told for every card's news that carries
   * a comment's words (`kind: "words"`, the default) or tells the instance its card can be started (`kind: "handoff"`, docs/design/task-board.md,
   * "Handoffs"); the board marks the comments, or the handoffs, it concerns. Absent: nobody keeps it.
   */
  settled?(event: { uuid: string; instance: string; kind?: "words" | "handoff"; key?: string; skip?: WakeSkip; replaces?: readonly string[] }): void;
  log(level: "info" | "warn", message: string, extra?: Record<string, unknown>): void;
  gatherMs?: number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  now?: () => number;
}

/** The start of a task board notice's key; `:cards=` and the card uuids end it (#2801). */
const KEY_PREFIX = "task-board:";
/** The card uuids a task board notice's key names (empty for a key that is not one). */
export const cardsOfKey = (key: string) => { if (!key.startsWith(KEY_PREFIX)) return []; const at = key.lastIndexOf(":cards="); return at < 0 ? [] : key.slice(at + 7).split(",").filter(Boolean); };
/** The comments (entry numbers) a notice quotes: `:comments=12,15` before its `:cards=`. */
const commentsOfKey = (key: string): number[] => {
  const m = /:comments=([\d,]*):cards=/.exec(key);
  return m ? m[1]!.split(",").filter(Boolean).map(Number) : [];
};
/**
 * The delivery states after which a notice can no longer be withdrawn, and so needs no replacement: the instance has it
 * (delivered), or it will never be sent (failed, cancelled), or it may have reached the instance (uncertain). Any other
 * state — queued, retry_wait, and an attempt under way that may yet fall back to retry_wait — can still be withdrawn.
 */
const SPENT_STATES = new Set(["delivered", "failed", "uncertain", "cancelled"]);

/** More assignments than this in one message are told as a count, not a line each. */
const MANY_ASSIGNED = 3;
/** The order a card's news is told in. */
const ORDER: WakeReason[] = ["cancelled", "sent_back", "decide", "to_confirm", "confirm_own", "answered", "answer_kept", "wrap_up", "assigned", "start", "ready", "progress", "mention", "comment"];
/** A comment (written by someone who is not the assignee) or an `@` mention: news only because of the words. */
const isCommentNews = (r: WakeReason) => r === "comment" || r === "mention";
/** News whose words are a comment's: those two, and a dispatcher's answer to a blocked question (the comment that came with it). */
const carriesWords = (r: WakeReason) => isCommentNews(r) || r === "answered" || r === "answer_kept";
const hasCommentNews = (w: Wake) => w.reasons.some(isCommentNews);
/** News that hands the card to the instance to start: everything it waited for is done, or it was given to it while it could start. */
const isHandoff = (r: WakeReason) => r === "ready" || r === "assigned";

const quote = (text: string | undefined) => (text ? `: "${oneLine(text, 160)}"` : "");
/** A reply says which comment it answers (its number and author, as `task get` shows them) and what that one said. */
const replying = (w: Wake, r: WakeReason) => {
  const to = w.replies?.[r];
  return to ? ` (replying to c${to.id}${to.author ? ` (${to.author})` : ""}: "${oneLine(to.text, 100)}")` : "";
};
/** A comment's words are the last of several gathered together: the others are on the card. */
const earlierWords = (w: Wake) => (w.earlier ? ` (+${w.earlier} earlier comment${w.earlier === 1 ? "" : "s"}: task get ${w.code})` : "");

/**
 * A person wrote the comment, so the reply goes on the card, not to an `@name` (an agent that answered "@web-user" was
 * told that nobody was woken). Not said for an instance's comment, which an `@` may rightly answer.
 */
const personReads = (w: Wake, r: WakeReason) => (w.byPerson?.[r] ? " (a person reads the card; no @ needed)" : "");

const FOLLOW_WHY: Record<string, string> = { dispatcher: "you handed it out", watcher: "you watch it", leader: "you lead its project" };

/** What a follower is told: the card's new state, who made it, and the words with it; the card stays the assignee's. */
function progressLine(w: Wake, card: Card | undefined): string {
  const by = w.by.progress ?? "someone";
  const news = w.news;
  const words = quote(w.texts.progress);
  const who = card?.assignee ? ` (@${card.assignee})` : "";
  let said: string;
  switch (news?.kind) {
    case "done": said = `finished by ${by}${words}`; break;
    case "review": said = `${by} moved it to review${words} — waiting for ${card ? confirmerOf(card) : "its confirmer"} to confirm it`; break;
    case "sent_back": said = `sent back by ${by}${words}${who ? ` — back with ${card!.assignee}` : ""}`; break;
    case "blocked": said = `blocked${who}${words ? ` — ${words.slice(2)}` : ""} (moved by ${by})`; break;
    case "reassigned": said = `${by} gave it to ${news.assignee ? `@${news.assignee}` : "nobody"}${news.from ? ` (it was @${news.from}'s)` : ""}`; break;
    default: said = `it moved on (${by})`;
  }
  return `${said} — ${FOLLOW_WHY[news?.as ?? "watcher"]}; step in (comment, reassign, open the next card) only if it needs you`;
}

/** One reason, as a line about the card says it. */
function say(w: Wake, r: WakeReason, card: Card | undefined, here = false): string {
  const by = w.by[r] ?? "someone";
  switch (r) {
    // The board shows what an instance works on only once its card is `claimed`: an instance that started on an assigned card without
    // claiming it (one did, for six minutes) looked idle on the card. The notice says so, where the instance reads it.
    case "assigned": return `assigned to you by ${by} — claim it first (task claim ${w.code}), then start`;
    case "start": return `${by} asks you to start it`;
    case "sent_back": return `sent back by ${by}${quote(w.texts.sent_back)}`;
    case "answered": return `${by} answered your blocked question${quote(w.texts.answered)} — it is in progress again`;
    // #2801 review: the answer waits on the card while the assignee finishes another (#2303); nothing else would say so.
    case "answer_kept": return `${by} answered your blocked question${quote(w.texts.answer_kept)} — kept on the card, which stays blocked while you finish your current card: resume it (move it to claimed) when you're free`;
    case "ready": return `everything it waited for is done — you can start it: claim it first (task claim ${w.code}), then start`;
    case "decide": return here
      ? `you handed it out and it is blocked${card?.assignee ? ` (@${card.assignee})` : ""}${quote(w.texts.decide)} — answer it yourself if you can (move it back to claimed with the decision as the comment); otherwise the person has Answer for it in your channel`
      : `you handed it out and it is blocked${card?.assignee ? ` (@${card.assignee})` : ""}${quote(w.texts.decide)} — ask the person, then answer it: move it back to claimed with the decision as the comment`;
    // #2434: only an agent's card (its instance dispatcher confirms it); the person's own are in their Needs you.
    case "to_confirm": {
      const gap = card ? wrapUpGap(card) : null;
      const waits = `you handed it out and it is ready for your confirmation${card?.assignee ? ` (@${card.assignee})` : ""}${gap ? `, though ${gapText(gap, card!.kind === "main")}` : ""}`;
      return `${waits} — check it, then move it to done, or back to claimed with what is missing`;
    }
    // #2080: an agent's own card (nobody else confirms it) in review by itself or by another's move.
    case "confirm_own": {
      const gap = card ? wrapUpGap(card) : null;
      return `it is in review and nobody else confirms it — it is yours${gap ? `, though ${gapText(gap, card!.kind === "main")}` : ""}: check it, then move it to done`;
    }
    // Comments wake (docs/design/task-board.md, "Comments and mentions"): the words are in the notice; the reply goes on the card.
    case "comment": return `new comment from ${by}${quote(w.texts.comment)}${replying(w, r)}${earlierWords(w)} — reply on the card (task update, with a comment${w.replies?.comment ? " and reply_to" : ""}) only if it asks or needs something from you${personReads(w, r)}`;
    case "mention": return `${by} mentioned you in a comment${quote(w.texts.mention)}${replying(w, r)}${earlierWords(w)} — reply on the card (task update, with a comment${w.replies?.mention ? " and reply_to" : ""}) if it asks something of you; the card is not yours unless it says so${personReads(w, r)}`;
    // A follower (docs/design/task-board.md, "Following a card"): how the card moved on, who did it, with the words that came with it.
    case "progress": return progressLine(w, card);
    case "cancelled": return `cancelled by ${by}${w.texts.cancelled?.startsWith("with its main task") ? ` ${oneLine(w.texts.cancelled, 160)}` : quote(w.texts.cancelled)} — stop working on it`;
    case "wrap_up": {
      const gap = card ? wrapUpGap(card) : null;
      // Every sub task is done: the card is in review, or done (nobody had to confirm it, or it was confirmed meanwhile) — its owner still has to wrap it up.
      const went = card?.status === "done" ? "is done" : `went ${card && !personConfirms(card) ? "to review" : "to the person for confirmation"} by itself`;
      return `it ${went}${gap ? `, but ${gapText(gap, true)}` : ""} — wrap it up with update: check the items that are met, result: a short summary of what was delivered and where to open it, and a comment on the card for the person`;
    }
  }
}

/** "M-11–M-16" for a run of numbers, else the first few. */
function idList(codes: string[]): string {
  const n = (c: string) => Number(c.slice(2));
  const sorted = [...codes].sort((a, b) => n(a) - n(b));
  const run = sorted.length > 2 && sorted.every((c, i) => i === 0 || n(c) === n(sorted[i - 1]!) + 1);
  if (run) return `${sorted[0]}–${sorted[sorted.length - 1]}`;
  return sorted.length > 5 ? `${sorted.slice(0, 5).join(", ")} …` : sorted.join(", ");
}

/**
 * One message for an instance's gathered news: a line per card (a main task assigned with its sub tasks is one line),
 * or — a whole plan assigned at once — a count, so it does not read as everything to do right now.
 */
export function wakeMessage(wakes: Wake[], card: (uuid: string) => Card | undefined = () => undefined,
  /** #2352: the person has this wake's card's buttons in the woken instance's channel. */
  buttonsHere: (w: Wake) => boolean = () => false): string {
  const assignedMains = new Set(wakes.filter((w) => w.reasons.includes("assigned") && !w.parent).map((w) => w.code));
  const folded = new Map<string, number>();
  const items = wakes.filter((w) => {
    const into = w.parent && w.reasons.length === 1 && w.reasons[0] === "assigned" && assignedMains.has(w.parent) ? w.parent : null;
    if (into) folded.set(into, (folded.get(into) ?? 0) + 1);
    return !into;
  });
  const line = (w: Wake) => {
    const subs = folded.get(w.code);
    const news = ORDER.filter((r) => w.reasons.includes(r)).map((r) => say(w, r, card(w.uuid), buttonsHere(w))).join("; ");
    return `${w.code} "${oneLine(w.title, 60)}"${subs ? ` (with ${subs} sub task${subs === 1 ? "" : "s"})` : ""}: ${news}.`;
  };
  const assigned = items.filter((w) => w.reasons.length === 1 && w.reasons[0] === "assigned");
  if (items.length > 1 && assigned.length > MANY_ASSIGNED) {
    const mains = assigned.filter((w) => !w.parent).map((w) => w.code);
    const subs = assigned.length - mains.length + [...folded.values()].reduce((a, b) => a + b, 0);
    const what = [mains.length ? `${mains.length} main task${mains.length === 1 ? "" : "s"} (${idList(mains)})` : "", subs ? `${subs} sub task${subs === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
    const summary = `You were assigned ${what}.`;
    const rest = items.filter((w) => !assigned.includes(w));
    const tail = "Read task mine for the order and work through them one at a time, by priority; claim a card (task claim ID) before you start on it.";
    return rest.length ? `[Task board] ${summary}\n${rest.map((w) => `- ${line(w)}`).join("\n")}\n${tail}` : `[Task board] ${summary} ${tail}`;
  }
  if (items.length === 1) return `[Task board] ${line(items[0]!)} Read it with: task get ${items[0]!.code}`;
  return `[Task board] ${items.length} things on your cards:\n${items.map((w) => `- ${line(w)}`).join("\n")}\nYour work: task mine`;
}

/**
 * A merged wake's writers whose words it carries, each with every origin snapshot its gathered writes came with. None
 * is dropped: the notice quotes the latest comment and points to the earlier ones on the card, so the recipient
 * inherits each (#4367 review: keeping only the first lost a later comment's origin).
 */
function mergePrincipals(had: Wake | undefined, w: Wake): Pick<Wake, "principals" | "origins"> {
  const principals = [...new Set([...(had?.principals ?? []), ...(w.principals ?? [])])];
  if (!principals.length) return {};
  const origins: Record<string, unknown[]> = {};
  for (const p of principals) {
    const all = unionOrigins(had?.origins?.[p], w.origins?.[p]);
    if (all.length) origins[p] = all;
  }
  return { principals, ...(Object.keys(origins).length ? { origins } : {}) };
}

/** Origin snapshots, each once (by value), in the order first seen. */
function unionOrigins(...lists: Array<readonly unknown[] | undefined>): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const list of lists) for (const o of list ?? []) {
    if (o === null || o === undefined) continue;
    const k = JSON.stringify(o);
    if (!seen.has(k)) { seen.add(k); out.push(o); }
  }
  return out;
}

/** A merged wake's replies: a reason whose newer words answer a comment says which; one whose newer words answer none says nothing (the earlier one's is not its). */
function mergeReplies(had: Wake, w: Wake): Pick<Wake, "replies"> {
  const out: NonNullable<Wake["replies"]> = { ...had.replies };
  for (const r of Object.keys(w.texts) as WakeReason[]) { if (w.replies?.[r]) out[r] = w.replies[r]; else delete out[r]; }
  return Object.keys(out).length ? { replies: out } : {};
}

/** A merged wake's person flags: each reason takes the newer wake's word on who wrote it, else keeps the earlier. */
function mergePerson(had: Wake, w: Wake): Partial<Record<WakeReason, true>> {
  const out: Partial<Record<WakeReason, true>> = { ...had.byPerson };
  for (const r of w.reasons) { if (w.byPerson?.[r]) out[r] = true; else delete out[r]; }
  return out;
}

export class TaskBoardWaker {
  private readonly gathering = new Map<string, { wakes: Map<string, Wake>; timer: unknown }>();
  /**
   * The wakes of each notice handed over that quotes a comment, by its key: what replaces it if the comment is edited or deleted while it
   * waits. Kept as long as the notice may still be withdrawn (its delivery has not settled), whatever the time or the number of notices
   * waiting: the notices an offline or paused instance has waiting are held by the delivery outbox too, which is what bounds them.
   */
  private readonly kept = new Map<string, Wake[]>();
  private stopped = false;
  private seq = 0;
  private readonly timers: NonNullable<TaskBoardWakerDeps["timers"]>;

  constructor(private readonly deps: TaskBoardWakerDeps) {
    this.timers = deps.timers ?? { set: (fn, ms) => { const h = setTimeout(fn, ms); h.unref?.(); return h; }, clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  }

  /** A committed write's wakes: gathered per instance, a card's news merged (each reason keeps its own words). */
  note(wakes: readonly Wake[]): void {
    if (this.stopped) return;
    for (const w of wakes) {
      if (!this.deps.isInstance(w.instance)) continue;
      let batch = this.gathering.get(w.instance);
      if (!batch) {
        batch = { wakes: new Map(), timer: this.timers.set(() => this.flush(w.instance), this.deps.gatherMs ?? 10_000) };
        this.gathering.set(w.instance, batch);
      }
      const had = batch.wakes.get(w.uuid);
      // The latest progress news says it all: the words of an earlier one stay behind with it.
      if (had && w.news && w.texts.progress === undefined) delete had.texts.progress;
      // A second comment on the card in the same window: the notice quotes the last and counts the ones before it.
      const earlier = (had?.earlier ?? 0) + (had && hasCommentNews(had) && hasCommentNews(w) ? 1 : 0);
      batch.wakes.set(w.uuid, had
        ? { ...had, title: w.title, reasons: [...new Set([...had.reasons, ...w.reasons])], by: { ...had.by, ...w.by }, texts: { ...had.texts, ...w.texts }, ...(had.entries || w.entries ? { entries: { ...had.entries, ...w.entries } } : {}), ...(had.replaces || w.replaces ? { replaces: [...new Set([...(had.replaces ?? []), ...(w.replaces ?? [])])] } : {}), ...(had.byPerson || w.byPerson ? { byPerson: mergePerson(had, w) } : {}), ...(w.news ?? had.news ? { news: w.news ?? had.news } : {}), ...(earlier ? { earlier } : {}), ...mergePrincipals(had, w), ...mergeReplies(had, w) }
        : { ...w, reasons: [...w.reasons], by: { ...w.by }, texts: { ...w.texts }, ...(w.entries ? { entries: { ...w.entries } } : {}), ...(w.byPerson ? { byPerson: { ...w.byPerson } } : {}), ...(w.news ? { news: { ...w.news } } : {}), ...(w.replies ? { replies: { ...w.replies } } : {}), ...mergePrincipals(undefined, w) });
    }
  }

  /**
   * #2801: these cards' status or assignee just changed. A notice still waiting that names one of them is withdrawn
   * once every card it names has changed since it was handed over — it no longer says how they stand; what still
   * concerns the instance is told anew from this change. News still gathering is checked again as it goes (holds).
   */
  changed(uuids: readonly string[]): void {
    if (this.stopped || !uuids.length || !this.deps.withdraw) return;
    const now = new Set(uuids);
    const stale = (key: string, createdAt: string) => {
      const cards = cardsOfKey(key);
      return cards.some((u) => now.has(u)) && cards.every((u) => now.has(u) || (this.deps.changedAt?.(u) ?? "") > createdAt);
    };
    try {
      const n = this.deps.withdraw(KEY_PREFIX, stale, "superseded: its card changed again");
      if (n) this.deps.log("info", "Task board notices withdrawn: their cards changed again", { count: n });
    } catch (err) {
      this.deps.log("warn", "Task board could not withdraw stale notices", { err: (err as Error).message });
    }
  }

  /**
   * These comments were edited or deleted. News still gathering reads the comment again as it goes out (holds), so it says the new
   * words, or leaves a deleted one out. A notice already handed over and still waiting is withdrawn, however long it has waited, and —
   * when this waker still has its wakes (not after a restart) — what of it still stands is told anew, so the instance gets one notice
   * with the words as they are now. One already delivered cannot be called back.
   *
   * With no wakes to tell it anew from (after a restart), an edit leaves the notice as it is — the old words are harmless, and the rest of
   * what it carries (an assignment…) is not lost; a delete still withdraws it, so the deleted words are not delivered.
   */
  recalled(items: ReadonlyArray<{ uuid: string; entry: number; deleted: boolean }>): void {
    if (this.stopped || !items.length || !this.deps.withdraw) return;
    const deleted = new Set(items.filter((i) => i.deleted).map((i) => i.entry));
    const edited = new Set(items.filter((i) => !i.deleted).map((i) => i.entry));
    const picked: string[] = [];
    let left = 0;
    const stale = (key: string) => {
      const named = commentsOfKey(key);
      if (!named.some((n) => deleted.has(n))) {
        if (!named.some((n) => edited.has(n))) return false;
        if (!this.kept.has(key)) { left++; return false; }           // an edit, and nothing to replace it with
      }
      picked.push(key);
      return true;
    };
    try {
      const n = this.deps.withdraw(KEY_PREFIX, stale, "superseded: a comment it quotes was edited or deleted");
      if (left) this.deps.log("info", "Task board notices left as they are: a comment they quote was edited and there is nothing to replace them with", { count: left });
      if (!n) return;
      this.deps.log("info", "Task board notices withdrawn: a comment they quote was edited or deleted", { count: n });
      for (const key of picked) {
        if (this.deps.noticeState?.(key) !== "cancelled") continue;
        const had = this.kept.get(key);
        this.kept.delete(key);
        if (had) this.note(had.map((w) => ({ ...structuredClone(w), replaces: [...(w.replaces ?? []), key] })));
      }
    } catch (err) {
      this.deps.log("warn", "Task board could not withdraw notices that quote a changed comment", { err: (err as Error).message });
    }
  }

  /** Nothing more is sent (the fleet is stopping); news still gathering is dropped — the cards keep it. */
  stop(): void {
    this.stopped = true;
    for (const b of this.gathering.values()) this.timers.clear(b.timer);
    this.gathering.clear();
    this.kept.clear();
  }

  /**
   * A wake as the fleet's contact rules let it reach `instance` now: when a writer whose words it carries may no longer
   * reach it, the words are left out (every word reason: which words came from whom is not kept apart once gathered),
   * and what the board says of its own (an assignment, a send-back…) still goes. null when nothing is left.
   */
  private contactHolds(instance: string, w: Wake): Wake | null {
    const gate = this.deps.mayReach;
    if (!gate || !w.principals?.length) return w;
    const refused = w.principals.filter((p) => { try { return !gate(p, instance); } catch { return true; } });
    if (!refused.length) return w;
    this.deps.log("info", "Task board words not sent: their writer may not reach the instance without a contact approval", { instance, code: w.code, writers: refused });
    const reasons = w.reasons.filter((r) => !WORD_REASONS.includes(r));
    if (!reasons.length) return null;
    const keep = <T>(o: Partial<Record<WakeReason, T>> | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([r]) => reasons.includes(r as WakeReason))) as Partial<Record<WakeReason, T>>;
    const out: Wake = { ...w, reasons, by: keep(w.by), texts: keep(w.texts) };
    if (w.byPerson) out.byPerson = keep(w.byPerson);
    if (w.replies) { const replies = keep(w.replies); if (Object.keys(replies).length) out.replies = replies; else delete out.replies; }
    delete out.principals; delete out.origins; delete out.news; delete out.earlier;
    return out;
  }

  /**
   * Remembers the wakes of a notice that quotes a comment, for a replacement, and lets go of those of the notices whose delivery has
   * settled (delivered, failed, cancelled, or gone from the outbox): not by age or number, so a notice that waits for an offline
   * instance keeps its wakes for as long as it waits. Without the outbox's help (no withdraw, no state) nothing is withdrawn, so nothing is kept.
   */
  private keep(key: string, wakes: readonly Wake[]): void {
    const state = this.deps.noticeState;
    if (!this.deps.withdraw || !state) return;
    this.kept.set(key, wakes.map((w) => structuredClone(w)));
    for (const k of [...this.kept.keys()]) {
      let now: string | null;
      try { now = state(k); } catch { continue; }                       // cannot tell: keep it
      if (now === null || SPENT_STATES.has(now)) this.kept.delete(k);
    }
  }


  /**
   * Tells the board what became of a card's news for `instance` (settled), never failing the send: once for the comments it carried the words
   * of, and once for the handoff it carried (`only` limits it to one of them, for news only part of which could not go).
   */
  private settle(instance: string, w: Wake, what: { key?: string; skip?: WakeSkip }, only?: "words" | "handoff"): void {
    const kinds: Array<"words" | "handoff"> = [];
    if ((!only || only === "words") && w.reasons.some(carriesWords)) kinds.push("words");
    if ((!only || only === "handoff") && w.reasons.some(isHandoff)) kinds.push("handoff");
    // A replacement (an edit or delete withdrew the notice that carried these comments) names the keys it replaces whether it is handed
    // over or dropped: either way the comments leave the withdrawn notice's key, or they would read as withdrawn instead of what became of them.
    const replaces = w.replaces?.length ? { replaces: w.replaces } : {};
    for (const kind of kinds) {
      try { this.deps.settled?.({ uuid: w.uuid, instance, kind, ...what, ...replaces }); } catch (err) { this.deps.log("warn", "Task board could not record what became of a card's news", { instance, code: w.code, kind, err: (err as Error).message }); }
    }
  }

  private flush(instance: string): void {
    const batch = this.gathering.get(instance);
    this.gathering.delete(instance);
    if (!batch || this.stopped) return;
    if (this.deps.boardOff?.(instance)) {
      this.deps.log("info", "Task board news not sent: the instance has the task board switched off", { instance });
      for (const w of batch.wakes.values()) this.settle(instance, w, { skip: "board_off" });
      return;
    }
    // Only what still holds as it goes out: not finished meanwhile, still theirs, still waiting on them.
    const wakes: Wake[] = [];
    for (const gathered of batch.wakes.values()) {
      const held = this.deps.holds(gathered);
      if (!held) { this.settle(instance, gathered, { skip: "not_waiting" }); continue; }
      // The card started (or was given away) while the news gathered: the handoff no longer stands, whatever else of the news does.
      if (gathered.reasons.some(isHandoff) && !held.reasons.some(isHandoff)) this.settle(instance, gathered, { skip: "not_waiting" }, "handoff");
      const reach = this.contactHolds(instance, held);
      if (!reach) { this.settle(instance, held, { skip: "contact_held" }, "words"); continue; }
      // The words are left out when their writer may not reach the instance; the card's own news still goes.
      if (held.reasons.some(carriesWords) && !reach.reasons.some(carriesWords)) this.settle(instance, held, { skip: "contact_held" }, "words");
      wakes.push(reach);
    }
    if (!wakes.length) return;
    // Every card's snapshots of each writer, not the first card's only.
    const origins: Record<string, unknown[]> = {};
    for (const w of wakes) for (const p of w.principals ?? []) origins[p] = unionOrigins(origins[p], w.origins?.[p]);
    const codes = wakes.map((w) => w.code);
    const quoting = [...new Set(wakes.flatMap((w) => Object.values(w.entries ?? {})))].sort((a, b) => a - b);
    const key = `${KEY_PREFIX}${instance}:${(this.deps.now ?? Date.now)()}:${++this.seq}${quoting.length ? `:comments=${quoting.join(",")}` : ""}:cards=${wakes.map((w) => w.uuid).join(",")}`;
    let taken = false;
    try { taken = this.deps.deliver(instance, wakeMessage(wakes, (uuid) => this.deps.card(uuid), (w) => this.deps.buttonsHere?.(instance, w.uuid) === true), key, origins); } catch (err) {
      this.deps.log("warn", "Task board wake failed", { instance, codes, err: (err as Error).message });
      for (const w of wakes) this.settle(instance, w, { skip: "not_taken" });
      return;
    }
    if (taken && quoting.length) this.keep(key, wakes);
    for (const w of wakes) this.settle(instance, w, taken ? { key } : { skip: "not_taken" });
    if (taken) this.deps.log("info", "Task board wake handed to delivery", { instance, codes });
    else this.deps.log("warn", "Task board wake not taken; the cards keep the news", { instance, codes });
  }
}
