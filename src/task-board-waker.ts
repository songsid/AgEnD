/**
 * Waking an instance when someone else changes a card it owns or handed out (step 2, docs/design/task-board.md). The
 * board decides who hears what (TaskBoard's settleWakes); this gathers an instance's news for `gatherMs` (10 s) into
 * one message — dragging five cards, or opening a whole plan, is one wake — checks again that each piece still stands
 * when it goes out (wakeHolds), and hands it to the fleet as a notice from AgEnD: the delivery outbox holds it until
 * the instance can take it, across a restart too. What is gathered but not yet handed over is lost on a stop; the card
 * keeps the news (`task mine`, the comments new to its assignee).
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
  log(level: "info" | "warn", message: string, extra?: Record<string, unknown>): void;
  gatherMs?: number;
  timers?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
  now?: () => number;
}

/** More assignments than this in one message are told as a count, not a line each. */
const MANY_ASSIGNED = 3;
/** The order a card's news is told in. */
const ORDER: WakeReason[] = ["cancelled", "sent_back", "decide", "to_confirm", "answered", "approved", "wrap_up", "assigned", "start", "ready", "comment"];

const quote = (text: string | undefined) => (text ? `: "${oneLine(text, 160)}"` : "");

/** One reason, as a line about the card says it. */
function say(w: Wake, r: WakeReason, card: Card | undefined, here = false): string {
  const by = w.by[r] ?? "someone";
  switch (r) {
    case "assigned": return `assigned to you by ${by}`;
    case "start": return `${by} asks you to start it`;
    case "sent_back": return `sent back by ${by}${quote(w.texts.sent_back)}`;
    case "answered": return `${by} answered your blocked question${quote(w.texts.answered)} — it is in progress again`;
    case "comment": return `new comment from ${by}${quote(w.texts.comment)}`;
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
    case "approved": {
      const who = card && !personConfirms(card) ? by : "the person";
      return card?.assignee === w.instance ? `${who} confirmed it${quote(w.texts.approved)}` : `you handed it out; ${who} confirmed it${quote(w.texts.approved)}`;
    }
    case "cancelled": return `cancelled by ${by}${w.texts.cancelled?.startsWith("with its main task") ? ` ${oneLine(w.texts.cancelled, 160)}` : quote(w.texts.cancelled)} — stop working on it`;
    case "wrap_up": {
      const gap = card ? wrapUpGap(card) : null;
      return `it went to the person for confirmation by itself${gap ? `, but ${gapText(gap, true)}` : ""} — fill it in with update`;
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
  private readonly gathering = new Map<string, { wakes: Map<string, Wake>; timer: unknown }>();
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
      batch.wakes.set(w.uuid, had
        ? { ...had, title: w.title, reasons: [...new Set([...had.reasons, ...w.reasons])], by: { ...had.by, ...w.by }, texts: { ...had.texts, ...w.texts } }
        : { ...w, reasons: [...w.reasons], by: { ...w.by }, texts: { ...w.texts } });
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
    // Only what still holds as it goes out: not finished meanwhile, still theirs, still waiting on them.
    const wakes = [...batch.wakes.values()].map((w) => this.deps.holds(w)).filter((w): w is Wake => w !== null);
    if (!wakes.length) return;
    const codes = wakes.map((w) => w.code);
    const key = `task-board:${instance}:${(this.deps.now ?? Date.now)()}:${++this.seq}`;
    let taken = false;
    try { taken = this.deps.deliver(instance, wakeMessage(wakes, (uuid) => this.deps.card(uuid), (w) => this.deps.buttonsHere?.(instance, w.uuid) === true), key); } catch (err) {
      this.deps.log("warn", "Task board wake failed", { instance, codes, err: (err as Error).message });
      return;
    }
    if (taken) this.deps.log("info", "Task board wake handed to delivery", { instance, codes });
    else this.deps.log("warn", "Task board wake not taken; the cards keep the news", { instance, codes });
  }
}
