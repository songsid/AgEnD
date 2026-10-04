/**
 * Which kiro engine, kiro-cli version and AgEnD version each kiro instance
 * has been launched with — the baseline the V1 → V3 migration works from.
 *
 * Kept in `<AGEND_HOME>/kiro-engine-ledger.json`, not the instance directory:
 * `replace_instance` deletes that directory, and the migration needs to know
 * what an instance ran on before it was replaced.
 *
 * It is a record, not a source of truth: writing it is best-effort, and a
 * launch never fails because it could not be read or written. Which V3
 * session an instance owns is NOT kept here (see kiro-v3-identity.ts), since
 * that has to be durable and exclusive and this does not.
 */
import { createRequire } from "node:module";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { getAgendHome } from "../paths.js";

export type KiroUi = "legacy" | "tui" | "v3";

export interface KiroLaunchRecord {
  at: string;
  kiroVersion: string | null;
  agendVersion: string;
  ui: KiroUi;
  flags: string[];
}

export interface KiroLedgerEntry {
  workingDirectory: string;
  /** The credential profile the instance launched under; null for the shared store. */
  credentialProfile: string | null;
  firstSeen: string;
  lastLaunch: KiroLaunchRecord;
  /** One row per change of kiro version, AgEnD version, UI or engine flags; newest last. */
  history: KiroLaunchRecord[];
}

export type KiroLedger = Record<string, KiroLedgerEntry>;

const HISTORY_LIMIT = 20;

export function kiroLedgerPath(agendHome: string = getAgendHome()): string {
  return join(agendHome, "kiro-engine-ledger.json");
}

let agendVersionCache: string | undefined;
export function agendVersion(): string {
  if (agendVersionCache === undefined) {
    try { agendVersionCache = String(createRequire(import.meta.url)("../../package.json").version ?? "unknown"); } catch { agendVersionCache = "unknown"; }
  }
  return agendVersionCache;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const UIS: readonly unknown[] = ["legacy", "tui", "v3"];

function isLaunchRecord(v: unknown): v is KiroLaunchRecord {
  return isObject(v) && typeof v.at === "string"
    && (v.kiroVersion === null || typeof v.kiroVersion === "string")
    && typeof v.agendVersion === "string" && UIS.includes(v.ui)
    && Array.isArray(v.flags) && v.flags.every(f => typeof f === "string");
}

/** An entry the code can read without guessing, down to every launch record; anything else is dropped. */
function isLedgerEntry(v: unknown): v is KiroLedgerEntry {
  return isObject(v) && typeof v.workingDirectory === "string" && typeof v.firstSeen === "string"
    && (v.credentialProfile === null || typeof v.credentialProfile === "string")
    && isLaunchRecord(v.lastLaunch) && Array.isArray(v.history) && v.history.every(isLaunchRecord);
}

export function readKiroLedger(path: string = kiroLedgerPath()): KiroLedger {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (isObject(parsed)) return Object.fromEntries(Object.entries(parsed).filter(([, e]) => isLedgerEntry(e))) as KiroLedger;
  } catch { /* missing or damaged: start over */ }
  return {};
}

/** Write via a temp file and rename; the temp file is removed whatever happens. Throws on failure. */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function writeKiroLedger(ledger: KiroLedger, path: string): void {
  writeFileAtomic(path, JSON.stringify(ledger, null, 2) + "\n");
}

/** Read, change one entry, write back atomically. Returns false when the ledger could not be written. */
export function updateKiroLedger(instance: string, change: (entry: KiroLedgerEntry | undefined) => KiroLedgerEntry | undefined, path: string = kiroLedgerPath()): boolean {
  try {
    const ledger = readKiroLedger(path);
    const next = change(ledger[instance]);
    if (next === undefined) return true;
    ledger[instance] = next;
    writeKiroLedger(ledger, path);
    return true;
  } catch {
    return false;
  }
}

function sameLaunch(a: KiroLaunchRecord, b: KiroLaunchRecord): boolean {
  return a.kiroVersion === b.kiroVersion && a.agendVersion === b.agendVersion && a.ui === b.ui
    && a.flags.length === b.flags.length && a.flags.every((f, i) => f === b.flags[i]);
}

export interface KiroLaunchFacts {
  instance: string;
  workingDirectory: string;
  credentialProfile: string | null;
  kiroVersion: string | null;
  ui: KiroUi;
  /** The UI/engine flags AgEnD pinned for this launch. */
  flags: string[];
  now?: Date;
}

export function recordKiroLaunch(facts: KiroLaunchFacts, path: string = kiroLedgerPath()): boolean {
  const record: KiroLaunchRecord = {
    at: (facts.now ?? new Date()).toISOString(),
    kiroVersion: facts.kiroVersion,
    agendVersion: agendVersion(),
    ui: facts.ui,
    flags: [...facts.flags],
  };
  return updateKiroLedger(facts.instance, entry => {
    const history = entry?.history ?? [];
    const last = history[history.length - 1];
    const nextHistory = last && sameLaunch(last, record) ? history : [...history, record].slice(-HISTORY_LIMIT);
    return {
      ...entry,
      workingDirectory: facts.workingDirectory,
      credentialProfile: facts.credentialProfile,
      firstSeen: entry?.firstSeen ?? record.at,
      lastLaunch: record,
      history: nextHistory,
    };
  }, path);
}
