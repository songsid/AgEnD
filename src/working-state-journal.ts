import type Database from "better-sqlite3";

/** Metadata only. Stage 1 observes; these records never authorize a resume. */
export const WORKING_STATE_MAX_BYTES = 8 * 1024;
export const WORKING_STATE_MAX_REFS = 16;
export type WorkingStateReason = "published" | "execution" | "background" | "turn_started" | "turn_closed" | "completion_delivered" | "cancelled" | "before_stop" | "before_spawn" | "process" | "supervision_ended" | "tasks" | "obligations";
export interface WorkingStateOwner { bootId: string; spawnGeneration: number; launchAttempt: number; launchFenceEpoch: number }
export interface WorkingStateTurn {
  generation: number;
  deliveryId: string | null;
  correlationId: string | null;
  messageId: string | null;
  cancelled: boolean;
  completionDelivered: boolean;
}
export interface WorkingStateObservation {
  owner: WorkingStateOwner;
  backend: string;
  /** A digest, never a raw workspace/profile or transcript path. */
  configuration: string;
  executionState: "idle" | "working" | "stuck" | "paused" | null;
  processStatus: "running" | "crashed" | "stopped";
  backgroundWork: boolean | null;
  turn: WorkingStateTurn | null;
  /** No generic getSessionId discovery is allowed on this observation path. */
  sessionId: string | null;
  backendTurnId: null;
  /** A confirmed local continuation starts a demonstrably resumed work interval. */
  recoveryDeliveryId?: string;
}
export type WorkingStateReference =
  | { kind: "task"; id: string; version: number; status: "claimed" | "blocked" | "review" }
  | { kind: "owed" | "waiting"; correlationId: string; requester: string; owner: string; deliveryId: string };
export interface WorkingStateSnapshot {
  version: 1;
  managerBootId: string;
  observedAt: number;
  lastActivityAt: number | null;
  reason: WorkingStateReason;
  observation: WorkingStateObservation;
  references: WorkingStateReference[];
  totalReferences: number;
  unavailable: Array<"tasks" | "obligations">;
}
export interface WorkingStateEntry { instance: string; revision: number; current: WorkingStateSnapshot; prior: WorkingStateSnapshot | null }

const reasons = new Set<WorkingStateReason>(["published", "execution", "background", "turn_started", "turn_closed", "completion_delivered", "cancelled", "before_stop", "before_spawn", "process", "supervision_ended", "tasks", "obligations"]);
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && Buffer.byteLength(v) <= 256 && !/[\u0000-\u001f\u007f]/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** Whitelist every field: callers cannot accidentally persist a pane/config/message. */
function bounded(input: WorkingStateSnapshot): WorkingStateSnapshot {
  const o = input.observation, owner = o.owner, turn = o.turn;
  if (!id(input.managerBootId) || !reasons.has(input.reason) || !Number.isFinite(input.observedAt)
    || !id(owner.bootId) || ![owner.spawnGeneration, owner.launchAttempt, owner.launchFenceEpoch].every(integer)
    || !id(o.backend) || !/^[a-f0-9]{64}$/.test(o.configuration)
    || ![null, "idle", "working", "stuck", "paused"].includes(o.executionState)
    || !["running", "crashed", "stopped"].includes(o.processStatus)) throw new Error("Invalid working-state observation");
  const refs: WorkingStateReference[] = [];
  for (const ref of input.references.slice(0, WORKING_STATE_MAX_REFS)) {
    if (ref.kind === "task" && id(ref.id) && integer(ref.version) && ["claimed", "blocked", "review"].includes(ref.status)) {
      refs.push({ kind: "task", id: ref.id, version: ref.version, status: ref.status });
    } else if ((ref.kind === "owed" || ref.kind === "waiting") && [ref.correlationId, ref.requester, ref.owner, ref.deliveryId].every(id)) {
      refs.push({ kind: ref.kind, correlationId: ref.correlationId, requester: ref.requester, owner: ref.owner, deliveryId: ref.deliveryId });
    }
  }
  const value: WorkingStateSnapshot = {
    version: 1, managerBootId: input.managerBootId, observedAt: input.observedAt, reason: input.reason,
    lastActivityAt: typeof input.lastActivityAt === "number" && Number.isFinite(input.lastActivityAt) ? input.lastActivityAt : null,
    observation: {
      owner: { bootId: owner.bootId, spawnGeneration: owner.spawnGeneration, launchAttempt: owner.launchAttempt, launchFenceEpoch: owner.launchFenceEpoch },
      backend: o.backend, configuration: o.configuration, executionState: o.executionState, processStatus: o.processStatus,
      backgroundWork: typeof o.backgroundWork === "boolean" ? o.backgroundWork : null,
      turn: turn && integer(turn.generation) ? { generation: turn.generation,
        deliveryId: id(turn.deliveryId) ? turn.deliveryId : null, correlationId: id(turn.correlationId) ? turn.correlationId : null,
        messageId: id(turn.messageId) ? turn.messageId : null, cancelled: turn.cancelled === true, completionDelivered: turn.completionDelivered === true } : null,
      sessionId: id(o.sessionId) ? o.sessionId : null, backendTurnId: null,
      ...(id(o.recoveryDeliveryId) ? { recoveryDeliveryId: o.recoveryDeliveryId } : {}),
    },
    references: refs, totalReferences: Math.max(integer(input.totalReferences) ? input.totalReferences : 0, input.references.length),
    unavailable: ["tasks", "obligations"].filter(x => input.unavailable.includes(x as "tasks" | "obligations")) as Array<"tasks" | "obligations">,
  };
  while (Buffer.byteLength(JSON.stringify(value)) > WORKING_STATE_MAX_BYTES && value.references.length) value.references.pop();
  if (Buffer.byteLength(JSON.stringify(value)) > WORKING_STATE_MAX_BYTES) throw new Error("Working-state observation exceeds its byte budget");
  return value;
}

/** Task cards describe ownership, not proof that execution was interrupted. */
export function hasInterruptedExecution(s: WorkingStateSnapshot): boolean {
  const turn = s.observation.turn;
  return ["working", "stuck"].includes(s.observation.executionState ?? "")
    && !turn?.cancelled && !turn?.completionDelivered;
}

function notable(s: WorkingStateSnapshot): boolean {
  const turn = s.observation.turn;
  return s.totalReferences > 0 || s.observation.backgroundWork === true || (!!turn && !turn.cancelled && !turn.completionDelivered)
    || hasInterruptedExecution(s);
}

/** Two bounded snapshots per instance: latest, plus first unconsumed interruption. */
export class WorkingStateJournal {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS working_state_journal (
      instance_name TEXT PRIMARY KEY, revision INTEGER NOT NULL,
      current_json TEXT NOT NULL CHECK(length(CAST(current_json AS BLOB)) <= 8192),
      prior_json TEXT CHECK(prior_json IS NULL OR length(CAST(prior_json AS BLOB)) <= 8192)
    )`);
  }

  get(instance: string): WorkingStateEntry | undefined {
    const row = this.db.prepare("SELECT revision,current_json,prior_json FROM working_state_journal WHERE instance_name=?").get(instance) as
      { revision: number; current_json: string; prior_json: string | null } | undefined;
    if (!row) return undefined;
    return { instance, revision: row.revision, current: JSON.parse(row.current_json), prior: row.prior_json ? JSON.parse(row.prior_json) : null };
  }

  observe(instance: string, input: WorkingStateSnapshot): WorkingStateEntry | null {
    if (!id(instance)) throw new Error("Invalid working-state instance");
    let snapshot = bounded(input);
    return this.db.transaction(() => {
      const previous = this.get(instance);
      // A confirmed continuation identifies work, not a CLI generation. A
      // replacement may temporarily lack session ownership; recover the marker
      // only after it proves the same configuration/session, never for a fresh one.
      if (!snapshot.observation.recoveryDeliveryId && snapshot.observation.sessionId) {
        const matching = [previous?.current, previous?.prior].find(s => s?.observation.recoveryDeliveryId
          && s.observation.configuration === snapshot.observation.configuration
          && s.observation.sessionId === snapshot.observation.sessionId);
        if (matching) {
          snapshot.observation.recoveryDeliveryId = matching.observation.recoveryDeliveryId;
          snapshot = bounded(snapshot); // The inherited metadata must also fit the byte budget.
        }
      }
      // Exact heartbeats do not write or emit. The caller observes changes, not polling.
      const comparable = (s: WorkingStateSnapshot) => JSON.stringify({ ...s, observedAt: 0, reason: "observation" });
      const boundary = snapshot.reason === "before_stop" || snapshot.reason === "before_spawn";
      if (previous && comparable(previous.current) === comparable(snapshot)
        && !(boundary && previous.current.reason !== snapshot.reason)) return null;
      let prior = previous?.prior ?? null;
      // Idle task metadata is still observable, but cannot hide later genuine
      // work. Keep legacy-owned turns and the continuation-marker inheritance above.
      if (prior && !hasInterruptedExecution(prior) && !prior.observation.turn && hasInterruptedExecution(snapshot)) prior = null;
      if (!prior && previous?.current.managerBootId !== snapshot.managerBootId && previous && notable(previous.current)) prior = previous.current;
      if (!prior && boundary && notable(snapshot)) prior = snapshot;
      // A later graceful stop is authoritative: work that reached idle before
      // it stopped was not interrupted by this stop. Marker inheritance above
      // remains available as metadata, and durable delivery receipts are separate.
      if (snapshot.reason === "before_stop" && snapshot.observation.executionState === "idle" && !snapshot.observation.turn) prior = snapshot;
      const revision = (previous?.revision ?? 0) + 1;
      this.db.prepare(`INSERT INTO working_state_journal(instance_name,revision,current_json,prior_json) VALUES(?,?,?,?)
        ON CONFLICT(instance_name) DO UPDATE SET revision=excluded.revision,current_json=excluded.current_json,prior_json=excluded.prior_json`)
        .run(instance, revision, JSON.stringify(snapshot), prior ? JSON.stringify(prior) : null);
      return { instance, revision, current: snapshot, prior };
    })();
  }
}
