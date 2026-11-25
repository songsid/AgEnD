/**
 * One durable update offer per fleet (design #4480 §3.1, slice 1.1).
 * Banner, Settings, chat `/update`, the Hub request and a scheduled time all read this object.
 * Phase 1 changes words and timing only: today's updater still installs. Pre-flight is a seam
 * for slice 1.2 — absent, nothing is refused with 412. `updates.mode: auto-when-idle` is stored
 * and does not queue anything.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { atomicWriteFileSync } from "./atomic-write.js";
import { IdleUpdateQueue, IDLE_UPDATE_MIGRATION, type IdleUpdate, type IdleUpdateLaunch } from "./update-idle.js";
import { installedChannel } from "./update-check.js";
import { inUpdatePause, resolveUpdates, type ResolvedUpdates, type UpdatesSettings } from "./update-settings.js";

export const NOT_NOW_MS = 7 * 24 * 60 * 60_000;
export const PICK_WITHIN_MS = NOT_NOW_MS;
/** Same cadence as the Hub member's update tick: look again while a local row is waiting. */
const IDLE_POLL_MS = 5_000;
const CARD_FILE = "update-card.json";
const QUEUE_FILE = "update-idle.sqlite";

export type UpdateCardState = "offered" | "not-now" | "scheduled" | "waiting-idle" | "updating" | "done" | "failed" | "cant";
export type UpdateCardAction = "when-idle" | "now" | "pick-time" | "not-now" | "cancel";
export type UpdateCardChannel = "alpha" | "beta" | "stable";
export type UpdateFailCause = "network" | "permission" | "other";

export interface UpdateCardView {
  version: string;
  channel: UpdateCardChannel;
  installable: boolean;
  notes?: string;
  state: UpdateCardState;
  notNowUntil?: number;
  scheduledAt?: number;
  waitingFor?: string[];
  waitingSince?: number;
  lastAnswer?: { action: UpdateCardAction; at: number; by: string };
  failed?: { cause: UpdateFailCause; rolledBack: boolean };
}

export interface UpdateOfferInput {
  version: string;
  channel: UpdateCardChannel;
  installable: boolean;
  notes?: string;
}

export interface UpdateAnswerBody {
  action?: unknown;
  confirm?: unknown;
  at?: unknown;
}

export type UpdateAnswerResult =
  | { ok: true; status: 200; card: UpdateCardView | null }
  | { ok: false; status: 400; body: { error: string } }
  | { ok: false; status: 409; body: { key: "update_running" | "card_changed"; error?: string } }
  | { ok: false; status: 412; body: { key: "preflight"; preflight: unknown } }
  | { ok: false; status: number; body: { error: string } };

interface StoredCard {
  version: string;
  channel: UpdateCardChannel;
  installable: boolean;
  notes?: string;
  state: UpdateCardState;
  notNowUntil?: number;
  scheduledAt?: number;
  queueId?: string;
  waitingSince?: number;
  owner?: "local" | "hub";
  lastAnswer?: { action: UpdateCardAction; at: number; by: string };
  failed?: { cause: UpdateFailCause; rolledBack: boolean };
  /** When this run was claimed. A progress marker from before it is not this run. */
  runAt?: number;
}

export interface UpdateCardDeps {
  dataDir: string;
  now(): number;
  settings(): UpdatesSettings | undefined;
  /** Display names of agents still working. Unknown is an empty list. */
  busyNames(): string[];
  /** Every agent is idle and nothing is in flight. Pause and pin are applied here, not by the caller. */
  agentsIdle(): boolean;
  /** A Hub row or another update already owns the machine. */
  externalBusy(): boolean;
  /** Today's immediate install. */
  launchNow(by: string): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  /** Hub "update now": force the waiting Hub row. Absent when this fleet has no Hub queue. */
  launchHubNow?(id: string): Promise<{ ok: true } | { ok: false; status: number; error: string }>;
  /** Cancel one waiting Hub row. The local queue is cancelled here. */
  cancelHub?(id: string): void;
  /** Idle launch, the same installer as launchNow, claimed by the queue. */
  launchIdle(version: string, control: IdleUpdateLaunch): Promise<boolean>;
  /** Slice 1.2. Absent, or null, allows the action. */
  preflight?(action: UpdateCardAction): { preflight: unknown } | null;
}

/** A display label for lastAnswer.by. A bare id is never stored. */
export function updateAnswerLabel(label: string | undefined): string {
  const text = (label ?? "").trim().slice(0, 80);
  if (!text || /^[0-9a-f-]{32,}$/i.test(text) || /^\d{6,}$/.test(text)) return "admin";
  return text;
}

function stamp(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Which chat line `/update` (not `/update now`) replies with. */
export function updateOfferReply(card: UpdateCardView | null, current: string | null, pinned: boolean): { key: string; args: string[] } {
  if (pinned) return { key: "update.offer.pinned", args: [] };
  const have = current ? `v${current}` : "AgEnD";
  if (!card) return { key: "update.offer.none", args: [have] };
  const version = `v${card.version}`;
  if (!card.installable) return { key: "update.offer.stable", args: [version, have] };
  switch (card.state) {
    case "not-now": return { key: "update.offer.not_now", args: [version, have, stamp(card.notNowUntil)] };
    case "waiting-idle": return { key: "update.offer.waiting", args: [version] };
    case "scheduled": return { key: "update.offer.scheduled", args: [version, stamp(card.scheduledAt)] };
    case "updating": return { key: "update.offer.updating", args: [version] };
    case "done": return { key: "update.offer.done", args: [version] };
    case "failed": return { key: "update.offer.failed", args: [version] };
    case "cant": return { key: "update.offer.cant", args: [version] };
    default: return { key: "update.offer.ready", args: [version, have] };
  }
}

export class UpdateOfferCard {
  private readonly db: Database.Database;
  private readonly queue: IdleUpdateQueue;
  private stored: StoredCard | null = null;
  private stopped = false;
  /** Cancel/retarget notifies the queue; ignore that echo so it cannot overwrite the card mid-update. */
  private quiet = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly answers = new Map<string, UpdateAnswerResult>();

  constructor(private readonly deps: UpdateCardDeps) {
    mkdirSync(deps.dataDir, { recursive: true });
    this.db = new Database(join(deps.dataDir, QUEUE_FILE));
    this.db.pragma("busy_timeout = 5000");
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fleet_idle_updates'").get();
    if (!exists) IDLE_UPDATE_MIGRATION.up(this.db);
    this.queue = new IdleUpdateQueue({
      db: this.db,
      now: () => this.deps.now(),
      current: () => !this.stopped,
      // Pause and pin must not cancel the row. allowed() false is permission-revoked.
      allowed: () => true,
      idle: () => this.idle(),
      launch: (row, control) => this.deps.launchIdle(row.version, control),
      changed: row => this.mirrorLocal(row),
    });
    this.stored = this.read();
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.queue.close();
    this.db.close();
  }

  /** Drop an offer the latest check no longer makes. Leaves a wait or an update alone. */
  clearQuietOffer(): void {
    if (!this.stored) return;
    if (this.stored.state !== "offered" && this.stored.state !== "not-now") return;
    this.stored = null;
    this.save();
  }

  noteOffer(offer: UpdateOfferInput): void {
    if (this.stopped) return;
    const prev = this.stored;
    if (prev?.owner === "hub" && (prev.state === "waiting-idle" || prev.state === "updating")) return;
    if (prev?.state === "updating") return;
    const next: StoredCard = {
      ...(prev ?? { state: "offered" as const }),
      version: offer.version,
      channel: offer.channel,
      installable: offer.installable,
      ...(offer.notes ? { notes: offer.notes } : {}),
    };
    if (!offer.notes) delete next.notes;
    if (!prev || prev.state === "done" || prev.state === "failed" || prev.state === "cant") next.state = "offered";
    if (prev?.state === "not-now" && this.deps.now() >= (prev.notNowUntil ?? 0)) {
      next.state = "offered";
      delete next.notNowUntil;
    }
    this.stored = next;
    if (next.state === "waiting-idle" && next.owner !== "hub") this.retarget(offer.version);
    this.save();
    this.arm();
  }

  /** The immediate path has claimed the machine. Does not overwrite lastAnswer. */
  beginRun(version: string): void {
    if (this.stopped) return;
    if (this.stored && this.stored.state !== "updating") this.stopWait(this.stored);
    const prev = this.stored;
    this.stored = {
      version: version || prev?.version || "",
      channel: prev?.channel ?? "stable",
      installable: prev?.installable ?? true,
      ...(prev?.notes ? { notes: prev.notes } : {}),
      state: "updating",
      owner: "local",
      runAt: this.deps.now(),
      ...(prev?.lastAnswer ? { lastAnswer: prev.lastAnswer } : {}),
    };
    this.save();
  }

  /**
   * A progress marker for this run. A marker that started before the run, or names another version, is left alone.
   * Null (no marker) does not settle.
   */
  noteMarker(marker: { startedAt: number; stage: string; version?: string; operation?: string; cause?: UpdateFailCause } | null): void {
    if (!marker || marker.operation === "full-restart") return;
    if (marker.stage !== "complete" && marker.stage !== "failed") return;
    const card = this.stored;
    if (card?.state !== "updating") return;
    if (card.runAt !== undefined && marker.startedAt + 2_000 < card.runAt) return;
    if (marker.version && card.version && marker.version !== card.version) return;
    this.settleRunning(marker.stage === "complete"
      ? { state: "done" }
      : { state: "failed", cause: marker.cause ?? "other", rolledBack: false });
  }

  settleRunning(outcome: { state: "done" | "failed"; cause?: UpdateFailCause; rolledBack?: boolean }): void {
    if (this.stored?.state !== "updating") return;
    this.stored = outcome.state === "done"
      ? { ...this.stored, state: "done", owner: "local" }
      : { ...this.stored, state: "failed", owner: "local", failed: { cause: outcome.cause ?? "other", rolledBack: outcome.rolledBack === true } };
    delete this.stored.queueId;
    delete this.stored.waitingSince;
    this.save();
  }

  /** A Hub admission is the same card. It does not open a second local queue row. */
  observeHub(row: IdleUpdate): void {
    if (this.stopped) return;
    const active = row.state === "waiting" || row.state === "starting" || row.state === "updating";
    if (active) {
      if (this.stored?.state === "updating" && this.stored.owner !== "hub") return;
      const local = this.queue.pending();
      if (local && local.id !== row.id && local.state !== "updating") this.queue.cancel(local.id, "owner");
      const prev = this.stored;
      const channel = installedChannel(row.version);
      this.stored = {
        version: row.version,
        channel: channel === "latest" ? "stable" : channel,
        installable: true,
        state: row.state === "updating" ? "updating" : "waiting-idle",
        queueId: row.id,
        waitingSince: row.createdAt,
        owner: "hub",
        ...(prev?.lastAnswer ? { lastAnswer: prev.lastAnswer } : {}),
      };
      this.save();
      return;
    }
    if (this.stored?.owner !== "hub" || this.stored.queueId !== row.id) return;
    if (row.state === "done") this.stored = { ...this.stored, state: "done" };
    else if (row.state === "failed" || row.state === "rolled-back") this.stored = { ...this.stored, state: "failed", failed: { cause: "other", rolledBack: row.state === "rolled-back" } };
    else this.stored = { ...this.stored, state: "offered" };
    delete this.stored.queueId;
    delete this.stored.waitingSince;
    delete this.stored.owner;
    this.save();
  }

  /** Local scheduled / waiting / updating blocks a second admission. A Hub-owned row does not block itself. */
  blocksAdmission(): boolean {
    const card = this.stored;
    if (!card || card.owner === "hub") return false;
    return card.state === "scheduled" || card.state === "waiting-idle" || card.state === "updating";
  }

  view(): UpdateCardView | null {
    this.promote();
    if (this.settings().pin) return null;
    return this.toView();
  }

  tick(): void {
    this.promote();
    void this.queue.pump();
    this.arm();
  }

  async answer(key: string, by: string, body: UpdateAnswerBody): Promise<UpdateAnswerResult> {
    const known = this.answers.get(key);
    if (known) return known;
    const result = await this.apply(updateAnswerLabel(by), body);
    this.answers.set(key, result);
    while (this.answers.size > 32) this.answers.delete(this.answers.keys().next().value!);
    return result;
  }

  private async apply(by: string, body: UpdateAnswerBody): Promise<UpdateAnswerResult> {
    const action = body.action;
    if (action !== "when-idle" && action !== "now" && action !== "pick-time" && action !== "not-now" && action !== "cancel") {
      return { ok: false, status: 400, body: { error: 'action must be "when-idle", "now", "pick-time", "not-now", or "cancel"' } };
    }
    if (this.settings().pin) return { ok: false, status: 409, body: { key: "card_changed", error: "pinned" } };
    this.promote();
    const card = this.stored;
    if (!card) return { ok: false, status: 409, body: { key: "card_changed", error: "nothing_offered" } };
    if (action === "now" && body.confirm !== "update-agend") return { ok: false, status: 400, body: { error: 'confirm must be the literal "update-agend"' } };
    const blocked = this.deps.preflight?.(action);
    if (blocked) return { ok: false, status: 412, body: { key: "preflight", preflight: blocked.preflight } };
    if ((action === "when-idle" || action === "now" || action === "pick-time") && !card.installable) {
      return { ok: false, status: 409, body: { key: "card_changed", error: "not_installable" } };
    }
    if (card.state === "updating" && action !== "cancel") return { ok: false, status: 409, body: { key: "update_running" } };
    if (action === "cancel") return this.cancel(card, by);
    if (action === "not-now") return this.notNow(card, by);
    if (action === "pick-time") return this.pickTime(card, by, body.at);
    if (action === "when-idle") return this.whenIdle(card, by);
    return this.now(card, by);
  }

  private cancel(card: StoredCard, by: string): UpdateAnswerResult {
    if (card.state === "updating") return { ok: false, status: 409, body: { key: "update_running" } };
    if (card.state !== "waiting-idle" && card.state !== "scheduled") return { ok: false, status: 409, body: { key: "card_changed" } };
    this.stopWait(card);
    this.stored = { ...card, state: "offered", lastAnswer: { action: "cancel", at: this.deps.now(), by } };
    delete this.stored.scheduledAt;
    delete this.stored.queueId;
    delete this.stored.waitingSince;
    delete this.stored.owner;
    this.save();
    return this.ok();
  }

  private notNow(card: StoredCard, by: string): UpdateAnswerResult {
    if (card.state === "updating") return { ok: false, status: 409, body: { key: "update_running" } };
    this.stopWait(card);
    const at = this.deps.now();
    this.stored = { ...card, state: "not-now", notNowUntil: at + NOT_NOW_MS, lastAnswer: { action: "not-now", at, by } };
    delete this.stored.scheduledAt;
    delete this.stored.queueId;
    delete this.stored.waitingSince;
    delete this.stored.owner;
    this.save();
    this.arm();
    return this.ok();
  }

  private pickTime(card: StoredCard, by: string, at: unknown): UpdateAnswerResult {
    if (typeof at !== "number" || !Number.isSafeInteger(at)) return { ok: false, status: 400, body: { error: "at must be a millisecond timestamp" } };
    const now = this.deps.now();
    if (at <= now) return { ok: false, status: 400, body: { error: "pick-time must be in the future" } };
    if (at > now + PICK_WITHIN_MS) return { ok: false, status: 400, body: { error: "pick-time must be within 7 days" } };
    this.stopWait(card);
    this.stored = { ...card, state: "scheduled", scheduledAt: at, owner: "local", lastAnswer: { action: "pick-time", at: now, by } };
    delete this.stored.queueId;
    delete this.stored.waitingSince;
    delete this.stored.notNowUntil;
    this.save();
    this.arm();
    return this.ok();
  }

  private whenIdle(card: StoredCard, by: string): UpdateAnswerResult {
    if (card.state === "waiting-idle") return this.ok();
    if (this.deps.externalBusy() || this.queue.pending()) return { ok: false, status: 409, body: { key: "update_running" } };
    const id = randomUUID();
    try { this.queue.request({ id, version: card.version, waitMs: this.waitMs() }); }
    catch { return { ok: false, status: 409, body: { key: "update_running" } }; }
    this.stored = { ...card, state: "waiting-idle", queueId: id, waitingSince: this.deps.now(), owner: "local", lastAnswer: { action: "when-idle", at: this.deps.now(), by } };
    delete this.stored.scheduledAt;
    delete this.stored.notNowUntil;
    this.save();
    void this.queue.pump();
    return this.ok();
  }

  private async now(card: StoredCard, by: string): Promise<UpdateAnswerResult> {
    if (this.deps.externalBusy() && card.owner !== "hub") return { ok: false, status: 409, body: { key: "update_running" } };
    if (card.owner === "hub" && card.queueId && this.deps.launchHubNow) {
      const hub = await this.deps.launchHubNow(card.queueId);
      if (!hub.ok) return this.launchError(hub.status, hub.error);
      this.remember("now", by);
      return this.ok();
    }
    const localWait = card.owner !== "hub" && !!card.queueId;
    this.stopWait(card);
    const launched = await this.deps.launchNow(by);
    if (!launched.ok) {
      // stopWait is quiet, so a cancelled local row would otherwise leave the card waiting with nothing behind it.
      if (localWait && this.stored && (this.stored.state === "waiting-idle" || this.stored.state === "scheduled")) {
        this.stored = { ...this.stored, state: "offered" };
        delete this.stored.queueId;
        delete this.stored.waitingSince;
        delete this.stored.owner;
        this.save();
      }
      return this.launchError(launched.status, launched.error);
    }
    this.remember("now", by);
    return this.ok();
  }

  private launchError(status: number, error: string): UpdateAnswerResult {
    if (status === 409 && (error === "update_running" || error === "stopping" || error === "update_not_started")) {
      return { ok: false, status: 409, body: { key: "update_running", error } };
    }
    if (status === 409) return { ok: false, status: 409, body: { key: "card_changed", error } };
    return { ok: false, status, body: { error } };
  }

  private remember(action: UpdateCardAction, by: string): void {
    if (!this.stored) return;
    this.stored = { ...this.stored, lastAnswer: { action, at: this.deps.now(), by } };
    this.save();
  }

  private stopWait(card: StoredCard): void {
    this.quiet++;
    try {
      if (card.owner === "hub" && card.queueId) { try { this.deps.cancelHub?.(card.queueId); } catch { /* the card still leaves the wait */ } return; }
      if (!card.queueId) return;
      const row = this.queue.get(card.queueId);
      if (row && (row.state === "waiting" || row.state === "starting")) this.queue.cancel(card.queueId, "owner");
    } finally { this.quiet--; }
  }

  private retarget(version: string): void {
    const card = this.stored;
    if (!card?.queueId || card.owner === "hub") return;
    const row = this.queue.get(card.queueId);
    if (!row || row.version === version || (row.state !== "waiting" && row.state !== "starting")) return;
    const id = randomUUID();
    this.quiet++;
    try {
      this.queue.cancel(card.queueId, "owner");
      this.queue.request({ id, version, waitMs: this.waitMs() });
      card.queueId = id;
      card.owner = "local";
    } finally { this.quiet--; }
  }

  private promote(): void {
    const card = this.stored;
    if (!card || this.stopped) return;
    const now = this.deps.now();
    if (card.state === "not-now" && now >= (card.notNowUntil ?? 0)) {
      this.stored = { ...card, state: "offered" };
      delete this.stored.notNowUntil;
      this.save();
    } else if (card.state === "scheduled" && card.scheduledAt !== undefined && now >= card.scheduledAt) {
      if (this.deps.externalBusy() || (this.queue.pending() && this.queue.pending()?.id !== card.queueId)) return;
      const id = card.queueId ?? randomUUID();
      try {
        if (!this.queue.get(id)) this.queue.request({ id, version: card.version, waitMs: this.waitMs() });
      } catch { return; }
      this.stored = { ...card, state: "waiting-idle", queueId: id, waitingSince: now, owner: "local" };
      delete this.stored.scheduledAt;
      this.save();
      void this.queue.pump();
    }
    this.arm();
  }

  private mirrorLocal(row: IdleUpdate): void {
    const card = this.stored;
    if (this.quiet || !card || card.owner === "hub" || card.queueId !== row.id) return;
    if (row.state === "waiting" || row.state === "starting") {
      this.stored = { ...card, state: "waiting-idle", waitingSince: card.waitingSince ?? row.createdAt };
    } else if (row.state === "updating") {
      this.stored = { ...card, state: "updating", runAt: card.runAt ?? this.deps.now() };
    } else if (row.state === "done") {
      this.stored = { ...card, state: "done" };
      delete this.stored.queueId;
    } else if (row.state === "failed" || row.state === "rolled-back") {
      this.stored = { ...card, state: "failed", failed: { cause: "other", rolledBack: row.state === "rolled-back" } };
      delete this.stored.queueId;
    } else if (card.state === "waiting-idle" || card.state === "updating") {
      // Expired or cancelled by the queue itself: the offer comes back. Update now stays available.
      this.stored = { ...card, state: "offered" };
      delete this.stored.queueId;
      delete this.stored.waitingSince;
    } else return;
    this.save();
  }

  private idle(): boolean {
    const settings = this.settings();
    if (settings.pin || inUpdatePause(settings.pause, new Date(this.deps.now()))) return false;
    try { return this.deps.agentsIdle() === true; } catch { return false; }
  }

  private settings(): ResolvedUpdates {
    return resolveUpdates(this.deps.settings());
  }

  private waitMs(): number {
    return this.settings().maxIdleWait * 60 * 60_000;
  }

  private ok(): UpdateAnswerResult {
    return { ok: true, status: 200, card: this.view() };
  }

  private toView(): UpdateCardView | null {
    const card = this.stored;
    if (!card) return null;
    const waiting = card.state === "waiting-idle" ? this.deps.busyNames().filter(name => name.trim()) : [];
    return {
      version: card.version,
      channel: card.channel,
      installable: card.installable,
      ...(card.notes ? { notes: card.notes } : {}),
      state: card.state,
      ...(card.state === "not-now" && card.notNowUntil !== undefined ? { notNowUntil: card.notNowUntil } : {}),
      ...(card.state === "scheduled" && card.scheduledAt !== undefined ? { scheduledAt: card.scheduledAt } : {}),
      ...(waiting.length ? { waitingFor: waiting } : {}),
      ...(card.state === "waiting-idle" && card.waitingSince !== undefined ? { waitingSince: card.waitingSince } : {}),
      ...(card.lastAnswer ? { lastAnswer: card.lastAnswer } : {}),
      ...(card.state === "failed" && card.failed ? { failed: card.failed } : {}),
    };
  }

  private arm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopped || !this.stored) return;
    // A waiting row has no due time of its own. Poll until it launches, is cancelled, or the queue expires it.
    if (this.stored.state === "waiting-idle") {
      this.timer = setTimeout(() => { this.timer = undefined; this.tick(); }, IDLE_POLL_MS);
      this.timer.unref?.();
      return;
    }
    const due = this.stored.state === "scheduled" ? this.stored.scheduledAt
      : this.stored.state === "not-now" ? this.stored.notNowUntil : undefined;
    if (due === undefined) return;
    const delay = Math.max(0, Math.min(due - this.deps.now(), 2_147_000_000));
    this.timer = setTimeout(() => { this.timer = undefined; this.tick(); }, delay);
    this.timer.unref?.();
  }

  private path(): string { return join(this.deps.dataDir, CARD_FILE); }

  private read(): StoredCard | null {
    try {
      const parsed = JSON.parse(readFileSync(this.path(), "utf8")) as StoredCard;
      if (!parsed || typeof parsed.version !== "string" || typeof parsed.state !== "string") return null;
      return parsed;
    } catch { return null; }
  }

  private save(): void {
    if (!this.stored) {
      try { unlinkSync(this.path()); } catch { /* already gone */ }
      return;
    }
    atomicWriteFileSync(this.path(), JSON.stringify(this.stored) + "\n", { mode: 0o600 });
  }
}
