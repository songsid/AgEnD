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
import { completeSqliteWal } from "../src/runtime-pane-codex-index.js";

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

it("only a well-formed, frame-aligned SQLite WAL header is accepted", () => {
  const header = (magic: number, version: number, page: number, frames: number) => {
    const b = Buffer.alloc(32 + frames * (24 + (page === 1 ? 65536 : page))); b.writeUInt32BE(magic, 0); b.writeUInt32BE(version, 4); b.writeUInt32BE(page, 8); return b;
  };
  expect(completeSqliteWal(header(0x377f0682, 3007000, 4096, 2))).toBe(true);
  expect(completeSqliteWal(header(0x377f0683, 3007000, 1, 1))).toBe(true);
  expect(completeSqliteWal(header(0x377f0682, 3007000, 4096, 0))).toBe(true);
  expect(completeSqliteWal(header(0x12345678, 3007000, 4096, 1))).toBe(false);
  expect(completeSqliteWal(header(0x377f0682, 3007001, 4096, 1))).toBe(false);
  expect(completeSqliteWal(header(0x377f0682, 3007000, 3000, 1))).toBe(false);
  expect(completeSqliteWal(header(0x377f0682, 3007000, 4096, 1).subarray(0, 100))).toBe(false);
  expect(completeSqliteWal(Buffer.alloc(16))).toBe(false);
});
