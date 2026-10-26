/**
 * Which conversation a classic (v1) or TUI (v2) kiro instance owns, and so resumes (#906/#1410,
 * docs/design/kiro-per-instance-agent.md §2).
 *
 * Plain `--resume` takes the working directory's newest conversation and brings back the agent it was saved under
 * (probe, E9), so two instances in one directory could each come back as the other. Each instance resumes by
 * `--resume-id` the conversation it owns. The model is kiro-v3-identity.ts's, per engine store:
 *
 *   claims/<engine>/<id>   created exclusively ("wx"): the owner's name and a newline, written last. Only the owner
 *                          rewrites or removes it. Giving the conversation up marks it (`<owner>\nabandoned\n`), so
 *                          nobody — the owner included, even after losing its state — takes it up again.
 *   instances/<hash>.json  the instance's records, one per key (engine, directory, credential profile): the
 *                          conversation it owns, or a fresh-start mark (`id: null`, when, and which conversations
 *                          existed), the ids it gave up, and whether its conversation was switched to its agent.
 *                          Named by a hash of the instance name, so any instance name AgEnD allows (CJK included)
 *                          has one; the name itself is inside.
 *
 *  - Adoption (no state file at all, and either the engine ledger shows this instance launched here before #906,
 *    or the pre-ledger upgrade fallback proves this is the only configured kiro instance in the directory): the
 *    newest conversation for the directory is claimed and recorded before the launch. An unreadable store then is
 *    legacy mode — the old command, not isolated, nothing recorded — and the next launch tries again. A claim this
 *    instance completed whose record could not be written is taken up again on the retry, never given up.
 *  - A recorded conversation is resumed by id while its claim is held (and not abandoned), without reading the store.
 *  - A fresh start never resumes. The conversation its launch made is taken up on a later launch only on evidence it
 *    is new — CREATED after the mark (an update proves nothing), absent from the mark's list, not given up, unclaimed
 *    or claimed by this very take-up, the only one — and with no sibling waiting on the same store and directory.
 *    An unreadable store defers that.
 *  - A key with no record in an existing state file starts durably fresh (as V3 does on a changed key); the other
 *    keys' records are kept. An unreadable or malformed state file is never "no state": this key starts fresh.
 *  - A fresh start that cannot be recorded refuses the launch: the next one would otherwise resume what it gave up.
 *
 * Directories are compared by one canonical identity (symlinks resolved), the same one the store selectors key on.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeFileAtomic } from "./kiro-engine-ledger.js";
import { sharedKiroV2StoreLane } from "./kiro-v2-store.js";

export type KiroClassicEngine = "v1" | "v2";
/** v3 has its own identity (kiro-v3-identity.ts); its records here only say whether it runs as the agent. */
type RecordEngine = KiroClassicEngine | "v3";

/** Conversation ids become file names: only plain ones. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
/** An owner name is one line. */
const OWNER_NAME = /^[^\n\r\0]{1,512}$/;

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
interface StateFile { version: 2; instance: string; keys: Record<string, KeyRecord>; }

export interface KiroStoreSession { id: string; updatedAt: number; }
export type KiroStoreRead =
  | {
    kind: "ok";
    sessions: KiroStoreSession[];
    /**
     * When `id` was created (epoch ms); null when the store has no such time for it; "unreadable" when the store could
     * not be asked (a lock, an I/O error) — which defers a take-up rather than ruling the conversation out.
     * Asked only of take-up candidates.
     */
    createdAt(id: string): number | null | "unreadable";
  }
  | { kind: "unreadable"; detail: string };

/** The directory as kiro may have keyed it: as configured, resolved, and with symlinks resolved. */
export function kiroDirectoryKeys(workingDirectory: string): string[] {
  const keys = new Set([workingDirectory, resolve(workingDirectory)]);
  try { keys.add(realpathSync(workingDirectory)); } catch { /* the literal forms */ }
  return [...keys];
}

/** One identity per directory: symlinks resolved, else the absolute path. */
export function kiroCanonicalDirectory(workingDirectory: string): string {
  try { return realpathSync(workingDirectory); } catch { return resolve(workingDirectory); }
}

const EMPTY_STORE: KiroStoreRead = { kind: "ok", sessions: [], createdAt: () => null };

/** The metadata index the v1 selector must use: `updated_at` comes from it, never from the row (#1048, #1416). */
const V1_INDEX = "idx_conversations_v2_key_updated";

/**
 * v1: `conversations_v2` in the store the instance launches with, read-only, through the (key, updated_at) index —
 * forced with INDEXED BY, so a missing index is an error (unreadable), never a silent scan of the table. The row
 * itself is touched only for `conversation_id`, which precedes `value`. `created_at` follows `value`, so it is read
 * only for the few take-up candidates. A missing database is an empty store.
 */
export function listKiroV1Sessions(workingDirectory: string, dbPath: string): KiroStoreRead {
  try { statSync(dbPath); } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? EMPTY_STORE
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
    const rows = db.prepare(`SELECT conversation_id AS id, updated_at AS at FROM conversations_v2 INDEXED BY ${V1_INDEX} WHERE key IN (?, ?, ?)`)
      .all(a, b, c) as Array<{ id: unknown; at: unknown }>;
    const sessions = rows.filter(r => typeof r.id === "string").map(r => ({ id: r.id as string, updatedAt: Number(r.at) || 0 }));
    return {
      kind: "ok",
      sessions,
      createdAt: (id: string) => {
        let reader: Database.Database | null = null;
        try {
          reader = new Database(dbPath, { readonly: true, fileMustExist: true });
          const row = reader.prepare("SELECT created_at AS at FROM conversations_v2 WHERE key IN (?, ?, ?) AND conversation_id = ? LIMIT 1")
            .get(a, b, c, id) as { at: unknown } | undefined;
          const at = Number(row?.at);
          return Number.isFinite(at) && at > 0 ? at : null;
        } catch { return "unreadable" as const; } finally { try { reader?.close(); } catch { /* closed */ } }
      },
    };
  } catch (err) {
    return { kind: "unreadable", detail: `cannot read ${dbPath}: ${(err as Error).message}` };
  } finally {
    try { db.close(); } catch { /* closed */ }
  }
}

/** Full v2 files are read/parsed in a bounded worker, never on the fleet loop. */
export async function listKiroV2Sessions(workingDirectory: string, sessionsDir: string): Promise<KiroStoreRead> {
  const result = await sharedKiroV2StoreLane.read({ keys: kiroDirectoryKeys(workingDirectory), sessionsDir });
  if (result.kind === "unreadable") return result;
  const created = new Map(result.sessions.map(s => [s.id, s.createdAt]));
  return { kind: "ok", sessions: result.sessions.map(({ id, updatedAt }) => ({ id, updatedAt })),
    createdAt: (id: string) => created.get(id) ?? null };
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
  | { mode: "fresh"; notice?: "shared-directory" | "claimed-conversation" | "unknown-peers" };

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
  /** Only for an absent launch record, on a capable binary. Consults the current
   * complete configured roster at the synchronous adoption boundary, not a
   * snapshot taken before v2 discovery. null means no upgrade fallback.
   */
  upgradeAdoption?: () => "eligible" | "shared-directory" | "unknown-peers" | null;
  now?: () => number;
}

const keyOf = (engine: RecordEngine, cwd: string, profile: string | null): string =>
  JSON.stringify([engine, kiroCanonicalDirectory(cwd), profile ?? null]);

function isRecord(v: unknown): v is KeyRecord {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (r.engine === "v1" || r.engine === "v2" || r.engine === "v3") && typeof r.workingDirectory === "string"
    && (r.credentialProfile === null || typeof r.credentialProfile === "string")
    && (r.id === null || (typeof r.id === "string" && SAFE_ID.test(r.id)))
    && typeof r.since === "number" && Number.isFinite(new Date(r.since).getTime())
    && Array.isArray(r.known) && r.known.every(k => typeof k === "string")
    && Array.isArray(r.abandoned) && r.abandoned.every(k => typeof k === "string")
    && typeof r.agentConfirmed === "boolean";
}

type StateRead = { kind: "none" } | { kind: "bad" } | { kind: "ok"; state: StateFile };

function readState(path: string, instance?: string): StateRead {
  let text: string;
  try { text = readFileSync(path, "utf-8"); } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "none" } : { kind: "bad" };
  }
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (v?.version !== 2 || typeof v.instance !== "string" || (instance !== undefined && v.instance !== instance)) return { kind: "bad" };
    if (!v.keys || typeof v.keys !== "object" || Array.isArray(v.keys)) return { kind: "bad" };
    const keys: Record<string, KeyRecord> = {};
    for (const [k, r] of Object.entries(v.keys as Record<string, unknown>)) { if (!isRecord(r)) return { kind: "bad" }; keys[k] = r; }
    return { kind: "ok", state: { version: 2, instance: v.instance, keys } };
  } catch { return { kind: "bad" }; }
}

const fileNameOf = (instance: string): string => `${createHash("sha256").update(instance).digest("hex").slice(0, 32)}.json`;
const pendingNameOf = (instance: string): string => fileNameOf(instance).replace(/\.json$/, ".adopting.json");

function paths(agendHome: string, engine: RecordEngine, instance: string) {
  const root = join(agendHome, "kiro-identity");
  return {
    root, claims: join(root, "claims", engine), instances: join(root, "instances"), state: join(root, "instances", fileNameOf(instance)),
    /** The adoption under way: the exact conversation chosen, recorded before it is claimed. */
    pending: join(root, "instances", pendingNameOf(instance)),
  };
}

/** The adoptions under way, key → chosen id; "unreadable" when the file exists but cannot be read (never "none"). */
function readPending(path: string): Record<string, string> | "unreadable" {
  let text: string;
  try { text = readFileSync(path, "utf-8"); } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? {} : "unreadable";
  }
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (!v || typeof v !== "object" || Array.isArray(v)) return "unreadable";
    const out: Record<string, string> = {};
    for (const [k, id] of Object.entries(v)) { if (typeof id !== "string" || !SAFE_ID.test(id)) return "unreadable"; out[k] = id; }
    return out;
  } catch { return "unreadable"; }
}

/** Record or settle one key's adoption, keeping the others'. Throws when it cannot be written. */
function writePending(path: string, map: Record<string, string>): void {
  if (Object.keys(map).length === 0) { rmSync(path, { force: true }); return; }
  writeFileAtomic(path, JSON.stringify(map) + "\n");
}

type Claim = { owner: string; abandoned: boolean } | null | "incomplete";

/** null: unclaimed. "incomplete": being written or cut short — someone's, and not usable. */
function claimOf(claims: string, id: string): Claim {
  let text: string;
  try { text = readFileSync(join(claims, id), "utf8"); } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : "incomplete";
  }
  if (!text.endsWith("\n")) return "incomplete";
  const [owner, mark, ...rest] = text.slice(0, -1).split("\n");
  if (!owner || rest.length > 0 || (mark !== undefined && mark !== "abandoned")) return "incomplete";
  return { owner, abandoned: mark === "abandoned" };
}
const heldBy = (claim: Claim, instance: string): boolean => !!claim && claim !== "incomplete" && claim.owner === instance && !claim.abandoned;

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

/** Mark a conversation this instance holds as given up. Its claim stays: nobody takes it up again. */
function abandonClaim(claims: string, id: string, instance: string): void {
  if (!SAFE_ID.test(id) || !heldBy(claimOf(claims, id), instance)) return;
  try { writeFileAtomic(join(claims, id), `${instance}\nabandoned\n`); } catch { /* the state's abandoned list still holds it */ }
}

/** Whether launch preparation needs a store snapshot. Only reads the small
 * identity/claim files; never claims or writes. The final resolver rereads this
 * state synchronously AFTER preparation/admission, so an async result cannot
 * overwrite a newer identity. Pending unclaimed adoption is conservative:
 * claiming may fail, in which case a fresh baseline will need the store.
 */
export function kiroIdentityNeedsStore(opts: Omit<ResolveKiroIdentityOptions, "readStore" | "launchedBefore">): boolean {
  if (!OWNER_NAME.test(opts.instance)) return false;
  const p = paths(opts.agendHome, opts.engine, opts.instance);
  const read = readState(p.state, opts.instance);
  const key = keyOf(opts.engine, opts.workingDirectory, opts.credentialProfile);
  const record = read.kind === "ok" ? read.state.keys[key] : undefined;
  const pending = readPending(p.pending);
  if (pending === "unreadable") return false; // the resolver refuses this launch
  const pendingId = Object.hasOwn(pending, key) ? pending[key]! : null;
  if (pendingId && !record) {
    if (opts.skipResume || read.kind === "bad") return true;
    return !heldBy(claimOf(p.claims, pendingId), opts.instance);
  }
  if (read.kind === "none" || read.kind === "bad" || !record || opts.skipResume) return true;
  return record.id === null || !heldBy(claimOf(p.claims, record.id), opts.instance);
}

/**
 * #2648: the conversation this instance's record — else its pending adoption — names for this key, read-only (the
 * small identity files only). What launch preparation reads ahead for; the resolver still decides the launch itself.
 */
export function kiroRecordedConversation(opts: { agendHome: string; instance: string; engine: RecordEngine; workingDirectory: string; credentialProfile: string | null }): string | null {
  if (!OWNER_NAME.test(opts.instance)) return null;
  const p = paths(opts.agendHome, opts.engine, opts.instance);
  const read = readState(p.state, opts.instance);
  const key = keyOf(opts.engine, opts.workingDirectory, opts.credentialProfile);
  const record = read.kind === "ok" ? read.state.keys[key] : undefined;
  if (record?.id) return record.id;
  const pending = readPending(p.pending);
  return pending !== "unreadable" && Object.hasOwn(pending, key) ? pending[key]! : null;
}

/** Read-only forensic pin: a completed record AND its live claim, never a pending adoption or directory guess. */
export function kiroOwnedConversation(opts: { agendHome: string; instance: string; engine: RecordEngine; workingDirectory: string; credentialProfile: string | null }): string | null {
  if (!OWNER_NAME.test(opts.instance)) return null;
  const p = paths(opts.agendHome, opts.engine, opts.instance);
  const read = readState(p.state, opts.instance);
  const record = read.kind === "ok" ? read.state.keys[keyOf(opts.engine, opts.workingDirectory, opts.credentialProfile)] : undefined;
  return record?.id && record.engine === opts.engine && kiroCanonicalDirectory(record.workingDirectory) === kiroCanonicalDirectory(opts.workingDirectory)
    && record.credentialProfile === opts.credentialProfile && !record.abandoned.includes(record.id)
    && heldBy(claimOf(p.claims, record.id), opts.instance) ? record.id : null;
}

export interface KiroCarryCandidate { id: string; repair: boolean; since: number }
/** The original classic owner identifies an incomplete carried migration; never choose a newest session. */
export function kiroCarryCandidate(opts: { agendHome: string; instance: string; workingDirectory: string; credentialProfile: string | null }): KiroCarryCandidate | null {
  const p = paths(opts.agendHome, "v2", opts.instance), read = readState(p.state, opts.instance);
  if (read.kind === "bad") throw new KiroIdentityError("Kiro ownership record is unreadable; migration repair held");
  if (read.kind !== "ok") return null;
  const classic = read.state.keys[keyOf("v1", opts.workingDirectory, opts.credentialProfile)];
  const tui = read.state.keys[keyOf("v2", opts.workingDirectory, opts.credentialProfile)];
  for (const [record, engine] of [[classic, "v1"], [tui, "v2"]] as const) {
    if (record && (record.engine !== engine || kiroCanonicalDirectory(record.workingDirectory) !== kiroCanonicalDirectory(opts.workingDirectory)
      || record.credentialProfile !== opts.credentialProfile)) throw new KiroIdentityError("Carry ownership record does not match its engine, directory or profile");
  }
  if (!classic?.id || !tui || (!tui.abandoned.includes(classic.id) && tui.id !== classic.id)) return null;
  if (tui.id && tui.id !== classic.id) return null; // an already-owned deliberate replacement is never overwritten
  if (!heldBy(claimOf(paths(opts.agendHome, "v1", opts.instance).claims, classic.id), opts.instance)) throw new KiroIdentityError("Original classic ownership is not proven; migration repair held");
  if (tui.id === classic.id && heldBy(claimOf(p.claims, classic.id), opts.instance)) return { id: classic.id, repair: false, since: tui.since };
  const claim = claimOf(p.claims, classic.id);
  if (tui.id !== null || !tui.abandoned.includes(classic.id) || !claim || claim === "incomplete" || claim.owner !== opts.instance) {
    throw new KiroIdentityError("The carried V2 pin cannot be recovered without replacing another owner/session");
  }
  return { id: classic.id, repair: true, since: tui.since };
}
/** Only after external stopped-process and complete-owned-carry proofs. A failed state write leaves the old owner reserved. */
export function reinstateKiroCarryPin(opts: { agendHome: string; instance: string; workingDirectory: string; credentialProfile: string | null }, id: string): void {
  const candidate = kiroCarryCandidate(opts);
  if (!candidate || candidate.id !== id) throw new KiroIdentityError("Carried session ownership changed before re-pin");
  if (!candidate.repair) return;
  const p = paths(opts.agendHome, "v2", opts.instance), read = readState(p.state, opts.instance);
  if (read.kind !== "ok") throw new KiroIdentityError("Carried ownership record changed");
  const key = keyOf("v2", opts.workingDirectory, opts.credentialProfile), previous = read.state.keys[key]!;
  writeFileAtomic(join(p.claims, id), opts.instance + "\n");
  writeFileAtomic(p.state, JSON.stringify({ ...read.state, keys: { ...read.state.keys, [key]: { ...previous, id,
    abandoned: previous.abandoned.filter(old => old !== id), agentConfirmed: false } } }) + "\n");
}

export function resolveKiroIdentity(opts: ResolveKiroIdentityOptions): KiroIdentityDecision {
  const { instance, engine, workingDirectory, credentialProfile } = opts;
  if (!OWNER_NAME.test(instance)) return { mode: "legacy", reason: "the instance name cannot be recorded" };
  const now = opts.now ?? Date.now;
  const p = paths(opts.agendHome, engine, instance);
  const key = keyOf(engine, workingDirectory, credentialProfile);
  const read = readState(p.state, instance);
  const keys: Record<string, KeyRecord> = read.kind === "ok" ? { ...read.state.keys } : {};
  const record = keys[key];

  const save = (next: KeyRecord): boolean => {
    try {
      mkdirSync(p.instances, { recursive: true, mode: 0o700 });
      writeFileAtomic(p.state, JSON.stringify({ version: 2, instance, keys: { ...keys, [key]: next } } satisfies StateFile) + "\n");
      return true;
    } catch { return false; }
  };
  /** Recorded first: until it is, the old record still says which conversation this instance holds. */
  /** `alsoGivingUp`: a conversation held outside the record (a pending adoption's) given up with this fresh start. */
  const startFresh = (store?: KiroStoreRead, alsoGivingUp?: string): Extract<KiroIdentityDecision, { mode: "fresh" }> => {
    const listed = store ?? opts.readStore();
    const abandoned = new Set(record?.abandoned ?? []);
    if (record?.id) abandoned.add(record.id);
    if (alsoGivingUp) abandoned.add(alsoGivingUp);
    const next: KeyRecord = {
      engine, workingDirectory, credentialProfile, id: null, since: now(),
      known: listed.kind === "ok" ? listed.sessions.map(s => s.id) : [],
      abandoned: [...abandoned], agentConfirmed: true,
    };
    if (!save(next)) throw new KiroIdentityError(`cannot write ${p.state}`);
    // Its claim is marked, not released: given up for good, by everyone.
    if (record?.id) abandonClaim(p.claims, record.id, instance);
    if (alsoGivingUp) abandonClaim(p.claims, alsoGivingUp, instance);
    return { mode: "fresh" };
  };

  // An adoption under way for THIS key (recorded before its claim; see below) is settled before anything else —
  // whether there is no state file yet or other keys have been written since. It is never forgotten or bypassed:
  //  - an explicit fresh start gives its conversation up for good (claim marked, id listed abandoned);
  //  - an unreadable or malformed state file gives it up too (nothing can be recorded about it);
  //  - otherwise it is taken up exactly — held or still claimable — or, someone else's by now, the key starts fresh.
  const pendingMap = readPending(p.pending);
  if (pendingMap === "unreadable") throw new KiroIdentityError(`cannot read ${p.pending}`);
  const pendingId = Object.hasOwn(pendingMap, key) ? pendingMap[key]! : null;
  /** Settled: this key's entry goes, the other keys' adoptions stay. */
  const settlePending = () => {
    const rest = { ...pendingMap };
    delete rest[key];
    try { writePending(p.pending, rest); } catch { /* the entry stays; recovering it again is idempotent */ }
  };
  if (pendingId && !record) {
    if (opts.skipResume || read.kind === "bad") {
      const fresh = startFresh(undefined, pendingId);
      settlePending();
      return fresh;
    }
    const c = claimOf(p.claims, pendingId);
    if (heldBy(c, instance) || (c === null && claim(p.claims, pendingId, instance))) {
      if (!save({ engine, workingDirectory, credentialProfile, id: pendingId, since: now(), known: [], abandoned: [], agentConfirmed: false })) {
        throw new KiroIdentityError(`cannot write ${p.state}`);
      }
      settlePending();
      return { mode: "resume", id: pendingId, agentConfirmed: false };
    }
    const fresh = startFresh();
    settlePending();
    return fresh;
  }

  // Adoption: only with no state file at all, with old launch evidence or the
  // one-time unshared-directory upgrade fallback (#1624). A durably fresh mark
  // always takes the evidence-only path below. The chosen
  // conversation is recorded (pending) before it is claimed, so a retry after any failure takes up that exact
  // conversation — never whichever is newest by then.
  if (read.kind === "none") {
    if (opts.skipResume) return startFresh();
    const previousLaunch = opts.launchedBefore();
    const upgrade = previousLaunch ? null : opts.upgradeAdoption?.() ?? null;
    if (!previousLaunch && upgrade !== "eligible") {
      const fresh = startFresh();
      return upgrade ? { ...fresh, notice: upgrade } : fresh;
    }
    const store = opts.readStore();
    if (store.kind === "unreadable") return { mode: "legacy", reason: store.detail };
    const newest = store.sessions.filter(s => SAFE_ID.test(s.id)).sort((x, y) => y.updatedAt - x.updatedAt)[0];
    if (!newest) return startFresh(store);
    if (claimOf(p.claims, newest.id) !== null) {
      const fresh = startFresh(store);
      return upgrade === "eligible" ? { ...fresh, notice: "claimed-conversation" } : fresh;
    }
    try {
      mkdirSync(p.instances, { recursive: true, mode: 0o700 });
      writePending(p.pending, { ...pendingMap, [key]: newest.id });
    } catch { throw new KiroIdentityError(`cannot write ${p.pending}`); }
    if (!claim(p.claims, newest.id, instance)) {
      settlePending();
      const fresh = startFresh(store);
      return upgrade === "eligible" ? { ...fresh, notice: "claimed-conversation" } : fresh;
    }
    if (!save({ engine, workingDirectory, credentialProfile, id: newest.id, since: now(), known: [], abandoned: [], agentConfirmed: false })) {
      throw new KiroIdentityError(`cannot write ${p.state}`); // the pending entry and the claim stand: the retry takes this id
    }
    settlePending();
    return { mode: "resume", id: newest.id, agentConfirmed: false };
  }

  // An unreadable or malformed state file is not "no state": this key starts fresh (never a selection).
  if (read.kind === "bad" || !record || opts.skipResume) return startFresh();

  if (record.id) {
    // Resumed only while the claim is really held: a state alone never re-creates one. No store read.
    return heldBy(claimOf(p.claims, record.id), instance)
      ? { mode: "resume", id: record.id, agentConfirmed: record.agentConfirmed }
      : startFresh();
  }

  // A fresh start is on record: take up the conversation that launch made, if — and only if — that is certain.
  const store = opts.readStore();
  if (store.kind === "unreadable") return { mode: "fresh" }; // deferred, never guessed; the mark stays as it is
  const excluded = new Set([...record.known, ...record.abandoned]);
  let creationUnreadable = false;
  const candidates = store.sessions.filter(s => {
    if (!SAFE_ID.test(s.id) || excluded.has(s.id) || s.updatedAt <= record.since) return false;
    const c = claimOf(p.claims, s.id);
    if (!(c === null || heldBy(c, instance))) return false;
    // New, not merely updated: created after the mark.
    const created = store.createdAt(s.id);
    if (created === "unreadable") { creationUnreadable = true; return false; }
    return created !== null && created > record.since;
  });
  // A creation time that could not be read is like an unreadable store: deferred, and the mark kept as it is — a new
  // mark would list this very conversation as already existing and lose it for good.
  if (creationUnreadable) return { mode: "fresh" };
  const canonical = kiroCanonicalDirectory(workingDirectory);
  const siblingWaiting = (() => {
    let names: string[];
    try { names = readdirSync(p.instances); } catch { return true; }
    return names.some(n => {
      if (n === fileNameOf(instance) || !n.endsWith(".json") || n.endsWith(".adopting.json")) return false;
      const other = readState(join(p.instances, n));
      if (other.kind !== "ok") return true; // not certain, so it counts
      // Waiting on the same store and directory: v1 stores are per credential profile, the v2 store is shared.
      return Object.values(other.state.keys).some(r => r.engine === engine && r.id === null
        && kiroCanonicalDirectory(r.workingDirectory) === canonical
        && (engine === "v2" || r.credentialProfile === credentialProfile));
    });
  })();
  if (candidates.length !== 1 || siblingWaiting) return startFresh(store);
  const pick = candidates[0]!.id;
  if (!heldBy(claimOf(p.claims, pick), instance) && !claim(p.claims, pick, instance)) return startFresh(store);
  // A fresh launch carried --agent, so the conversation it made already runs as the instance's agent.
  save({ ...record, id: pick, agentConfirmed: true });
  return { mode: "resume", id: pick, agentConfirmed: true };
}

/** Whether `id` is recorded as already running as the instance's agent. */
export function kiroAgentConfirmed(agendHome: string, instance: string, engine: RecordEngine, workingDirectory: string, credentialProfile: string | null, id: string): boolean {
  if (!OWNER_NAME.test(instance)) return false;
  const read = readState(paths(agendHome, engine, instance).state, instance);
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
  if (!OWNER_NAME.test(instance)) return false;
  const p = paths(agendHome, engine, instance);
  const read = readState(p.state, instance);
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
    writeFileAtomic(p.state, JSON.stringify({ version: 2, instance, keys: { ...keys, [key]: next } } satisfies StateFile) + "\n");
    return true;
  } catch { return false; }
}

/** Delete or replace: drop the instance's records and every claim it holds (active or given up). Conversations stay. */
export function forgetKiroIdentity(agendHome: string, instance: string): void {
  if (!OWNER_NAME.test(instance)) return;
  for (const engine of ["v1", "v2"] as const) {
    const p = paths(agendHome, engine, instance);
    let ids: string[] = [];
    try { ids = readdirSync(p.claims); } catch { /* none */ }
    for (const id of ids) {
      const c = claimOf(p.claims, id);
      if (c && c !== "incomplete" && c.owner === instance) rmSync(join(p.claims, id), { force: true });
    }
  }
  rmSync(paths(agendHome, "v1", instance).state, { force: true });
  rmSync(paths(agendHome, "v1", instance).pending, { force: true });
}

/**
 * #2598 B3: the newest engine this instance has a conversation record on — v2 once it ran under the TUI, v3 under V3
 * — or null (never past classic). Moving to a newer engine forks the conversation and freezes the old engine's copy, so
 * a launch on an older engine than this would resume the stale copy and lose everything done since. A pending
 * migration does not count: until the newer engine's launch records it, nothing has happened there.
 */
export function kiroEngineFloor(agendHome: string, instance: string): "v2" | "v3" | null {
  if (!OWNER_NAME.test(instance)) return null;
  const read = readState(paths(agendHome, "v1", instance).state, instance);
  if (read.kind !== "ok") return null;
  const engines = new Set(Object.values(read.state.keys).map(r => r.engine));
  return engines.has("v3") ? "v3" : engines.has("v2") ? "v2" : null;
}

export type KiroTuiMigration =
  | { kind: "ready"; classicId: string | null }
  | { kind: "refused"; reason: "already-tui" | "no-classic-conversation" | "unreadable" | "name" };

/**
 * #2598 B2: what moving this instance from classic (v1) to the TUI (v2) would carry, read-only. Its classic
 * conversation is the one its v1 record holds (claim still held); null when it has none (a fresh or legacy-mode
 * instance). Refused once it has any TUI record or a TUI adoption under way.
 */
export function inspectKiroTuiMigration(opts: { agendHome: string; instance: string; workingDirectory: string; credentialProfile: string | null }): KiroTuiMigration {
  const { agendHome, instance, workingDirectory, credentialProfile } = opts;
  if (!OWNER_NAME.test(instance)) return { kind: "refused", reason: "name" };
  const p1 = paths(agendHome, "v1", instance);
  const read = readState(p1.state, instance);
  if (read.kind === "bad") return { kind: "refused", reason: "unreadable" };
  const pending = readPending(p1.pending);
  if (pending === "unreadable") return { kind: "refused", reason: "unreadable" };
  const v2Key = keyOf("v2", workingDirectory, credentialProfile);
  const keys = read.kind === "ok" ? read.state.keys : {};
  if (Object.values(keys).some(r => r.engine === "v2" || r.engine === "v3") || Object.hasOwn(pending, v2Key)) {
    return { kind: "refused", reason: "already-tui" };
  }
  const v1 = keys[keyOf("v1", workingDirectory, credentialProfile)];
  const classicId = v1?.id && heldBy(claimOf(p1.claims, v1.id), instance) ? v1.id : null;
  return { kind: "ready", classicId };
}

/**
 * #2598 B2: arm the move. The classic conversation is recorded as this instance's TUI adoption under way, so the
 * next TUI launch resolves to exactly it (resolveKiroIdentity's pending path: claimed, recorded, resumed by id once —
 * kiro copies the classic history into its session files). Nothing else is written; the classic record and claim
 * stay as they are. With no classic conversation nothing is armed, and the TUI launch starts fresh.
 * Throws when the adoption cannot be written. Returns what was armed.
 */
export function armKiroTuiMigration(opts: { agendHome: string; instance: string; workingDirectory: string; credentialProfile: string | null }): KiroTuiMigration {
  const inspected = inspectKiroTuiMigration(opts);
  if (inspected.kind !== "ready" || !inspected.classicId) return inspected;
  const p = paths(opts.agendHome, "v2", opts.instance);
  const pending = readPending(p.pending);
  if (pending === "unreadable") return { kind: "refused", reason: "unreadable" };
  mkdirSync(p.instances, { recursive: true, mode: 0o700 });
  writePending(p.pending, { ...pending, [keyOf("v2", opts.workingDirectory, opts.credentialProfile)]: inspected.classicId });
  return inspected;
}

/** Undo armKiroTuiMigration before any TUI launch took it up (a config save that failed after arming). */
export function disarmKiroTuiMigration(opts: { agendHome: string; instance: string; workingDirectory: string; credentialProfile: string | null }): void {
  if (!OWNER_NAME.test(opts.instance)) return;
  const p = paths(opts.agendHome, "v2", opts.instance);
  const pending = readPending(p.pending);
  if (pending === "unreadable") return;
  const rest = { ...pending };
  delete rest[keyOf("v2", opts.workingDirectory, opts.credentialProfile)];
  try { writePending(p.pending, rest); } catch { /* left armed: the next TUI launch takes it up, as intended anyway */ }
}
