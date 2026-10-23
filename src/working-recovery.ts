import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { WorkingStateSnapshot, WorkingStateReference } from "./working-state-journal.js";
import type { MemoryPressureSnapshot } from "./memory-pressure.js";

export const WORKING_RECOVERY_KIND = "working_recovery";
export const RECOVERY_STABLE_MS = 120_000;
export const RECOVERY_NORMAL_MS = 30_000;
export const RECOVERY_PACE_MS = 5_000;
export type RecoveryCause = "manual_restart" | "update" | "unknown_interruption";
export type RecoveryOutcome = "deferred" | "excluded" | "admitted";
export interface RecoveryEpisode {
  instance: string; key: string; group: string; snapshot: WorkingStateSnapshot;
  outcome: RecoveryOutcome; reason: string; deliveryId: string | null;
}
export interface RecoveryLive {
  owner: string;
  configuration: string;
  sessionId: string | null;
  idle: boolean;
  paused: boolean;
  stopped: boolean;
  legacyPending: boolean;
  legacyCovered: boolean;
  nativeWork: boolean;
  freshChoice?: boolean;
  crashLoopFresh?: boolean;
  cancelled: boolean;
  background: boolean | null;
}
export interface RecoveryCard { uuid: string; version: number; assignee: string | null; status: string }
export type RecoveryVerdict = { outcome: "deferred" | "excluded"; reason: string } | { outcome: "ready"; tasks: WorkingStateReference[]; advisory: boolean };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function buildWorkingRecoveryPrompt(tasks: WorkingStateReference[], cause: RecoveryCause, advisory: boolean): string {
  const ids = tasks.filter(r => r.kind === "task").slice(0, 16).map(r => r.id);
  return `[system:working-recovery] Interrupted work; observed cause: unknown interruption${cause === "unknown_interruption" ? "" : `; prior requested action: ${cause}`}. `
    + (advisory ? "Advisory: background state is unknown. " : "")
    + `Task references: ${JSON.stringify(ids)}. Inspect existing jobs, processes, worktrees, receipts and each current card first. `
    + "Continue only unfinished work still assigned to you, then report normally. Never restart a command or re-send a delegation blindly; do not replay the original request. "
    + "This is one informational continuation for this work episode.";
}

/** Work identity, not boot identity: another failed boot must not create another prompt. */
export function recoveryKey(instance: string, snapshot: WorkingStateSnapshot): string {
  return digest([instance, snapshot.observation.configuration, snapshot.observation.sessionId,
    snapshot.observation.turn, snapshot.observation.recoveryDeliveryId ?? null,
    [...snapshot.references].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
}

/** Stage 3 owns task-only episodes. The legacy turn/obligation owners remain intact until stage 4. */
export function decideWorkingRecovery(episode: RecoveryEpisode, live: RecoveryLive | null, enabled: boolean,
  card: (id: string) => RecoveryCard | undefined | null): RecoveryVerdict {
  if (!enabled) return { outcome: "deferred", reason: "opted_out" };
  const snapshot = episode.snapshot, previous = snapshot.observation;
  if (previous.turn?.cancelled || previous.turn?.completionDelivered) return { outcome: "excluded", reason: "turn_terminal" };
  if (!live) return { outcome: "deferred", reason: "not_running" };
  if (live.stopped) return { outcome: "excluded", reason: "session_oom_stopped" };
  if (live.cancelled) return { outcome: "excluded", reason: "cancelled" };
  if (previous.configuration !== live.configuration) return { outcome: "excluded", reason: "configuration_changed" };
  if (!previous.sessionId || !live.sessionId) return { outcome: "deferred", reason: "session_unknown" };
  if (live.freshChoice) return { outcome: "excluded", reason: "fresh_session_choice" };
  if (previous.sessionId !== live.sessionId && !live.crashLoopFresh) return { outcome: "excluded", reason: "session_changed" };
  if (live.legacyPending) return { outcome: "deferred", reason: "legacy_pending" };
  if (previous.turn || live.legacyCovered || snapshot.references.some(r => r.kind === "owed")) {
    return { outcome: "excluded", reason: "legacy_owned" };
  }
  if (snapshot.unavailable.length || snapshot.totalReferences > snapshot.references.length) return { outcome: "deferred", reason: "references_incomplete" };
  const tasks: WorkingStateReference[] = [];
  for (const ref of snapshot.references) {
    if (ref.kind !== "task") continue; // waiting on another agent never authorizes a resend
    const current = card(ref.id);
    if (current === null) return { outcome: "deferred", reason: "task_store_unavailable" };
    if (!current || current.assignee !== episode.instance || ["done", "cancelled", "open"].includes(current.status)) continue;
    if (current.status !== "claimed") return { outcome: "deferred", reason: "task_waiting" };
    if (current.version !== ref.version) return { outcome: "excluded", reason: "task_changed" };
    tasks.push(ref);
  }
  if (!tasks.length) return { outcome: "excluded", reason: "no_unfinished_task" };
  if (live.nativeWork) return { outcome: "excluded", reason: "native_reengaged" };
  if (live.paused || !live.idle) return { outcome: "deferred", reason: "not_idle" };
  if (live.background === true) return { outcome: "deferred", reason: "background_running" };
  return { outcome: "ready", tasks, advisory: live.background === null };
}

/** Authoritative recovery state on the SAME SQLite connection as the outbox. */
export class WorkingRecoveryStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS working_recovery_episodes (
      instance_name TEXT PRIMARY KEY, episode_key TEXT NOT NULL, episode_group TEXT NOT NULL,
      snapshot_json TEXT NOT NULL CHECK(length(CAST(snapshot_json AS BLOB))<=8192),
      outcome TEXT NOT NULL, reason TEXT NOT NULL, delivery_id TEXT
    );
    CREATE TABLE IF NOT EXISTS working_recovery_receipts (episode_key TEXT PRIMARY KEY, outcome TEXT NOT NULL, reason TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS working_recovery_run (singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      boot_id TEXT NOT NULL, pid INTEGER NOT NULL, started_at INTEGER NOT NULL, requested_cause TEXT);
    CREATE TABLE IF NOT EXISTS working_recovery_summaries (episode_group TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS working_recovery_cancellations (instance_name TEXT PRIMARY KEY, configuration TEXT NOT NULL, session_id TEXT);`);
  }
  beginRun(bootId: string, pid: number, now: number): RecoveryCause {
    return this.db.transaction(() => {
      const previous = this.db.prepare("SELECT boot_id,requested_cause FROM working_recovery_run WHERE singleton=1").get() as
        { boot_id: string; requested_cause: string | null } | undefined;
      if (previous?.boot_id === bootId) return "unknown_interruption";
      this.db.prepare("INSERT OR REPLACE INTO working_recovery_run VALUES(1,?,?,?,NULL)").run(bootId, pid, now);
      return previous?.requested_cause === "manual_restart" || previous?.requested_cause === "update" ? previous.requested_cause : "unknown_interruption";
    })();
  }
  requested(bootId: string, cause: "manual_restart" | "update"): void {
    this.db.prepare("UPDATE working_recovery_run SET requested_cause=? WHERE singleton=1 AND boot_id=?").run(cause, bootId);
  }
  clearRequested(bootId: string): void {
    this.db.prepare("UPDATE working_recovery_run SET requested_cause=NULL WHERE singleton=1 AND boot_id=?").run(bootId);
  }
  cancel(instance: string, configuration: string, sessionId: string | null): void {
    this.db.prepare("INSERT OR REPLACE INTO working_recovery_cancellations VALUES(?,?,?)").run(instance, configuration, sessionId);
  }
  cancelled(instance: string, snapshot: WorkingStateSnapshot): boolean {
    const row = this.db.prepare("SELECT configuration,session_id FROM working_recovery_cancellations WHERE instance_name=?").get(instance) as
      { configuration: string; session_id: string | null } | undefined;
    return !!row && row.configuration === snapshot.observation.configuration && row.session_id === snapshot.observation.sessionId;
  }
  discover(instance: string, snapshot: WorkingStateSnapshot): void {
    const key = recoveryKey(instance, snapshot);
    this.db.transaction(() => {
      const receipt = this.db.prepare("SELECT outcome,reason FROM working_recovery_receipts WHERE episode_key=?").get(key) as { outcome: string; reason: string } | undefined;
      const current = this.get(instance);
      if (current?.key === key) return;
      // An admitted/uncertain delivery is owned by the outbox, never replaced by a new candidate.
      if (current?.outcome === "admitted" && current.deliveryId) {
        const delivery = this.db.prepare("SELECT state FROM deliveries WHERE delivery_id=?").get(current.deliveryId) as { state: string } | undefined;
        if (!delivery || !["delivered", "uncertain", "failed", "cancelled"].includes(delivery.state)) return;
      }
      this.db.prepare(`INSERT OR REPLACE INTO working_recovery_episodes VALUES(?,?,?,?,?,?,NULL)`)
        .run(instance, key, snapshot.managerBootId, JSON.stringify(snapshot), receipt?.outcome ?? "deferred", receipt?.reason ?? "awaiting_stability");
    })();
  }
  get(instance: string): RecoveryEpisode | null {
    const row = this.db.prepare("SELECT * FROM working_recovery_episodes WHERE instance_name=?").get(instance) as any;
    return row ? { instance: row.instance_name, key: row.episode_key, group: row.episode_group, snapshot: JSON.parse(row.snapshot_json),
      outcome: row.outcome, reason: row.reason, deliveryId: row.delivery_id } : null;
  }
  list(): RecoveryEpisode[] {
    return (this.db.prepare("SELECT instance_name FROM working_recovery_episodes ORDER BY instance_name").all() as Array<{ instance_name: string }>).map(r => this.get(r.instance_name)!);
  }
  private clearPrior(episode: RecoveryEpisode): void {
    this.db.prepare("UPDATE working_state_journal SET prior_json=NULL WHERE instance_name=? AND prior_json=?")
      .run(episode.instance, JSON.stringify(episode.snapshot));
  }
  decision(episode: RecoveryEpisode, outcome: "deferred" | "excluded", reason: string): void {
    const before = this.get(episode.instance);
    if (before?.key !== episode.key || before.outcome === "admitted"
      || before.outcome === outcome && before.reason === reason) return;
    this.db.transaction(() => {
      const current = this.get(episode.instance);
      if (current?.key !== episode.key || current.outcome === "admitted") return;
      this.db.prepare("UPDATE working_recovery_episodes SET outcome=?,reason=? WHERE instance_name=? AND episode_key=?").run(outcome, reason, episode.instance, episode.key);
      if (outcome === "excluded") {
        this.db.prepare("INSERT OR IGNORE INTO working_recovery_receipts VALUES(?,?,?)").run(episode.key, outcome, reason);
        this.clearPrior(episode);
      }
    })();
  }
  /** The delivery admission and episode receipt commit together, or neither does. */
  admit(episode: RecoveryEpisode, insert: () => string, advisory = false): boolean {
    return this.db.transaction(() => {
      const current = this.get(episode.instance);
      if (current?.key !== episode.key || current.outcome !== "deferred") return false;
      if (this.db.prepare("SELECT 1 FROM working_recovery_receipts WHERE episode_key=?").get(episode.key)) return false;
      const deliveryId = insert();
      this.db.prepare("UPDATE working_recovery_episodes SET outcome='admitted',reason=?,delivery_id=? WHERE instance_name=? AND episode_key=?")
        .run(advisory ? "advisory_background_unknown" : "outbox_owned", deliveryId, episode.instance, episode.key);
      this.db.prepare("INSERT INTO working_recovery_receipts VALUES(?,'admitted',?)")
        .run(episode.key, advisory ? "advisory_background_unknown" : "outbox_owned");
      this.clearPrior(episode);
      return true;
    })();
  }
  summary(group: string, insert: () => void): boolean {
    return this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM working_recovery_summaries WHERE episode_group=?").get(group)) return false;
      insert(); this.db.prepare("INSERT INTO working_recovery_summaries VALUES(?)").run(group); return true;
    })();
  }
}

export interface WorkingRecoveryDependencies {
  store: WorkingRecoveryStore;
  now: () => number; // monotonic stability/pacing; durable timestamps are stored separately
  active: () => boolean;
  pressure: () => MemoryPressureSnapshot;
  storm: () => boolean;
  enabled: (instance: string) => boolean;
  live: (instance: string) => RecoveryLive | null;
  card: (id: string) => RecoveryCard | undefined | null;
  laneFree: (instance: string) => boolean;
  admit: (episode: RecoveryEpisode, tasks: WorkingStateReference[], advisory: boolean) => boolean;
  summary: (group: string, rows: RecoveryEpisode[]) => void;
  log: (episode: RecoveryEpisode, outcome: string, reason: string) => void;
}

/** No spawn or native probes. Missing prerequisites leave the durable candidate deferred. */
export class WorkingRecoveryCoordinator {
  private readyAt: number | null = null;
  private normalAt: number | null = null;
  private lastAdmittedAt = Number.NEGATIVE_INFINITY;
  private lastDispatchedAt = Number.NEGATIVE_INFINITY;
  private dispatchOwner: { instance: string; key: string } | null = null;
  constructor(private readonly deps: WorkingRecoveryDependencies) {}
  ready(): void { this.readyAt = this.deps.now(); this.normalAt = null; }
  reset(): void { this.readyAt = null; this.normalAt = null; }
  stable(): boolean {
    const now = this.deps.now(), p = this.deps.pressure();
    if (!this.deps.active() || this.deps.storm() || p.level !== "normal" || p.sampledAt === null || p.recovering) {
      this.normalAt = null; return false;
    }
    this.normalAt ??= now;
    return this.readyAt !== null && now - this.readyAt >= RECOVERY_STABLE_MS && now - this.normalAt >= RECOVERY_NORMAL_MS;
  }
  verdict(episode: RecoveryEpisode): RecoveryVerdict {
    if (this.deps.store.cancelled(episode.instance, episode.snapshot)) return { outcome: "excluded", reason: "cancelled" };
    return decideWorkingRecovery(episode, this.deps.live(episode.instance), this.deps.enabled(episode.instance), this.deps.card);
  }
  tick(): void {
    if (!this.stable()) return;
    for (const row of this.deps.store.list()) {
      if (row.outcome !== "deferred") continue;
      const verdict = this.verdict(row);
      if (verdict.outcome !== "ready") {
        this.deps.store.decision(row, verdict.outcome, verdict.reason);
        if (row.reason !== verdict.reason || row.outcome !== verdict.outcome) this.deps.log(row, verdict.outcome, verdict.reason);
        continue;
      }
      if (!this.deps.laneFree(row.instance) || this.deps.now() - this.lastAdmittedAt < RECOVERY_PACE_MS) continue;
      if (this.deps.admit(row, verdict.tasks, verdict.advisory)) { this.lastAdmittedAt = this.deps.now(); this.deps.log(row, "admitted", verdict.advisory ? "advisory_background_unknown" : "outbox_owned"); }
    }
    const rows = this.deps.store.list();
    for (const group of new Set(rows.map(row => row.group))) {
      const members = rows.filter(row => row.group === group);
      // Finish the paced admission sweep before the single summary, so every
      // advisory admission in that sweep is named, rather than only its first row.
      if (members.some(row => row.outcome === "deferred" && this.verdict(row).outcome === "ready")) continue;
      this.deps.summary(group, members);
    }
  }
  /** Called again by the local pane writer, including after every awaited prerequisite. */
  accepts(instance: string, key: string): boolean {
    if (!this.stable()) return false;
    const row = this.deps.store.get(instance);
    return !!row && row.key === key && row.outcome === "admitted" && this.verdict(row).outcome === "ready";
  }
  /** Recovered queued rows also pass this physical-write pace, independently of admission. */
  canDispatch(instance: string, key: string): boolean {
    return this.dispatchOwner === null && this.deps.now() - this.lastDispatchedAt >= RECOVERY_PACE_MS
      && this.accepts(instance, key);
  }
  reserveDispatch(instance: string, key: string): (() => void) | null {
    if (!this.canDispatch(instance, key)) return null;
    const owner = { instance, key };
    this.dispatchOwner = owner; this.lastDispatchedAt = this.deps.now();
    return () => { if (this.dispatchOwner === owner) this.dispatchOwner = null; };
  }
}
