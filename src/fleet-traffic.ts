/**
 * #1918: live cross-instance traffic for the org canvas — what the delivery outbox already records, as a small item the
 * page can draw: who sends what kind of message to whom, and how far it got. No new probe: items are made where the
 * outbox already changes a row (admission, its "state" events, a consumed mark), from the row the listener already has.
 *
 * - Only messages between instances: send_to_instance and what is built on it (delegate_task, report_result,
 *   request_information) and broadcast. Fleet-generated notices (system, reply-obligation, outcome) are not traffic.
 * - Never a delivery id or any text: an opaque id (a hash of the delivery id) and the two instance names. A broadcast's
 *   items (one row per recipient) share an opaque `op`, so the page can draw them as one fan-out.
 * - An instance whose cross_instance_visibility is "hidden" takes no part: a message to or from it is not shown.
 * - The work, not just the message (Delegations): a task opens a delegation, delegator → worker, that stays open until
 *   the worker's report with the same correlation id comes back (the other way), so "who is working for whom" is on the
 *   canvas for as long as it is true, a reload or the public link included. Opaque ids again (a hash of the correlation
 *   id and the two names); capped, and given up after DELEGATION_TTL_MS with "no report yet".
 */
import { createHash } from "node:crypto";
import type { FleetConfig } from "./types.js";
import type { OutboxDelivery, OutboxState } from "./delivery-outbox.js";
import { crossInstanceVisibility } from "./cross-instance-notice.js";

export type TrafficKind = "task" | "report" | "query" | "update" | "send" | "broadcast";
export type TrafficState = "queued" | "delivering" | "delivered" | "consumed" | "failed" | "uncertain" | "cancelled";
export interface TrafficItem { id: string; from: string; to: string; kind: TrafficKind; state: TrafficState; at: string; op?: string }

/** The row kinds that are messages between instances (outbound-handlers: send_to_instance's family, broadcast). */
const MESSAGE_KINDS: ReadonlySet<string> = new Set(["fleet_inbound", "steer", "broadcast"]);
const REQUEST_KINDS: Readonly<Record<string, TrafficKind>> = { task: "task", report: "report", query: "query", update: "update" };
const STATES: Readonly<Record<OutboxState | "consumed", TrafficState>> = {
  queued: "queued", retry_wait: "queued",
  delivering: "delivering", submission_started: "delivering", reconciliation_pending: "delivering",
  delivered: "delivered", consumed: "consumed",
  failed: "failed", uncertain: "uncertain", cancelled: "cancelled",
};
/** Finished: the item stays a short while (it fades on the page), then leaves. */
export const TRAFFIC_FINISHED: ReadonlySet<TrafficState> = new Set(["delivered", "consumed", "failed", "uncertain", "cancelled"]);
/** How long a finished item stays in the snapshot, and how many items a snapshot holds at most. */
export const TRAFFIC_RECENT_MS = 120_000;
export const TRAFFIC_SNAPSHOT_MAX = 200;

export const trafficId = (deliveryId: string): string => createHash("sha256").update(deliveryId).digest("hex").slice(0, 16);

/** The item for a delivery row in `state` (default: the row's own), or null when it is not shown. */
export function trafficItem(row: OutboxDelivery, fleet: Pick<FleetConfig, "defaults" | "instances"> | null | undefined, at: string, state?: OutboxState | "consumed"): TrafficItem | null {
  if (!MESSAGE_KINDS.has(row.kind)) return null;
  const from = row.sourceInstance, to = row.targetInstance;
  if (!from || !to || from === to) return null;
  if (crossInstanceVisibility(fleet, from) === "hidden" || crossInstanceVisibility(fleet, to) === "hidden") return null;
  const mapped = STATES[state ?? (row.reconciliationPending ? "reconciliation_pending" : row.state)];
  if (!mapped) return null;
  const meta = (row.payload as { meta?: { request_kind?: unknown } } | undefined)?.meta;
  const kind: TrafficKind = row.kind === "broadcast" ? "broadcast"
    : typeof meta?.request_kind === "string" && Object.prototype.hasOwnProperty.call(REQUEST_KINDS, meta.request_kind) ? REQUEST_KINDS[meta.request_kind]! : "send";
  return { id: trafficId(row.deliveryId), from, to, kind, state: mapped, at, ...(kind === "broadcast" ? { op: trafficId(`op:${row.operationId}`) } : {}) };
}

/**
 * The traffic the fleet keeps in memory for a snapshot: each item's latest state, by id. Finished items are dropped
 * TRAFFIC_RECENT_MS after they finished; at most TRAFFIC_SNAPSHOT_MAX are kept (the oldest go first).
 */
export class TrafficLog {
  private readonly items = new Map<string, { item: TrafficItem; seenMs: number }>();
  constructor(private readonly monotonic: () => number = () => performance.now()) {}

  /** Record an item; returns it when it is news (a new id, or a new state for one), else null. */
  note(item: TrafficItem): TrafficItem | null {
    const prev = this.items.get(item.id);
    if (prev && prev.item.state === item.state) return null;
    // A finished item never goes back to an earlier state (events can arrive out of order across listeners).
    if (prev && TRAFFIC_FINISHED.has(prev.item.state) && !TRAFFIC_FINISHED.has(item.state)) return null;
    if (prev && prev.item.state === "consumed") return null;
    this.items.delete(item.id);
    this.items.set(item.id, { item, seenMs: this.monotonic() });
    this.prune();
    return item;
  }

  /**
   * In flight now and recently finished: the pending rows' items first (the outbox is the truth for what is still
   * moving), then the recent finished ones; newest last, at most TRAFFIC_SNAPSHOT_MAX.
   */
  snapshot(pending: readonly TrafficItem[]): TrafficItem[] {
    this.prune();
    const out = new Map<string, TrafficItem>();
    for (const p of pending) out.set(p.id, p);
    for (const { item } of this.items.values()) if (TRAFFIC_FINISHED.has(item.state) && !out.has(item.id)) out.set(item.id, item);
    const all = [...out.values()];
    return all.slice(Math.max(0, all.length - TRAFFIC_SNAPSHOT_MAX));
  }

  private prune(): void {
    const now = this.monotonic();
    for (const [id, e] of this.items) {
      if (TRAFFIC_FINISHED.has(e.item.state) ? now - e.seenMs > TRAFFIC_RECENT_MS : now - e.seenMs > 24 * 3_600_000) this.items.delete(id);
    }
    while (this.items.size > TRAFFIC_SNAPSHOT_MAX * 2) this.items.delete(this.items.keys().next().value!);
  }
}

export type DelegationState = "open" | "done" | "expired" | "cancelled";
/** A delegation as the page draws it: `age_ms` how long it has been open (the page's own clock times its expiry). */
export interface Delegation { id: string; from: string; to: string; state: DelegationState; age_ms: number }
/** How long a delegation waits for its report before the canvas gives up on it ("no report yet"), and how many are open. */
export const DELEGATION_TTL_MS = 4 * 3_600_000;
export const DELEGATIONS_MAX = 100;

/** The pair a report closes: correlation id, delegator, worker. */
const pairKey = (correlationId: string, from: string, to: string): string => `${correlationId}\u0000${from}\u0000${to}`;
const DEAD: ReadonlySet<TrafficState> = new Set(["failed", "cancelled"]);
/** How many deliveries are remembered as handled: a task that opened one, a report that was taken (#2135 review). */
const HANDLED_MAX = 2000;

/**
 * The delegations open now. `note(row, item)` takes each traffic item with its row (for the correlation id, never sent
 * on): a task delivery's admission opens one (keyed for its report by correlation id and the two names; its id is the
 * delivery's own, so a new task with the same correlation id is a new delegation); that delivery failing or being
 * cancelled takes it back; a report from the worker to the delegator with the same correlation id closes it. Each
 * delivery counts once, at its first state: a later state of a task delivery that already opened one — delivered or
 * consumed after its report came back, or after it expired — never opens it again, and a later state of a report never
 * closes the next task of the same correlation id and pair. Returns the news, for the stream. The oldest go first past DELEGATIONS_MAX; an open
 * one past DELEGATION_TTL_MS expires.
 */
export class Delegations {
  private readonly open = new Map<string, { id: string; task: string; from: string; to: string; openedMs: number }>();
  /** The deliveries (their traffic ids) already handled — tasks that opened one, reports taken: bounded, oldest out. */
  private readonly handled = new Set<string>();
  constructor(private readonly monotonic: () => number = () => performance.now()) {}

  private ended(d: { id: string; from: string; to: string; openedMs: number }, state: Exclude<DelegationState, "open">): Delegation {
    return { id: d.id, from: d.from, to: d.to, state, age_ms: Math.max(0, this.monotonic() - d.openedMs) };
  }

  note(row: Pick<OutboxDelivery, "correlationId">, item: TrafficItem): Delegation[] {
    const news = this.sweep();
    const corr = row.correlationId;
    if (!corr || (item.kind !== "task" && item.kind !== "report")) return news;
    if (item.kind === "task") {
      const key = pairKey(corr, item.from, item.to), cur = this.open.get(key);
      if (DEAD.has(item.state)) {
        if (cur && cur.task === item.id) { this.open.delete(key); news.push(this.ended(cur, "cancelled")); }
        return news;
      }
      if (this.handled.has(item.id)) return news;                    // a later state of a delivery that opened one already
      this.noteHandled(item.id);
      if (cur) return news;                                          // one is open for this pair and correlation: its report closes it
      const d = { id: trafficId(`del:${item.id}`), task: item.id, from: item.from, to: item.to, openedMs: this.monotonic() };
      this.open.set(key, d);
      news.push({ id: d.id, from: d.from, to: d.to, state: "open", age_ms: 0 });
      while (this.open.size > DELEGATIONS_MAX) {
        const [oldKey, old] = this.open.entries().next().value!;
        this.open.delete(oldKey);
        news.push(this.ended(old, "expired"));
      }
      return news;
    }
    // A report closes the task it answers: same correlation id, the other way round — once, at its first state (its later
    // states are the same report, not an answer to a newer task).
    if (this.handled.has(item.id)) return news;
    this.noteHandled(item.id);
    if (DEAD.has(item.state)) return news;
    const key = pairKey(corr, item.to, item.from), d = this.open.get(key);
    if (d) { this.open.delete(key); news.push(this.ended(d, "done")); }
    return news;
  }

  private noteHandled(deliveryId: string): void {
    this.handled.delete(deliveryId);
    this.handled.add(deliveryId);
    while (this.handled.size > HANDLED_MAX) this.handled.delete(this.handled.values().next().value!);
  }

  /** What is open now (after expiring the ones past the TTL — the stream is told by the next note). */
  snapshot(): Delegation[] {
    this.sweep();
    const now = this.monotonic();
    return [...this.open.values()].map((d) => ({ id: d.id, from: d.from, to: d.to, state: "open" as const, age_ms: Math.max(0, now - d.openedMs) }));
  }

  /** Expire what has waited past the TTL; returns the news. */
  sweep(): Delegation[] {
    const now = this.monotonic(), out: Delegation[] = [];
    for (const [key, d] of this.open) {
      if (now - d.openedMs < DELEGATION_TTL_MS) continue;
      this.open.delete(key);
      out.push(this.ended(d, "expired"));
    }
    return out;
  }
}
