// M-3770 slice 2.3 (design update-transaction §4.5, §5.2, §5.3): the snapshot on a real temp home seeded like S-233 —
// WAL databases with committed frames not yet checkpointed (kept) and a torn uncommitted tail (not), a Hub database, a
// symlinked directory and a symlinked database parent (never followed), excluded user state and caches — the exact-set
// verification, a writer appearing mid-copy (discarded), and the refusals.
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readManifest, SNAPSHOT_DIR, SNAPSHOT_MANIFEST, takeSnapshot, verifySnapshot, walkScope } from "../src/update-snapshot.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (p = "snap-") => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const gone = { proveWritersGone: () => ({ ok: true as const }) };

/**
 * A database left with committed WAL frames not yet checkpointed: written in another directory with autocheckpoint
 * off, its `.db` and `-wal` copied while the writer still holds them open (so nothing is checkpointed), then a torn
 * uncommitted tail appended to the copy's WAL.
 */
function walDatabase(at: string, rows: string[], tornTail = true): void {
  const scratch = tmp("wal-src-"), src = join(scratch, "x.db");
  const db = new Database(src);
  db.pragma("journal_mode = WAL"); db.pragma("wal_autocheckpoint = 0");
  db.exec("CREATE TABLE t (v TEXT)"); db.pragma("user_version = 7");
  const ins = db.prepare("INSERT INTO t VALUES (?)");
  for (const r of rows) ins.run(r);
  if (tornTail) {
    // Real uncommitted frames: a transaction whose pages spill into the WAL (a one-page cache) and never commits;
    // the files are copied mid-transaction, then it is rolled back.
    db.pragma("cache_size = 1");
    db.exec("BEGIN");
    for (let i = 0; i < 300; i++) ins.run(`uncommitted-${i}-${"u".repeat(400)}`);
    copyFileSync(src, at); copyFileSync(`${src}-wal`, `${at}-wal`);
    db.exec("ROLLBACK");
  } else {
    copyFileSync(src, at); copyFileSync(`${src}-wal`, `${at}-wal`);
  }
  db.close();
  if (tornTail) appendFileSync(`${at}-wal`, Buffer.alloc(4096 + 24, 0xab));          // and a torn frame after them
}

function seed(): string {
  const home = join(tmp(), "home"); mkdirSync(home);
  writeFileSync(join(home, "fleet.yaml"), "instances: {}\n");
  walDatabase(join(home, "events.db"), ["committed-1", "committed-2"]);
  mkdirSync(join(home, "hub")); walDatabase(join(home, "hub", "hub.db"), ["hub-row"], false);
  mkdirSync(join(home, "instances", "a"), { recursive: true });
  writeFileSync(join(home, "instances", "a", "session.jsonl"), "{}\n");
  writeFileSync(join(home, "instances", "a", "output.log"), "log\n");                      // excluded
  mkdirSync(join(home, "workspaces", "a"), { recursive: true }); writeFileSync(join(home, "workspaces", "a", "f"), "w");   // excluded
  mkdirSync(join(home, "credential-profiles", "claude-code", "p"), { recursive: true });
  writeFileSync(join(home, "credential-profiles", "claude-code", "p", ".claude.json"), "{}");                          // excluded
  mkdirSync(join(home, "cache")); writeFileSync(join(home, "cache", "c"), "c");             // excluded
  writeFileSync(join(home, ".state-lease.sqlite"), "lease");                                // excluded
  // Links the snapshot can record: to a plain file, and a dangling one.
  symlinkSync("fleet.yaml", join(home, "fleet-link"));
  symlinkSync("nowhere", join(home, "dangling-link"));
  return home;
}

/** The rows of a snapshot database, read from a scratch copy: opening a WAL database creates its -wal/-shm beside it. */
const rowsOf = (path: string) => {
  const copy = join(tmp("read-"), "copy.db"); copyFileSync(path, copy);
  const db = new Database(copy, { readonly: true });
  try { return (db.prepare("SELECT v FROM t").all() as Array<{ v: string }>).map(r => r.v); } finally { db.close(); }
};

describe("M-3770 §5.2–5.3: the snapshot", () => {
  it("copies the scope exactly: committed WAL frames kept, the torn tail not; excluded paths and links' targets never copied", () => {
    const home = seed(), attempt = tmp("attempt-");
    const res = takeSnapshot(home, attempt, gone);
    if (!res.ok) throw new Error(res.reason);
    const snap = join(attempt, SNAPSHOT_DIR);
    expect(rowsOf(join(snap, "events.db"))).toEqual(["committed-1", "committed-2"]);                    // no uncommitted row
    const wal = join(home, "events.db-wal");                                                         // checkpointed (TRUNCATE): empty, or removed on close
    expect(!existsSync(wal) || statSync(wal).size === 0).toBe(true);
    expect(rowsOf(join(snap, "hub", "hub.db"))).toEqual(["hub-row"]);
    for (const sidecar of ["events.db-wal", "events.db-shm", "hub/hub.db-wal"]) expect(existsSync(join(snap, sidecar)), sidecar).toBe(false);
    for (const excluded of ["instances/a/output.log", "workspaces", "credential-profiles", "cache", ".state-lease.sqlite"]) expect(existsSync(join(snap, excluded)), excluded).toBe(false);
    expect(lstatSync(join(snap, "dangling-link")).isSymbolicLink()).toBe(true);
    expect(res.manifest.databases.map(d => d.rel)).toEqual(["events.db", "hub/hub.db"]);
    expect(res.manifest.databases[0]).toMatchObject({ userVersion: 7, schemaSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(res.manifest.entries.find(e => e.rel === "fleet-link")).toEqual({ rel: "fleet-link", type: "link", mode: expect.any(Number), target: "fleet.yaml" });
    expect(readFileSync(join(snap, "instances", "a", "session.jsonl"), "utf8")).toBe("{}\n");
    expect(readManifest(attempt)).toEqual(res.manifest);
    expect(verifySnapshot(attempt, res.manifest)).toEqual({ ok: true });
  });

  it("keeps modes and mtimes, and never writes into the home", () => {
    const home = seed(), attempt = tmp("attempt-");
    const before = statSync(join(home, "fleet.yaml"));
    const res = takeSnapshot(home, attempt, gone);
    if (!res.ok) throw new Error(res.reason);
    const copied = statSync(join(attempt, SNAPSHOT_DIR, "fleet.yaml"));
    expect(copied.mode & 0o7777).toBe(before.mode & 0o7777);
    expect(Math.abs(copied.mtimeMs - before.mtimeMs)).toBeLessThan(2);                                 // utimes' float precision
    expect(existsSync(join(home, SNAPSHOT_DIR))).toBe(false);
  });

  it("the exact-set verification catches an extra, a missing, a changed file and a re-pointed link", () => {
    const home = seed(), attempt = tmp("attempt-");
    const res = takeSnapshot(home, attempt, gone);
    if (!res.ok) throw new Error(res.reason);
    const snap = join(attempt, SNAPSHOT_DIR);
    writeFileSync(join(snap, "extra"), "x");
    expect(verifySnapshot(attempt, res.manifest)).toMatchObject({ ok: false, reason: expect.stringMatching(/entries/) });
    rmSync(join(snap, "extra"));
    writeFileSync(join(snap, "fleet.yaml"), "changed");
    expect(verifySnapshot(attempt, res.manifest)).toMatchObject({ ok: false, reason: expect.stringMatching(/fleet.yaml differs/) });
    writeFileSync(join(snap, "fleet.yaml"), "instances: {}\n");
    rmSync(join(snap, "fleet-link")); symlinkSync("elsewhere", join(snap, "fleet-link"));
    expect(verifySnapshot(attempt, res.manifest)).toMatchObject({ ok: false, reason: expect.stringMatching(/points elsewhere/) });
    rmSync(join(snap, "fleet-link"));
    writeFileSync(join(snap, "fleet-link"), "now a file");
    expect(verifySnapshot(attempt, res.manifest)).toMatchObject({ ok: false, reason: expect.stringMatching(/is a file, not a link/) });
  });
});

describe("M-3770 §4.4, §5.2: what refuses the snapshot (nothing partial is left)", () => {
  it("a writer present before, or appearing during the copy: refused and discarded", () => {
    const home = seed(), attempt = tmp("attempt-");
    expect(takeSnapshot(home, attempt, { proveWritersGone: () => ({ ok: false, reason: "pid 99 has fleet.yaml open" }) })).toMatchObject({ ok: false, reason: expect.stringMatching(/writers are present: pid 99/) });
    expect(existsSync(join(attempt, SNAPSHOT_DIR))).toBe(false);
    let calls = 0;
    const res = takeSnapshot(home, attempt, { proveWritersGone: () => (++calls === 1 ? { ok: true } : { ok: false, reason: "pid 77 appeared" }) });
    expect(res).toMatchObject({ ok: false, reason: expect.stringMatching(/appeared during the copy: pid 77/) });
    expect(existsSync(join(attempt, SNAPSHOT_DIR))).toBe(false);
    expect(existsSync(join(attempt, SNAPSHOT_MANIFEST))).toBe(false);
  });

  it("a checkpoint that can't complete (a reader still holds the WAL) refuses: the copy would lack committed frames", () => {
    const home = seed(), attempt = tmp("attempt-");
    const reader = new Database(join(home, "events.db"), { readonly: true });
    reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM t").get();                              // a read snapshot pins the WAL
    try {
      expect(takeSnapshot(home, attempt, gone)).toMatchObject({ ok: false, reason: expect.stringMatching(/events\.db's checkpoint is incomplete/) });
      expect(existsSync(join(attempt, SNAPSHOT_DIR))).toBe(false);
    } finally { reader.exec("COMMIT"); reader.close(); }
  });

  it("a FIFO (neither file, directory nor link) refuses", () => {
    const home = seed(), attempt = tmp("attempt-");
    expect(spawnSync("mkfifo", [join(home, "fifo")]).status).toBe(0);
    expect(takeSnapshot(home, attempt, gone)).toMatchObject({ ok: false, reason: expect.stringMatching(/fifo is neither a file/) });
    expect(existsSync(join(attempt, SNAPSHOT_DIR))).toBe(false);
  });

  it("a database that fails its quick_check refuses", () => {
    const home = seed(), attempt = tmp("attempt-");
    const p = join(home, "scheduler.db");
    const db = new Database(p); db.exec("CREATE TABLE t (v TEXT)"); for (let i = 0; i < 200; i++) db.prepare("INSERT INTO t VALUES (?)").run("x".repeat(100)); db.close();
    const buf = readFileSync(p); buf.fill(0x5a, 4096, 8192); writeFileSync(p, buf);                     // corrupt page 2, keep the header
    const res = takeSnapshot(home, attempt, gone);
    expect(res).toMatchObject({ ok: false });
    expect(existsSync(join(attempt, SNAPSHOT_DIR))).toBe(false);
  });

  it("a link to a directory or to a database refuses — the rollback couldn't restore what's behind it (Fable #4523 F2)", () => {
    const outside = join(tmp("outside-"), "d"); mkdirSync(outside); walDatabase(join(outside, "secret.db"), ["outside"], false);
    const linkedDir = seed();
    symlinkSync(outside, join(linkedDir, "linked-dir"));
    expect(takeSnapshot(linkedDir, tmp("attempt-"), gone)).toMatchObject({ ok: false, reason: expect.stringMatching(/linked-dir is a link to a directory/) });
    const linkedDb = seed();
    symlinkSync(join(outside, "secret.db"), join(linkedDb, "hub.db"));
    expect(takeSnapshot(linkedDb, tmp("attempt-"), gone)).toMatchObject({ ok: false, reason: expect.stringMatching(/hub\.db is a link to a SQLite database/) });
    // A link to a plain file, and a dangling link, are recorded (the seed has both).
    const walked = walkScope(seed());
    expect(walked.entries.filter(e => e.type === "link").map(e => e.rel)).toEqual(["dangling-link", "fleet-link"]);
  });

  it("the walk refuses nothing that's excluded", () => {
    const home = seed();
    writeFileSync(join(home, "operator.sock"), "");                                                   // excluded *.sock
    expect(walkScope(home).files).not.toContain("operator.sock");
  });

  it("a snapshot already present is never touched: a second call refuses, and the first still verifies (Fable #4523 F1)", () => {
    const home = seed(), attempt = tmp("attempt-");
    const first = takeSnapshot(home, attempt, gone);
    if (!first.ok) throw new Error(first.reason);
    expect(takeSnapshot(home, attempt, gone)).toMatchObject({ ok: false, reason: expect.stringMatching(/already here/) });
    expect(verifySnapshot(attempt, first.manifest)).toEqual({ ok: true });
    expect(readManifest(attempt)).toEqual(first.manifest);
    // A manifest alone (no snapshot directory) refuses too, and is kept.
    const other = tmp("attempt-");
    writeFileSync(join(other, SNAPSHOT_MANIFEST), "{}");
    expect(takeSnapshot(home, other, gone)).toMatchObject({ ok: false, reason: expect.stringMatching(/already here/) });
    expect(readFileSync(join(other, SNAPSHOT_MANIFEST), "utf8")).toBe("{}");
  });

  it("a snapshot directory that appears after the up-front check (another taker) is kept when this call fails on it", () => {
    const home = seed(), attempt = tmp("attempt-");
    const theirs = join(attempt, SNAPSHOT_DIR);
    const res = takeSnapshot(home, attempt, { proveWritersGone: () => { if (!existsSync(theirs)) { mkdirSync(theirs); writeFileSync(join(theirs, "theirs"), "x"); } return { ok: true }; } });
    expect(res).toMatchObject({ ok: false, reason: expect.stringMatching(/EEXIST/) });
    expect(readFileSync(join(theirs, "theirs"), "utf8")).toBe("x");                                // not this call's: untouched
  });
});
