/**
 * Which conversation a classic (v1) or TUI (v2) kiro instance owns, and so resumes (#906/#1410,
 * docs/design/kiro-per-instance-agent.md §2).
 *
 * Plain `--resume` takes the working directory's newest conversation and brings back the agent it was saved under
 * (probe, E9), so two instances in one directory could each come back as the other. Each instance resumes by
 * `--resume-id` the conversation it owns. The model is kiro-v3-identity.ts's, per engine store:
 *
 *   claims/<engine>/<id>   created exclusively ("wx") holding the owner's name and a newline, written last; only the
 *                          owner removes it, and it is kept for a conversation the owner gave up, so nobody takes
 *                          that one up again.
 *   instances/<name>.json  one record per key — engine, working directory, credential profile: the conversation the
 *                          instance owns, or a fresh-start mark (`id: null`, when, and which conversations existed),
 *                          the ids it gave up, and whether the conversation was switched to the instance's agent.
 *
 *  - Adoption (no state file at all, and the engine ledger shows this instance launched here before #906): the
 *    newest conversation for the directory is claimed and recorded before the launch. An unreadable store then is
 *    legacy mode — the old command, not isolated, nothing recorded — and the next launch tries again.
 *  - A recorded conversation is resumed by id while its claim is held, without reading the store.
 *  - A fresh start never resumes; the conversation its launch made is taken up on a later launch only on evidence
 *    (absent from the mark's list, updated after it, unclaimed, the only one, no sibling waiting). An unreadable
 *    store defers that.
 *  - A key with no record in an existing state file starts durably fresh (as V3 does on a changed key); the other
 *    keys' records are kept, so going back finds them as they were.
 *  - A fresh start that cannot be recorded refuses the launch: the next one would otherwise resume what it gave up.
 */
import Database from "better-sqlite3";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "./kiro-engine-ledger.js";

export type KiroClassicEngine = "v1" | "v2";

/** Ids and instance names become file names: only plain ones. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
/** Never a valid instance name (it fails SAFE_NAME), so never mistaken for one. */
const INCOMPLETE = "\0incomplete";

/** v3 has its own identity (kiro-v3-identity.ts); its records here only say whether it runs as the agent. */
type RecordEngine = KiroClassicEngine | "v3";

interface KeyRecord {
  engine: RecordEngine;
  workingDirectory: string;
  credentialProfile: string | null;
  id: string | null;
  /** Fresh-start mark (epoch ms) and the conversations that existed then; meaningful while id is null. */
  since: number;
  known: string[];
  abandoned: string[];
  agentConfirmed: boolean;
}
interface StateFile { version: 1; keys: Record<string, KeyRecord>; }

export interface KiroStoreSession { id: string; updatedAt: number; }
export type KiroStoreRead = { kind: "ok"; sessions: KiroStoreSession[] } | { kind: "unreadable"; detail: string };

/** The directory as kiro may have keyed it: as configured, resolved, and with symlinks resolved. */
export function kiroDirectoryKeys(workingDirectory: string): string[] {
  const keys = new Set([workingDirectory, resolve(workingDirectory)]);
  try { keys.add(realpathSync(workingDirectory)); } catch { /* the literal forms */ }
  return [...keys];
}

/**
 * v1: `conversations_v2` in the store the instance launches with, read-only. Only the (key, updated_at) index and
 * `conversation_id`, which comes before `value` in the row, are read — never a conversation itself (#1048).
 * A missing database is an empty store (kiro has written nothing yet); any other failure is unreadable.
 */
export function listKiroV1Sessions(workingDirectory: string, dbPath: string): KiroStoreRead {
  try { statSync(dbPath); } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "ok", sessions: [] }
      : { kind: "unreadable", detail: `cannot stat ${dbPath}: ${(err as Error).message}` };
  }
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return { kind: "unreadable", detail: `cannot open ${dbPath}: ${(err as Error).message}` };
  }
  try {
    const keys = kiroDirectoryKeys(workingDirectory);
    const [a, b = a, c = b] = keys;
    const rows = db.prepare("SELECT conversation_id AS id, updated_at AS at FROM conversations_v2 WHERE key IN (?, ?, ?)")
      .all(a, b, c) as Array<{ id: unknown; at: unknown }>;
    return { kind: "ok", sessions: rows.filter(r => typeof r.id === "string").map(r => ({ id: r.id as string, updatedAt: Number(r.at) || 0 })) };
  } catch (err) {
    return { kind: "unreadable", detail: `cannot read ${dbPath}: ${(err as Error).message}` };
  } finally {
    try { db.close(); } catch { /* closed */ }
  }
}

/**
 * v2: the TUI's session files, `<sessionsDir>/<id>.json`, whose `cwd` is this directory and which are not a turn's
 * subagent. A missing directory is an empty store; an unreadable directory is unreadable. A file that cannot be
 * parsed (being written) is skipped: it is not a conversation anyone could be handed.
 */
export function listKiroV2Sessions(workingDirectory: string, sessionsDir: string): KiroStoreRead {
  let names: string[];
  try { names = readdirSync(sessionsDir); } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "ok", sessions: [] }
      : { kind: "unreadable", detail: `cannot list ${sessionsDir}: ${(err as Error).message}` };
  }
  const keys = new Set(kiroDirectoryKeys(workingDirectory));
  const sessions: KiroStoreSession[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const meta = JSON.parse(readFileSync(join(sessionsDir, name), "utf-8")) as Record<string, unknown>;
      if (typeof meta.cwd !== "string" || !keys.has(meta.cwd) || meta.session_created_reason === "subagent") continue;
      const id = typeof meta.session_id === "string" ? meta.session_id : name.slice(0, -".json".length);
      sessions.push({ id, updatedAt: Date.parse(String(meta.updated_at ?? "")) || 0 });
    } catch { /* partly written */ }
  }
  return { kind: "ok", sessions };
}

export class KiroIdentityError extends Error {
  constructor(detail: string) {
    super(`AgEnD could not record this kiro instance's conversation (${detail}); not launching, so it never resumes a conversation it gave up or another instance's`);
    this.name = "KiroIdentityError";
  }
}

export type KiroIdentityDecision =
  /** Not isolated: the old command, nothing recorded. */
  | { mode: "legacy"; reason: string }
  | { mode: "resume"; id: string; agentConfirmed: boolean }
  | { mode: "fresh" };

export interface ResolveKiroIdentityOptions {
  instance: string;
  engine: KiroClassicEngine;
  workingDirectory: string;
  credentialProfile: string | null;
  skipResume?: boolean;
  agendHome: string;
  /** The engine's store, read only when needed (adoption, take-up, a fresh mark's list). */
  readStore: () => KiroStoreRead;
  /** Whether this instance launched in this directory, with this profile and engine, before #906. */
  launchedBefore: () => boolean;
  now?: () => number;
}

const keyOf = (engine: RecordEngine, cwd: string, profile: string | null): string =>
  JSON.stringify([engine, resolve(cwd), profile ?? null]);

function isRecord(v: unknown): v is KeyRecord {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (r.engine === "v1" || r.engine === "v2" || r.engine === "v3") && typeof r.workingDirectory === "string"
    && (r.credentialProfile === null || typeof r.credentialProfile === "string")
    && (r.id === null || (typeof r.id === "string" && SAFE_NAME.test(r.id)))
    && typeof r.since === "number" && Number.isFinite(new Date(r.since).getTime())
    && Array.isArray(r.known) && r.known.every(k => typeof k === "string")
    && Array.isArray(r.abandoned) && r.abandoned.every(k => typeof k === "string")
    && typeof r.agentConfirmed === "boolean";
}

type StateRead = { kind: "none" } | { kind: "bad" } | { kind: "ok"; state: StateFile };

function readState(path: string): StateRead {
  let text: string;
  try { text = readFileSync(path, "utf-8"); } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "none" } : { kind: "bad" };
  }
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (v?.version !== 1 || !v.keys || typeof v.keys !== "object" || Array.isArray(v.keys)) return { kind: "bad" };
    const keys: Record<string, KeyRecord> = {};
    for (const [k, r] of Object.entries(v.keys as Record<string, unknown>)) { if (!isRecord(r)) return { kind: "bad" }; keys[k] = r; }
    return { kind: "ok", state: { version: 1, keys } };
  } catch { return { kind: "bad" }; }
}

function paths(agendHome: string, engine: RecordEngine, instance: string) {
  const root = join(agendHome, "kiro-identity");
  return { root, claims: join(root, "claims", engine), instances: join(root, "instances"), state: join(root, "instances", `${instance}.json`) };
}

/** null: unclaimed. INCOMPLETE: being written or cut short — someone's, and not usable. */
function ownerOf(claims: string, id: string): string | null {
  let text: string;
  try { text = readFileSync(join(claims, id), "utf8"); } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : INCOMPLETE;
  }
  return text.endsWith("\n") ? text.slice(0, -1) : INCOMPLETE;
}

/** Claims an unclaimed conversation. True only once the whole owner line is on disk. */
function claim(claims: string, id: string, instance: string): boolean {
  const path = join(claims, id);
  let fd: number;
  try {
    mkdirSync(claims, { recursive: true, mode: 0o700 });
    fd = openSync(path, "wx", 0o600);
  } catch { return false; }
  let complete = false;
  try {
    const line = Buffer.from(`${instance}\n`);
    let offset = 0;
    while (offset < line.length) {
      const n = writeSync(fd, line, offset, line.length - offset);
      if (n <= 0) break;
      offset += n;
    }
    complete = offset === line.length;
  } catch { /* stays incomplete */ } finally {
    closeSync(fd);
  }
  if (!complete) rmSync(path, { force: true });
  return complete;
}

export function resolveKiroIdentity(opts: ResolveKiroIdentityOptions): KiroIdentityDecision {
  const { instance, engine, workingDirectory, credentialProfile } = opts;
  if (!SAFE_NAME.test(instance)) return { mode: "legacy", reason: "the instance name cannot be a file name" };
  const now = opts.now ?? Date.now;
  const p = paths(opts.agendHome, engine, instance);
  const key = keyOf(engine, workingDirectory, credentialProfile);
  const read = readState(p.state);
  const keys: Record<string, KeyRecord> = read.kind === "ok" ? { ...read.state.keys } : {};
  const record = keys[key];

  const save = (next: KeyRecord): boolean => {
    try {
      mkdirSync(p.instances, { recursive: true, mode: 0o700 });
      writeFileAtomic(p.state, JSON.stringify({ version: 1, keys: { ...keys, [key]: next } } satisfies StateFile) + "\n");
      return true;
    } catch { return false; }
  };
  /** Recorded first: until it is, the old record still says which conversation this instance holds. */
  const startFresh = (store?: KiroStoreRead): KiroIdentityDecision => {
    const listed = store ?? opts.readStore();
    const abandoned = new Set(record?.abandoned ?? []);
    if (record?.id) abandoned.add(record.id); // its claim is kept: nobody takes a given-up conversation again
    const next: KeyRecord = {
      engine, workingDirectory, credentialProfile, id: null, since: now(),
      known: listed.kind === "ok" ? listed.sessions.map(s => s.id) : [],
      abandoned: [...abandoned], agentConfirmed: true,
    };
    if (!save(next)) throw new KiroIdentityError(`cannot write ${p.state}`);
    return { mode: "fresh" };
  };

  // Adoption: only with no state file at all, and only for an instance that ran here before (#906 §2).
  if (read.kind === "none") {
    if (opts.skipResume || !opts.launchedBefore()) return startFresh();
    const store = opts.readStore();
    if (store.kind === "unreadable") return { mode: "legacy", reason: store.detail };
    const newest = store.sessions.filter(s => SAFE_NAME.test(s.id)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!newest || ownerOf(p.claims, newest.id) !== null || !claim(p.claims, newest.id, instance)) return startFresh(store);
    if (!save({ engine, workingDirectory, credentialProfile, id: newest.id, since: now(), known: [], abandoned: [], agentConfirmed: false })) {
      // The claim stands (it is ours); the next launch finds no state and adopts it again.
      throw new KiroIdentityError(`cannot write ${p.state}`);
    }
    return { mode: "resume", id: newest.id, agentConfirmed: false };
  }

  // An unreadable or malformed state file is not "no state": this key starts fresh (never a selection).
  if (read.kind === "bad" || !record || opts.skipResume) return startFresh();

  if (record.id) {
    // Resumed only while the claim is really held: a state alone never re-creates one. No store read.
    return ownerOf(p.claims, record.id) === instance
      ? { mode: "resume", id: record.id, agentConfirmed: record.agentConfirmed }
      : startFresh();
  }

  // A fresh start is on record: take up the conversation that launch made, if — and only if — that is certain.
  const store = opts.readStore();
  if (store.kind === "unreadable") return { mode: "fresh" }; // deferred, never guessed; the mark stays as it is
  const excluded = new Set([...record.known, ...record.abandoned]);
  const candidates = store.sessions.filter(s => SAFE_NAME.test(s.id) && !excluded.has(s.id) && s.updatedAt > record.since
    && (ownerOf(p.claims, s.id) ?? instance) === instance);
  const siblingWaiting = (() => {
    let names: string[];
    try { names = readdirSync(p.instances); } catch { return true; }
    return names.some(n => {
      if (n === `${instance}.json` || !n.endsWith(".json")) return false;
      const other = readState(join(p.instances, n));
      if (other.kind !== "ok") return true; // not certain, so it counts
      return Object.values(other.state.keys).some(r => r.engine === engine && resolve(r.workingDirectory) === resolve(workingDirectory) && r.id === null);
    });
  })();
  if (candidates.length !== 1 || siblingWaiting) return startFresh(store);
  const pick = candidates[0]!.id;
  if (ownerOf(p.claims, pick) !== instance && !claim(p.claims, pick, instance)) return startFresh(store);
  // A fresh launch carried --agent, so the conversation it made already runs as the instance's agent.
  save({ ...record, id: pick, agentConfirmed: true });
  return { mode: "resume", id: pick, agentConfirmed: true };
}

/** Whether `id` is recorded as already running as the instance's agent. */
export function kiroAgentConfirmed(agendHome: string, instance: string, engine: RecordEngine, workingDirectory: string, credentialProfile: string | null, id: string): boolean {
  if (!SAFE_NAME.test(instance)) return false;
  const read = readState(paths(agendHome, engine, instance).state);
  if (read.kind !== "ok") return false;
  const record = read.state.keys[keyOf(engine, workingDirectory, credentialProfile)];
  return !!record && record.id === id && record.agentConfirmed;
}

/**
 * Record that `id` now runs as the instance's agent (the switch was confirmed on screen). For v1/v2 the record must
 * already own `id`; a v3 conversation (owned per kiro-v3-identity.ts) gets a record here if it has none. An
 * unreadable state file is never overwritten: false.
 */
export function confirmKiroAgentSwitch(agendHome: string, instance: string, engine: RecordEngine, workingDirectory: string, credentialProfile: string | null, id: string): boolean {
  if (!SAFE_NAME.test(instance)) return false;
  const p = paths(agendHome, engine, instance);
  const read = readState(p.state);
  if (read.kind === "bad") return false;
  const keys = read.kind === "ok" ? read.state.keys : {};
  const key = keyOf(engine, workingDirectory, credentialProfile);
  const record = keys[key];
  let next: KeyRecord;
  if (record && record.id === id) next = { ...record, agentConfirmed: true };
  else if (engine === "v3") next = { engine, workingDirectory, credentialProfile, id, since: Date.now(), known: [], abandoned: [], agentConfirmed: true };
  else return false;
  try {
    mkdirSync(p.instances, { recursive: true, mode: 0o700 });
    writeFileAtomic(p.state, JSON.stringify({ version: 1, keys: { ...keys, [key]: next } } satisfies StateFile) + "\n");
    return true;
  } catch { return false; }
}

/** Delete or replace: drop the instance's records and release every claim it holds. Conversations stay in kiro. */
export function forgetKiroIdentity(agendHome: string, instance: string): void {
  if (!SAFE_NAME.test(instance)) return;
  for (const engine of ["v1", "v2"] as const) {
    const p = paths(agendHome, engine, instance);
    let ids: string[] = [];
    try { ids = readdirSync(p.claims); } catch { /* none */ }
    for (const id of ids) if (ownerOf(p.claims, id) === instance) rmSync(join(p.claims, id), { force: true });
  }
  rmSync(paths(agendHome, "v1", instance).state, { force: true });
}
