import { readFile, open, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { UsageMetric } from "./providers.js";
import type { UsagePayload } from "./usage-api.js";
import type { QuotaNoticeRule, QuotaPeriod } from "../quota-notice-config.js";
import { usageText } from "./i18n.js";

export interface QuotaSubscription { account: string; providerId: string; rule: Required<QuotaNoticeRule> }
export interface QuotaNoticePolicy { subscriptions: QuotaSubscription[]; target: string; locale: string; destinationBinding?: string }
type Entry = { reset: number; floor: number };
type State = { v: 1; entries: Record<string, Entry> };
const RESET_DRIFT = 10 * 60_000;
const MAX_ENTRIES = 2048;

/** Periods are provider semantics/durations, never translated display labels. */
export function quotaPeriod(m: UsageMetric): QuotaPeriod | null {
  if (m.quotaPeriod) return m.quotaPeriod;
  const ms = m.windowMs;
  if (!ms || !Number.isFinite(ms)) return null;
  const hours = ms / 3_600_000;
  if (hours >= 0.9 && hours <= 1.1) return "hourly";
  if (hours > 1.1 && hours < 12) return "session";
  if (hours >= 23 && hours <= 25) return "daily";
  if (hours >= 6 * 24 && hours <= 8 * 24) return "weekly";
  if (hours >= 27 * 24 && hours <= 32 * 24) return "monthly";
  return null;
}
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/** Serial, durable at-most-once dispatch. An unknown external result is never blindly retried. */
export class QuotaNotices {
  private tail: Promise<void> = Promise.resolve();
  private stopped = false;
  private state: State | null = null;
  private failed = false;
  constructor(private opts: {
    file: string; policy(): QuotaNoticePolicy;
    send(target: string, text: string): boolean;
    warn(error: unknown): void;
    now?: () => number;
    persist?: (file: string, state: string) => Promise<void>;
  }) {}

  observe(payload: UsagePayload): Promise<void> {
    const policy = this.opts.policy(), signature = digest(policy);
    const work = this.tail.then(() => this.evaluate(payload, policy, signature));
    this.tail = work.catch(error => { this.failed = true; this.opts.warn(error); });
    return this.tail;
  }
  stop(): Promise<void> { this.stopped = true; return this.tail; }
  private current(signature: string): boolean {
    return !this.stopped && !this.failed && digest(this.opts.policy()) === signature;
  }
  private async load(): Promise<State> {
    try {
      const raw = await readFile(this.opts.file, "utf8");
      if (raw.length > 400_000) throw new Error("Quota notice state too large");
      const state = JSON.parse(raw) as State;
      if (state.v !== 1 || !state.entries || typeof state.entries !== "object" || Array.isArray(state.entries)
        || Object.keys(state.entries).length > MAX_ENTRIES
        || Object.entries(state.entries).some(([k, e]) => !/^[a-f0-9]{64}$/.test(k) || !e || !Number.isFinite(e.reset) || !Number.isFinite(e.floor) || e.floor < 1 || e.floor > 99)) throw new Error("Invalid quota notice state");
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { v: 1, entries: {} };
      throw error; // Corruption/permission errors must not reset deduplication.
    }
  }
  private async save(state: State): Promise<void> {
    const text = JSON.stringify(state);
    if (this.opts.persist) return this.opts.persist(this.opts.file, text);
    await mkdir(dirname(this.opts.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.opts.file}.${process.pid}.tmp`;
    const file = await open(tmp, "w", 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(tmp, this.opts.file);
    if (process.platform !== "win32") {
      const directory = await open(dirname(this.opts.file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  }
  private async evaluate(payload: UsagePayload, policy: QuotaNoticePolicy, signature: string): Promise<void> {
    if (!this.current(signature) || payload.refreshing || !policy.target) return;
    this.state ??= await this.load();
    if (!this.current(signature)) return;
    const now = this.opts.now?.() ?? Date.now();
    const fetched = Date.parse(payload.fetchedAt);
    if (!Number.isFinite(fetched) || fetched > now + 60_000 || now - fetched > 10 * 60_000) return;
    const grouped = new Map<string, QuotaSubscription[]>();
    for (const s of policy.subscriptions) if (s.rule.enabled) grouped.set(s.account, [...(grouped.get(s.account) ?? []), s]);
    for (const [account, subscriptions] of grouped) {
      if (!this.current(signature)) return;
      const changes: Array<{ key: string; entry: Entry; line: string; observed: number }> = [];
      const row = payload.providers.find(p => p.id === subscriptions[0]!.providerId);
      if (!row || row.status !== "ok" || row.stale || row.unlimited) continue;
      const observed = row.observedAt === undefined ? fetched : Date.parse(row.observedAt);
      if (!Number.isFinite(observed) || observed > now + 60_000 || now - observed > 10 * 60_000) continue;
      for (const m of row.metrics) {
        const period = quotaPeriod(m), reset = Date.parse(m.resetsAt ?? "");
        const measured = m.observedAt === undefined ? observed : Date.parse(m.observedAt ?? "");
        if (!Number.isFinite(measured) || measured > now + 60_000 || now - measured > 10 * 60_000) continue;
        if (!period || m.type !== "percent" || typeof m.used !== "number" || !Number.isFinite(m.used) || m.used < 0
          || m.resetKind === "expiry" || m.resetPassed || !Number.isFinite(reset) || reset <= now) continue;
        const remaining = Math.max(0, 100 - m.used);
        const thresholds = subscriptions.flatMap(s => s.rule.periods.includes(period) ? s.rule.thresholds : []);
        const threshold = Math.min(...thresholds.filter(t => remaining <= t));
        if (!Number.isFinite(threshold)) continue;
        const key = digest([account, m.labelI18n ?? m.label, m.pool ?? null, m.scope ?? null, period]);
        const prior = this.state.entries[key];
        // A later real reset opens another window. Moving a reset backwards is not proof of a new one.
        const newWindow = prior && now >= prior.reset && reset > prior.reset + RESET_DRIFT;
        if (prior && !newWindow && threshold >= prior.floor) continue;
        changes.push({ key, observed: measured, entry: { reset: prior && !newWindow ? prior.reset : reset, floor: threshold },
          line: `${m.pool?.label ? `${usageText(m.pool.label, m.pool.labelI18n)} · ` : ""}${usageText(m.label, m.labelI18n)}: ${+remaining.toFixed(1)}%${policy.locale.startsWith("zh") ? " 剩餘" : " remaining"}` });
      }
      if (!changes.length) continue;
      const next: State = { v: 1, entries: { ...this.state.entries } };
      // Keep a reset-drift margin; never evict a live reservation to make room for another notice.
      for (const [k, entry] of Object.entries(next.entries)) if (entry.reset + RESET_DRIFT < now) delete next.entries[k];
      for (const c of changes) next.entries[c.key] = c.entry;
      if (Object.keys(next.entries).length > MAX_ENTRIES) throw new Error("Quota notice state full");
      await this.save(next);
      this.state = next;
      const dispatchAt = this.opts.now?.() ?? Date.now();
      if (!this.current(signature) || dispatchAt - fetched > 10 * 60_000 || dispatchAt - observed > 10 * 60_000
        || changes.some(c => c.entry.reset <= dispatchAt || dispatchAt - c.observed > 10 * 60_000)) return;
      const title = policy.locale.startsWith("zh") ? "用量提醒" : "Usage reminder";
      // No await between the current-policy fence and outbound admission. false/unknown remains reserved.
      this.opts.send(policy.target, `${title} · ${row.name}\n${[...new Set(changes.map(c => c.line))].join("\n")}`);
    }
  }
}
