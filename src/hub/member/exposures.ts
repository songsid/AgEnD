/**
 * S3c (S-55, docs/design/hub-s3c-exposures.md): the member's exposure store — the owner's locally approved exposure
 * policy/context mappings (hub.md §4), in the member DB (hub-member/<hubId>/member.sqlite) with its own version floor.
 *
 * - One exposure per local agent: a COMMITTED mapping (what S1 admission and S4 read) and at most one STAGED candidate
 *   (the next revision, never visible to admission or execution: its exposure.state is "withdrawn" until the atomic
 *   publish promotes it). Publish = stage → S4 readinessCandidate → recheck → atomic promote; withdraw narrows at once.
 * - Every change: check (meta revision == floor), work, audit in THIS transaction, raise the floor, bump the revision
 *   (the snapshot revision: it never repeats with other content, and never rolls back). A failure after a write marks
 *   the store failed (uncertain) until restart.
 * - snapshot(): the complete current set the Hub mirrors — published (and frozen) exposures; a withdrawn one is left
 *   out, which the Hub's receiveSnapshot reads as withdrawn. Never staged rows, never instance inventory.
 * No file opening or migration on import; composition (S5) supplies the DB, floor, audit and the views registry.
 */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { canonicalArguments } from "../identity.js";
import { HubProtocolError } from "../validation.js";
import type { HubVersionFloor } from "../store.js";
import type { HubAuditRecord, HubExposure, HubExposureSnapshot } from "../types.js";
import { executionPolicyDigest, type HubDocumentView } from "../execution/views.js";
import type { HubExecutionReadiness, HubLocalExposure } from "../execution/service.js";
import type { HubMigration } from "../db.js";
import type { HubMemberLink } from "../client.js";

/** P1: at most this many published exposures a member (protocol: the snapshot's 64). */
export const HUB_EXPOSURE_MAX = 64;

export const HUB_EXPOSURE_MIGRATION: HubMigration = {
  component: "s3c-exposures",
  version: 1,
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS hub_exposure_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_exposures(id TEXT PRIMARY KEY, agent TEXT UNIQUE NOT NULL, committed TEXT, staged TEXT);`);
  },
};

/** The member's binding a mapping is made under: the paired owner and fleet (null: not paired). */
export interface HubExposureBinding { owner: HubExposure["owner"]; fleetId: string }
export interface HubExposureStoreOptions {
  floor: HubVersionFloor;
  /** S5's member-local audit (raw-db store: appendInTransaction). */
  audit: { appendInTransaction(record: HubAuditRecord, database: Database.Database): void };
  /** The current pairing's owner and fleet, or null. */
  binding(): HubExposureBinding | null;
  /** The exact registry S4 gets (built by S5 from durable owner-approved snapshots). */
  views: ReadonlyMap<string, HubDocumentView>;
  now?: () => number;
}
export interface HubExposureInput {
  agent: string; providerId: string; displayName: string; dataViewId: string; allowedTools: readonly string[];
  /** The committed revision the owner saw (0: none yet). */
  expectedRevision: number;
}
export type HubExposureError = "not_paired" | "unknown_agent" | "unknown_view" | "not_enforceable" | "conflict" | "limit";
export class HubExposureRefusal extends Error { constructor(readonly code: HubExposureError) { super(code); } }
/** One row for the owner's list (the UI's view is made from it). */
export interface HubExposureRow { agent: string; committed: HubLocalExposure | null; staged: HubLocalExposure | null }

type Row = { id: string; agent: string; committed: string | null; staged: string | null };
const parse = (s: string | null): HubLocalExposure | null => (s ? JSON.parse(s) as HubLocalExposure : null);
const same = (a: unknown, b: unknown) => canonicalArguments([a]) === canonicalArguments([b]);

export class HubExposureStore {
  private failed = false;
  constructor(readonly database: Database.Database, private readonly options: HubExposureStoreOptions) {}

  /** A new member set only: floor 0 and no meta row (S5 initializes every floor of the set together). */
  initialize(): void {
    if (this.options.floor.read() !== 0 || this.database.prepare("SELECT 1 FROM hub_exposure_meta").get()) throw new HubProtocolError("uncertain");
    this.database.prepare("INSERT INTO hub_exposure_meta VALUES(1,0)").run();
  }
  /** The store revision (== the floor), or uncertain. */
  check(): number {
    if (this.failed) throw new HubProtocolError("uncertain");
    try {
      const row = this.database.prepare("SELECT revision FROM hub_exposure_meta WHERE singleton=1").get() as { revision: number } | undefined;
      if (!row || !Number.isSafeInteger(row.revision) || row.revision !== this.options.floor.read()) throw Error();
      return row.revision;
    } catch { this.failed = true; throw new HubProtocolError("uncertain"); }
  }
  private change<T>(action: string, exposureId: string, work: (revision: number) => T): T {
    let writing = false;
    try {
      return this.database.transaction(() => {
        const revision = this.check(), value = work(revision); writing = true;
        // #3115 r1 P6: required audit finishes in THIS transaction. A thenable (an async sink) is refused: the store
        // goes uncertain, the transaction rolls back, and a late rejection is observed (never unhandled).
        const result: unknown = this.options.audit.appendInTransaction({ id: randomUUID(), sequence: revision + 1, at: (this.options.now ?? Date.now)(), requestId: randomUUID(),
          actor: { kind: "local-host" }, action, result: "completed", exposureId, policyVersion: revision + 1 }, this.database);
        if (result && typeof (result as { then?: unknown }).then === "function") {
          void Promise.resolve(result).catch(() => {});
          throw new HubProtocolError("uncertain");
        }
        this.options.floor.raise(revision + 1);
        this.database.prepare("UPDATE hub_exposure_meta SET revision=? WHERE singleton=1").run(revision + 1);
        return value;
      }).immediate();
    } catch (error) { if (writing) this.failed = true; throw error; }
  }
  private rowOf(agent: string): Row | undefined { return this.database.prepare("SELECT * FROM hub_exposures WHERE agent=?").get(agent) as Row | undefined; }
  private rowById(id: string): Row | undefined { return this.database.prepare("SELECT * FROM hub_exposures WHERE id=?").get(id) as Row | undefined; }

  // ── Readers (unchanged signatures for S1 and S4) ──
  /** S1 admission: the COMMITTED exposure only (a staged candidate is never visible; a withdrawn one says so). */
  exposure(id: string): HubExposure | null {
    this.check();
    const r = this.rowById(id);
    return parse(r?.committed ?? null)?.exposure ?? null;
  }
  /** S4: the committed mapping while published or frozen; withdrawn (or none): null — fenced. */
  localExposure(id: string): HubLocalExposure | null {
    this.check();
    const c = parse(this.rowById(id)?.committed ?? null);
    return c && c.exposure.state !== "withdrawn" ? c : null;
  }
  /** The complete set the Hub mirrors at this revision (published and frozen; withdrawn left out). */
  snapshot(): HubExposureSnapshot {
    const revision = this.check();
    const rows = this.database.prepare("SELECT committed FROM hub_exposures WHERE committed IS NOT NULL ORDER BY id").all() as Array<{ committed: string }>;
    return { revision, exposures: rows.map((r) => parse(r.committed)!.exposure).filter((e) => e.state !== "withdrawn") };
  }
  list(): HubExposureRow[] {
    this.check();
    return (this.database.prepare("SELECT * FROM hub_exposures ORDER BY agent").all() as Row[]).map((r) => ({ agent: r.agent, committed: parse(r.committed), staged: parse(r.staged) }));
  }

  // ── The owner's changes ──
  /**
   * Stage the next revision of `agent`'s exposure (or its first): a candidate S4 can judge (readinessCandidate) and
   * nobody can admit (state "withdrawn" until publish). Refused: not paired, an unknown view or tools S4 would deny,
   * a committed revision other than the one the owner saw (conflict), more than HUB_EXPOSURE_MAX published.
   */
  stage(input: HubExposureInput): HubLocalExposure {
    const binding = this.options.binding();
    if (!binding) throw new HubExposureRefusal("not_paired");
    const view = this.options.views.get(input.dataViewId);
    if (!view) throw new HubExposureRefusal("unknown_view");
    let policyDigest: string;
    try { policyDigest = executionPolicyDigest(view, input.allowedTools); } catch { throw new HubExposureRefusal("not_enforceable"); }
    const before = this.rowOf(input.agent), id = before?.id ?? randomUUID();
    return this.change("exposure.staged", id, () => {
      const row = this.rowOf(input.agent), committed = parse(row?.committed ?? null);
      if ((committed?.exposure.revision ?? 0) !== input.expectedRevision || (row && row.id !== id)) throw new HubExposureRefusal("conflict");
      if (!(committed && committed.exposure.state === "published") && this.published() >= HUB_EXPOSURE_MAX) throw new HubExposureRefusal("limit");
      const candidate: HubLocalExposure = {
        agent: input.agent, providerId: input.providerId, consentId: randomUUID(), generation: (committed?.generation ?? 0) + 1,
        exposure: { id, fleetId: binding.fleetId, owner: binding.owner, displayName: input.displayName, revision: input.expectedRevision + 1,
          state: "withdrawn", dataViewId: input.dataViewId, allowedTools: [...input.allowedTools].sort(), policyDigest },
      };
      if (row) this.database.prepare("UPDATE hub_exposures SET staged=? WHERE id=?").run(JSON.stringify(candidate), id);
      else this.database.prepare("INSERT INTO hub_exposures VALUES(?,?,NULL,?)").run(id, input.agent, JSON.stringify(candidate));
      return candidate;
    });
  }
  /**
   * The atomic publish: in ONE transaction, recheck that the staged candidate is exactly `candidate`, the committed
   * revision is still the one before it, the binding and the view's policy digest are unchanged, and S4's readiness
   * (called again here, immediately before the write) still holds; then promote it to the committed, published mapping.
   */
  publish(candidate: HubLocalExposure, ready: (candidate: HubLocalExposure) => HubExecutionReadiness): HubLocalExposure {
    const id = candidate.exposure.id;
    return this.change("exposure.published", id, () => {
      const row = this.rowById(id), committed = parse(row?.committed ?? null), binding = this.options.binding();
      if (!row || !same(parse(row.staged), candidate) || (committed?.exposure.revision ?? 0) !== candidate.exposure.revision - 1) throw new HubExposureRefusal("conflict");
      if (!binding || !same(binding.owner, candidate.exposure.owner) || binding.fleetId !== candidate.exposure.fleetId) throw new HubExposureRefusal("conflict");
      const view = this.options.views.get(candidate.exposure.dataViewId);
      let digest = "";
      try { digest = view ? executionPolicyDigest(view, candidate.exposure.allowedTools) : ""; } catch { digest = ""; }
      if (digest !== candidate.exposure.policyDigest) throw new HubExposureRefusal("not_enforceable");
      const r = ready(candidate);
      if (!r.ok || r.policyDigest !== candidate.exposure.policyDigest || r.exposureRevision !== candidate.exposure.revision) throw new HubExposureRefusal("not_enforceable");
      if (!(committed && committed.exposure.state === "published") && this.published() >= HUB_EXPOSURE_MAX) throw new HubExposureRefusal("limit");
      const published: HubLocalExposure = { ...candidate, exposure: { ...candidate.exposure, state: "published" } };
      this.database.prepare("UPDATE hub_exposures SET committed=?, staged=NULL WHERE id=?").run(JSON.stringify(published), id);
      return published;
    });
  }
  /** Drop a staged candidate (a refused readiness, a cancelled confirmation); the committed mapping is untouched. */
  discard(id: string): void {
    const row = this.rowById(id);
    if (!row || !row.staged) return;
    this.change("exposure.discarded", id, () => {
      if (row.committed) this.database.prepare("UPDATE hub_exposures SET staged=NULL WHERE id=?").run(id);
      else this.database.prepare("DELETE FROM hub_exposures WHERE id=?").run(id);
    });
  }
  /**
   * Withdraw at once (narrowing needs no consent): the committed mapping becomes withdrawn at the next revision (S1
   * admission then refuses, S4 sees null), any staged candidate goes. `expectedRevision`: the one the owner saw.
   */
  withdraw(id: string, expectedRevision: number): HubLocalExposure {
    return this.change("exposure.withdrawn", id, () => {
      const row = this.rowById(id), committed = parse(row?.committed ?? null);
      if (!committed || committed.exposure.revision !== expectedRevision || committed.exposure.state === "withdrawn") throw new HubExposureRefusal("conflict");
      const out: HubLocalExposure = { ...committed, exposure: { ...committed.exposure, revision: committed.exposure.revision + 1, state: "withdrawn" } };
      this.database.prepare("UPDATE hub_exposures SET committed=?, staged=NULL WHERE id=?").run(JSON.stringify(out), id);
      return out;
    });
  }
  private published(): number {
    return (this.database.prepare("SELECT committed FROM hub_exposures WHERE committed IS NOT NULL").all() as Array<{ committed: string }>)
      .filter((r) => parse(r.committed)!.exposure.state === "published").length;
  }
}

/**
 * The owner's publish, end to end: stage → S4 readinessCandidate (capability evidence, not consent) → recheck and
 * atomic publish (readiness asked again inside it). A refusal at any step drops the candidate and leaves the committed
 * mapping as it was.
 */
export function publishExposure(store: HubExposureStore, input: HubExposureInput, ready: (candidate: HubLocalExposure) => HubExecutionReadiness): HubLocalExposure {
  const candidate = store.stage(input);
  try {
    const first = ready(candidate);
    if (!first.ok) throw new HubExposureRefusal("not_enforceable");
    return store.publish(candidate, ready);
  } catch (error) {
    try { store.discard(candidate.exposure.id); } catch { /* the store says uncertain on its own */ }
    throw error;
  }
}

/**
 * The snapshot to the Hub through S1 (Sentinel's rules, S-55 Q2): `{ v:1, type:"exposure.snapshot", requestId: fresh,
 * linkEpoch: the link's, payload: store.snapshot() }`.
 * - `publishSnapshot(link)`: S-56's handshake step, before the link is ready (`link.send`); it remembers the link.
 * - `afterCommit()`: after an owner's publish or withdraw, on that link while it is current; otherwise the next
 *   handshake carries it. Socket acceptance is all a send proves (no ack frame): the owner is told "pending".
 * Never an older revision than one sent (the store's revision only goes up, and this checks it); the same revision is
 * sent again on a new link (metadata retry, never input replay); a fresh requestId every time; the link is checked
 * again after the await, and a send on an old link promotes nothing.
 */
export function exposureSnapshotSender(store: Pick<HubExposureStore, "snapshot">) {
  let link: HubMemberLink | null = null, sent = 0;
  const push = async (l: HubMemberLink): Promise<boolean> => {
    if (!l.current()) return false;
    const payload = store.snapshot();
    if (payload.revision < sent) throw new HubProtocolError("stale");
    await l.send({ v: 1, type: "exposure.snapshot", requestId: randomUUID(), linkEpoch: l.linkEpoch, payload });
    if (!l.current()) return false;
    sent = Math.max(sent, payload.revision);
    return true;
  };
  return {
    async publishSnapshot(l: HubMemberLink): Promise<void> {
      link = l;
      if (!(await push(l))) throw new HubProtocolError("stale");
    },
    async afterCommit(): Promise<"pending"> {
      const l = link;
      if (l && l.current()) { try { await push(l); } catch { /* the next handshake carries the current snapshot */ } }
      return "pending";
    },
    /** The highest revision handed to a current link (socket acceptance only). */
    sentRevision: () => sent,
  };
}
