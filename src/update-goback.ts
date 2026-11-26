/**
 * M-3770 slice 2.5 (design update-transaction §5.7, rev 16; Fable's Go back review, Sentinel's S-230 read contract):
 * **Go back** — an update in reverse, through the same transaction. A new attempt `kind: "go-back"`, `goBackOf` the
 * committed attempt, driven by `runUpdate`: the current fleet is stopped and fenced, the CURRENT home snapshotted (so a
 * failed Go back rolls back to now with the existing driver), and "install" restores the committed attempt's retained
 * artifacts — its home snapshot, package preimage and unit preimage — with no npm and no network. It commits like an
 * update; the retained entry it returned to is then marked used. A go-back is not itself go-back-able.
 *
 * Offered (`readGoBackOffer`) only for a committed, unexpired, unused entry whose `from` version speaks this transaction
 * (`txProtocol`), whose artifacts are present and verify, on a systemd or detached install (launchd: S-260). retained.json
 * is never permission on its own: S-230's guard (`requestContextGoBackAllowed`, injected until #4519 lands) is asked
 * under the locks before the attempt opens, and again at snapshotted → installing against the fresh snapshot.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { identityOf } from "./install-ownership.js";
import { attemptDir, defaultJournalIo, journalDir, openAttempt, readAttemptRecord, type AttemptInit, type JournalIo } from "./update-journal.js";
import { readAttemptPreimage, restorePackage, restoreUnit, type Substeps } from "./update-package-restore.js";
import { verifyRecoveryKit } from "./update-recovery/kit.js";
import { restoreHome } from "./update-restore.js";
import { cacheRetainedUnavailable, readRetained, type RetainedEntry } from "./update-retained.js";
import { readManifest } from "./update-snapshot-manifest.js";
import { walkScope } from "./update-snapshot.js";
import { runUpdate, type UpdateDeps, type UpdateResult } from "./update-forward.js";

/** The lowest transaction protocol a version Go back returns to must speak (handoff takeover, the fleet's hand-back). */
export const MIN_GO_BACK_PROTOCOL = 1;
/** The fleet's delivery outbox: S-230's activation record lives in it (Sentinel, S-252-goback-s230). */
export const OUTBOX_DB = "delivery-outbox.db";

export interface GoBackEligible { attemptId: string; committedAt: number; expiresAt: number; from: string; version: string }
export interface GoBackOffer {
  /** Every committed attempt Go back could return to now, oldest first (S-230 binds the exact set). */
  eligible: GoBackEligible[];
  /** The latest `expiresAt` among them (Unix ms), or null with none. */
  latestDeadline: number | null;
  /** Entries not offered, with why (for Settings → Version). */
  unavailable: { attemptId: string; reason: string }[];
}

/** S-230's four-argument guard (`requestContextGoBackAllowed`): the live outbox DB, the committed attempt, its commit
 *  time (Unix ms, audit only) and the private, verified copy of a snapshot's outbox DB (null: the snapshot has none). */
export type GoBackGuard = (liveDb: string, attemptId: string, committedAt: number, snapshotDb: string | null) => boolean;

type Check = { ok: true } | { ok: false; reason: string };

/** Why an entry isn't offered (null: it is). Reads only; nothing is written. */
function unavailableReason(home: string, e: RetainedEntry, now: number, io: JournalIo): string | null {
  if (e.used) return `Go back to ${e.from} was already used (${e.used.by})`;
  if (e.unavailable) return e.unavailable.reason;
  if (!(Date.parse(e.expiresAt) > now)) return `the Go back window to ${e.from} ended ${e.expiresAt}`;
  if (e.txProtocol === null || e.txProtocol < MIN_GO_BACK_PROTOCOL) return `AgEnD ${e.from} can't take part in a Go back (it predates this update transaction)`;
  const record = readAttemptRecord(home, e.attemptId, io);
  if (!record || record.stage !== "committed") return `the update to ${e.version} isn't recorded as committed`;
  const id = identityOf(record);
  if (!id) return "the update's recorded ownership is missing or malformed";
  if (id.ownership.service?.kind === "launchd") return "Go back isn't available on macOS service installs yet";
  if (!readManifest(e.snapshotDir)) return "the snapshot from before the update is missing or unreadable";
  const pre = readAttemptPreimage(e.preimage.dir, e.preimage.manifestSha256);
  if (!pre.ok) return `the package from before the update doesn't verify: ${pre.reason}`;
  if (e.unitPreimage !== null && !existsSync(e.unitPreimage)) return "the service definition from before the update is missing";
  const kit = verifyRecoveryKit(home, e.attemptId);
  if (!kit.ok) return `the update's recovery kit doesn't verify: ${kit.reason}`;
  return null;
}

/**
 * §5.7: what Go back can return to now — for the Settings offer and for S-230's On confirmation, which binds this exact
 * set. Mutates nothing. An unreadable retained.json offers nothing (and says so).
 */
export function readGoBackOffer(home: string, now: number = Date.now(), io: JournalIo = defaultJournalIo): GoBackOffer {
  const read = readRetained(home, io);
  if (!read.ok) return { eligible: [], latestDeadline: null, unavailable: [{ attemptId: "", reason: read.reason }] };
  const eligible: GoBackEligible[] = [], unavailable: GoBackOffer["unavailable"] = [];
  for (const e of read.entries) {
    const why = unavailableReason(home, e, now, io);
    if (why) unavailable.push({ attemptId: e.attemptId, reason: why });
    else eligible.push({ attemptId: e.attemptId, committedAt: Date.parse(e.committedAt), expiresAt: Date.parse(e.expiresAt), from: e.from, version: e.version });
  }
  eligible.sort((a, b) => a.committedAt - b.committedAt || a.attemptId.localeCompare(b.attemptId));
  return { eligible, latestDeadline: eligible.length ? Math.max(...eligible.map(e => e.expiresAt)) : null, unavailable };
}

/**
 * S-230's read contract: a snapshot's outbox DB is never opened in the snapshot tree (a WAL file grows sidecars even on
 * a read-only connection). It and its manifest-listed sidecars are copied to a fresh 0700 directory on the home's own
 * volume, each checked against its manifest sha256. `cleanup` removes it (the caller's finally).
 */
export function privateSnapshotDb(home: string, snapshotDir: string): { ok: true; path: string | null; cleanup(): void } | { ok: false; reason: string } {
  const manifest = readManifest(snapshotDir);
  if (!manifest) return { ok: false, reason: "the snapshot's manifest can't be read" };
  const files = manifest.entries.filter(e => e.type === "file" && (e.rel === OUTBOX_DB || e.rel.startsWith(`${OUTBOX_DB}-`)));
  if (!files.some(e => e.rel === OUTBOX_DB)) return { ok: true, path: null, cleanup: () => {} };
  mkdirSync(journalDir(home), { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(journalDir(home), "go-back-check-"));
  const cleanup = () => { rmSync(dir, { recursive: true, force: true }); };
  try {
    for (const e of files) {
      const to = join(dir, e.rel);
      copyFileSync(join(snapshotDir, "snapshot", e.rel), to);
      const sha = createHash("sha256").update(readFileSync(to)).digest("hex");
      if (sha !== e.sha256) { cleanup(); return { ok: false, reason: `the snapshot's ${e.rel} doesn't match its manifest` }; }
    }
  } catch (err) { cleanup(); return { ok: false, reason: `the snapshot's ${OUTBOX_DB} can't be copied (${(err as Error).message})` }; }
  return { ok: true, path: join(dir, OUTBOX_DB), cleanup };
}

/** The S-230 guard against `snapshotDir`'s outbox DB: a false answer, a thrown error or an unverifiable copy refuses. */
export function goBackAllowed(home: string, entry: { attemptId: string; committedAt: string }, snapshotDir: string, guard: GoBackGuard): Check {
  const copy = privateSnapshotDb(home, snapshotDir);
  if (!copy.ok) return { ok: false, reason: copy.reason };
  try {
    return guard(join(home, OUTBOX_DB), entry.attemptId, Date.parse(entry.committedAt), copy.path)
      ? { ok: true } : { ok: false, reason: "request-based contact approvals were turned on after this update, which ended its Go back" };
  } catch (err) {
    return { ok: false, reason: `whether Go back is still allowed can't be read (${(err as Error).message})` };
  } finally { copy.cleanup(); }
}

/** A content check's cache for one confirmation's lifetime: (path, size, mtime) → sha256. */
export type HashCache = Map<string, string>;

/**
 * §5.7, Fable's Go back review (c): what Go back sets aside — the top-level home entries whose scope content differs from
 * the committed snapshot (changed, added since, or gone), for the confirmation (computed when it opens, not for the offer
 * card). Size first; only a same-size file is hashed, cached by (path, size, mtime). The confirmation words them (labels)
 * and says "everything since <committedAt>".
 */
export function goBackChanges(home: string, snapshotDir: string, cache: HashCache = new Map()): { ok: true; changed: string[] } | { ok: false; reason: string } {
  const manifest = readManifest(snapshotDir);
  if (!manifest) return { ok: false, reason: "the snapshot's manifest can't be read" };
  let live;
  try { live = walkScope(home); } catch (err) { return { ok: false, reason: (err as Error).message } }
  const top = (rel: string) => rel.split("/")[0]!;
  const changed = new Set<string>();
  const before = new Map(manifest.entries.map(e => [e.rel, e]));
  const now = new Map(live.entries.map(e => [e.rel, e]));
  for (const rel of new Set([...before.keys(), ...now.keys()])) {
    const b = before.get(rel), n = now.get(rel);
    if (!b || !n || b.type !== n.type) { changed.add(top(rel)); continue; }
    if (b.type === "link") { if (b.target !== n.target) changed.add(top(rel)); continue; }
    if (b.type !== "file") continue;
    if (b.size !== n.size) { changed.add(top(rel)); continue; }
    const key = `${rel}\0${n.size}\0${n.mtimeMs}`;
    let sha = cache.get(key);
    if (sha === undefined) { sha = createHash("sha256").update(readFileSync(join(home, rel))).digest("hex"); cache.set(key, sha); }
    if (sha !== b.sha256) changed.add(top(rel));
  }
  return { ok: true, changed: [...changed].sort() };
}

export interface GoBackDeps extends Omit<UpdateDeps, "install" | "beforeInstall"> { guard: GoBackGuard; now?(): number }

/**
 * §5.7: Go back to the committed attempt `committedId`. The caller holds the three locks and the EXCLUSIVE state lease,
 * has proven ownership, and supplies the opening identity (`init`: the current install as the old side, the current
 * fleet as generation old). Refused before any attempt opens when the entry isn't offered or the guard says no (its
 * reason cached in retained.json).
 */
export function runGoBack(home: string, committedId: string, init: Omit<AttemptInit, "kind" | "goBackOf" | "to">, d: GoBackDeps):
  UpdateResult | { ok: false; outcome: "refused"; reason: string } {
  const io = d.io ?? defaultJournalIo;
  const offer = readGoBackOffer(home, d.now?.() ?? Date.now(), io);
  const entry = offer.eligible.find(e => e.attemptId === committedId);
  if (!entry) return { ok: false, outcome: "refused", reason: offer.unavailable.find(u => u.attemptId === committedId)?.reason ?? `no Go back is offered for ${committedId}` };
  const retained = { attemptId: committedId, committedAt: new Date(entry.committedAt).toISOString() };
  const first = goBackAllowed(home, retained, attemptDir(home, committedId), d.guard);
  if (!first.ok) { cacheRetainedUnavailable(home, committedId, first.reason, io); return { ok: false, outcome: "refused", reason: first.reason }; }

  const read = readRetained(home, io);
  const kept = read.ok ? read.entries.find(e => e.attemptId === committedId) : undefined;
  if (!kept) return { ok: false, outcome: "refused", reason: "the Go back entry vanished" };
  const opened = openAttempt(home, { ...init, kind: "go-back", goBackOf: committedId, to: { name: init.from.name, version: kept.from, integrity: null } }, io);
  if (!opened.ok) return { ok: false, outcome: "refused", reason: opened.reason };
  const goBackId = opened.attempt.id;

  // The restore's substeps live only for this run: a crash in installing rolls back (§7), never resumes these.
  const done = new Set<string>();
  const steps: Substeps = { done: n => done.has(n), record: n => { done.add(n); } };
  return runUpdate(home, opened.attempt, { target: { name: init.from.name, version: kept.from, integrity: null }, command: ["agend-go-back", committedId] }, {
    ...d,
    // Blocking 2 (Fable): the guard again, right before anything is restored, against the snapshot just taken of now.
    beforeInstall: () => goBackAllowed(home, retained, attemptDir(home, goBackId), d.guard),
    install: () => {
      const work = join(attemptDir(home, goBackId), "go-back");
      mkdirSync(work, { recursive: true, mode: 0o700 });
      const h = restoreHome(home, work, { proveWritersGone: d.proveWritersGone }, { snapshotFrom: kept.snapshotDir });
      if (!h.ok) return { ok: false, reason: `the home from before ${kept.version} can't be restored: ${h.reason}` };
      const record = readAttemptRecord(home, goBackId, io);
      const id = record && identityOf(record);
      if (!record || !id) return { ok: false, reason: "the Go back's own record can't be read" };
      const p = restorePackage(id.ownership, committedId, kept.preimage.manifestSha256, steps, { work: goBackId });
      if (!p.ok) return { ok: false, reason: `AgEnD ${kept.from} can't be put back: ${p.reason}` };
      if (id.ownership.service) {
        const u = restoreUnit(home, record, { keepRoute: true, plistArgs: d.plistArgs, reload: d.manager.reload, preimageOf: committedId }, steps);
        if (!u.ok) return { ok: false, reason: `the service definition can't be put back: ${u.reason}` };
      }
      return { ok: true };
    },
  });
}
