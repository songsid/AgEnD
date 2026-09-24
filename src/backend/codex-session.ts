import { closeSync, openSync, readFileSync, readlinkSync, readdirSync, readSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, isAbsolute, join, sep } from "node:path";

export const CODEX_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CodexResumeConflictError extends Error {
  constructor(readonly ownerPid: number | null) {
    super(ownerPid
      ? `Codex conversation is still open in process ${ownerPid}; no second resumer was started. Close that owner, then restart this instance.`
      : "Codex conversation is locked by another owner; no second resumer was started. Close that owner, then restart this instance.");
    this.name = "CodexResumeConflictError";
  }
}

export class CodexResumeUnavailableError extends Error {
  constructor() {
    super("Codex could not resume the verified session. It was preserved; automatic restart is paused. Check the pane and restart this instance after resolving the cause.");
    this.name = "CodexResumeUnavailableError";
  }
}

export interface CodexSessionRecord {
  id: string;
  /** Instance directory basename, never a credential/profile identifier. */
  owner: string;
  cwd: string;
  rolloutPath: string;
}

/** Read only the first JSONL line. A rollout can contain private conversation text. */
export function readCodexRolloutMeta(path: string): { id: string; cwd: string } | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(65_536);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const end = buf.subarray(0, bytes).indexOf(10);
    if (end < 0) return null;
    const row = JSON.parse(buf.toString("utf8", 0, end));
    const id = row?.payload?.id;
    const cwd = row?.payload?.cwd;
    return row?.type === "session_meta" && typeof id === "string" && CODEX_SESSION_ID.test(id)
      && typeof cwd === "string" && isAbsolute(cwd) ? { id, cwd } : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function procGroup(pid: number, procRoot: string): number | null {
  try {
    const stat = readFileSync(join(procRoot, String(pid), "stat"), "utf8");
    const afterName = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const group = Number(afterName[2]); // field 5 (pgrp); afterName[0] is field 3
    return Number.isSafeInteger(group) ? group : null;
  } catch { return null; }
}

function processIds(procRoot: string): number[] {
  try { return readdirSync(procRoot).filter(name => /^\d+$/.test(name)).map(Number); }
  catch { return []; }
}

function macOutput(command: string, args: string[]): string {
  try { return execFileSync(command, args, { encoding: "utf8", timeout: 2_000, maxBuffer: 2_000_000 }); }
  catch { return ""; }
}

function paneProcessIds(panePid: number, procRoot: string): number[] {
  if (process.platform !== "darwin" || procRoot !== "/proc") {
    return processIds(procRoot).filter(pid => procGroup(pid, procRoot) === panePid);
  }
  return macOutput("ps", ["-axo", "pid=,pgid="]).split("\n").flatMap(row => {
    const [pid, group] = row.trim().split(/\s+/).map(Number);
    return group === panePid && Number.isSafeInteger(pid) ? [pid] : [];
  });
}

function openPaths(pid: number, procRoot: string): string[] {
  if (process.platform === "darwin" && procRoot === "/proc") {
    return macOutput("lsof", ["-Fn", "-p", String(pid)]).split("\n")
      .filter(row => row.startsWith("n/")).map(row => row.slice(1));
  }
  const dir = join(procRoot, String(pid), "fd");
  try {
    return readdirSync(dir).flatMap(fd => {
      try { return [readlinkSync(join(dir, fd))]; }
      catch { return []; }
    });
  } catch { return []; }
}

function* rolloutFiles(dir: string, depth = 0): Generator<string> {
  if (depth > 4) return;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) yield* rolloutFiles(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
    }
  } catch { /* missing sessions dir is ordinary on first install */ }
}

/** Explicit/manual lookup; never infer ownership from the newest CWD row. */
export function codexRolloutForId(home: string, id: string): { id: string; cwd: string; rolloutPath: string } | null {
  if (!CODEX_SESSION_ID.test(id)) return null;
  for (const path of rolloutFiles(join(home, "sessions"))) {
    if (!basename(path).endsWith(`${id}.jsonl`)) continue;
    const meta = readCodexRolloutMeta(path);
    if (meta?.id === id) return { ...meta, rolloutPath: realpathSync(path) };
  }
  return null;
}

/** A one-time upgrade notice is warranted only if this CWD had real history. */
export function hasCodexHistoryForCwd(home: string, cwd: string): boolean {
  for (const path of rolloutFiles(join(home, "sessions"))) {
    if (readCodexRolloutMeta(path)?.cwd === cwd) return true;
  }
  return false;
}

/** A pane's process group gives exact session identity even if two TUIs share a CWD. */
export function codexSessionForPane(
  panePid: number,
  sharedHome: string,
  procRoot = "/proc",
): { id: string; cwd: string; rolloutPath: string } | null {
  if (!Number.isSafeInteger(panePid) || panePid <= 0) return null;
  let sessionsRoot: string;
  try { sessionsRoot = realpathSync(join(sharedHome, "sessions")) + sep; }
  catch { return null; }
  const candidates = new Map<string, { id: string; cwd: string; rolloutPath: string }>();
  for (const pid of paneProcessIds(panePid, procRoot)) {
    const paths = openPaths(pid, procRoot);
    const lockIds = new Set(paths.map(path => basename(path).match(/^([0-9a-f-]{36})\.lock$/i)?.[1]).filter((id): id is string => !!id && CODEX_SESSION_ID.test(id)));
    for (const path of paths) {
      if (!path.endsWith(".jsonl") || !path.includes(`${sep}sessions${sep}`)) continue;
      let actual: string;
      try { actual = realpathSync(path); } catch { continue; }
      if (!actual.startsWith(sessionsRoot)) continue;
      const meta = readCodexRolloutMeta(actual);
      if (meta && lockIds.has(meta.id)) candidates.set(meta.id, { ...meta, rolloutPath: actual });
    }
  }
  // A process group can briefly expose both old and new rollouts during /new.
  // No ordering of fd numbers or mtimes is ownership proof; wait for one.
  return candidates.size === 1 ? [...candidates.values()][0] : null;
}

/** Any process holding this session's writer lock is a live competing owner. */
export function codexSessionOwners(id: string, procRoot = "/proc"): number[] {
  if (!CODEX_SESSION_ID.test(id)) return [];
  const name = `${id}.lock`;
  const pids = process.platform === "darwin" && procRoot === "/proc"
    ? macOutput("ps", ["-axo", "pid=,comm="]).split("\n").flatMap(row => {
      const match = row.trim().match(/^(\d+)\s+(.+)$/);
      return match && basename(match[2]) === "codex" ? [Number(match[1])] : [];
    })
    : processIds(procRoot);
  return pids.filter(pid => openPaths(pid, procRoot).some(path => basename(path) === name));
}
