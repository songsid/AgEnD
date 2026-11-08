/** #3425: request-local browser handoff for the ONE directory SQL decision. No token in files, audit or notices. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { HubCore } from "./http/core.js";
import type { HubMigration } from "./db.js";
import type { HubDirectoryDecisionRequest, HubDirectorySettingsOperation } from "./settings-directory-decision.js";
import { personKeyString } from "./identity.js";
import { HubProtocolError, identifier, person, validated } from "./validation.js";
import { readHubSessionEpoch } from "./session-epoch.js";
import { z } from "zod";

const RECENT_MS = 5 * 60_000, IDLE_MS = 60 * 60_000;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const actorSchema = z.strictObject({ kind: z.literal("hub-administrator"), person, sessionId: identifier, requestId: identifier });
type Actor = z.infer<typeof actorSchema>;

/** Legacy sessions have no attestation. A rotated session never inherits one from its predecessor. */
export const HUB_SESSION_AUTHENTICATION_MIGRATION: HubMigration = Object.freeze({ component: "s5-session-authentication", version: 1, up(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS hub_session_authentication(session_id TEXT PRIMARY KEY REFERENCES hub_sessions(id) ON DELETE CASCADE,
    directory_epoch INTEGER NOT NULL CHECK(directory_epoch>=0), authenticated_at INTEGER NOT NULL CHECK(authenticated_at>=0))`);
} });

interface Row { token_hash: string; id: string; person: string; created_at: number; seen_at: number; expires_at: number; state: string; directory_epoch: number }
function row(db: Database.Database, sessionId: string): Row | undefined {
  return db.prepare("SELECT token_hash,id,person,created_at,seen_at,expires_at,state,directory_epoch FROM hub_sessions WHERE id=?").get(sessionId) as Row | undefined;
}
function current(r: Row | undefined, who: string, epoch: number, now: number): r is Row {
  return !!r && r.person === who && r.state === "active" && r.directory_epoch === epoch
    && [now, r.created_at, r.seen_at, r.expires_at].every(n => Number.isSafeInteger(n) && n >= 0)
    && now >= r.created_at && now >= r.seen_at && now < r.expires_at && now - r.seen_at <= IDLE_MS;
}

/** Only server session rows created by successful trusted-directory sign-in attest authentication. Never touches seen_at. */
export function recentHubDirectoryAuthentication(core: HubCore, raw: Actor): number | null {
  const actor = validated(actorSchema, raw);
  if (personKeyString(actor.person) !== personKeyString(core.deps.config.administrator)) return null;
  return core.atomic(db => {
    const now = core.now(), who = personKeyString(actor.person), r = row(db, actor.sessionId);
    if (!current(r, who, core.directoryEpoch, now)) return null;
    const proof = db.prepare("SELECT directory_epoch,authenticated_at FROM hub_session_authentication WHERE session_id=?").get(actor.sessionId) as { directory_epoch: number; authenticated_at: number } | undefined;
    return proof && proof.directory_epoch === core.directoryEpoch && Number.isSafeInteger(proof.authenticated_at)
      && proof.authenticated_at >= r.created_at && now >= proof.authenticated_at && now - proof.authenticated_at <= RECENT_MS ? proof.authenticated_at : null;
  });
}

/** Opaque, ephemeral and single use. A browser/body cannot construct its private proof or retrieve its new token. */
export interface HubDirectorySessionRotation { discard(): void }
interface Rotation {
  db: Database.Database; hubId: string; actor: Actor; old: Row; epoch: number; createdAt: number; expiresAt: number;
  now(): number; token: string | null; newId: string; phase: "prepared" | "taken" | "committed" | "released" | "discarded";
  operationId?: string; nextEpoch?: number;
}
const rotations = new WeakMap<HubDirectorySessionRotation, Rotation>();

export function prepareHubDirectorySessionRotation(core: HubCore, token: string, raw: Actor): HubDirectorySessionRotation {
  const actor = validated(actorSchema, raw);
  if (personKeyString(actor.person) !== personKeyString(core.deps.config.administrator)) throw new HubProtocolError("denied");
  const snapshot = core.atomic(db => {
    const now = core.now(), r = row(db, actor.sessionId);
    if (!current(r, personKeyString(actor.person), core.directoryEpoch, now) || r.token_hash !== hash(token)) throw new HubProtocolError("revoked");
    return { db, old: { ...r }, now };
  });
  const state: Rotation = { db: snapshot.db, hubId: core.deps.config.hubId, actor, old: snapshot.old, epoch: core.directoryEpoch,
    createdAt: snapshot.now, expiresAt: Math.min(snapshot.old.expires_at, snapshot.now + RECENT_MS), now: () => core.now(),
    token: randomBytes(32).toString("hex"), newId: randomUUID(), phase: "prepared" };
  const handle = Object.freeze({ discard() { state.token = null; state.phase = "discarded"; } });
  rotations.set(handle, state); return handle;
}

/** Internal SQL participant. Consume before callbacks; refused/rolled-back attempts cannot reuse the handoff. */
export function takeHubDirectorySessionRotation(handle: HubDirectorySessionRotation, db: Database.Database, hubId: string,
  actor: HubDirectoryDecisionRequest["actor"], expectedEpoch: number) {
  const state = rotations.get(handle);
  if (!state || state.phase !== "prepared") throw new HubProtocolError("denied");
  state.phase = "taken";
  if (state.db !== db || state.hubId !== hubId || state.epoch !== expectedEpoch || actor.kind !== "hub-administrator"
    || actor.sessionId !== state.actor.sessionId || actor.requestId !== state.actor.requestId
    || personKeyString(actor.person) !== personKeyString(state.actor.person)) { handle.discard(); throw new HubProtocolError("denied"); }
  return {
    declaration: Object.freeze({ v: 1 as const, previousSessionId: state.actor.sessionId, sessionId: state.newId }),
    /** Sample time before the caller's final SQL image rechecks; nothing here publishes browser authority. */
    clock: () => state.now(),
    validate(now: number) {
      const r = row(db, state.actor.sessionId);
      if (state.phase !== "taken" || !state.token || !Number.isSafeInteger(now) || now < state.createdAt || now >= state.expiresAt
        || readHubSessionEpoch(db) !== expectedEpoch || !current(r, state.old.person, expectedEpoch, now)
        || r.token_hash !== state.old.token_hash || r.created_at !== state.old.created_at || r.expires_at !== state.old.expires_at) throw new HubProtocolError("revoked");
      // Return only copied SQL values. The caller advances the epoch, then inserts with NO further application callbacks.
      return { tokenHash: hash(state.token), id: state.newId, person: state.old.person, at: now, expiresAt: state.old.expires_at };
    },
    committed(operation: HubDirectorySettingsOperation) {
      state.phase = "committed"; state.operationId = operation.id; state.nextEpoch = operation.directoryEpoch;
    },
  };
}

/** Only the NEW mounted HubSessions can release to the originating response. No lookup by old cookie/ref exists. */
export function completeHubDirectorySessionRotation(core: HubCore, handle: HubDirectorySessionRotation, operationId: string): { token: string; maxAgeMs: number } {
  const state = rotations.get(handle);
  if (!state || state.phase !== "committed" || !state.token || state.operationId !== operationId
    || state.hubId !== core.deps.config.hubId || state.nextEpoch !== core.directoryEpoch
    || personKeyString(state.actor.person) !== personKeyString(core.deps.config.administrator)) throw new HubProtocolError("revoked");
  const out = core.atomic(db => {
    const now = core.now(), head = db.prepare("SELECT operation_id,directory_epoch FROM hub_settings_head WHERE singleton=1").get() as { operation_id: string; directory_epoch: number } | undefined;
    const r = row(db, state.newId);
    const saved = db.prepare("SELECT body FROM hub_settings_operations WHERE id=?").get(operationId) as {body:string} | undefined;
    let transition: unknown;
    try { transition = saved && JSON.parse(saved.body).browserSession; } catch { throw new HubProtocolError("uncertain"); }
    const binding = z.strictObject({v:z.literal(1),previousSessionId:identifier,sessionId:identifier}).safeParse(transition);
    if (!binding.success || binding.data.previousSessionId !== state.actor.sessionId || binding.data.sessionId !== state.newId) throw new HubProtocolError("revoked");
    if (!head || head.operation_id !== operationId || head.directory_epoch !== state.nextEpoch
      || !Number.isSafeInteger(now) || now < state.createdAt || now >= state.expiresAt
      || !current(r, state.old.person, state.nextEpoch!, now) || r.token_hash !== hash(state.token!)) throw new HubProtocolError("revoked");
    return { token: state.token!, maxAgeMs: r.expires_at - now };
  });
  state.token = null; state.phase = "released"; return out;
}
