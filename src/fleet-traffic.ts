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

const delegationId = (correlationId: string, from: string, to: string): string => trafficId(`del:${correlationId}\u0000${from}\u0000${to}`);
const DEAD: ReadonlySet<TrafficState> = new Set(["failed", "cancelled"]);

/**
 * The delegations open now. `note(row, item)` takes each traffic item with its row (for the correlation id, never sent
 * on): a task that was admitted opens one; its delivery failing or being cancelled takes it back; a report from the
 * worker to the delegator with the same correlation id closes it. Returns the news, for the stream. The oldest go first
 * past DELEGATIONS_MAX; an open one past DELEGATION_TTL_MS expires.
 */
export class Delegations {
  private readonly open = new Map<string, { from: string; to: string; openedMs: number }>();
  constructor(private readonly monotonic: () => number = () => performance.now()) {}

  note(row: Pick<OutboxDelivery, "correlationId">, item: TrafficItem): Delegation[] {
    const news = this.sweep();
    const corr = row.correlationId;
    if (!corr || (item.kind !== "task" && item.kind !== "report")) return news;
    if (item.kind === "task") {
      const id = delegationId(corr, item.from, item.to);
      if (DEAD.has(item.state)) {
        if (this.open.delete(id)) news.push({ id, from: item.from, to: item.to, state: "cancelled", age_ms: 0 });
      } else if (!this.open.has(id)) {
        this.open.set(id, { from: item.from, to: item.to, openedMs: this.monotonic() });
        news.push({ id, from: item.from, to: item.to, state: "open", age_ms: 0 });
        while (this.open.size > DELEGATIONS_MAX) {
          const [oldId, old] = this.open.entries().next().value!;
          this.open.delete(oldId);
          news.push({ id: oldId, from: old.from, to: old.to, state: "expired", age_ms: Math.max(0, this.monotonic() - old.openedMs) });
        }
      }
      return news;
    }
    // A report closes the task it answers: same correlation id, the other way round.
    if (DEAD.has(item.state)) return news;
    const id = delegationId(corr, item.to, item.from), d = this.open.get(id);
    if (d) { this.open.delete(id); news.push({ id, from: d.from, to: d.to, state: "done", age_ms: Math.max(0, this.monotonic() - d.openedMs) }); }
    return news;
  }

  /** What is open now (after expiring the ones past the TTL — the stream is told by the next note). */
  snapshot(): Delegation[] {
    this.sweep();
    const now = this.monotonic();
    return [...this.open].map(([id, d]) => ({ id, from: d.from, to: d.to, state: "open" as const, age_ms: Math.max(0, now - d.openedMs) }));
  }

  /** Expire what has waited past the TTL; returns the news. */
  sweep(): Delegation[] {
    const now = this.monotonic(), out: Delegation[] = [];
    for (const [id, d] of this.open) {
      if (now - d.openedMs < DELEGATION_TTL_MS) continue;
      this.open.delete(id);
      out.push({ id, from: d.from, to: d.to, state: "expired", age_ms: now - d.openedMs });
    }
    return out;
  }
}
