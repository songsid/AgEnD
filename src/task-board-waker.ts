/**
 * Waking an instance when someone else changes a card it owns or handed out (step 2, docs/design/task-board.md). The
 * board decides who hears what (TaskBoard's settleWakes); this gathers an instance's news for `gatherMs` (10 s) into
 * one message — dragging five cards, or opening a whole plan, is one wake — checks again that each piece still stands
 * when it goes out (wakeHolds), and hands it to the fleet as a notice from AgEnD: the delivery outbox holds it until
 * the instance can take it, across a restart too. What is gathered but not yet handed over is lost on a stop; the card
 * keeps the news (`task mine`, the comments new to its assignee). #2801: a notice still waiting when one of its cards
 * changes status or assignee again is withdrawn once every card on it has (its key names them); and news an instance
 * also told in its own message (naming the card, within TOLD_WINDOW_MS) is not told again.
 */
import type { Wake, WakeReason } from "./scheduler/task-board.js";
import { gapText, oneLine } from "./scheduler/task-board-text.js";
import { personConfirms, wrapUpGap, type Card } from "./scheduler/task-board.js";

export interface TaskBoardWakerDeps {
  /** Hand `message` to the instance for good (the fleet's durable delivery); false when it could not be taken. */
  deliver(instance: string, message: string, key: string): boolean;
  /** Whether the board may wake this name: a fleet instance (an assignee can be any name). */
  isInstance(name: string): boolean;
  /** What of a wake still stands now (TaskBoard.wakeHolds), and the card, to say what it lacks. */
  holds(wake: Wake): Wake | null;
  card(uuid: string): Card | undefined;
  /**
   * #2352: whether the person has this card's Needs you buttons in `instance`'s own channel (it is the card's lane):
   * then a dispatcher's wake says so instead of asking it to tell the person.
   */
  buttonsHere?(instance: string, uuid: string): boolean;
  /**
   * #2785 (c), #2801: whether `from` sent `to` a message naming one of `codes` since `sinceMs` (epoch ms). An instance
   * that changes a card and messages the one it concerns about it (delegate_task, send_to_instance) has told them: the
   * board's line would only repeat it. Absent: every piece of news is told.
   */
  messagedAbout?(from: string, to: string, codes: string[], sinceMs: number): boolean;
  /**
   * #2801: drop AgEnD's notices still waiting whose key starts with `prefix` and that `stale` judges overtaken (the
   * delivery outbox's withdrawWaitingNotices); returns how many. Absent: a waiting notice is delivered as it is.
   */
  withdraw?(prefix: string, stale: (key: string, createdAt: string) => boolean, reason: string): number;
  /** #2801: when a card's status or assignee last changed (ISO; TaskBoard.lastChangeAt). */
  changedAt?(uuid: string): string | null;
  log(level: "info" | "warn", message: string, extra?: Record<string, unknown>): void;
  gatherMs?: number;
  /** #2785 (c), #2801: how far back, and how long ahead, a change looks for its maker's own message about it. */
  toldWindowMs?: number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  now?: () => number;
}

/**
 * #2785 (c), #2801: news an instance made waits this long (from the change) for its own message about the card before
 * the board tells it; an assignment also counts a message up to this long before it.
 */
export const TOLD_WINDOW_MS = 120_000;
/** The start of a task board notice's key; `:cards=` and the card uuids end it (#2801). */
const KEY_PREFIX = "task-board:";
const cardsOfKey = (key: string) => { const at = key.lastIndexOf(":cards="); return at < 0 ? [] : key.slice(at + 7).split(",").filter(Boolean); };

/** Whether `text` names card `code` (M-12 is not M-123). */
export const namesCard = (text: string, code: string) => new RegExp(`(^|[^\\w-])${code.replace(/-/g, "\\-")}(?!\\d)`).test(text);

/** More assignments than this in one message are told as a count, not a line each. */
const MANY_ASSIGNED = 3;
/** The order a card's news is told in. */
const ORDER: WakeReason[] = ["cancelled", "sent_back", "decide", "to_confirm", "confirm_own", "answered", "answer_kept", "wrap_up", "assigned", "start", "ready"];

const quote = (text: string | undefined) => (text ? `: "${oneLine(text, 160)}"` : "");

/** One reason, as a line about the card says it. */
function say(w: Wake, r: WakeReason, card: Card | undefined, here = false): string {
  const by = w.by[r] ?? "someone";
  switch (r) {
    case "assigned": return `assigned to you by ${by}`;
    case "start": return `${by} asks you to start it`;
    case "sent_back": return `sent back by ${by}${quote(w.texts.sent_back)}`;
    case "answered": return `${by} answered your blocked question${quote(w.texts.answered)} — it is in progress again`;
    // #2801 review: the answer waits on the card while the assignee finishes another (#2303); nothing else would say so.
    case "answer_kept": return `${by} answered your blocked question${quote(w.texts.answer_kept)} — kept on the card, which stays blocked while you finish your current card: resume it (move it to claimed) when you're free`;
    case "ready": return "everything it waited for is done — you can start it";
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
    case "cancelled": return `cancelled by ${by}${w.texts.cancelled?.startsWith("with its main task") ? ` ${oneLine(w.texts.cancelled, 160)}` : quote(w.texts.cancelled)} — stop working on it`;
    case "wrap_up": {
      const gap = card ? wrapUpGap(card) : null;
      return `it went ${card && !personConfirms(card) ? "to review" : "to the person for confirmation"} by itself${gap ? `, but ${gapText(gap, true)}` : ""} — fill it in with update`;
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
    const tail = "Read task mine for the order and work through them one at a time, by priority.";
    return rest.length ? `[Task board] ${summary}\n${rest.map((w) => `- ${line(w)}`).join("\n")}\n${tail}` : `[Task board] ${summary} ${tail}`;
  }
  if (items.length === 1) return `[Task board] ${line(items[0]!)} Read it with: task get ${items[0]!.code}`;
  return `[Task board] ${items.length} things on your cards:\n${items.map((w) => `- ${line(w)}`).join("\n")}\nYour work: task mine`;
}

export class TaskBoardWaker {
  private readonly gathering = new Map<string, { wakes: Map<string, Wake>; at: Map<string, number>; timer: unknown }>();
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
        batch = { wakes: new Map(), at: new Map(), timer: this.timers.set(() => this.flush(w.instance), this.deps.gatherMs ?? 10_000) };
        this.gathering.set(w.instance, batch);
      }
      if (!batch.at.has(w.uuid)) batch.at.set(w.uuid, (this.deps.now ?? Date.now)());
      const had = batch.wakes.get(w.uuid);
      batch.wakes.set(w.uuid, had
        ? { ...had, title: w.title, reasons: [...new Set([...had.reasons, ...w.reasons])], by: { ...had.by, ...w.by }, texts: { ...had.texts, ...w.texts } }
        : { ...w, reasons: [...w.reasons], by: { ...w.by }, texts: { ...w.texts } });
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

  /** Nothing more is sent (the fleet is stopping); news still gathering is dropped — the cards keep it. */
  stop(): void {
    this.stopped = true;
    for (const b of this.gathering.values()) this.timers.clear(b.timer);
    this.gathering.clear();
  }

  private flush(instance: string): void {
    const batch = this.gathering.get(instance);
    this.gathering.delete(instance);
    if (!batch || this.stopped) return;
    // #2785 (c), #2801: news an instance made is told by its own message; the board waits for it, then drops its line.
    const told = this.foldToldNews(instance, batch);
    // Only what still holds as it goes out: not finished meanwhile, still theirs, still waiting on them.
    const wakes = told.map((w) => this.deps.holds(w)).filter((w): w is Wake => w !== null);
    if (!wakes.length) return;
    const codes = wakes.map((w) => w.code);
    const key = `${KEY_PREFIX}${instance}:${(this.deps.now ?? Date.now)()}:${++this.seq}:cards=${wakes.map((w) => w.uuid).join(",")}`;
    let taken = false;
    try { taken = this.deps.deliver(instance, wakeMessage(wakes, (uuid) => this.deps.card(uuid), (w) => this.deps.buttonsHere?.(instance, w.uuid) === true), key); } catch (err) {
      this.deps.log("warn", "Task board wake failed", { instance, codes, err: (err as Error).message });
      return;
    }
    if (taken) this.deps.log("info", "Task board wake handed to delivery", { instance, codes });
    else this.deps.log("warn", "Task board wake not taken; the cards keep the news", { instance, codes });
  }

  /**
   * #2785 (c), #2801: the batch's wakes with each piece of news dropped where the instance that made it messaged this
   * one naming the card (or, for a sub task, its main task) about it: for an assignment since shortly before it (a
   * delegate_task often comes first); for anything else only since the change (#2801 review: an earlier message about
   * the card did not tell what came after it). A card whose maker has not yet done so waits, up to TOLD_WINDOW_MS from
   * the change, in a batch of its own; after that the board tells it. A cancel is told at once, never folded ("stop
   * working on it" must not wait); so are a person's change and the board's own.
   */
  private foldToldNews(instance: string, batch: { wakes: Map<string, Wake>; at: Map<string, number> }): Wake[] {
    const ask = this.deps.messagedAbout;
    if (!ask) return [...batch.wakes.values()];
    const now = (this.deps.now ?? Date.now)();
    const window = this.deps.toldWindowMs ?? TOLD_WINDOW_MS;
    const out: Wake[] = [];
    const waiting = new Map<string, Wake>();
    for (const [uuid, w] of batch.wakes) {
      if (w.reasons.includes("cancelled")) { out.push(w); continue; }
      const at = batch.at.get(uuid) ?? now;
      const codes = [w.code, ...(w.parent ? [w.parent] : [])];
      const asked = new Map<string, boolean | "failed">();
      const told: WakeReason[] = [];
      let pending = false;
      for (const r of w.reasons) {
        const by = w.by[r];
        if (!by || !this.deps.isInstance(by)) continue;
        const since = r === "assigned" ? at - window : at;
        let messaged = asked.get(`${by}\u0000${since}`);
        if (messaged === undefined) {
          try { messaged = ask(by, instance, codes, since); }
          catch (err) {
            this.deps.log("warn", "Task board could not look for the maker's message; telling it", { instance, code: w.code, err: (err as Error).message });
            messaged = "failed";
          }
          asked.set(`${by}\u0000${since}`, messaged);
        }
        if (messaged === true) told.push(r);
        else if (messaged === false && now - at < window) pending = true;
      }
      if (pending) { waiting.set(uuid, w); continue; }
      if (told.length) this.deps.log("info", "Task board news already told by its maker", { instance, code: w.code, reasons: told });
      const rest = w.reasons.filter((r) => !told.includes(r));
      if (rest.length) out.push(told.length ? { ...w, reasons: rest } : w);
    }
    if (waiting.size && !this.stopped) {
      const left = Math.min(...[...waiting.keys()].map((uuid) => window - (now - (batch.at.get(uuid) ?? now))));
      const again = this.gathering.get(instance) ?? { wakes: new Map(), at: new Map(), timer: this.timers.set(() => this.flush(instance), Math.max(1, left)) };
      for (const [uuid, w] of waiting) { again.wakes.set(uuid, w); again.at.set(uuid, batch.at.get(uuid) ?? now); }
      this.gathering.set(instance, again);
    }
    return out;
  }
}
