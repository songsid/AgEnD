/**
 * #2122 §10 step 5: OpenCode's usage, measured — finished assistant messages' `tokens` in opencode.db (both its message
 * tables, each id once), by the session's directory; reasoning apart from output (as OpenCode records it); the provider's
 * `cost` only where the price table lacks the model. The tables are built in the shapes opencode wrote on the host.
 */
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { opencodeTurn, scanOpencodeUsage } from "../src/opencode-usage-scan.js";
import { runOpencodeUsageScan } from "../src/kiro-usage-run.js";
import { CacheService, type CacheInstance } from "../src/cache-service.js";
import { buildUsageReport } from "../src/usage-report.js";

const NOW = Date.UTC(2026, 9, 18, 12), T = (h: number) => Date.UTC(2026, 9, 17, h);
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-oc-usage-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const msg = (t: number, o: { model?: string; provider?: string; cost?: number; done?: boolean; tokens?: object } = {}) => ({ agent: "build", role: "assistant",
  model: { providerID: o.provider ?? "github-copilot", id: o.model ?? "gpt-5.5" }, cost: o.cost ?? 0,
  tokens: o.tokens ?? { input: 247, output: 414, reasoning: 365, cache: { read: 11_392, write: 0 } },
  time: { created: t, ...(o.done === false ? {} : { completed: t + 5000 }) } });

function store() {
  const root = tmp(), dbPath = join(root, "opencode.db"), cwd = join(root, "work"), other = join(root, "other");
  mkdirSync(cwd); mkdirSync(other);
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  for (const t of ["session", "session_v2"]) { db.prepare(`INSERT INTO ${t} VALUES (?, ?)`).run("s1", cwd); db.prepare(`INSERT INTO ${t} VALUES (?, ?)`).run("s2", other); }
  const v1 = (id: string, session: string, data: object, u: number) => db.prepare("INSERT OR REPLACE INTO message VALUES (?, ?, ?, ?, ?)").run(id, session, u, u, JSON.stringify(data));
  const v2 = (id: string, session: string, data: object, u: number) => db.prepare("INSERT OR REPLACE INTO session_message VALUES (?, ?, 'assistant', 0, ?, ?, ?)").run(id, session, u, u, JSON.stringify(data));
  return { root, dbPath, cwd, other, db, v1, v2 };
}

describe("an assistant message", () => {
  it("input uncached, cache read and write apart, output + reasoning as output with reasoning its part, the provider's cost", () => {
    expect(opencodeTurn(msg(T(9), { cost: 0.0123 }))).toEqual({ t: T(9), model: "gpt-5.5", prompt: 11_639, uncached: 247, read: 11_392, write5m: 0, write1h: 0, write: 0,
      output: 779, reasoning: 365, cost: 0.0123 });
  });
  it("not finished, not an assistant's, or no tokens at all: not a turn; older rows name the model `modelID`", () => {
    expect(opencodeTurn(msg(T(9), { done: false }))).toBeNull();
    expect(opencodeTurn({ ...msg(T(9)), role: "user" })).toBeNull();
    expect(opencodeTurn(msg(T(9), { tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }))).toBeNull();
    expect(opencodeTurn({ ...msg(T(9)), model: undefined, modelID: "GLM-5.2" })).toMatchObject({ model: "GLM-5.2" });
  });
});

describe("the scan", () => {
  const input = (s: ReturnType<typeof store>, cursor: { after: number; ids: string[] } | null = null) =>
    ({ dbPath: s.dbPath, cutoff: NOW - 31 * 86_400_000, instances: [{ name: "w", cwds: [s.cwd], cursor }] });
  it("both tables, each id once; only its directory's sessions", () => {
    const s = store();
    s.v1("m1", "s1", msg(T(9)), T(9)); s.v2("m1", "s1", msg(T(9)), T(12));        // copied to the newer table later
    s.v2("m2", "s1", msg(T(10)), T(10)); s.v2("m3", "s2", msg(T(10)), T(10));
    const r = scanOpencodeUsage(input(s)).instances[0]!;
    expect([r.failed, r.turns.map(t => t.t)]).toEqual([false, [T(9), T(10)]]);
    expect(scanOpencodeUsage(input(s, r.cursor)).instances[0]!.turns).toEqual([]);
  });
  it("a message still streaming is counted once it is finished, whole", () => {
    const s = store();
    s.v2("m1", "s1", msg(T(9), { done: false, tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }), T(9));
    const first = scanOpencodeUsage(input(s)).instances[0]!;
    expect(first.turns).toEqual([]);
    s.v2("m1", "s1", msg(T(9)), T(9) + 6000);
    expect(scanOpencodeUsage(input(s, first.cursor)).instances[0]!.turns).toEqual([expect.objectContaining({ uncached: 247, output: 779 })]);
  });
  it("no database: nothing, not a failure; one that is there and unreadable: a failure", async () => {
    const s = store();
    expect(scanOpencodeUsage({ ...input(s), dbPath: join(s.root, "none", "opencode.db") }).instances[0]!.failed).toBe(false);
    const bad = join(s.root, "bad.db"); writeFileSync(bad, "not sqlite at all");
    expect(scanOpencodeUsage({ ...input(s), dbPath: bad }).instances[0]!.failed).toBe(true);
    expect(scanOpencodeUsage({ ...input(s), dbPath: s.root }).instances[0]!.failed).toBe(true);       // a directory: cannot be opened
    expect((await runOpencodeUsageScan(input(s), 60_000)).instances).toEqual(scanOpencodeUsage(input(s)).instances);
  }, 90_000);
});

describe("in the usage report", () => {
  it("measured with reasoning; a priced model at list price, an unpriced one at the provider's cost (said so), else not priced", async () => {
    const s = store();
    s.v2("m1", "s1", msg(T(9), { model: "claude-opus-4.6", provider: "github-copilot" }), T(9));
    s.v2("m2", "s1", msg(T(10), { model: "GLM-5.2", provider: "custom", cost: 0.05 }), T(10));
    s.v2("m3", "s1", msg(T(11), { model: "big-pickle", provider: "opencode" }), T(11));
    const inst: CacheInstance = { name: "oc", backend: "opencode", workingDirectory: s.cwd, ledgerPath: join(s.root, "oc", "cache-ledger.json"), profile: "default" };
    const svc = new CacheService({ instances: () => [inst], claudeProjectsDir: () => join(s.root, "c"), claudeKey: (d) => d, codexSessionsDir: () => join(s.root, "x"),
      listRollouts: () => [], metaPath: join(s.root, "m.json"), now: () => NOW, zone: () => "UTC", opencodeDbPath: () => s.dbPath, opencodeScan: async (i) => scanOpencodeUsage(i) });
    await svc.pass(); await svc.pass();
    const data = await svc.usageData();
    const r = buildUsageReport({ now: NOW, zone: "UTC", range: { kind: "7d" }, group: "model", messages: [], scanning: data.scanning,
      instances: data.instances.map(d => ({ name: d.inst.name, backend: d.inst.backend, team: null, status: d.status, ledger: d.ledger, days: d.days })) });
    const by = Object.fromEntries(r.rows.map(x => [x.key, x]));
    expect(by["claude-opus-4.6"]).toMatchObject({ requests: 1, output: 414, reasoning: 365, reasoningReported: true, priced: "all", flags: [] });
    expect(by["GLM-5.2"]).toMatchObject({ amount: 0.05, flags: ["cost_reported"] });
    expect(by["big-pickle"]).toMatchObject({ amount: null, flags: ["not_priced"] });
    expect((await svc.report("7d")).instances[0]).toMatchObject({ status: "unsupported" });
  });
});
