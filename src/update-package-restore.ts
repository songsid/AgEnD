/**
 * M-3770 slice 2.3 (design update-transaction §6.3): the package and the service unit, put back with retryable substeps.
 *
 * - **The transaction's own package preimage** is a copy, taken before the install: `<prefix>/.agend-rollback/
 *   attempt-<id>/agend`, with the bin links' targets recorded and every entry hashed into `preimage.json` (its sha256
 *   is the install intent's `preimage.manifestSha256`, §3.2). `restorePackagePreimage` (the legacy one) consumes its
 *   copy; this one never does — a restore copies from it.
 * - **Package restore**, each substep journaled after its effect, each retry recognising an effect already done by
 *   the path's presence and its hash against the preimage's manifest:
 *   1. `pkg-aside`: the current `<root>/@songsid/agend` renamed to `<preimage>/replaced-package` (if present, and that
 *      destination is new);
 *   2. `pkg-staged`: the preimage tree copied to `<root>/@songsid/.agend-restore-<id>`, fsynced;
 *   3. `pkg-placed`: the staged tree renamed into `<root>/@songsid/agend`;
 *   4. `bins`: each bin link made at `<bin>.restore-tmp` and renamed over `<bin>` (removed when it had none).
 * - **Unit restore**: `unit.preimage`'s bytes written to `<fragment>.restore-tmp`, fsynced, renamed; the route either
 *   kept (the runner, until the takeover is acknowledged: §6.2 step 3 — launchd keeps its wrapper around the original
 *   arguments) or removed; then the manager reloaded. A retry writes the same bytes again.
 *
 * Anything a retry can't recognise is manual-recovery. The caller holds the locks and has re-proven ownership.
 */
import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync,
  rmSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Ownership } from "./install-ownership.js";
import { removeRecoveryRoute, unitPreimagePath, wrapPlist } from "./update-recovery/route.js";
import { identityOf } from "./install-ownership.js";
import type { AttemptRecord } from "./update-journal.js";

export const ATTEMPT_PREIMAGE_PREFIX = "attempt-";
export const PREIMAGE_MANIFEST = "preimage.json";
export const attemptPreimageDir = (prefix: string, attemptId: string) => join(prefix, ".agend-rollback", `${ATTEMPT_PREIMAGE_PREFIX}${attemptId}`);

interface TreeEntry { rel: string; type: "file" | "dir" | "link"; mode: number; sha256?: string; target?: string }
export interface PreimageManifest { schema: 1; attemptId: string; packagePath: string; entries: TreeEntry[]; bins: Record<string, { link: string; target: string | null }> }

const fsyncPath = (p: string) => { const fd = openSync(p, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } };
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** A tree's entries, never following a link, in a stable order. */
function treeOf(root: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  const visit = (rel: string) => {
    for (const name of readdirSync(rel ? join(root, rel) : root).sort()) {
      const r = rel ? `${rel}/${name}` : name, st = lstatSync(join(root, r));
      if (st.isSymbolicLink()) out.push({ rel: r, type: "link", mode: 0, target: readlinkSync(join(root, r)) });
      else if (st.isDirectory()) { out.push({ rel: r, type: "dir", mode: st.mode & 0o7777 }); visit(r); }
      else out.push({ rel: r, type: "file", mode: st.mode & 0o7777, sha256: sha256(readFileSync(join(root, r))) });
    }
  };
  visit("");
  return out;
}

/** Does the tree at `root` match `entries` exactly? */
function treeMatches(root: string, entries: TreeEntry[]): boolean {
  if (!existsSync(root)) return false;
  let now: TreeEntry[];
  try { now = treeOf(root); } catch { return false; }
  return JSON.stringify(now) === JSON.stringify(entries);
}

/** Every file and directory under `root` fsynced, deepest first. */
function fsyncTree(root: string): void {
  const dirs: string[] = [root];
  for (const e of treeOf(root)) {
    if (e.type === "dir") dirs.push(join(root, e.rel));
    else if (e.type === "file") fsyncPath(join(root, e.rel));
  }
  for (const d of dirs.sort((a, b) => b.length - a.length)) fsyncPath(d);
}

export type PreimageResult = { ok: true; dir: string; manifestSha256: string } | { ok: false; reason: string };

/** §6.3: copy the installed package aside for this attempt, hash it, record the bin links. Its directory must be new. */
export function takeAttemptPreimage(ownership: Ownership, attemptId: string): PreimageResult {
  const dir = attemptPreimageDir(ownership.prefix, attemptId);
  if (existsSync(dir)) return { ok: false, reason: `${dir} already exists; an attempt's preimage is never reused` };
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    cpSync(ownership.packagePath, join(dir, "agend"), { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    fsyncTree(join(dir, "agend"));
    const bins: PreimageManifest["bins"] = {};
    for (const [name, link] of Object.entries(ownership.binLinks)) {
      let target: string | null = null;
      try { if (lstatSync(link).isSymbolicLink()) target = readlinkSync(link); } catch { target = null; }
      bins[name] = { link, target };
    }
    const manifest: PreimageManifest = { schema: 1, attemptId, packagePath: ownership.packagePath, entries: treeOf(join(dir, "agend")), bins };
    const text = JSON.stringify(manifest, null, 2) + "\n";
    const tmp = join(dir, `${PREIMAGE_MANIFEST}.tmp`);
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, join(dir, PREIMAGE_MANIFEST)); fsyncPath(dir); fsyncPath(dirname(dir));
    return { ok: true, dir, manifestSha256: sha256(text) };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, reason: `the installed package can't be copied aside (${(err as Error).message})` };
  }
}

/** The preimage, verified against the sha256 the attempt recorded: its manifest and its tree exactly. */
export function readAttemptPreimage(dir: string, manifestSha256: string): { ok: true; manifest: PreimageManifest } | { ok: false; reason: string } {
  let text: string;
  try { text = readFileSync(join(dir, PREIMAGE_MANIFEST), "utf8"); } catch (err) { return { ok: false, reason: `the preimage's manifest can't be read (${(err as Error).message})` }; }
  if (sha256(text) !== manifestSha256) return { ok: false, reason: "the preimage's manifest isn't the one the attempt recorded" };
  const manifest = JSON.parse(text) as PreimageManifest;
  if (!treeMatches(join(dir, "agend"), manifest.entries)) return { ok: false, reason: "the preimage's tree doesn't match its manifest" };
  return { ok: true, manifest };
}

/** The journal's view for the restores: which substeps are done, and how to record one after its effect. */
export interface Substeps { done(name: string): boolean; record(name: string): void }

export type StepResult = { ok: true } | { ok: false; manual: boolean; reason: string };
class Manual extends Error {}

/** §6.3: put the preimage's package and bin links back. */
export function restorePackage(ownership: Ownership, attemptId: string, manifestSha256: string, steps: Substeps): StepResult {
  const dir = attemptPreimageDir(ownership.prefix, attemptId);
  const pre = readAttemptPreimage(dir, manifestSha256);
  if (!pre.ok) return { ok: false, manual: true, reason: pre.reason };
  const { manifest } = pre;
  const pkg = ownership.packagePath, scope = dirname(pkg), staged = join(scope, `.agend-restore-${attemptId}`), replaced = join(dir, "replaced-package");
  try {
    if (pkg !== manifest.packagePath) throw new Manual(`the preimage was taken for ${manifest.packagePath}, not ${pkg}`);
    if (!steps.done("pkg-aside")) {
      const here = existsSync(pkg) || isLink(pkg), there = existsSync(replaced) || isLink(replaced);
      if (here && !there) { renameSync(pkg, replaced); fsyncPath(scope); fsyncPath(dir); }
      else if (here && there) throw new Manual(`${pkg} and ${replaced} both exist`);
      steps.record("pkg-aside");                                     // moved now, moved before (only replaced/), or nothing was installed
    }
    if (!steps.done("pkg-staged")) {
      rmSync(staged, { recursive: true, force: true });              // only this restore's own staging directory: copied afresh
      cpSync(join(dir, "agend"), staged, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
      fsyncTree(staged); fsyncPath(scope);
      steps.record("pkg-staged");
    }
    if (!steps.done("pkg-placed")) {
      if (treeMatches(pkg, manifest.entries) && !existsSync(staged)) { /* the rename landed before its line */ }
      else if (existsSync(staged) && !existsSync(pkg) && !isLink(pkg)) { renameSync(staged, pkg); fsyncPath(scope); }
      else throw new Manual(`${pkg} can't be placed: ${existsSync(pkg) ? "something else is there" : "the staged tree is missing"}`);
      steps.record("pkg-placed");
    }
    if (!steps.done("bins")) {
      for (const { link, target } of Object.values(manifest.bins)) {
        const now = isLink(link) ? readlinkSync(link) : existsSync(link) ? "(a file)" : null;
        if (now === target) continue;
        if (target === null) { unlinkSync(link); continue; }
        const tmp = `${link}.restore-tmp`;
        rmSync(tmp, { force: true });
        symlinkSync(target, tmp);
        renameSync(tmp, link);
      }
      for (const d of new Set(Object.values(manifest.bins).map(b => dirname(b.link)))) fsyncPath(d);
      steps.record("bins");
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof Manual) return { ok: false, manual: true, reason: err.message };
    throw err;                                                       // a crash: the retry recognises what landed
  }
}

function isLink(p: string): boolean { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } }

/**
 * §6.3: put the unit's own definition back. `keepRoute` (the runner, §6.2 step 3): systemd keeps its drop-in; launchd
 * gets its wrapper around the ORIGINAL arguments. Otherwise the route goes too. Then `reload()` (daemon-reload, or the
 * plist reload with no start job in progress — the caller's).
 */
export function restoreUnit(home: string, attempt: AttemptRecord, opts: { keepRoute: boolean; plistArgs(xml: string): string[] | null; reload(): boolean }, steps: Substeps): StepResult {
  const service = identityOf(attempt)?.ownership.service;
  if (!service) return { ok: false, manual: true, reason: "the attempt records no service" };
  let preimage: Buffer;
  try { preimage = readFileSync(unitPreimagePath(home, attempt.id)); }
  catch (err) { return { ok: false, manual: true, reason: `the unit's preimage can't be read (${(err as Error).message})` }; }
  let want = preimage;
  if (service.kind === "launchd" && opts.keepRoute) {
    const original = opts.plistArgs(preimage.toString("utf8"));
    const wrapped = original ? wrapPlist(preimage.toString("utf8"), home, attempt.id, original) : null;
    if (!wrapped) return { ok: false, manual: true, reason: "the job's original arguments can't be wrapped" };
    want = Buffer.from(wrapped);
  }
  try {
    if (!steps.done("unit-written")) {
      // Written afresh (a retry finds the same bytes either way): tmp, fsync, rename, directory fsync; the mode kept.
      const tmp = `${service.fragmentPath}.restore-tmp`;
      rmSync(tmp, { force: true });
      let mode = 0o644;
      try { mode = lstatSync(service.fragmentPath).mode & 0o7777; } catch { /* absent: the default */ }
      const fd = openSync(tmp, "wx", mode);
      try { writeSync(fd, want); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, service.fragmentPath); fsyncPath(dirname(service.fragmentPath));
      steps.record("unit-written");
    }
    if (!opts.keepRoute && service.kind === "systemd" && !steps.done("unit-route-removed")) {
      const removed = removeRecoveryRoute(home, attempt, { plistArgs: opts.plistArgs });
      if (!removed.ok) throw new Manual(removed.reason);
      steps.record("unit-route-removed");
    }
    if (!steps.done("unit-reloaded")) {
      if (!opts.reload()) return { ok: false, manual: false, reason: `the service manager couldn't reload ${basename(service.fragmentPath)}; retry` };
      steps.record("unit-reloaded");
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof Manual) return { ok: false, manual: true, reason: err.message };
    throw err;
  }
}
