/**
 * Which V3 session a V3 kiro instance owns, and so resumes.
 *
 * Kiro's V3 `--resume` takes the newest conversation in the working directory
 * from ANY engine, and converts a classic one into a new V3 copy on every
 * launch (#1141 kiro migration study). A V3 instance therefore resumes by id —
 * and the id must be its own: never a sibling's running conversation, never
 * one it gave up, never a guess. Two stores, both under `<AGEND_HOME>/kiro-v3`:
 *
 *   claims/<session id>   created exclusively ("wx") holding the owner's name
 *                         and a newline, the newline written last: a claim
 *                         without it is still being written (or was cut
 *                         short) and belongs to nobody who can use it.
 *                         Whoever created it owns the session; nobody else
 *                         can take it over, and only the owner removes it.
 *   instances/<name>.json the instance's state, written only by its own
 *                         launch: the session it owns, or a fresh-start mark
 *                         (`id: null`, when, and which sessions already existed).
 *
 * A session is taken up only with evidence that this instance's own fresh
 * launch made it: created (a valid instant) after the mark, absent from the
 * mark's list, owned by nobody, and the only such session — with no other
 * instance in the same directory waiting to take up its own. Anything less
 * certain starts fresh again — and a fresh start is only made once it is
 * on record: one that cannot be recorded refuses the launch, since the next
 * launch would otherwise go back to the session this one gave up. Two V3
 * instances in one working directory
 * cannot tell their sessions apart and each keeps starting fresh: a known
 * limit, chosen over handing one of them the other's conversation.
 */
import { mkdirSync, openSync, closeSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { getAgendHome } from "../paths.js";
import { writeFileAtomic } from "./kiro-engine-ledger.js";
import { kasBucket, listKasSessions } from "./kiro-kas-store.js";

interface V3State {
  bucket: string;
  credentialProfile: string | null;
  id: string | null;
  /** Fresh-start mark (epoch ms) and the sessions that existed then; meaningful while id is null. */
  since: number;
  known: string[];
}

/** Session ids and instance names become file names: only plain ones. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
/** Never a valid instance name (it fails SAFE_NAME), so never mistaken for one. */
const INCOMPLETE = "\0incomplete";

function isState(v: unknown): v is V3State {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const s = v as Record<string, unknown>;
  return typeof s.bucket === "string"
    && (s.credentialProfile === null || typeof s.credentialProfile === "string")
    && (s.id === null || (typeof s.id === "string" && SAFE_NAME.test(s.id)))
    // A real instant: Date accepts only ±8.64e15 ms, and an out-of-range mark is no evidence of anything.
    && typeof s.since === "number" && Number.isFinite(new Date(s.since).getTime())
    && Array.isArray(s.known) && s.known.every(k => typeof k === "string");
}

/** The fresh start could not be recorded: launching anyway would let the next launch resume what this one gave up. */
export class KiroV3IdentityError extends Error {
  constructor(detail: string) {
    super(`AgEnD could not record this V3 instance's fresh start (${detail}); not launching, so the conversation it gave up is not resumed later`);
    this.name = "KiroV3IdentityError";
  }
}

export interface KiroV3ResumeOptions {
  /** Start fresh: give up the session this instance owned. */
  skipResume?: boolean;
  agendHome?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export function resolveKiroV3Resume(instance: string, workingDirectory: string, credentialProfile: string | null, opts: KiroV3ResumeOptions = {}): string | null {
  if (!SAFE_NAME.test(instance)) return null;
  const root = join(opts.agendHome ?? getAgendHome(), "kiro-v3");
  const claims = join(root, "claims");
  const instances = join(root, "instances");
  const statePath = join(instances, `${instance}.json`);
  const bucket = kasBucket(workingDirectory);
  const sessions = listKasSessions(workingDirectory, opts.env).filter(s => SAFE_NAME.test(s.id));

  const readState = (path: string): V3State | null => {
    try { const v = JSON.parse(readFileSync(path, "utf8")) as unknown; return isState(v) ? v : null; } catch { return null; }
  };
  /** null: unclaimed. INCOMPLETE: a claim being written, or cut short — someone's, and not usable. */
  const owner = (id: string): string | null => {
    let text: string;
    try { text = readFileSync(join(claims, id), "utf8"); } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : INCOMPLETE;
    }
    return text.endsWith("\n") ? text.slice(0, -1) : INCOMPLETE;
  };
  /** Claims an unclaimed session. True only once the whole owner line is on disk. */
  const claim = (id: string): boolean => {
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
    } catch { /* the claim stays incomplete */ } finally {
      closeSync(fd);
    }
    // Ours (created exclusively), so ours to take back when it could not be finished.
    if (!complete) rmSync(path, { force: true });
    return complete;
  };
  // Only the owner removes a claim, and no one can create it while it exists, so read-then-remove is safe.
  const release = (id: string) => { if (owner(id) === instance) rmSync(join(claims, id), { force: true }); };
  const writeState = (state: V3State): boolean => {
    try {
      mkdirSync(instances, { recursive: true, mode: 0o700 });
      writeFileAtomic(statePath, JSON.stringify(state) + "\n");
      return true;
    } catch { return false; }
  };

  const state = readState(statePath);
  const startFresh = (): null => {
    // Recorded first: until it is, the old state still says which session this instance holds.
    if (!writeState({ bucket, credentialProfile, id: null, since: (opts.now ?? new Date()).getTime(), known: sessions.map(s => s.id) })) {
      throw new KiroV3IdentityError(`cannot write ${statePath}`);
    }
    try { if (state?.id) release(state.id); } catch { /* the claim stays; it only keeps others off a session nobody resumes */ }
    return null;
  };

  if (opts.skipResume || !state || state.bucket !== bucket || state.credentialProfile !== credentialProfile) return startFresh();
  if (state.id) {
    const id = state.id;
    // Resumed only while the claim is really held: a state alone never re-creates one.
    return sessions.some(s => s.id === id) && owner(id) === instance ? id : startFresh();
  }

  // A fresh start is on record: take up the session that launch made, if — and only if — that is certain.
  const known = new Set(state.known);
  const candidates = sessions.filter(s => !known.has(s.id) && s.createdAt !== null && s.createdAt > state.since
    && (owner(s.id) ?? instance) === instance);
  const siblingWaiting = (() => {
    let names: string[];
    // Siblings that cannot be listed are siblings that cannot be ruled out.
    try { names = readdirSync(instances); } catch { return true; }
    return names.some(n => {
      if (n === `${instance}.json` || !n.endsWith(".json")) return false;
      const other = readState(join(instances, n));
      // An unreadable state in this directory could be a sibling waiting: not certain, so it counts.
      return other === null || (other.bucket === bucket && other.id === null);
    });
  })();
  if (candidates.length !== 1 || siblingWaiting) return startFresh();
  const pick = candidates[0].id;
  // Already ours when an earlier launch claimed it but could not record that in its state.
  if (owner(pick) !== instance && !claim(pick)) return startFresh();
  // The claim is the ownership; if the state cannot record it, the next launch finds the claim again.
  writeState({ ...state, id: pick });
  return pick;
}

export type KiroV3Identity =
  | { kind: "none" }
  | { kind: "unreadable" }
  | { kind: "owned"; id: string; claimHeld: boolean; credentialProfile: string | null }
  | { kind: "fresh"; since: string; credentialProfile: string | null };

/** What an instance's V3 identity says right now, read-only (for kiro_engine_status). */
export function readKiroV3Identity(instance: string, agendHome: string = getAgendHome()): KiroV3Identity {
  if (!SAFE_NAME.test(instance)) return { kind: "none" };
  const root = join(agendHome, "kiro-v3");
  let raw: string;
  try { raw = readFileSync(join(root, "instances", `${instance}.json`), "utf8"); } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "none" } : { kind: "unreadable" };
  }
  let state: unknown;
  try { state = JSON.parse(raw); } catch { return { kind: "unreadable" }; }
  if (!isState(state)) return { kind: "unreadable" };
  if (state.id === null) return { kind: "fresh", since: new Date(state.since).toISOString(), credentialProfile: state.credentialProfile };
  let claimHeld = false;
  try { claimHeld = readFileSync(join(root, "claims", state.id), "utf8") === `${instance}\n`; } catch { /* not held */ }
  return { kind: "owned", id: state.id, claimHeld, credentialProfile: state.credentialProfile };
}
