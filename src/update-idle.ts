/** Durable idle admission; launch is injected and never performed by this module. */
import type Database from "better-sqlite3";
import { isExactVersion } from "./update-check.js";
export const IDLE_UPDATE_WAIT_MS = 24 * 60 * 60_000;
export const IDLE_UPDATE_MIGRATION = Object.freeze({ component: "fleet-idle-update", version: 1, up(db: Database.Database) {
  db.exec(`CREATE TABLE fleet_idle_updates(id TEXT PRIMARY KEY,version TEXT NOT NULL,created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,state TEXT NOT NULL,reason TEXT);
    CREATE UNIQUE INDEX fleet_idle_update_active ON fleet_idle_updates((1)) WHERE state IN ('waiting','starting','updating');`);
} });
export type IdleUpdateState = "waiting" | "starting" | "updating" | "done" | "rolled-back" | "expired" | "cancelled" | "failed";
export type IdleUpdateReason = "permission-revoked" | "expired" | "launch-failed" | "interrupted" | "owner" | "hub" | null;
export interface IdleUpdate { id: string; version: string; createdAt: number; expiresAt: number; updatedAt: number; state: IdleUpdateState; reason: IdleUpdateReason }
interface Row { id: string; version: string; created_at: number; expires_at: number; updated_at: number; state: IdleUpdateState; reason: IdleUpdateReason }
const view = (r: Row): IdleUpdate => ({ id: r.id, version: r.version, createdAt: r.created_at, expiresAt: r.expires_at, updatedAt: r.updated_at, state: r.state, reason: r.reason });
export interface IdleUpdateLaunch {
  /** Recheck after every await. Does not consume launch permission. */
  current(): boolean;
  /** Persist the one launch claim immediately before the actual spawn, with no await between. */
  claim(): boolean;
}
export interface IdleUpdateHost {
  db: Database.Database;
  now(): number;
  current(): boolean;
  allowed(request: IdleUpdate): boolean;
  /** All agents observed idle; no approval or delivery in flight. Unknown must return false. */
  idle(): boolean;
  /** Return true only after a claimed launch; never spawn unless control.claim() succeeds. */
  launch(request: IdleUpdate, control: IdleUpdateLaunch): Promise<boolean>;
  changed?(request: IdleUpdate): void;
}
export class IdleUpdateQueue {
  private stopped = false;
  private running: Promise<void> | null = null;
  private dirty = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly host: IdleUpdateHost) {}
  private live(): boolean { try { return !this.stopped && this.host.current() === true; } catch { return false; } }
  private allowed(row: IdleUpdate): boolean { try { return this.host.allowed(row) === true; } catch { return false; } }
  private idle(): boolean { try { return this.host.idle() === true; } catch { return false; } }
  get(id: string): IdleUpdate | null { const r = this.host.db.prepare("SELECT * FROM fleet_idle_updates WHERE id=?").get(id) as Row | undefined; return r ? view(r) : null; }
  pending(): IdleUpdate | null { const r = this.host.db.prepare("SELECT * FROM fleet_idle_updates WHERE state IN ('waiting','starting','updating')").get() as Row | undefined; return r ? view(r) : null; }
  private say(row: IdleUpdate): void { try { this.host.changed?.(row); } catch { /* presentation cannot change execution */ } }
  private put(id: string, state: IdleUpdateState, reason: IdleUpdateReason = null): IdleUpdate {
    this.host.db.prepare("UPDATE fleet_idle_updates SET state=?,reason=?,updated_at=? WHERE id=?").run(state, reason, this.host.now(), id);
    const row = this.get(id)!; this.say(row); this.arm(); return row;
  }
  request(value: { id: string; version: string; waitMs?: number }): IdleUpdate {
    if (!this.live()) throw Error("stopped");
    // Hub callers omit waitMs and keep the 24h wait. A fleet card passes updates.maxIdleWait.
    const wait = value.waitMs ?? IDLE_UPDATE_WAIT_MS;
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value.id) || value.version !== value.version.trim() || value.version.length > 128 || !isExactVersion(value.version)
      || !Number.isSafeInteger(wait) || wait < 1 || wait > 14 * 24 * 60 * 60_000) throw Error("invalid");
    this.expire();
    let inserted = false;
    const row = this.host.db.transaction(() => {
      const known = this.get(value.id);
      if (known) { if (known.version !== value.version) throw Error("conflict"); return known; }
      if (this.pending()) throw Error("busy");
      const now = this.host.now();
      this.host.db.prepare("INSERT INTO fleet_idle_updates VALUES(?,?,?,?,?,'waiting',NULL)").run(value.id, value.version, now, now + wait, now);
      inserted = true; return this.get(value.id)!;
    })();
    if (inserted) this.say(row); this.arm(); return row;
  }
  /** Resume preparation only. A durable updating claim is never automatically launched again. */
  async start(): Promise<void> {
    if (!this.live()) return;
    const row = this.pending(); if (row?.state === "starting") this.put(row.id, "waiting");
    await this.pump(); this.arm();
  }
  /** Called by idle/activity events, new admission, or the one expiry timer. */
  pump(): Promise<void> {
    if (this.running) { this.dirty = true; return this.running; }
    this.running = Promise.resolve().then(async () => {
      do { this.dirty = false; await this.run(); } while (this.dirty && this.live());
    }).finally(() => {
      this.running = null; this.arm();
      // A pump that arrived after the loop check, and before running was cleared, must not be dropped.
      if (this.dirty && this.live()) void this.pump();
    });
    return this.running;
  }
  private async run(): Promise<void> {
    if (!this.live()) return;
    this.expire();
    let row = this.pending();
    if (!row || row.state !== "waiting") return;
    if (!this.allowed(row)) { this.put(row.id, "cancelled", "permission-revoked"); return; }
    if (!this.idle()) return;
    row = this.put(row.id, "starting");
    const id = row.id;
    let claimed = false;
    const current = () => {
      if (!this.live()) return false;
      const saved = this.get(id);
      return !!saved && saved.state === (claimed ? "updating" : "starting") && this.allowed(saved)
        && (claimed || (this.host.now() < saved.expiresAt && this.idle()));
    };
    const control: IdleUpdateLaunch = { current, claim: () => {
      if (claimed) return false;
      if (!current()) return false;
      this.put(id, "updating"); claimed = true; return true;
    } };
    let launched = false;
    try { launched = await this.host.launch(row, control); } catch { /* retained failure below */ }
    if (!this.live()) return;
    const saved = this.get(id);
    if (!saved || !["starting", "updating"].includes(saved.state)) return;
    if (claimed) { if (!launched) this.put(id, "failed", "launch-failed"); return; }
    if (!this.allowed(saved)) this.put(id, "cancelled", "permission-revoked");
    else if (this.host.now() >= saved.expiresAt) this.put(id, "expired", "expired");
    else if (!this.idle()) this.put(id, "waiting");
    else this.put(id, "failed", "launch-failed");
  }
  cancel(id: string, reason: "owner" | "hub" | "permission-revoked" = "owner"): boolean {
    if (!this.live()) return false;
    const row = this.get(id);
    if (!row || !["waiting", "starting"].includes(row.state)) return false;
    this.put(id, "cancelled", reason); return true;
  }
  settle(id: string, state: "done" | "rolled-back" | "failed", reason: IdleUpdateReason = null): boolean {
    if (!this.live() || this.get(id)?.state !== "updating") return false;
    this.put(id, state, reason); return true;
  }
  private expire(): void {
    if (!this.live()) return;
    const row = this.pending();
    if (row && ["waiting", "starting"].includes(row.state) && this.host.now() >= row.expiresAt) this.put(row.id, "expired", "expired");
  }
  private arm(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.live()) return;
    const row = this.pending(); if (!row || !["waiting", "starting"].includes(row.state)) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.expire(); }, Math.max(0, row.expiresAt - this.host.now())); this.timer.unref();
  }
  close(): void { this.stopped = true; clearTimeout(this.timer); }
}
