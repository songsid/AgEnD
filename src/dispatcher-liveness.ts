/**
 * #3647: telling a card's dispatcher when its assignee stops — crashed and not coming back, paused (sign-in ended, a usage
 * limit, an error back-off), hung, waiting on a prompt nobody answers, or quiet with the card claimed (design:
 * docs/design/dispatcher-liveness.md). This file is the judgement only: what the assignee's facts say, and whether an
 * episode already told is still going on. The fleet gathers the facts (fleet-manager) and keeps the episodes
 * (scheduler/task-liveness.ts); DispatcherLiveness below ties them together on the fleet's 30 s sweep.
 *
 * The fleet only tells: it already respawns crashes and wakes a paused agent on delivery; restarting or reassigning
 * stays the dispatcher's call (the owner, 2026-11-11).
 */
import type { LivenessEpisode, LivenessLedger } from "./scheduler/task-liveness.js";
import { t } from "./locale.js";

/** `defaults.task_board.liveness` — the owner's defaults (2026-11-11). */
export const LIVENESS_DEFAULTS = Object.freeze({ enabled: true, quiet_minutes: 60, prompt_minutes: 10, crash_grace_minutes: 5 });
export interface LivenessSettings { enabled: boolean; quietMs: number; promptMs: number; crashGraceMs: number }
/** After the fleet starts, nothing is judged for this long: every agent is (re)starting, and none of it is news. */
export const LIVENESS_STARTUP_GRACE_MS = 5 * 60_000;

/** The settings in force: each value from `defaults.task_board.liveness`, else its default. */
export function livenessSettings(fleet: { defaults?: { task_board?: { liveness?: unknown } } } | null | undefined): LivenessSettings {
  const raw = fleet?.defaults?.task_board?.liveness;
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const minutes = (v: unknown, d: number) => typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 1440 ? v : d;
  return {
    enabled: o.enabled !== false,
    quietMs: minutes(o.quiet_minutes, LIVENESS_DEFAULTS.quiet_minutes) * 60_000,
    promptMs: minutes(o.prompt_minutes, LIVENESS_DEFAULTS.prompt_minutes) * 60_000,
    crashGraceMs: minutes(o.crash_grace_minutes, LIVENESS_DEFAULTS.crash_grace_minutes) * 60_000,
  };
}

/** What the fleet knows about an assignee right now (all optional: an unknown fact never makes an alarm). */
export interface AssigneeFacts {
  /** The process as the fleet last saw it. */
  process: "running" | "crashed" | "stopped";
  /** Supervision gave up on it: a crash loop (respawn paused) or supervision ended (retries spent, an exit, OOM). */
  gone?: { kind: "crash_loop" | "supervision_ended"; reason: string; at: number } | null;
  /** When the fleet first saw it crashed. */
  crashedAt?: number | null;
  /** Its pause marker: the reason and when. */
  paused?: { reason: string | null; at: number | null } | null;
  /** On a usage-limit hold. */
  usageHold?: { model: string; since: number } | null;
  /** Its pane's execution state and since when. */
  execution?: { state: "idle" | "working" | "stuck"; since: number } | null;
  /** When it last showed working (tool calls, thinking): any working edge counts as activity. */
  lastWorkingAt?: number | null;
  /** A prompt or dialog waiting for a person at its terminal, and since when. */
  prompt?: { since: number } | null;
  /** The instances it asked something and still waits on (an open request with a correlation id). */
  waitingOn?: string[];
  /** When it last sent a message to anyone (a reply, send_to_instance, report_result…). */
  lastMessageAt?: number | null;
}

/** The card's own times, for "no progress since". */
export interface CardTimes { claimedAt: number; updatedAt: number }

export type StopKind = "gone" | "crashed" | "auth" | "usage" | "error" | "hung" | "prompt" | "quiet";
/** Which episode wins when several hold: the most serious first ("will not come back" over "quiet"). */
const RANK: Record<StopKind, number> = { gone: 8, crashed: 7, auth: 6, usage: 5, error: 4, hung: 3, prompt: 2, quiet: 1 };
export const livenessRank = (k: StopKind): number => RANK[k] ?? 0;

export interface StopVerdict { kind: StopKind; since: number; detail: string }

const latest = (...xs: Array<number | null | undefined>): number => Math.max(0, ...xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x)));

/**
 * The episode the facts show now, or null: the most serious one whose time has come. `quiet` here is the clock only — the
 * caller still asks for background work (subagents, a background task) before telling it.
 */
export function judgeAssignee(f: AssigneeFacts, card: CardTimes, s: LivenessSettings, now: number): StopVerdict | null {
  if (f.gone) return { kind: "gone", since: f.gone.at, detail: f.gone.reason };
  if (f.process === "crashed") {
    const at = f.crashedAt ?? null;
    if (at !== null && now - at >= s.crashGraceMs) return { kind: "crashed", since: at, detail: "" };
    return null;                                                     // auto-respawn usually fixes it in seconds
  }
  const reason = f.paused?.reason ?? null;
  if (reason === "auth") return { kind: "auth", since: f.paused?.at ?? now, detail: "" };
  if (f.usageHold) return { kind: "usage", since: f.usageHold.since, detail: f.usageHold.model };
  if (reason === "error") return { kind: "error", since: f.paused?.at ?? now, detail: "" };
  if (f.process === "stopped") return null;                          // stopped by a person (or a fleet stop): they know
  if (f.execution?.state === "stuck") return { kind: "hung", since: f.execution.since, detail: "" };
  if (f.prompt && now - f.prompt.since >= s.promptMs) return { kind: "prompt", since: f.prompt.since, detail: "" };
  if (f.prompt || reason === "operator") return null;
  // Quiet: idle (or paused for being idle), nothing it asked still open, and no sign of progress for the threshold.
  const idlePaused = reason === "idle" || reason === "warm_cap";
  const idle = f.execution?.state === "idle" || idlePaused;
  if (!idle || f.execution?.state === "working" || (f.waitingOn?.length ?? 0) > 0) return null;
  const since = latest(card.claimedAt, card.updatedAt, f.lastMessageAt, f.lastWorkingAt,
    f.execution?.state === "idle" ? f.execution.since : null, idlePaused ? f.paused?.at : null);
  if (!since || now - since < s.quietMs) return null;
  return { kind: "quiet", since, detail: "" };
}

/**
 * Whether an episode already told is still going on. Recovery needs positive evidence, not just a clock below its
 * threshold — after a fleet restart the idle clock starts again, and that must not read as "working again".
 */
export function stillStopped(ep: { kind: StopKind; since: number }, f: AssigneeFacts, card: CardTimes): boolean {
  switch (ep.kind) {
    case "gone": return !!f.gone || f.process !== "running";
    case "crashed": return f.process === "crashed";
    case "auth": return f.paused?.reason === "auth";
    case "usage": return !!f.usageHold;
    case "error": return f.paused?.reason === "error";
    case "hung": return f.execution?.state === "stuck";
    case "prompt": return !!f.prompt;
    case "quiet": {
      if (f.process !== "running" && f.paused?.reason !== "idle" && f.paused?.reason !== "warm_cap") return true;
      if (f.execution?.state === "working") return false;
      return latest(card.updatedAt, f.lastMessageAt, f.lastWorkingAt) <= ep.since;
    }
  }
}

/** How long, said plainly: "1 h 05 min", "12 min". */
export function spanText(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m >= 60 ? t("liveness.span_hours", Math.floor(m / 60), String(m % 60).padStart(2, "0")) : t("liveness.span_minutes", m);
}

/** One card's line: what happened to its assignee and what the dispatcher can do. */
export function stoppedLine(card: { code: string; title: string }, assignee: string, v: StopVerdict, now: number): string {
  const title = card.title.replace(/\s+/g, " ").trim();
  const short = title.length > 60 ? `${title.slice(0, 59)}…` : title;
  const what = t(`liveness.what_${v.kind}`, assignee, spanText(now - v.since), v.detail);
  return `${card.code} "${short}" — ${what}${t("liveness.sep")}${t(`liveness.todo_${v.kind}`)}`;
}

/** The dispatcher's notice for one sweep's new episodes (one or several cards). */
export function stoppedMessage(lines: string[], codes: string[]): string {
  if (lines.length === 1) return `[Task board] ${lines[0]}${t("liveness.sep")}${t("liveness.read_one", codes[0])}`;
  return `[Task board] ${t("liveness.many", lines.length)}\n${lines.map((l) => `- ${l}`).join("\n")}\n${t("liveness.read_many")}`;
}

export const backMessage = (card: { code: string; title: string }, assignee: string): string =>
  `[Task board] ${t("liveness.back", card.code, card.title.replace(/\s+/g, " ").trim().slice(0, 60), assignee)}`;

/** The key of one card's notice in one episode: the same episode is admitted once, across restarts too. */
export const LIVENESS_KEY = "task-liveness:";
export const episodeKey = (dispatcher: string, uuids: string[], since: number[]) =>
  `${LIVENESS_KEY}${dispatcher}:${since.join(",")}:cards=${uuids.join(",")}`;

/** A claimed card as the sweep sees it. */
export interface LivenessCard {
  uuid: string; code: string; title: string; assignee: string;
  dispatcher: { kind: "person" | "instance"; name: string } | null;
  claimedAt: number; updatedAt: number;
}

export interface DispatcherLivenessDeps {
  settings(): LivenessSettings;
  /** A graceful stop or `agend update` is in progress: nothing is judged. */
  plannedRestart(): boolean;
  /** When this fleet process started (epoch ms). */
  startedAt(): number;
  /** Every claimed card that has an assignee. */
  claimedCards(): LivenessCard[];
  /** The assignee's facts, or null when it is not an instance of this fleet. */
  facts(name: string): AssigneeFacts | null;
  /** Background work the pane does not show: a live subagent, a background task. Asked only before a quiet notice. */
  backgroundBusy(name: string): Promise<boolean>;
  isInstance(name: string): boolean;
  /**
   * The dispatcher is an agent that is not running now (stopped, crashed, paused): its notice waits in its queue, so the
   * person is told in Needs you as well (the leader, 2026-11-11).
   */
  dispatcherAway?(name: string): boolean;
  /** The task board is switched off for this instance: it gets no board notices. */
  boardOff?(name: string): boolean;
  /** Hand an AgEnD notice to an instance (the delivery outbox; `key` makes it idempotent). */
  deliver(instance: string, message: string, key: string): boolean;
  /** Withdraw AgEnD notices still waiting whose key starts with `prefix` and that `stale` picks. */
  withdraw(prefix: string, stale: (key: string) => boolean, reason: string): number;
  /** The delivery state of the notice with this key, or null. */
  noticeState(key: string): string | null;
  /** Something a person sees changed (Needs you). */
  personChanged?(): void;
  ledger: LivenessLedger;
  now?: () => number;
  log(level: "info" | "warn", message: string, extra?: Record<string, unknown>): void;
}

/**
 * One sweep at a time: new episodes are told (one message per dispatcher), episodes that ended are cleared (a notice
 * still waiting is withdrawn; one already delivered gets one "working again" line), and an episode whose card moved on
 * or changed hands ends without a word.
 */
export class DispatcherLiveness {
  private running = false;
  constructor(private readonly deps: DispatcherLivenessDeps) {}

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try { await this.sweep(); }
    catch (err) { this.deps.log("warn", "Dispatcher liveness sweep failed", { err: (err as Error).message }); }
    finally { this.running = false; }
  }

  private async sweep(): Promise<void> {
    const d = this.deps, now = (d.now ?? Date.now)(), s = d.settings();
    if (d.plannedRestart() || now - d.startedAt() < LIVENESS_STARTUP_GRACE_MS) return;
    const cards = s.enabled ? d.claimedCards() : [];
    const live = new Map(cards.map((c) => [c.uuid, c] as const));
    // Episodes whose card is no longer claimed by the same assignee for the same dispatcher end quietly.
    for (const ep of d.ledger.listOpen()) {
      const c = live.get(ep.cardUuid);
      if (!c || c.assignee !== ep.assignee || (c.dispatcher?.name ?? null) !== ep.dispatcher) this.end(ep, false);
    }
    const told = new Map<string, Array<{ card: LivenessCard; v: StopVerdict }>>();
    for (const c of cards) {
      const disp = c.dispatcher;
      if (!disp || (disp.kind === "instance" && disp.name === c.assignee)) continue;   // nobody else to tell
      const f = d.facts(c.assignee);
      if (!f) continue;
      const times = { claimedAt: c.claimedAt, updatedAt: c.updatedAt };
      const open = d.ledger.get(c.uuid);
      const v = judgeAssignee(f, times, s, now);
      if (open) {
        if (stillStopped(open, f, times)) {
          if (!v || livenessRank(v.kind) <= livenessRank(open.kind)) continue;     // the same news, or less: once
          this.end(open, false);                                                    // worse news replaces it
        } else {
          this.end(open, true);
          if (!v || v.kind === open.kind) continue;
        }
      }
      if (!v) continue;
      if (v.kind === "quiet" && await d.backgroundBusy(c.assignee).catch(() => true)) continue;
      const toPerson = disp.kind === "person" || !d.isInstance(disp.name);
      if (toPerson) {
        d.ledger.open({ cardUuid: c.uuid, assignee: c.assignee, dispatcher: disp.name, dispatcherKind: "person", kind: v.kind, since: v.since, detail: v.detail, noticeKey: null, notifiedAt: now });
        d.personChanged?.();
        d.log("info", "Assignee stopped; the person dispatcher sees it in Needs you", { card: c.code, assignee: c.assignee, kind: v.kind });
        continue;
      }
      const list = told.get(disp.name) ?? [];
      list.push({ card: c, v });
      told.set(disp.name, list);
    }
    for (const [dispatcher, items] of told) {
      const key = episodeKey(dispatcher, items.map((x) => x.card.uuid), items.map((x) => x.v.since));
      if (d.boardOff?.(dispatcher)) {
        for (const x of items) d.ledger.open({ cardUuid: x.card.uuid, assignee: x.card.assignee, dispatcher, dispatcherKind: "instance", kind: x.v.kind, since: x.v.since, detail: x.v.detail, noticeKey: null, notifiedAt: now });
        continue;
      }
      const away = d.dispatcherAway?.(dispatcher) === true;
      const message = stoppedMessage(items.map((x) => stoppedLine(x.card, x.card.assignee, x.v, now)), items.map((x) => x.card.code));
      let taken = false;
      try { taken = d.deliver(dispatcher, message, key); }
      catch (err) { d.log("warn", "Dispatcher liveness notice failed", { dispatcher, err: (err as Error).message }); }
      for (const x of items) d.ledger.open({ cardUuid: x.card.uuid, assignee: x.card.assignee, dispatcher, dispatcherKind: "instance", kind: x.v.kind, since: x.v.since, detail: x.v.detail, noticeKey: taken ? key : null, notifiedAt: now, needsYou: away });
      if (away) d.personChanged?.();
      d.log("info", "Dispatcher told: assignee stopped", { dispatcher, cards: items.map((x) => x.card.code), kinds: items.map((x) => x.v.kind), taken, ...(away ? { dispatcherAway: true } : {}) });
    }
  }

  /** An episode is over: withdraw its notice if still waiting; `recovered` and already delivered → one "working again" line. */
  private end(ep: LivenessEpisode, recovered: boolean): void {
    const d = this.deps;
    d.ledger.close(ep.cardUuid);
    if (ep.dispatcherKind === "person") { d.personChanged?.(); return; }
    if (ep.needsYou) d.personChanged?.();
    if (!ep.noticeKey) return;
    const key = ep.noticeKey;
    // One notice may tell several cards: it is withdrawn only once none of them is still stopped.
    const withdrawn = d.ledger.openWithKey(key) === 0
      ? d.withdraw(key, (k) => k === key, recovered ? "the assignee is working again" : "the card moved on") : 0;
    if (withdrawn || !recovered) return;
    // Told, or still on its way (another card on it is still stopped — notices go out in order): the line follows it.
    // Withdrawn, failed or unknown: the dispatcher never read the news, so there is nothing to take back.
    const state = d.noticeState(key);
    if (!state || state === "cancelled" || state === "failed") return;
    const card = d.claimedCards().find((c) => c.uuid === ep.cardUuid);
    if (!card) return;
    d.deliver(ep.dispatcher, backMessage(card, ep.assignee), `task-liveness-back:${ep.dispatcher}:${ep.cardUuid}:${ep.since}`);
    d.log("info", "Dispatcher told: assignee working again", { dispatcher: ep.dispatcher, card: card.code });
  }
}
