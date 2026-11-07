import { randomBytes } from "node:crypto";
import { SettingsExecution, settingsFingerprint } from "./settings-transaction.js";
import type { SettingsChangeAuthority } from "./settings-authority.js";
import { performance } from "node:perf_hooks";
import { t } from "./locale.js";

export const SETTINGS_CONFIRMATION_TTL_MS = 5 * 60_000;
const RETAIN_TERMINAL_MS = 10 * 60_000;
const MAX_PENDING = 64;
const MAX_PER_SESSION = 8;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_RECORDS = 128;

export type SettingsChangeSection = "access" | "secret" | "channel";
export type SettingsChangeState = "pending" | "applying" | "applied" | "rejected" | "expired" | "stale" | "failed";
/** S-35: a failed apply's reason for the person and the audit — one line, bounded, control characters removed. */
export function applyErrorDetail(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const text = raw.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 300) : undefined;
}
export interface SettingsChangeOutcome {
  state: SettingsChangeState;
  decided_at: number;
  decided_by_label?: string;
  reason_code: string;
  message: string;
  /** S-35: why an apply failed — the handler's own words (bounded, control characters removed); never shown as success. */
  detail?: string;
  result?: unknown;
}
/**
 * alpha.6 feedback #2c (the user's decision hmsg-77256f66: never guide users to type a host command): why no General could
 * take a change's confirm card — no chat connection at all; the change spans chat platforms; no agent is the General; the
 * General's chat is not connected; the General has no topic yet; or posting the card failed.
 */
export type SettingsNoCardReason = "no_chat" | "cross_platform" | "no_general" | "chat_disconnected" | "no_topic" | "post_failed";
export interface SettingsPendingView {
  id: string;
  state: SettingsChangeState;
  section: SettingsChangeSection;
  requested_at: number;
  requested_by: string;
  expires_at: number;
  remaining_ms: number;
  source: "web_session" | "public_link" | "setup_session" | "agent_request";
  execution?: { phase: "queued" | "running" | "cleanup"; job_id?: string; reason_code?: string };
  summary: readonly string[];
  /**
   * How it is confirmed. #2868: "posting" while the General card is being sent (what the save itself answers), then
   * "chat" with `where` the card was posted (a platform and its connection), or "host_cli" when no General could take
   * it. #2170: "web" — confirmed by the requester's own web-verified account, not in chat or on the host. The host's
   * command (`code`) works whatever the kind.
   */
  confirmation: { kind: "posting" | "chat" | "host_cli" | "web"; code?: string; where?: Array<{ platform: string; connection: string }>;
    /** alpha.6 feedback #2c: with "host_cli", why no General could take the card, for the page to say in plain words. */
    reason?: SettingsNoCardReason };
  can_withdraw: boolean;
  /** #2868: the browser that reads it may confirm it itself now (#2170's rule, asked at that read): "Apply now". */
  can_self_confirm?: boolean;
  /** alpha.6 #2c (hmsg-468cc290): this page may confirm it with the authenticator's code (ready), or could once one is set up. */
  totp?: "ready" | "not_set_up" | "on_host" | "host_browser";
  /** B2b: with `totp` ready, the change's digest the page sends back with the code (one code confirms only this change). */
  confirm_digest?: string;
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
  requestFingerprint?: string;
  affectedConnections?: readonly string[];
  authority?: SettingsChangeAuthority;
  /** #2453: never confirmed by its own requester (#2170) — it turns the named-link option on. */
  noSelfConfirm?: true;
  /** B2b: noSelfConfirm, except for this computer's host operator on its own local session (see SettingsChangeDiff). */
  hostLocalConfirm?: true;
  /** A link option turned on: noSelfConfirm, except for the host's own session here only (see SettingsChangeDiff). */
  hostSessionOnly?: true;
  /** Session, token epoch, exposure and fleet lifecycle; never extends expiry. */
  current(): boolean;
  /** Recheck the original configuration before admitting the effect. */
  unchanged(): Promise<boolean>;
  /** The original handler, guarded at its asynchronous continuation edges. */
  apply(current: () => boolean, execution: SettingsExecution): Promise<unknown>;
  /** Runtime state and persistence revisions, excluding the operation's private state. */
  snapshot?(): unknown;
  discard?(): void;
}
interface RecordEntry {
  authority: SettingsChangeAuthority;
  view: Omit<SettingsPendingView, "remaining_ms" | "can_withdraw">;
  session: string;
  key: string;
  fingerprint: string;
  requestFingerprint?: string;
  snapshotFingerprint: string;
  deadline: number;
  finishedAt?: number;
  proposal?: SettingsChangeProposal;
  timer?: ReturnType<typeof setTimeout>;
  retire?: () => void;
  execution?: SettingsExecution;
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
    /** Post the confirm card; when none could be attached, why (the page says it; the host CLI stays the last resort). */
    notify?(view: SettingsPendingView): void | Promise<void | SettingsNoCardReason>;
    /** alpha.2 (M-2300): a request was made, decided or ran out — no details (a page that may see them reads them). */
    changed?(view: SettingsPendingView): void;
  }) {}
  private changed(entry: RecordEntry): void { try { this.options.changed?.(this.snapshot(entry)); } catch { /* a listener never breaks the store */ } }
  private now(): number { return this.options.now?.() ?? performance.now(); }
  private wall(): number { return this.options.wallNow?.() ?? Date.now(); }
  private audit(event: string, entry: RecordEntry, extra: Record<string, unknown> = {}): void {
    this.options.audit(event, { id: entry.view.id, section: entry.view.section, source: entry.view.source,
      authority: structuredClone(entry.authority), ...extra });
  }
  private display(label: string): string { return label.slice(0, 256).replace(/[\p{Cc}\p{Cf}]/gu,
    char => `\\u{${char.codePointAt(0)!.toString(16)}}`).replace(/@/g, "[at]").replace(/[\\`*_~[\]()<>|]/g, char => "\\" + char); }
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
    // S-35: a repeated Save maps its own key to the same request; drop every key that names it.
    for (const [index, id] of this.keys) if (id === entry.view.id) this.keys.delete(index);
  }
  private expire(entry: RecordEntry): void {
    if (entry.view.state === "pending" && this.now() >= entry.deadline) this.finish(entry, "expired", "expired", t("settings_confirm.result.expired"));
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
    // S-35: each Save sends a fresh idempotency key, so pressing Save again on the same change stacked another identical
    // request. The same session's identical operation (same immutable fingerprint) that is still pending is that request.
    const same = live.find(entry => entry.view.state === "pending" && entry.session === proposal.session && entry.fingerprint === proposal.fingerprint);
    if (same) { this.keys.set(index, same.view.id); proposal.discard?.(); return { view: this.snapshot(same), reused: true }; }
    if (live.length >= MAX_PENDING || live.filter(entry => entry.session === proposal.session).length >= MAX_PER_SESSION
      || live.reduce((sum, entry) => sum + (entry.proposal?.bytes ?? 0), 0) + proposal.bytes > MAX_BYTES)
      throw new SettingsConfirmationError(429, "too_many_pending_changes");
    const ttl = Math.min(SETTINGS_CONFIRMATION_TTL_MS, proposal.remainingMs ?? SETTINGS_CONFIRMATION_TTL_MS);
    if (!(ttl > 0) || !Number.isFinite(ttl)) throw new SettingsConfirmationError(409, "verification_expired");
    const id = randomBytes(16).toString("hex");
    const requested = this.wall();
    const entry: RecordEntry = { session: proposal.session, key: proposal.key, fingerprint: proposal.fingerprint,
      authority: structuredClone(proposal.authority ?? { connections: [], primaryGeneral: false, unknown: true }),
      snapshotFingerprint: settingsFingerprint(proposal.snapshot?.() ?? null),
      deadline: this.now() + ttl, requestFingerprint: proposal.requestFingerprint, proposal, view: { id, state: "pending", section: proposal.section,
        requested_at: requested, requested_by: this.display(proposal.requestedBy), expires_at: requested + ttl,
        source: proposal.source, summary: [...proposal.summary], confirmation: { kind: this.options.notify ? "posting" : "host_cli", code: id }, outcome: null } };
    this.records.set(id, entry); this.keys.set(index, id); this.arm(entry); this.audit("requested", entry); this.changed(entry);
    // Notification may fail or arrive late. Neither admits a configuration write. Once it is over, a request no General
    // card attached to says so: the host's command is then the way (still pending: a decided one keeps its own kind).
    let reason: SettingsNoCardReason | undefined;
    void Promise.resolve().then(() => this.options.notify?.(this.snapshot(entry))).then(r => { if (typeof r === "string") reason = r; }, () => { reason = "post_failed"; this.audit("notification_failed", entry); })
      .finally(() => { if (entry.view.state === "pending" && entry.view.confirmation.kind === "posting") entry.view.confirmation = { kind: "host_cli", code: id, ...(reason ? { reason } : {}) }; });
    return { view: this.snapshot(entry), reused: false };
  }
  findRequest(session: string, key: string, fingerprint: string): SettingsPendingView | null {
    this.prune(); const id = this.keys.get(this.index(session, key)); const entry = id ? this.records.get(id) : undefined;
    if (!entry) return null;
    if (entry.requestFingerprint !== fingerprint) throw new SettingsConfirmationError(409, "idempotency_key_reused");
    return this.snapshot(entry);
  }
  affectedConnections(id: string): readonly string[] { return this.records.get(id)?.proposal?.affectedConnections ?? []; }
  /** #2453: whether its requester may confirm it by applying it (#2170) — not a change that opens the named link. */
  selfConfirmable(id: string): boolean { const p = this.records.get(id)?.proposal; return !!p && p.noSelfConfirm !== true; }
  /** B2b: a noSelfConfirm change the host operator's own local session may still confirm. */
  /** A link option turned on (#2453): only the host's own session on this computer may confirm it (hostSessionHere). */
  hostSessionConfirmable(id: string): boolean { const p = this.records.get(id)?.proposal; return !!p && p.noSelfConfirm === true && p.hostSessionOnly === true; }
  hostLocalConfirmable(id: string): boolean { const p = this.records.get(id)?.proposal; return !!p && p.noSelfConfirm === true && p.hostLocalConfirm === true; }
  /** B2b (#3352 security review, point 2): what an authenticator code confirms — this change as the page showed it. */
  confirmDigest(id: string): string | null { const e = this.records.get(id); return e ? settingsFingerprint([id, e.fingerprint]).slice(0, 32) : null; }
  authorityOf(id: string): SettingsChangeAuthority | null {
    const entry = this.records.get(id); return entry ? structuredClone(entry.authority) : null;
  }
  inspectHost(id: string): { view: SettingsPendingView; fingerprint: string } | null {
    this.prune(); const entry = this.records.get(id);
    return entry && !this.closed ? { view: this.snapshot(entry), fingerprint: entry.fingerprint } : null;
  }
  get(id: string, session: string): SettingsPendingView | null {
    this.prune(); const entry = this.records.get(id);
    return entry?.session === session ? this.snapshot(entry) : null;
  }
  /**
   * alpha.2 (M-2300): every request from one source still waiting or being applied, whoever's session — for the one
   * surface that may confirm another session's request (a web-only fleet's verified owner, agents' requests).
   */
  listBySource(source: SettingsPendingView["source"]): SettingsPendingView[] {
    this.prune(); return [...this.records.values()].filter(entry => entry.view.source === source
      && (entry.view.state === "pending" || entry.view.state === "applying")).map(entry => this.snapshot(entry));
  }
  /** alpha.2: a request's view by id (any state still retained), whoever's session — its caller decides who may see it. */
  inspect(id: string): SettingsPendingView | null { this.prune(); const entry = this.records.get(id); return entry ? this.snapshot(entry) : null; }
  list(session: string): SettingsPendingView[] {
    this.prune(); return [...this.records.values()].filter(entry => entry.session === session
      && (entry.view.state === "pending" || entry.view.state === "applying")).map(entry => this.snapshot(entry));
  }
  /** A prompt ACK can only attach to the still-pending owner; otherwise retire it. */
  attachPrompt(id: string, retire: () => void, where?: { platform: string; connection: string }): boolean {
    const entry = this.records.get(id); if (entry) this.expire(entry);
    if (!entry || entry.view.state !== "pending" || this.closed || !entry.proposal?.current()) { retire(); return false; }
    entry.retire?.(); entry.retire = retire; entry.view.confirmation = { kind: "chat", code: id, ...(where ? { where: [{ ...where }] } : {}) }; return true;
  }
  withdraw(id: string, session: string): SettingsPendingView | null {
    const entry = this.records.get(id); if (entry?.session !== session) return null;
    this.expire(entry);
    if (entry.view.state === "pending") this.finish(entry, "rejected", "withdrawn", t("settings_confirm.result.withdrawn"));
    return this.snapshot(entry);
  }
  async decide(id: string, decision: "confirm" | "reject", actor: { label: string; current(): boolean; via?: "web"; audit?: Record<string, unknown>;
    followStop?(name: string, begin: () => Promise<unknown>): Promise<void> }): Promise<SettingsPendingView> {
    const entry = this.records.get(id);
    if (entry) this.expire(entry);
    if (!entry || this.closed || entry.view.state !== "pending") throw new SettingsConfirmationError(409, "confirmation_not_pending");
    const proposal = entry.proposal!;
    if (!actor.current()) throw new SettingsConfirmationError(403, "admin_required");
    if (!proposal.current()) { this.finish(entry, "stale", "request_no_longer_current", t("settings_confirm.result.request_no_longer_current")); return this.snapshot(entry); }
    if (decision === "reject") { this.finish(entry, "rejected", "rejected", t("settings_confirm.result.rejected"), actor.label); return this.snapshot(entry); }
    // Both surfaces claim before the first await, so neither can execute twice.
    entry.view.state = "applying"; clearTimeout(entry.timer); entry.retire?.(); entry.retire = undefined;
    if (actor.via === "web") entry.view.confirmation = { kind: "web" };
    this.changed(entry);
    this.audit("confirmed", entry, { decided_by: this.display(actor.label), ...(actor.audit ?? {}) });
    const current = (): boolean => !this.closed && entry.view.state === "applying"
      && this.now() < entry.deadline && actor.current() && proposal.current();
    try {
      const unchanged = await proposal.unchanged();
      if (!current() || !unchanged || entry.snapshotFingerprint !== settingsFingerprint(proposal.snapshot?.() ?? null)) this.finish(entry, "stale", "settings_changed", t("settings_confirm.result.settings_changed"), actor.label);
      else {
        const execution = new SettingsExecution({ current, snapshot: () => proposal.snapshot?.() ?? null,
          followStop: actor.followStop,
          now: () => this.now(), expectedFingerprint: entry.snapshotFingerprint, progress: (phase, reason_code) => { entry.view.execution = { phase, ...(reason_code ? { reason_code } : {}) }; } });
        entry.execution = execution;
        try {
          // #2942: the same actor-aware fence the store checks (admin, session, state), not only the execution's snapshot.
          const result = await proposal.apply(current, execution);
          if (!execution.completed) execution.complete();
          this.finish(entry, "applied", "applied", t("settings_confirm.result.applied"), actor.label, result);
        } finally { execution.close(); entry.execution = undefined; }
      }
    } catch (error) {
      // S-35: the real reason (a Windows relay that did not start, an agent limit, a startup race…) was swallowed here and the
      // person only ever read "could not be applied". Keep the localized message; carry the reason beside it and in the audit.
      const detail = applyErrorDetail(error);
      if (entry.view.state === "applying") this.finish(entry, this.closed ? "stale" : this.now() >= entry.deadline ? "expired" : "failed", this.closed ? "fleet_stopped" : this.now() >= entry.deadline ? "expired" : "apply_failed", t("settings_confirm.result.apply_failed"), actor.label, undefined, detail);
    }
    return this.snapshot(entry);
  }
  private finish(entry: RecordEntry, state: SettingsChangeState, reason: string, message: string, actor?: string, result?: unknown, detail?: string): void {
    clearTimeout(entry.timer); entry.retire?.(); entry.retire = undefined;
    entry.view.state = state; entry.finishedAt = this.now();
    entry.view.outcome = { state, reason_code: reason, message, decided_at: this.wall(), ...(actor ? { decided_by_label: this.display(actor) } : {}),
      ...(detail ? { detail } : {}), ...(result !== undefined ? { result } : {}) };
    entry.proposal?.discard?.(); entry.proposal = undefined;
    this.audit(state === "rejected" && reason === "withdrawn" ? "withdrawn" : state, entry, detail ? { detail } : {});
    this.changed(entry);
  }
  close(): void {
    this.closed = true;
    for (const entry of this.records.values()) if (entry.proposal) {
      if (entry.view.state === "applying") { entry.execution?.cancel(); entry.retire?.(); entry.retire = undefined; }
      else this.finish(entry, "stale", "fleet_stopped", t("settings_confirm.result.fleet_stopped"));
    }
  }
}

/** #2390: where a settings change came from, in the fleet's language (an unknown source as it is). */
export function settingsSourceLabel(source: string): string {
  const key = `settings_confirm.source.${source}`, text = t(key);
  return text === key ? source : text;
}
