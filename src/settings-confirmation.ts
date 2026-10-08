import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

export const SETTINGS_CONFIRMATION_TTL_MS = 5 * 60_000;
const RETAIN_TERMINAL_MS = 10 * 60_000;
const MAX_PENDING = 64;
const MAX_PER_SESSION = 8;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 128;

export type SettingsChangeSection = "access" | "secret" | "channel";
export type SettingsChangeState = "pending" | "applying" | "applied" | "rejected" | "expired" | "stale" | "failed";
export interface SettingsChangeOutcome {
  state: SettingsChangeState;
  decided_at: number;
  decided_by_label?: string;
  reason_code: string;
  message: string;
  result?: unknown;
}
export interface SettingsPendingView {
  id: string;
  state: SettingsChangeState;
  section: SettingsChangeSection;
  requested_at: number;
  requested_by: string;
  expires_at: number;
  remaining_ms: number;
  source: "web_session" | "public_link";
  summary: readonly string[];
  confirmation: { kind: "chat" | "host_cli"; code?: string };
  can_withdraw: boolean;
  outcome: SettingsChangeOutcome | null;
}
export interface SettingsChangeProposal {
  session: string;
  key: string;
  fingerprint: string;
  section: SettingsChangeSection;
  requestedBy: string;
  source: SettingsPendingView["source"];
  summary: readonly string[];
  bytes: number;
  remainingMs?: number;
  /** Session, token epoch, exposure and fleet lifecycle; never extends expiry. */
  current(): boolean;
  /** Recheck the original configuration before admitting the effect. */
  unchanged(): Promise<boolean>;
  /** The original handler, guarded at its asynchronous continuation edges. */
  apply(current: () => boolean): Promise<unknown>;
  discard?(): void;
}
interface RecordEntry {
  view: Omit<SettingsPendingView, "remaining_ms" | "can_withdraw">;
  session: string;
  key: string;
  fingerprint: string;
  deadline: number;
  finishedAt?: number;
  proposal?: SettingsChangeProposal;
  timer?: ReturnType<typeof setTimeout>;
  retire?: () => void;
}
export class SettingsConfirmationError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

/** One memory-only owner for chat and host claims. No HTTP confirmation method. */
export class SettingsConfirmationStore {
  private records = new Map<string, RecordEntry>();
  private keys = new Map<string, string>();
  private closed = false;
  constructor(private readonly options: {
    now?: () => number;
    wallNow?: () => number;
    audit(event: string, fields: Record<string, unknown>): void;
    notify?(view: SettingsPendingView): void | Promise<void>;
  }) {}
  private now(): number { return this.options.now?.() ?? performance.now(); }
  private wall(): number { return this.options.wallNow?.() ?? Date.now(); }
  private audit(event: string, entry: RecordEntry, extra: Record<string, unknown> = {}): void {
    this.options.audit(event, { id: entry.view.id, section: entry.view.section, source: entry.view.source, ...extra });
  }
  private index(session: string, key: string): string { return JSON.stringify([session, key]); }
  private snapshot(entry: RecordEntry): SettingsPendingView {
    return structuredClone({ ...entry.view, remaining_ms: Math.max(0, Math.ceil(entry.deadline - this.now())),
      can_withdraw: entry.view.state === "pending" });
  }
  private prune(): void {
    const now = this.now();
    for (const entry of this.records.values()) {
      this.expire(entry);
      if (entry.finishedAt !== undefined && now - entry.finishedAt >= RETAIN_TERMINAL_MS) this.remove(entry);
    }
    while (this.records.size >= MAX_RECORDS) {
      const terminal = [...this.records.values()].find(entry => entry.finishedAt !== undefined);
      if (!terminal) break;
      this.remove(terminal);
    }
  }
  private remove(entry: RecordEntry): void {
    clearTimeout(entry.timer);
    this.records.delete(entry.view.id);
    const index = this.index(entry.session, entry.key);
    if (this.keys.get(index) === entry.view.id) this.keys.delete(index);
  }
  private expire(entry: RecordEntry): void {
    if (entry.view.state === "pending" && this.now() >= entry.deadline) this.finish(entry, "expired", "expired", "Confirmation expired. Review and apply again.");
  }
  private arm(entry: RecordEntry): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { this.expire(entry); if (entry.view.state === "pending") this.arm(entry); },
      Math.max(1, Math.ceil(entry.deadline - this.now())));
    entry.timer.unref?.();
  }
  propose(proposal: SettingsChangeProposal): { view: SettingsPendingView; reused: boolean } {
    if (this.closed || !proposal.current()) throw new SettingsConfirmationError(409, "request_no_longer_current");
    this.prune();
    const index = this.index(proposal.session, proposal.key);
    const previousId = this.keys.get(index);
    const previous = previousId ? this.records.get(previousId) : undefined;
    if (previous) {
      if (previous.fingerprint !== proposal.fingerprint) throw new SettingsConfirmationError(409, "idempotency_key_reused");
      return { view: this.snapshot(previous), reused: true };
    }
    const live = [...this.records.values()].filter(entry => entry.proposal);
    if (live.length >= MAX_PENDING || live.filter(entry => entry.session === proposal.session).length >= MAX_PER_SESSION
      || live.reduce((sum, entry) => sum + (entry.proposal?.bytes ?? 0), 0) + proposal.bytes > MAX_BYTES)
      throw new SettingsConfirmationError(429, "too_many_pending_changes");
    const ttl = Math.min(SETTINGS_CONFIRMATION_TTL_MS, proposal.remainingMs ?? SETTINGS_CONFIRMATION_TTL_MS);
    if (!(ttl > 0) || !Number.isFinite(ttl)) throw new SettingsConfirmationError(409, "verification_expired");
    const id = randomBytes(16).toString("hex");
    const requested = this.wall();
    const entry: RecordEntry = { session: proposal.session, key: proposal.key, fingerprint: proposal.fingerprint,
      deadline: this.now() + ttl, proposal, view: { id, state: "pending", section: proposal.section,
        requested_at: requested, requested_by: proposal.requestedBy, expires_at: requested + ttl,
        source: proposal.source, summary: [...proposal.summary], confirmation: { kind: "host_cli", code: id }, outcome: null } };
    this.records.set(id, entry); this.keys.set(index, id); this.arm(entry); this.audit("requested", entry);
    // Notification may fail or arrive late. Neither admits a configuration write.
    void Promise.resolve().then(() => this.options.notify?.(this.snapshot(entry))).catch(() => this.audit("notification_failed", entry));
    return { view: this.snapshot(entry), reused: false };
  }
  get(id: string, session: string): SettingsPendingView | null {
    this.prune(); const entry = this.records.get(id);
    return entry?.session === session ? this.snapshot(entry) : null;
  }
  list(session: string): SettingsPendingView[] {
    this.prune(); return [...this.records.values()].filter(entry => entry.session === session
      && (entry.view.state === "pending" || entry.view.state === "applying")).map(entry => this.snapshot(entry));
  }
  /** A prompt ACK can only attach to the still-pending owner; otherwise retire it. */
  attachPrompt(id: string, retire: () => void): boolean {
    const entry = this.records.get(id); if (entry) this.expire(entry);
    if (!entry || entry.view.state !== "pending" || this.closed || !entry.proposal?.current()) { retire(); return false; }
    entry.retire?.(); entry.retire = retire; entry.view.confirmation = { kind: "chat" }; return true;
  }
  withdraw(id: string, session: string): SettingsPendingView | null {
    const entry = this.records.get(id); if (entry?.session !== session) return null;
    this.expire(entry);
    if (entry.view.state === "pending") this.finish(entry, "rejected", "withdrawn", "Change withdrawn.");
    return this.snapshot(entry);
  }
  async decide(id: string, decision: "confirm" | "reject", actor: { label: string; current(): boolean }): Promise<SettingsPendingView> {
    const entry = this.records.get(id);
    if (entry) this.expire(entry);
    if (!entry || this.closed || entry.view.state !== "pending") throw new SettingsConfirmationError(409, "confirmation_not_pending");
    const proposal = entry.proposal!;
    if (!actor.current()) throw new SettingsConfirmationError(403, "admin_required");
    if (!proposal.current()) { this.finish(entry, "stale", "request_no_longer_current", "The requesting session or fleet changed. Review and apply again."); return this.snapshot(entry); }
    if (decision === "reject") { this.finish(entry, "rejected", "rejected", "Change rejected.", actor.label); return this.snapshot(entry); }
    // Both surfaces claim before the first await, so neither can execute twice.
    entry.view.state = "applying"; clearTimeout(entry.timer); entry.retire?.(); entry.retire = undefined;
    this.audit("confirmed", entry, { decided_by: actor.label });
    const current = (): boolean => !this.closed && entry.view.state === "applying"
      && this.now() < entry.deadline && actor.current() && proposal.current();
    try {
      const unchanged = await proposal.unchanged();
      if (!current() || !unchanged) this.finish(entry, "stale", "settings_changed", "Settings changed since this request. Review and apply again.", actor.label);
      else {
        const result = await proposal.apply(current);
        if (entry.view.state === "applying") this.finish(entry, "applied", "applied", "Change applied.", actor.label, result);
      }
    } catch {
      if (entry.view.state === "applying") this.finish(entry, "failed", "apply_failed", "Change could not be applied. Review the configuration and try again.", actor.label);
    }
    return this.snapshot(entry);
  }
  private finish(entry: RecordEntry, state: SettingsChangeState, reason: string, message: string, actor?: string, result?: unknown): void {
    clearTimeout(entry.timer); entry.retire?.(); entry.retire = undefined;
    entry.view.state = state; entry.finishedAt = this.now();
    entry.view.outcome = { state, reason_code: reason, message, decided_at: this.wall(), ...(actor ? { decided_by_label: actor } : {}),
      ...(result !== undefined ? { result } : {}) };
    entry.proposal?.discard?.(); entry.proposal = undefined;
    this.audit(state === "rejected" && reason === "withdrawn" ? "withdrawn" : state, entry);
  }
  close(): void {
    this.closed = true;
    for (const entry of this.records.values()) if (entry.proposal) this.finish(entry, "stale", "fleet_stopped", "Fleet stopped. Review and apply again.");
  }
}
