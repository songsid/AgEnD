import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1490 (2.2 audit): while the Kiro store has no row for an instance, its transcript source fell back to the legacy
 * session files on every 2 s poll with `readdirSync` plus a `statSync` of every metadata file, on the event loop
 * (5,000 sessions: 16–18 ms per instance per poll). These pin the replacement: asynchronous, a poll stats only the
 * directory and recently active files, a full scan every KIRO_FULL_SCAN_MS, at most KIRO_SCAN_CONCURRENCY at a time.
 *
 * The real KiroSessionSource on a scratch sessions directory; `node:fs` and `node:fs/promises` pass through,
 * recorded for paths under that directory.
 */

const io = vi.hoisted(() => ({ dir: "", sync: [] as string[], stats: [] as string[], listings: 0, inFlight: 0, maxInFlight: 0, statDelayMs: 0 }));
const under = (p: unknown) => typeof p === "string" && io.dir !== "" && p.startsWith(io.dir);
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const watch = <F extends (...a: any[]) => any>(name: string, fn: F) =>
    ((...a: Parameters<F>) => { if (under(a[0])) io.sync.push(`${name} ${a[0]}`); return fn(...a); }) as F;
  return { ...real, readdirSync: watch("readdirSync", real.readdirSync), statSync: watch("statSync", real.statSync),
    readFileSync: watch("readFileSync", real.readFileSync), existsSync: watch("existsSync", real.existsSync) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    readdir: (async (...a: any[]) => { if (under(a[0])) io.listings++; return (real.readdir as any)(...a); }) as typeof real.readdir,
    stat: async (...a: Parameters<typeof real.stat>) => {
      if (!under(a[0])) return real.stat(...a);
      io.stats.push(String(a[0]));
      io.inFlight++; io.maxInFlight = Math.max(io.maxInFlight, io.inFlight);
      try {
        if (io.statDelayMs) await new Promise((r) => setTimeout(r, io.statDelayMs));
        return await real.stat(...a);
      } finally { io.inFlight--; }
    },
  };
});

const { KiroSessionSource, KIRO_FULL_SCAN_MS, KIRO_SCAN_CONCURRENCY } = await import("../src/transcript-sources.js");

let root: string, sessions: string, work: string;
let clock = 0;
const HOUR_AGO = () => new Date(Date.now() - 60 * 60_000);
const pin = (path: string, at: Date) => utimesSync(path, at, at);

function writeSession(id: string, cwd: string, updatedAt: string, at: Date): void {
  const metaPath = join(sessions, `${id}.json`);
  writeFileSync(metaPath, JSON.stringify({ session_id: id, cwd, created_at: updatedAt, updated_at: updatedAt }));
  writeFileSync(join(sessions, `${id}.jsonl`), "");
  pin(metaPath, at);
}
function source() {
  const s = new KiroSessionSource(work, sessions, Date.now(), join(root, "missing.sqlite3"));
  (s as unknown as { mono: () => number }).mono = () => clock;
  return s;
}
const active = async (s: InstanceType<typeof KiroSessionSource>) =>
  (await (s as unknown as { resolveActiveSession(): Promise<{ jsonlPath: string } | null> }).resolveActiveSession())?.jsonlPath;
const metaStats = () => io.stats.filter((p) => p.endsWith(".json")).length;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agend-kiro-scan-"));
  sessions = join(root, "sessions");
  work = join(root, "work");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(work);
  io.dir = sessions; io.sync = []; io.stats = []; io.listings = 0; io.inFlight = 0; io.maxInFlight = 0; io.statDelayMs = 0;
  clock = 1_000_000;
});
afterEach(() => { io.dir = ""; rmSync(root, { recursive: true, force: true }); });

describe("the Kiro legacy session scan (#1490)", () => {
  it("runs without a synchronous fs call on the sessions directory", async () => {
    writeSession("mine", work, "2026-10-04T10:00:00Z", new Date());
    const s = source();
    await s.poll();
    expect(await active(s)).toBe(join(sessions, "mine.jsonl"));
    expect(io.sync, "no readdirSync / statSync / readFileSync / existsSync on the poll path").toEqual([]);
    s.close();
  });

  it("between full scans a poll stats the directory and the recently active files, not every session", async () => {
    for (let i = 0; i < 50; i++) writeSession(`old-${String(i).padStart(2, "0")}`, "/elsewhere", "2026-10-01T10:00:00Z", HOUR_AGO());
    writeSession("mine", work, "2026-10-04T10:00:00Z", new Date());
    pin(sessions, HOUR_AGO());                    // the directory has not changed lately
    const s = source();
    expect(await active(s)).toBe(join(sessions, "mine.jsonl"));
    expect(metaStats(), "the first scan is a full one").toBe(51);

    io.stats = []; io.listings = 0;
    clock += KIRO_FULL_SCAN_MS - 1;
    expect(await active(s)).toBe(join(sessions, "mine.jsonl"));
    expect(metaStats(), "only the active session's metadata").toBe(1);
    expect(io.listings, "an unchanged directory is not listed again").toBe(0);

    io.stats = [];
    clock += 1;
    await active(s);
    expect(metaStats(), "a full scan again after KIRO_FULL_SCAN_MS").toBe(51);
    s.close();
  });

  it("an old session resumed without touching the directory is found by the next full scan", async () => {
    writeSession("older", work, "2026-10-04T09:00:00Z", HOUR_AGO());
    writeSession("newer", work, "2026-10-04T10:00:00Z", HOUR_AGO());
    pin(sessions, HOUR_AGO());
    const s = source();
    expect(await active(s)).toBe(join(sessions, "newer.jsonl"));

    writeSession("older", work, "2026-10-04T11:00:00Z", new Date());   // resumed: rewritten in place
    pin(sessions, HOUR_AGO());
    clock += 1_000;
    expect(await active(s), "quiet files are not re-stat'ed between full scans").toBe(join(sessions, "newer.jsonl"));
    clock += KIRO_FULL_SCAN_MS;
    expect(await active(s)).toBe(join(sessions, "older.jsonl"));
    s.close();
  });

  it("a new session (the directory changed) is found on the next poll", async () => {
    writeSession("first", work, "2026-10-04T09:00:00Z", HOUR_AGO());
    pin(sessions, HOUR_AGO());
    const s = source();
    expect(await active(s)).toBe(join(sessions, "first.jsonl"));
    writeSession("second", work, "2026-10-04T10:00:00Z", new Date());  // bumps the directory's mtime
    clock += 1_000;
    expect(await active(s)).toBe(join(sessions, "second.jsonl"));
    s.close();
  });

  it(`stats at most ${KIRO_SCAN_CONCURRENCY} files at a time`, async () => {
    for (let i = 0; i < 60; i++) writeSession(`s-${String(i).padStart(2, "0")}`, "/elsewhere", "2026-10-01T10:00:00Z", HOUR_AGO());
    io.statDelayMs = 5;
    const s = source();
    await active(s);
    expect(metaStats()).toBe(60);
    expect(io.maxInFlight).toBeGreaterThan(1);
    expect(io.maxInFlight).toBeLessThanOrEqual(KIRO_SCAN_CONCURRENCY);
    s.close();
  });
});
