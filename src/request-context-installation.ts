/** Durable installation intent. Runtime publication is separate: a committed row never means serving is installed. */
import type Database from "better-sqlite3";
import { z } from "zod";
import { commitRequestContextActivation, readRequestContextActivations, type RequestContextActivationRecord } from "./request-context-activation.js";
import { assertRequestContextCompatibility, REQUEST_CONTEXT_VERSION_FUNCTION } from "./request-context-compatibility.js";
import type { RequestContextActivationLease } from "./request-context-update-guard.js";
import type { RequestContextAdmissionPort } from "./request-context-admission.js";
import { requestContextDigest, requestContextJson } from "./request-context-store.js";

const TABLE = "request_context_installation_v1";
const key = z.string().min(1).max(256);
const State = z.strictObject({ revision: z.number().int().positive().safe(), epoch: key, owner: key,
  mode: z.enum(["active", "draining", "off"]) });
export type RequestContextInstallationState = z.infer<typeof State>;
export interface RequestContextInstallationOwner { readonly owner: string; current(): boolean }
export interface RequestContextOffProof { readonly epoch: string; readonly revision: number; current(): boolean }

/** Pure reader for startup, before recovery. Missing state under an active floor is never treated as legacy. */
export function readRequestContextInstallation(db: Database.Database): RequestContextInstallationState | null {
  const table = db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(TABLE) as { type: string } | undefined;
  if (!table) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name IN ('request_context_compatibility','request_context_activations_v1')").get()) throw Error("Installation state unavailable");
    return null;
  }
  if (table.type !== "table" || assertRequestContextCompatibility(db, 1) !== "active") throw Error("Invalid installation state");
  const rows = db.prepare(`SELECT singleton,state_json,state_sha256 FROM ${TABLE}`).all() as Array<{singleton:number;state_json:string;state_sha256:string}>;
  if (rows.length !== 1 || rows[0]!.singleton !== 1) throw Error("Invalid installation state");
  const row = rows[0]!, value = State.parse(JSON.parse(row.state_json));
  if (requestContextDigest(value) !== row.state_sha256) throw Error("Installation state differs");
  if (!readRequestContextActivations(db).some(a => a.epoch === value.epoch && a.owner === value.owner)) throw Error("Installation activation unavailable");
  return value;
}

export class RequestContextInstallationStore {
  constructor(private readonly db: Database.Database) {}
  read(): RequestContextInstallationState | null { return readRequestContextInstallation(this.db); }
  private requireOwner(owner: RequestContextInstallationOwner, state?: RequestContextInstallationState): void {
    if (!owner.current() || state && state.owner !== owner.owner) throw Error("Installation owner changed");
  }
  private write(state: RequestContextInstallationState): void {
    this.db.prepare(`INSERT INTO ${TABLE}(singleton,state_json,state_sha256) VALUES (1,?,?)
      ON CONFLICT(singleton) DO UPDATE SET state_json=excluded.state_json,state_sha256=excluded.state_sha256`)
      .run(requestContextJson(state), requestContextDigest(state));
  }
  /** Floor, history (including Go back), active epoch and desired mode have one outer COMMIT. */
  activate(record: RequestContextActivationRecord, owner: RequestContextInstallationOwner,
    update: RequestContextActivationLease, readyAndSameOffer: () => boolean, expectedRevision: number, initialize?: () => unknown): RequestContextInstallationState {
    return this.db.transaction(() => {
      this.requireOwner(owner);
      const previous = this.read();
      this.requireOwner(owner, previous ?? undefined);
      if ((previous?.revision ?? 0) !== expectedRevision || previous && previous.mode !== "off") throw Error("stale");
      if (record.owner !== owner.owner) throw Error("Installation owner changed");
      commitRequestContextActivation(this.db, record, update, () => owner.current() && readyAndSameOffer());
      this.db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),state_json TEXT NOT NULL,state_sha256 TEXT NOT NULL)`);
      for (const op of ["INSERT", "UPDATE"] as const) this.db.exec(`CREATE TRIGGER IF NOT EXISTS request_context_installation_${op.toLowerCase()}
        BEFORE ${op} ON ${TABLE} BEGIN SELECT CASE WHEN COALESCE(${REQUEST_CONTEXT_VERSION_FUNCTION}(),0)<1
          THEN RAISE(ABORT,'request-context dispatch v1 required') END; END`);
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS request_context_installation_no_delete BEFORE DELETE ON ${TABLE}
        BEGIN SELECT RAISE(ABORT,'Installation state cannot be removed'); END`);
      const state = State.parse({ revision: expectedRevision + 1, epoch: record.epoch, owner: owner.owner, mode: "active" });
      this.write(state);
      // Staged runtime owners already exist behind the fence. Their durable companion tables/work identities
      // join this outer transaction; neither a partial schema nor Go back invalidation may survive failure.
      if (initialize && initialize() !== undefined) throw Error("Activation initialization must be synchronous");
      this.requireOwner(owner);
      if (!update.current() || !readyAndSameOffer()) throw Error("Activation preparation changed");
      return this.read()!;
    })();
  }
  /** Persist desired Off before allowing tracked work to drain. Restart resumes this exact mode. */
  beginOff(expectedRevision: number, owner: RequestContextInstallationOwner): RequestContextInstallationState {
    return this.db.transaction(() => {
      const state = this.read(); if (!state || state.revision !== expectedRevision) throw Error("stale");
      this.requireOwner(owner, state);
      if (state.mode !== "active") return state;
      const next = { ...state, revision: state.revision + 1, mode: "draining" as const }; this.write(next);
      this.requireOwner(owner, state); return this.read()!;
    })();
  }
  /** The assessor is independent of the runtime installer; failed installation cannot make empty-work Off deadlock. */
  finishOff(expectedRevision: number, owner: RequestContextInstallationOwner, proof: RequestContextOffProof): RequestContextInstallationState {
    return this.db.transaction(() => {
      const state = this.read(); if (!state || state.mode !== "draining" || state.revision !== expectedRevision
        || proof.epoch !== state.epoch || proof.revision !== state.revision) throw Error("stale");
      this.requireOwner(owner, state); if (!proof.current()) throw Error("Scoped work still exists");
      const next = { ...state, revision: state.revision + 1, mode: "off" as const }; this.write(next);
      this.requireOwner(owner, state); if (!proof.current()) throw Error("Scoped work still exists");
      return this.read()!;
    })();
  }
}

export interface RequestContextPublishedInstallation<T> {
  readonly state: Readonly<RequestContextInstallationState>;
  readonly ports: Readonly<T>;
  current(): boolean;
  /** Existing tracked execution may finish during a preparation fence or same-epoch drain. */
  executionCurrent(): boolean;
}
/** One process-owned publication reference. Every ingress captures it, never a desired config flag. */
export class RequestContextPublication<T extends object> {
  private published: RequestContextPublishedInstallation<T> | null = null;
  private readonly executions = new Set<RequestContextPublishedInstallation<T>>();
  private required: boolean;
  private fenced = false;
  private fenceSerial = 0;
  private arrivals = 0;
  private readonly waiting = new Set<{ current(): boolean; resolve(available: boolean): void }>();
  private readonly admissionListeners = new Set<(available: boolean) => void>();
  readonly admission: RequestContextAdmissionPort = Object.freeze({
    available: () => this.admissionAvailable(),
    arrived: () => { if (!this.admissionAvailable()) this.arrivals++; },
    wait: (current: () => boolean) => this.waitForAdmission(current),
    changed: () => this.refreshAdmission(),
    subscribe: (listener: (available: boolean) => void) => {
      if (this.admissionListeners.size >= 64) throw Error("Request-context admission listeners are full");
      this.admissionListeners.add(listener); return () => { this.admissionListeners.delete(listener); };
    },
  });
  constructor(private readonly owner: RequestContextInstallationOwner, previouslyActivated: boolean) { this.required = previouslyActivated; this.fenced = previouslyActivated; }
  /**
   * Policy/instruction mode for the published executions, retained while their owner/ports remain current even
   * under a recovery or preparation fence. This does NOT mean admission is open: ingress must use capture(),
   * which refuses under the fence. Before the first publication (including startup recovery), this is null.
   */
  installedMode(): RequestContextInstallationState["mode"] | null { return this.published?.executionCurrent() ? this.published.state.mode : null; }
  installed(): boolean { return this.installedMode() !== null; }
  /** Startup recovery can mutate only behind the current owner's held admission fence. */
  recoveryAvailable(): boolean { return this.fenced && this.owner.current(); }
  private admissionAvailable(): boolean {
    try { return this.owner.current() && !this.fenced && (!this.required || this.published?.current() === true); }
    catch { return false; }
  }
  private producerCurrent(current: () => boolean): boolean { try { return current(); } catch { return false; } }
  private waitForAdmission(current: () => boolean): Promise<boolean> {
    if (!this.producerCurrent(current) || !this.producerCurrent(() => this.owner.current())) return Promise.resolve(false);
    if (this.admissionAvailable()) return Promise.resolve(true);
    if (this.waiting.size >= 4096) return Promise.reject(Error("Request-context admission backlog is full"));
    // Only an actual producer arrival invalidates preparation, never a pump/readiness poll.
    this.arrivals++;
    return new Promise(resolve => this.waiting.add({ current, resolve }));
  }
  private refreshAdmission(): void {
    const available = this.admissionAvailable();
    for (const waiter of this.waiting) {
      const current = this.producerCurrent(() => this.owner.current()) && this.producerCurrent(waiter.current);
      if (!current || available) { this.waiting.delete(waiter); waiter.resolve(current && available); }
    }
    for (const listener of this.admissionListeners) {
      try { listener(available); } catch { /* A scheduling observer cannot undo publication or block another producer. */ }
    }
  }
  /** A remote/local producer arriving under preparation invalidates its exact proof, without starting input. */
  ingressAvailable(): boolean {
    if (this.fenced) { this.arrivals++; return false; }
    return this.admissionAvailable();
  }
  fence(): { current(): boolean; owned(): boolean } {
    if (!this.owner.current()) throw Error("Installation fence unavailable");
    this.fenced = true; this.fenceSerial++;
    const serial = this.fenceSerial, arrivals = this.arrivals;
    const owned = () => this.owner.current() && this.fenced && this.fenceSerial === serial;
    return Object.freeze({ owned, current: () => owned() && this.arrivals === arrivals });
  }
  /** Call only after durable state commits, all nine ports are staged, and readiness is revalidated. */
  publish(state: RequestContextInstallationState, ports: T, fence: { current(): boolean }, ready: () => boolean,
    durable: () => RequestContextInstallationState | null, executionPortsCurrent: () => boolean): void {
    if (state.owner !== this.owner.owner || !fence.current() || !ready() || requestContextJson(durable()) !== requestContextJson(state)) throw Error("Installation preparation changed");
    if (!fence.current()) throw Error("Installation preparation changed");
    const copy = Object.freeze(State.parse(state)), owner = this.owner;
    if (!(copy.mode === "draining" && this.published?.state.epoch === copy.epoch && this.published.ports === ports)) this.executions.clear();
    const executionCurrent = () => this.executions.has(publication) && owner.current() && executionPortsCurrent();
    const publication: RequestContextPublishedInstallation<T> = Object.freeze({ state: copy, ports: Object.freeze(ports), executionCurrent,
      current: () => this.published === publication && !this.fenced && ready() && executionCurrent() });
    this.executions.add(publication);
    this.published = publication; this.required = true; this.fenced = false;
    this.refreshAdmission();
  }
  /** Activated-but-fenced or lost-owner never falls through to the lifetime dispatcher. */
  capture(): RequestContextPublishedInstallation<T> | null {
    if (!this.required && !this.fenced) return null;
    if (this.fenced || !this.published?.current()) throw Error("Request-context installation is fenced");
    return this.published;
  }
  /** Failed first preparation can resume legacy only when no durable activation committed. */
  abandon(fence: { current(): boolean; owned?(): boolean }, durable: () => RequestContextInstallationState | null): void {
    if (!(fence.owned?.() ?? fence.current()) || this.required || durable() !== null) throw Error("Activated installation cannot revert to legacy");
    this.fenced = false;
    this.refreshAdmission();
  }
}
