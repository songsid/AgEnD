/**
 * M-2423: real Codex (0.165, Linux repro) leaves a non-empty state_5.sqlite-wal after a clean exit, so the completed
 * absence proof of #3001 could never say "absent" and an unwritten pin always waited for an administrator. The WAL is now
 * read through a private snapshot copy (DB + WAL), never by opening the provider's files for writing; only a well-formed
 * WAL counts, a thread row living only in the WAL still blocks absence, and nothing is left behind.
 */
import { afterEach, expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync, appendFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeCodexSessionState } from "../src/runtime-pane-transcript.js";
import { coherentSqliteWal } from "../src/runtime-pane-codex-index.js";

const cleanup: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true }); });

/** A Codex profile whose state_5.sqlite has uncheckpointed WAL frames, as a cleanly exited Codex leaves it. */
function fixture(walRows: string[]) {
  const root = mkdtempSync(join(tmpdir(), "codex-proof-wal-")); cleanup.push(root);
  const cwd = join(root, "cwd"), codex = join(root, "codex"), side = join(root, "side"), id = randomUUID();
  for (const d of [cwd, codex, side, join(codex, "sessions", "2026", "11", "06"), join(codex, "archived_sessions")]) mkdirSync(d, { recursive: true });
  const src = join(side, "state_5.sqlite"), db = new DatabaseSync(src);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE threads(id TEXT PRIMARY KEY)");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  for (const row of walRows) db.prepare("INSERT INTO threads VALUES(?)").run(row === "$id" ? id : row);
  // Copy while the writer is open: the frames are still only in the WAL.
  const dbPath = join(codex, "state_5.sqlite");
  copyFileSync(src, dbPath); copyFileSync(src + "-wal", dbPath + "-wal"); copyFileSync(src + "-shm", dbPath + "-shm");
  db.close();
  const proof = () => nativeCodexSessionState(cwd, id, () => true, { codex, claude: join(root, "unused") });
  return { root, cwd, codex, id, dbPath, proof };
}
const digest = (dir: string) => readdirSync(dir).sort().map((n) => n.endsWith("sqlite") || n.includes("sqlite-") ? `${n}:${createHash("sha256").update(readFileSync(join(dir, n))).digest("hex")}` : n);
const snapshots = () => readdirSync(tmpdir()).filter((n) => n.startsWith("agend-codex-proof-"));

it("a cleanly exited Codex's WAL with no row for the pin proves absent; the provider's DB, WAL and -shm are untouched", async () => {
  const f = fixture([randomUUID(), randomUUID()]);
  expect(readFileSync(f.dbPath + "-wal").length).toBeGreaterThan(32);
  const before = digest(f.codex), leftovers = snapshots();
  expect(await f.proof()).toBe("absent");
  expect(digest(f.codex)).toEqual(before);
  expect(snapshots()).toEqual(leftovers);
});

it("a thread row that exists only in the WAL is never read as absence (any case)", async () => {
  expect(await fixture(["$id"]).proof()).toBe("unknown");
  const f = fixture([]); const db = new DatabaseSync(join(f.root, "side", "state_5.sqlite"));
  db.exec("PRAGMA wal_autocheckpoint=0"); db.prepare("INSERT INTO threads VALUES(?)").run(f.id.toUpperCase());
  copyFileSync(join(f.root, "side", "state_5.sqlite-wal"), f.dbPath + "-wal"); db.close();
  expect(await f.proof()).toBe("unknown");
});

it.each(["torn", "garbage", "no-db", "grown"])("a %s WAL stays unknown", async (kind) => {
  const f = fixture([randomUUID()]), wal = f.dbPath + "-wal";
  if (kind === "torn") truncateSync(wal, readFileSync(wal).length - 10);
  if (kind === "garbage") writeFileSync(wal, Buffer.alloc(4096 + 24 + 32, 7));
  if (kind === "no-db") rmSync(f.dbPath);
  if (kind === "grown") {
    const mod = await import("../src/runtime-pane-codex-index.js");
    const real = mod.codexIndexHasNoThread;
    vi.spyOn(mod, "codexIndexHasNoThread").mockImplementation(async (...args) => { const r = await real(...args); appendFileSync(wal, Buffer.alloc(4096 + 24)); return r; });
  }
  expect(await f.proof()).toBe("unknown");
});

// Prism R1 (#3219): SQLite drops a WAL whose header checksum, frame checksum or frame salt fails and then answers from
// the older main file, so each of those flips on the WAL holding the only row must stay unknown, never absent.
it.each([["header checksum", 24], ["first frame checksum", 48], ["first frame salt-1", 40], ["first frame salt-2", 44], ["page byte", 32 + 24 + 100]])
("a bit flip in the %s of a WAL holding the only row is unknown", async (_what, offset) => {
  const f = fixture(["$id"]); expect(await f.proof()).toBe("unknown");
  const wal = f.dbPath + "-wal", bytes = readFileSync(wal); bytes[offset as number] ^= 1; writeFileSync(wal, bytes);
  expect(coherentSqliteWal(bytes)).toBe(false);
  expect(await f.proof()).toBe("unknown");
});

it("a valid WAL (control) verifies; the real, coherent one with no row for the pin proves absent", async () => {
  const f = fixture([randomUUID()]); expect(coherentSqliteWal(readFileSync(f.dbPath + "-wal"))).toBe(true); expect(await f.proof()).toBe("absent");
});

/** A WAL SQLite restarted after a checkpoint: a short new generation at the front, the old generation's frames behind it. */
function restartedFixture(newRow: "$id" | "other") {
  const f = fixture([]), side = join(f.root, "side", "state_5.sqlite"), db = new DatabaseSync(side);
  db.exec("PRAGMA wal_autocheckpoint=0");
  for (let n = 0; n < 40; n++) db.prepare("INSERT INTO threads VALUES(?)").run(randomUUID() + "-" + "x".repeat(400));
  db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  db.prepare("INSERT INTO threads VALUES(?)").run(newRow === "$id" ? f.id : randomUUID());
  copyFileSync(side, f.dbPath); copyFileSync(side + "-wal", f.dbPath + "-wal"); db.close();
  return f;
}
it("a restarted WAL with an older generation behind the newest commit is coherent and still read exactly", async () => {
  const absent = restartedFixture("other"), wal = readFileSync(absent.dbPath + "-wal");
  // The fixture really has the shape: current-generation first frame, an older generation's last frame.
  const lastFrame = wal.length - (24 + wal.readUInt32BE(8));
  expect(wal.readUInt32BE(32 + 8)).toBe(wal.readUInt32BE(16));
  expect(wal.readUInt32BE(lastFrame + 8)).not.toBe(wal.readUInt32BE(16));
  expect(coherentSqliteWal(wal)).toBe(true);
  expect(await absent.proof()).toBe("absent");
  expect(await restartedFixture("$id").proof()).toBe("unknown");
});

it("frame-level shapes SQLite would silently drop are not coherent", () => {
  const f = fixture([randomUUID(), randomUUID()]), good = readFileSync(f.dbPath + "-wal"), page = good.readUInt32BE(8), frame = 24 + page;
  expect(coherentSqliteWal(good)).toBe(true);
  // An uncommitted (torn) last transaction: clear the commit marker of the final frame.
  const torn = Buffer.from(good); torn.writeUInt32BE(0, good.length - frame + 4); expect(coherentSqliteWal(torn)).toBe(false);
  // A later frame whose salt-2 alone changed (salt-1 equal): damage, not an older generation.
  const late = Buffer.from(good); late[good.length - frame + 12] ^= 1; expect(coherentSqliteWal(late)).toBe(false);
  // A frame of the current generation with page number 0.
  const zero = Buffer.from(good); zero.writeUInt32BE(0, 32); expect(coherentSqliteWal(zero)).toBe(false);
  // A not frame-aligned tail, a foreign magic/version/page size, too short.
  expect(coherentSqliteWal(good.subarray(0, good.length - 10))).toBe(false);
  for (const [at, value] of [[0, 0x12345678], [4, 3007001], [8, 3000]] as const) { const b = Buffer.from(good); b.writeUInt32BE(value, at); expect(coherentSqliteWal(b)).toBe(false); }
  expect(coherentSqliteWal(Buffer.alloc(16))).toBe(false);
});
