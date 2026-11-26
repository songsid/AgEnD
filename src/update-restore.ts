/**
 * M-3770 slice 2.3 (design update-transaction §5.5): restore the home from an attempt's verified snapshot — a per-unit,
 * crash-safe protocol that a retry replays to the same end state.
 *
 * - **Units and containers.** A *container* is a directory with excluded descendants (the home itself,
 *   `instances/<name>/`, …): never moved; its included children are units of their own, its mode is restored at the
 *   end. A *unit* is the largest in-scope path whose whole subtree is in scope (a file, a link, or a directory with no
 *   excluded descendant): moved and restored whole. Units never nest.
 * - **The plan.** Under the transaction's locks, with ownership re-proven and the writers fenced (the caller's): every
 *   current unit is recorded with its root's `{ type, dev, ino }`, and every unit is classed — **both** (current and in
 *   the manifest), **new-only**, **manifest-only**. `restore.log`'s header (the plan and the manifest's sha256) is made
 *   durable before anything moves.
 * - **Per unit, in path order:** `aside` (rename `<home>/u` → `replaced/u`, both parents fsynced, logged) for a current
 *   unit; `restored` (built from `snapshot/u` at `<home>/u.restore-tmp`, fsynced, renamed into place, the parent
 *   fsynced, logged) for a manifest unit. Then `containers` (created if missing, modes set), the exact-set verification
 *   of the restored scope, the writers' proof again, and `verified`.
 * - **A retry** replays the log with §5.5's table: an effect that landed before its log line is recognised (a moved
 *   unit by its identity in `replaced/`, a restored one by matching the manifest) and logged; anything the table
 *   doesn't cover is manual-recovery. `snapshot/` and `replaced/` are never modified by a retry.
 */
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync,
  renameSync, rmSync, chmodSync, symlinkSync, utimesSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { classify } from "./update-snapshot-scope.js";
import { readManifest, SNAPSHOT_DIR, SNAPSHOT_MANIFEST, verifySnapshot, type EntryType, type ManifestEntry, type SnapshotManifest } from "./update-snapshot.js";

export const RESTORE_LOG = "restore.log";
export const REPLACED_DIR = "replaced";
const TMP_SUFFIX = ".restore-tmp";

/** A unit root's identity (§5.5): `{ type, dev, ino, size, mtime }` — the inode alone is reused by the filesystem. */
interface Ident { type: EntryType; dev: number; ino: number; size: number; mtimeMs: number }
export interface PlanUnit { rel: string; kind: "both" | "new-only" | "manifest-only"; current?: Ident }
interface Header { schema: 1; manifestSha256: string; units: PlanUnit[]; containers: string[] }
type LogLine = { u: string; step: "aside" | "restored" } | { step: "containers" | "verified" };

/** The restore's I/O, as effects each followed by `step` — a test stops the process at any boundary. */
export interface RestoreIo { step(name: string): void }
export const defaultRestoreIo: RestoreIo = { step: () => {} };

export interface RestoreDeps {
  /** §4.4, again, after the restore and before `verified`. */
  proveWritersGone(): { ok: true } | { ok: false; reason: string };
  io?: RestoreIo;
}

export type RestoreResult = { ok: true } | { ok: false; manual: boolean; reason: string };

class Manual extends Error {}
class Retryable extends Error {}

const fsyncPath = (p: string) => { const fd = openSync(p, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };
const sha256File = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const parentRel = (rel: string) => (rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "");
const under = (rel: string, u: string) => rel === u || rel.startsWith(`${u}/`);

function identOf(path: string): Ident | null {
  try { const st = lstatSync(path); return { type: st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file", dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs }; }
  catch { return null; }
}
const sameIdent = (a: Ident | null, b: Ident | undefined) => !!a && !!b && a.type === b.type && a.dev === b.dev && a.ino === b.ino
  && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** The home's scope now: every included entry, never following a link, and the directories that are containers. */
function currentScope(home: string): { entries: Map<string, ManifestEntry>; containers: Set<string> } {
  const entries = new Map<string, ManifestEntry>(), containers = new Set<string>([""]);
  const visit = (rel: string): boolean => {                    // true: this directory has an excluded descendant
    let excludedBelow = false;
    for (const name of readdirSync(rel ? join(home, rel) : home).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (r.endsWith(TMP_SUFFIX) && classify(r.slice(0, -TMP_SUFFIX.length)).included) continue;   // a restore's own tmp
      if (!classify(r).included) { excludedBelow = true; continue; }
      const st = lstatSync(join(home, r));
      if (st.isSymbolicLink()) entries.set(r, { rel: r, type: "link", mode: 0, target: readlinkSync(join(home, r)) });
      else if (st.isDirectory()) {
        entries.set(r, { rel: r, type: "dir", mode: st.mode & 0o7777 });
        if (visit(r)) { containers.add(r); excludedBelow = true; }
      } else entries.set(r, { rel: r, type: "file", mode: st.mode & 0o7777, size: st.size });
    }
    return excludedBelow;
  };
  visit("");
  return { entries, containers };
}

/** The units: in-scope entries whose parent is a container and that aren't containers themselves. */
function unitsOf(rels: Iterable<string>, containers: Set<string>): string[] {
  return [...rels].filter(r => containers.has(parentRel(r)) && !containers.has(r));
}

/** Does the subtree at `<home>/u` match the manifest's entries under `u` exactly (types, hashes, sizes, modes, targets)? */
function matchesManifest(home: string, u: string, manifest: SnapshotManifest): boolean {
  const want = manifest.entries.filter(e => under(e.rel, u));
  const seen: ManifestEntry[] = [];
  const add = (r: string): boolean => {
    let st;
    try { st = lstatSync(join(home, r)); } catch { return false; }
    if (st.isSymbolicLink()) seen.push({ rel: r, type: "link", mode: 0, target: readlinkSync(join(home, r)) });
    else if (st.isDirectory()) { seen.push({ rel: r, type: "dir", mode: st.mode & 0o7777 }); for (const n of readdirSync(join(home, r))) if (!add(`${r}/${n}`)) return false; }
    else seen.push({ rel: r, type: "file", mode: st.mode & 0o7777, size: st.size, sha256: sha256File(join(home, r)) });
    return true;
  };
  if (!add(u) || seen.length !== want.length) return false;
  const byRel = new Map(seen.map(e => [e.rel, e]));
  return want.every(e => {
    const s = byRel.get(e.rel);
    if (!s || s.type !== e.type) return false;
    if (e.type === "link") return s.target === e.target;
    if (e.type === "dir") return s.mode === e.mode;
    return s.sha256 === e.sha256 && s.size === e.size && s.mode === e.mode;
  });
}

/** Build `snapshot/u` at `dst` (file copied, tree copied, link recreated), every file and directory fsynced. */
function build(snapshot: string, u: string, dst: string, manifest: SnapshotManifest): void {
  const entries = manifest.entries.filter(e => under(e.rel, u)).sort((a, b) => a.rel.length - b.rel.length || a.rel.localeCompare(b.rel));
  const dirs: string[] = [];
  for (const e of entries) {
    const to = e.rel === u ? dst : join(dst, e.rel.slice(u.length + 1));
    if (e.type === "dir") { mkdirSync(to, { mode: 0o700 }); dirs.push(to); continue; }
    if (e.type === "link") { symlinkSync(e.target!, to); continue; }
    const from = join(snapshot, e.rel);
    copyFileSync(from, to, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
    chmodSync(to, e.mode);
    const st = lstatSync(from); utimesSync(to, st.atime, st.mtime);
    fsyncPath(to);
  }
  for (const e of entries) if (e.type === "dir") chmodSync(e.rel === u ? dst : join(dst, e.rel.slice(u.length + 1)), e.mode);
  for (const d of dirs.sort((a, b) => b.length - a.length)) fsyncPath(d);
}

/**
 * §5.5: restore `home` from `<attemptDir>/snapshot` (verified first). The caller holds the locks, has re-proven
 * ownership and fenced the writers. `manual: true` means the table found a state it doesn't cover — manual-recovery.
 */
export function restoreHome(home: string, attemptDir: string, deps: RestoreDeps): RestoreResult {
  const io = deps.io ?? defaultRestoreIo;
  const snapshot = join(attemptDir, SNAPSHOT_DIR), replaced = join(attemptDir, REPLACED_DIR), logPath = join(attemptDir, RESTORE_LOG);
  const manifest = readManifest(attemptDir);
  if (!manifest) return { ok: false, manual: true, reason: "the snapshot's manifest can't be read" };
  const intact = verifySnapshot(attemptDir, manifest);
  if (!intact.ok) return { ok: false, manual: true, reason: `the snapshot doesn't verify: ${intact.reason}` };
  const manifestSha256 = createHash("sha256").update(readFileSync(join(attemptDir, SNAPSHOT_MANIFEST))).digest("hex");

  try {
    // ── The plan: written once, durable before anything moves ──
    let header: Header, logged: LogLine[];
    let text: string | null = null;
    try { text = readFileSync(logPath, "utf8"); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    if (text === null) {
      const now = currentScope(home);
      const manifestRels = new Set(manifest.entries.map(e => e.rel));
      const currentUnits = unitsOf(now.entries.keys(), now.containers);
      const manifestUnits = unitsOf(manifestRels, now.containers);
      const all = [...new Set([...currentUnits, ...manifestUnits])].sort();
      const units: PlanUnit[] = all.map(rel => {
        const inCurrent = currentUnits.includes(rel), inManifest = manifestUnits.includes(rel);
        const current = inCurrent ? identOf(join(home, rel)) ?? undefined : undefined;
        return { rel, kind: inCurrent && inManifest ? "both" : inCurrent ? "new-only" : "manifest-only", ...(current ? { current } : {}) };
      });
      header = { schema: 1, manifestSha256, units, containers: [...now.containers].filter(c => c !== "").sort() };
      const tmp = `${logPath}.tmp-${process.pid}`;
      const fd = openSync(tmp, "wx", 0o600);
      try { writeSync(fd, JSON.stringify(header) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, logPath); fsyncPath(attemptDir); io.step("header");
      logged = [];
    } else {
      const lines = text.split("\n").filter(Boolean);
      header = JSON.parse(lines[0]!) as Header;
      if (header.schema !== 1 || header.manifestSha256 !== manifestSha256) throw new Manual("restore.log's header doesn't match this snapshot");
      logged = [];
      for (const [i, l] of lines.slice(1).entries()) {
        try { logged.push(JSON.parse(l) as LogLine); }
        catch { if (i !== lines.length - 2) throw new Manual("restore.log has an unreadable line"); }   // a torn last line: never written
      }
    }
    const log = (line: LogLine) => {
      const fd = openSync(logPath, "a");
      try { writeSync(fd, JSON.stringify(line) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      logged.push(line);
      io.step("step" in line && "u" in line ? `log:${line.step}:${line.u}` : `log:${line.step}`);
    };
    const has = (u: string, step: "aside" | "restored") => logged.some(l => "u" in l && l.u === u && l.step === step);

    const aside = (u: string) => {
      const to = join(replaced, u);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      renameSync(join(home, u), to); io.step(`rename-aside:${u}`);
      fsyncPath(dirname(join(home, u))); fsyncPath(dirname(to)); io.step(`fsync-aside:${u}`);
      log({ u, step: "aside" });
    };
    const restore = (u: string) => {
      const tmp = join(home, u + TMP_SUFFIX);
      rmSync(tmp, { recursive: true, force: true });                 // only the restore's own tmp
      build(snapshot, u, tmp, manifest); io.step(`built:${u}`);
      renameSync(tmp, join(home, u)); io.step(`rename-restore:${u}`);
      fsyncPath(dirname(join(home, u))); io.step(`fsync-restore:${u}`);
      log({ u, step: "restored" });
    };

    // ── Per unit, in path order, with the retry table ──
    for (const unit of header.units) {
      const u = unit.rel, at = join(home, u), moved = join(replaced, u);
      const complete = has(u, "restored") || (unit.kind === "new-only" && has(u, "aside"));
      if (complete) continue;
      const here = identOf(at), there = identOf(moved);
      if (unit.kind === "new-only") {
        if (!here && sameIdent(there, unit.current)) { log({ u, step: "aside" }); continue; }
        if (here && !there) { aside(u); continue; }
        throw new Manual(`${u} (new since the snapshot) is in a state the restore doesn't cover`);
      }
      if (unit.kind === "both" && !has(u, "aside")) {
        if (!here && sameIdent(there, unit.current)) log({ u, step: "aside" });
        else if (sameIdent(here, unit.current) && !there) aside(u);
        else throw new Manual(`${u} is in a state the restore doesn't cover (present: ${!!here}, set aside: ${!!there})`);
      }
      // `both` with `aside` logged, or `manifest-only`: put the snapshot's copy in place.
      if (identOf(at)) {
        if (matchesManifest(home, u, manifest)) { log({ u, step: "restored" }); continue; }   // the rename landed before its log line
        throw new Manual(`${u} is present and matches neither the snapshot nor the plan`);
      }
      restore(u);
    }

    // ── Containers: created if missing, modes as recorded ──
    if (!logged.some(l => l.step === "containers")) {
      const modes = new Map(manifest.entries.filter(e => e.type === "dir").map(e => [e.rel, e.mode]));
      for (const c of header.containers) {
        if (!identOf(join(home, c))) mkdirSync(join(home, c), { recursive: true, mode: 0o700 });
        const mode = modes.get(c);
        if (mode !== undefined) chmodSync(join(home, c), mode);
      }
      fsyncPath(home);
      log({ step: "containers" });
    }

    // ── Verify the restored scope against the manifest, as an exact set; the writers' proof again ──
    if (!logged.some(l => l.step === "verified")) {
      const now = currentScope(home).entries;
      const want = new Map(manifest.entries.map(e => [e.rel, e]));
      for (const rel of now.keys()) if (!want.has(rel)) throw new Manual(`after the restore, ${rel} is in the home but not in the snapshot`);
      for (const e of manifest.entries) if (!now.has(e.rel)) throw new Manual(`after the restore, ${e.rel} is missing`);
      for (const u of header.units) if (want.has(u.rel) && !matchesManifest(home, u.rel, manifest)) throw new Manual(`after the restore, ${u.rel} doesn't match the snapshot`);
      const writers = deps.proveWritersGone();
      if (!writers.ok) throw new Retryable(`a writer appeared during the restore: ${writers.reason}`);
      log({ step: "verified" });
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof Manual) return { ok: false, manual: true, reason: err.message };
    if (err instanceof Retryable) return { ok: false, manual: false, reason: err.message };
    throw err;                                                       // a crash (or an injected one): the retry replays
  }
}
