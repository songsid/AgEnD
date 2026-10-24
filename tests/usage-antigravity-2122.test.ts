/**
 * #2122 §10 step 6: Antigravity's usage, measured — each generation's usage in agy's conversation databases (a protobuf
 * in SQLite, tokscale's field map), by the workspace the conversation records. The databases are built here with the
 * same tables and field numbers agy 1.4.6 wrote on the host.
 */
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { antigravityGeneration, antigravityUsageSupported, scanAntigravityUsage, type AntigravityScanInput } from "../src/antigravity-usage-scan.js";
import { runAntigravityUsageScan } from "../src/kiro-usage-run.js";
import { CacheService, type CacheInstance } from "../src/cache-service.js";
import { buildUsageReport } from "../src/usage-report.js";

const NOW = Date.UTC(2026, 9, 18, 12), T = (h: number) => Date.UTC(2026, 9, 17, h);
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-agy-usage-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

// ── A protobuf writer for the fixtures: [field, value] pairs; a number is a varint, a string or nested list a message.
type PB = Array<[number, number | string | PB]>;
const varint = (n: number): number[] => { const out: number[] = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return out; };
const pb = (fields: PB): Buffer => Buffer.from(fields.flatMap(([n, v]) => {
  if (typeof v === "number") return [...varint(n * 8), ...varint(v)];
  const body = typeof v === "string" ? Buffer.from(v) : pb(v);
  return [...varint(n * 8 + 2), ...varint(body.length), ...body];
}));
const ts = (ms: number): PB => [[1, Math.floor(ms / 1000)], [2, (ms % 1000) * 1e6]];
const gen = (o: { input?: number; read?: number; out?: number; think?: number; id?: string; model?: string; label?: string; at?: number }): Buffer => pb([[1, [
  [4, [[1, 1132], [2, o.input ?? 500], ...(o.read ? [[5, o.read] as [number, number]] : []), ...(o.out !== undefined ? [[9, o.out] as [number, number]] : []), [10, o.think ?? 40], ...(o.id ? [[11, o.id] as [number, string]] : [])]],
  ...(o.at ? [[9, [[4, ts(o.at)]]] as [number, PB]] : []),
  ...(o.model ? [[19, o.model] as [number, string]] : []), ...(o.label ? [[21, o.label] as [number, string]] : []),
]]]);

function conversations() {
  const root = tmp(), dir = join(root, "conversations"), cwd = join(root, "agy-work"), other = join(root, "other");
  mkdirSync(dir); mkdirSync(cwd); mkdirSync(other);
  const make = (name: string, ws: string, created: number, gens: Array<[number, Buffer]>, steps: Buffer[] = []) => {
    const db = new Database(join(dir, `${name}.db`));
    db.exec("CREATE TABLE trajectory_metadata_blob (data BLOB); CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB); CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)");
    db.prepare("INSERT INTO trajectory_metadata_blob VALUES (?)").run(pb([[1, [[1, pathToFileURL(ws).href]]], [2, ts(created)]]));
    for (const [i, g] of gens) db.prepare("INSERT OR REPLACE INTO gen_metadata VALUES (?, ?)").run(i, g);
    steps.forEach((s, i) => db.prepare("INSERT INTO steps VALUES (?, 15, ?)").run(i, s));
    db.close();
    return join(dir, `${name}.db`);
  };
  return { root, dir, cwd, other, make };
}
const input = (c: ReturnType<typeof conversations>, cursors: AntigravityScanInput["instances"][number]["cursors"] = {}, index: AntigravityScanInput["index"] = {}): AntigravityScanInput =>
  ({ dir: c.dir, cutoff: NOW - 31 * 86_400_000, index, instances: [{ name: "agy", cwds: [c.cwd], cursors }] });

describe("a generation", () => {
  const at = { steps: new Map<string, number>(), byIdx: new Map<number, number>(), fallback: T(1) };
  it("input = system prompt + new input, cache read apart, output = text + thinking with thinking as reasoning", () => {
    expect(antigravityGeneration(0, gen({ input: 500, read: 16_000, out: 300, think: 40, id: "r1", model: "gemini-3-flash-a", at: T(9) }), at))
      .toMatchObject({ t: T(9), model: "gemini-3-flash-a", uncached: 1632, read: 16_000, output: 340, reasoning: 40, prompt: 17_632, write: null });
  });
  it("no #9 output text is 0 (thinking only); the routing label is no model; the time from the steps when the row has none", () => {
    const steps = { ...at, steps: new Map([["r2", T(10)]]), byIdx: new Map([[7, T(11)]]) };
    expect(antigravityGeneration(0, gen({ id: "r2", model: "gemini-default" }), steps)).toMatchObject({ t: T(10), model: "", output: 40, reasoning: 40 });
    expect(antigravityGeneration(7, gen({}), steps)).toMatchObject({ t: T(11) });
    expect(antigravityGeneration(8, gen({}), steps)).toMatchObject({ t: T(1) });
  });
});

describe("the scan", () => {
  it("its workspace's conversations only; each responseId once; a row without a model takes its label's", () => {
    const c = conversations();
    c.make("a", c.cwd, T(8), [[0, gen({ id: "r1", model: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", at: T(9) })], [1, gen({ id: "r1", at: T(9) })],
      [2, gen({ id: "r2", label: "Claude Sonnet 4.6", at: T(10) })]]);
    c.make("b", c.other, T(8), [[0, gen({ id: "x", model: "gemini-3-flash-a", at: T(9) })]]);
    const r = scanAntigravityUsage(input(c)).instances[0]!;
    expect([r.failed, r.live.length, r.updates[0]!.turns.map(t => [t.t, t.model])]).toEqual([false, 1, [[T(9), "claude-sonnet-4-6"], [T(10), "claude-sonnet-4-6"]]]);
  });
  it("a label two models share is ambiguous: a row without #19 stays unknown (Prism #2609)", () => {
    const c = conversations();
    c.make("a", c.cwd, T(8), [[0, gen({ id: "r1", model: "claude-sonnet-4-5", label: "Sonnet", at: T(9) })], [1, gen({ id: "r2", model: "claude-sonnet-4-6", label: "Sonnet", at: T(9) })],
      [2, gen({ id: "r3", label: "Sonnet", at: T(10) })]]);
    expect(scanAntigravityUsage(input(c)).instances[0]!.updates[0]!.turns.map(t => t.model)).toEqual(["claude-sonnet-4-5", "claude-sonnet-4-6", "unknown"]);
  });
  it("a step without a generation index (#20 with no #3) dates nothing; an explicit index 0 does (Prism #2609)", () => {
    const c = conversations();
    const step = (at: number, idx: number | null) => pb([[1, ts(at)], [20, idx === null ? [[1, 5]] : [[1, 5], [3, idx]]]]);
    c.make("a", c.cwd, T(8), [[0, gen({ id: "r1", model: "m" })]], [step(T(10), null)]);
    expect(scanAntigravityUsage(input(c)).instances[0]!.updates[0]!.turns.map(t => t.t)).toEqual([T(8)]);
    const d = conversations();
    d.make("a", d.cwd, T(8), [[0, gen({ id: "r1", model: "m" })]], [step(T(10), 0)]);
    expect(scanAntigravityUsage(input(d)).instances[0]!.updates[0]!.turns.map(t => t.t)).toEqual([T(10)]);
  });
  it("incremental: unchanged is not opened again; new generations after the last index only", () => {
    const c = conversations();
    const path = c.make("a", c.cwd, T(8), [[0, gen({ id: "r1", model: "m", at: T(9) })]]);
    const first = scanAntigravityUsage(input(c));
    const u = first.instances[0]!.updates[0]!;
    expect(scanAntigravityUsage(input(c, { [u.key]: { sig: u.sig, after: u.after } }, first.index)).instances[0]!.updates).toEqual([]);
    const db = new Database(path); db.prepare("INSERT INTO gen_metadata VALUES (?, ?)").run(1, gen({ id: "r2", model: "m", at: T(10) })); db.close();
    expect(scanAntigravityUsage(input(c, { [u.key]: { sig: u.sig, after: u.after } }, first.index)).instances[0]!.updates[0]!.turns.map(t => t.t)).toEqual([T(10)]);
  });
  it("a database that can't be read fails every instance's scan (whose it is is unknown); none at all is nothing", async () => {
    const c = conversations();
    writeFileSync(join(c.dir, "broken.db"), "not sqlite");
    expect(scanAntigravityUsage(input(c)).instances[0]!.failed).toBe(true);
    expect(scanAntigravityUsage({ ...input(c), dir: join(c.root, "none") }).instances[0]!.failed).toBe(false);
    rmSync(join(c.dir, "broken.db"));
    c.make("a", c.cwd, T(8), [[0, gen({ id: "r1", model: "m", at: T(9) })]]);
    expect((await runAntigravityUsageScan(input(c), 60_000)).instances).toEqual(scanAntigravityUsage(input(c)).instances);
  }, 90_000);
});

describe("the version gate (design §10.4: the field map is reverse-engineered)", () => {
  it("the checked line is read; another version, or none recorded yet, is not", () => {
    expect(["1.4.6", "1.4.7", "agy 1.4.12"].map(antigravityUsageSupported)).toEqual([true, true, true]);
    expect(["1.5.0", "1.3.9", "2.0.0", "", null, undefined].map(antigravityUsageSupported)).toEqual([false, false, false, false, false, false]);
  });
  it("an unchecked version: not read, listed as not measured, nothing covered — its history kept", async () => {
    const c = conversations();
    c.make("a", c.cwd, T(8), [[0, gen({ id: "r1", model: "claude-sonnet-4-6", at: T(9) })]]);
    for (const version of ["1.5.0", null]) {
      let scans = 0;
      const inst: CacheInstance = { name: "agy", backend: "antigravity", workingDirectory: c.cwd, ledgerPath: join(c.root, `agy-${version}`, "cache-ledger.json"), profile: "default" };
      const svc = new CacheService({ instances: () => [inst], claudeProjectsDir: () => join(c.root, "c"), claudeKey: (d) => d, codexSessionsDir: () => join(c.root, "x"),
        listRollouts: () => [], metaPath: join(c.root, "m.json"), now: () => NOW, zone: () => "UTC", antigravityDir: () => c.dir, antigravityVersion: () => version,
        antigravityScan: async (i) => { scans++; return scanAntigravityUsage(i); } });
      await svc.kick();
      const d = (await svc.usageData()).instances[0]!;
      expect([scans, d.status, d.days.coverage, Object.keys(d.ledger.hours)]).toEqual([0, "unsupported", [], []]);
    }
  });
});

describe("in the usage report", () => {
  it("measured per instance with reasoning; Claude at list price, Gemini not priced; out of the cache analysis", async () => {
    const c = conversations();
    c.make("a", c.cwd, T(8), [[0, gen({ id: "r1", model: "claude-sonnet-4-6", out: 300, at: T(9) })], [1, gen({ id: "r2", model: "gemini-3-flash-a", out: 100, at: T(10) })]]);
    const inst: CacheInstance = { name: "agy", backend: "antigravity", workingDirectory: c.cwd, ledgerPath: join(c.root, "agy", "cache-ledger.json"), profile: "default" };
    const svc = new CacheService({ instances: () => [inst], claudeProjectsDir: () => join(c.root, "c"), claudeKey: (d) => d, codexSessionsDir: () => join(c.root, "x"),
      listRollouts: () => [], metaPath: join(c.root, "m.json"), now: () => NOW, zone: () => "UTC", antigravityDir: () => c.dir, antigravityVersion: () => "1.4.7", antigravityScan: async (i) => scanAntigravityUsage(i) });
    await svc.pass(); await svc.pass();
    const data = await svc.usageData();
    const r = buildUsageReport({ now: NOW, zone: "UTC", range: { kind: "7d" }, group: "model", messages: [], scanning: data.scanning,
      instances: data.instances.map(d => ({ name: d.inst.name, backend: d.inst.backend, team: null, status: d.status, ledger: d.ledger, days: d.days })) });
    const by = Object.fromEntries(r.rows.map(x => [x.key, x]));
    expect(by["claude-sonnet-4-6"]).toMatchObject({ requests: 1, input: 1632, output: 300, reasoning: 40, reasoningReported: true, priced: "all" });
    expect(by["gemini-3-flash-a"]).toMatchObject({ amount: null, flags: ["not_priced"] });
    expect((await svc.report("7d")).instances[0]).toMatchObject({ status: "unsupported" });
  });
});
