/**
 * M-3770 slice 2.5 (design update-transaction §5.6, §5.7): `retained.json`, the committed attempts whose artifacts are
 * kept for **Go back** — the snapshot, the package preimage, the unit preimage and the recovery kit — each for 7 days
 * from its commit. Written at commit (substep `retained`), before the route comes off or any agent starts. Pruning never
 * removes an artifact a live entry names; Go back is offered only while its entry is live and its artifacts verify.
 *
 * `<home>/.update-journal/retained.json` (outside the snapshot's scope): `{ schema: 1, entries: RetainedEntry[] }`,
 * written whole (tmp, fsync, rename, directory fsync). One entry per attempt id; a retry replaces it with the same.
 */
import { join } from "node:path";
import { attemptDir, defaultJournalIo, journalDir, type AttemptRecord, type JournalIo } from "./update-journal.js";
import { identityOf } from "./install-ownership.js";
import { kitDir } from "./update-recovery/pre-start.js";
import { unitPreimagePath } from "./update-recovery/route.js";

export const RETAINED_FILE = "retained.json";
export const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
export const retainedPath = (home: string) => join(journalDir(home), RETAINED_FILE);

export interface RetainedEntry {
  attemptId: string;
  /** The version the commit made current, and the one Go back returns to. */
  version: string;
  from: string;
  committedAt: string;
  expiresAt: string;
  /** The attempt's directory: its snapshot (`snapshot/` + manifest) and, with a service, `unit.preimage`. */
  snapshotDir: string;
  /** The package preimage the install intent named. */
  preimage: { dir: string; manifestSha256: string };
  unitPreimage: string | null;
  kit: string;
}

export type RetainedRead = { ok: true; entries: RetainedEntry[] } | { ok: false; reason: string };

const isEntry = (e: unknown): e is RetainedEntry => {
  const v = e as Partial<RetainedEntry> | null;
  return !!v && typeof v.attemptId === "string" && typeof v.version === "string" && typeof v.from === "string"
    && typeof v.committedAt === "string" && typeof v.expiresAt === "string" && typeof v.snapshotDir === "string"
    && !!v.preimage && typeof v.preimage.dir === "string" && typeof v.preimage.manifestSha256 === "string"
    && (v.unitPreimage === null || typeof v.unitPreimage === "string") && typeof v.kit === "string";
};

/** The retained entries; absent reads as none. An unreadable or malformed file is reported, never treated as empty. */
export function readRetained(home: string, io: JournalIo = defaultJournalIo): RetainedRead {
  let text: string | null;
  try { text = io.read(retainedPath(home)); }
  catch (err) { return { ok: false, reason: `${retainedPath(home)} can't be read (${(err as Error).message})` }; }
  if (text === null) return { ok: true, entries: [] };
  try {
    const v = JSON.parse(text) as { schema?: unknown; entries?: unknown };
    if (v.schema !== 1 || !Array.isArray(v.entries) || !v.entries.every(isEntry)) return { ok: false, reason: `${retainedPath(home)} is malformed` };
    return { ok: true, entries: v.entries };
  } catch { return { ok: false, reason: `${retainedPath(home)} isn't JSON` }; }
}

/** §5.6: record a committing attempt's artifacts for Go back. The caller holds the home lock. */
export function recordRetained(home: string, attempt: AttemptRecord, io: JournalIo = defaultJournalIo): { ok: true; entry: RetainedEntry } | { ok: false; reason: string } {
  const id = identityOf(attempt);
  const intent = attempt.intent as { preimage?: { dir?: unknown; manifestSha256?: unknown } } | undefined;
  if (!id) return { ok: false, reason: "the attempt's recorded ownership is missing or malformed" };
  if (typeof intent?.preimage?.dir !== "string" || typeof intent.preimage.manifestSha256 !== "string") return { ok: false, reason: "the attempt records no package preimage" };
  const read = readRetained(home, io);
  if (!read.ok) return read;
  const at = io.now();
  const entry: RetainedEntry = {
    attemptId: attempt.id, version: attempt.to.version, from: attempt.from.version,
    committedAt: at.toISOString(), expiresAt: new Date(at.getTime() + RETAIN_MS).toISOString(),
    snapshotDir: attemptDir(home, attempt.id),
    preimage: { dir: intent.preimage.dir, manifestSha256: intent.preimage.manifestSha256 },
    unitPreimage: id.ownership.service ? unitPreimagePath(home, attempt.id) : null,
    kit: kitDir(home, attempt.id),
  };
  const kept = read.entries.find(e => e.attemptId === attempt.id);
  if (kept) return { ok: true, entry: kept };                                     // a retry: the first record stands
  const body = JSON.stringify({ schema: 1, entries: [...read.entries, entry] }, null, 2) + "\n";
  const path = retainedPath(home), tmp = `${path}.tmp`;
  try {
    try { io.unlink(tmp); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }   // a crashed write's own tmp
    io.writeSynced(tmp, body); io.step(`write:${RETAINED_FILE}.tmp`);
    io.rename(tmp, path); io.step(`rename:${RETAINED_FILE}`);
    io.fsyncDir(journalDir(home)); io.step("fsync-dir:.update-journal");
  } catch (err) { return { ok: false, reason: `${path} can't be written (${(err as Error).message})` }; }
  return { ok: true, entry };
}
