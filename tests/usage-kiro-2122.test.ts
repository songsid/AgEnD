/**
 * #2122 §10 step 2: Kiro's usage, estimated (option B, the user's decision) — tokscale's method on Kiro's three stores,
 * attributed per instance by working directory, deduped across stores, and flagged "estimated" everywhere it shows.
 * Fixtures are in the real shapes checked on the development host (design §10.1); the stores are built in a temp dir.
 */
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { kiroClassicTurns, kiroKasTurns, kiroTuiTurns, KIRO_DEFAULT_WINDOW } from "../src/kiro-usage.js";
import { scanKiroUsage, type KiroScanInput } from "../src/kiro-usage-scan.js";
import { runKiroUsageScan } from "../src/kiro-usage-run.js";
import { kasBucket } from "../src/backend/kiro-kas-store.js";
import { CacheService, type CacheInstance } from "../src/cache-service.js";
import { buildUsageReport } from "../src/usage-report.js";
import { priceKey, ratesFor } from "../src/cache-prices.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 18, 12);
const T = (h: number, m = 0) => Date.UTC(2026, 9, 17, h, m);
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-kiro-usage-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A classic history entry as kiro-cli 2.30 writes it: every token field null. */
const classicEntry = (start: number, o: { prompt?: string; tool?: string; response?: number; pct?: number } = {}) => ({
  user: { content: o.tool !== undefined ? { ToolUseResults: { tool_use_results: [{ tool_use_id: "t1", content: [{ Text: o.tool }], status: "Success" }] } } : { Prompt: { prompt: o.prompt ?? "hello" } } },
  assistant: { Response: { message_id: "m", content: "x" } },
  request_metadata: { request_id: "r", request_start_timestamp_ms: start, stream_end_timestamp_ms: start + 5000, user_prompt_length: 0, response_size: o.response ?? 400,
    context_usage_percentage: o.pct ?? 10, model_id: "claude-sonnet-4.6", total_tokens: null, uncached_input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_write_input_tokens: null },
});
const classicConversation = (history: unknown[], window: number | null = 1_000_000) =>
  ({ conversation_id: "c1", history, model_info: { model_id: "claude-sonnet-4.6", ...(window ? { context_window_tokens: window } : {}) }, user_turn_metadata: { usage_info: [] } });

describe("the estimate: tokscale's method, per store", () => {
  it("classic: fresh input from the prompt (or tool-result text) bytes / 4, output from response_size / 4, cache read from the context", () => {
    const turns = kiroClassicTurns(classicConversation([classicEntry(T(9), { prompt: "héllo world!" }), classicEntry(T(10), { tool: "x".repeat(4000), pct: 0.05 })]), 0);
    // "héllo world!" is 13 UTF-8 bytes → 4; 10% of 1,000,000 = 100,000 − 4.
    expect(turns[0]).toMatchObject({ t: T(9), model: "claude-sonnet-4.6", uncached: 4, read: 99_996, output: 100, write: null, write5m: 0, write1h: 0 });
    // A tool result's Text is fresh input; 0.05% of the window (500) is less than it: no cache read.
    expect(turns[1]).toMatchObject({ uncached: 1000, read: 0, output: 100 });
  });
  it("classic: no window recorded → no cache read (as tokscale); an entry without request_metadata, or before `after`, is not a turn", () => {
    const conv = classicConversation([["legacy", "pair"], classicEntry(T(8)), classicEntry(T(9))], null);
    const turns = kiroClassicTurns(conv, T(8));
    expect(turns.map(t => [t.t, t.read])).toEqual([[T(9), 0]]);
  });
  it("a real count, should Kiro ever write one, is taken instead of the estimate", () => {
    const e = classicEntry(T(9));
    Object.assign(e.request_metadata, { uncached_input_tokens: 1234, output_tokens: 56, cache_read_input_tokens: 7890 });
    expect(kiroClassicTurns(classicConversation([e]), 0)[0]).toMatchObject({ uncached: 1234, output: 56, read: 7890 });
    Object.assign(e.request_metadata, { request_count: 3 });
    expect(kiroClassicTurns(classicConversation([e]), 0)[0]).toMatchObject({ requests: 3 });
    expect(kiroClassicTurns(classicConversation([classicEntry(T(9))]), 0)[0]!.requests).toBeUndefined();   // one
  });
  it("TUI: only the messages a turn names count (the sidecar also holds history brought over), and the 200,000 window by default", () => {
    const session = { session_id: "s1", cwd: "/w", session_state: { rts_model_state: { model_info: { model_id: "claude-sonnet-4.6" } },
      conversation_metadata: { user_turn_metadatas: [{ message_ids: ["p2", "a2"], user_prompt_length: 0, assistant_response_length: 0, context_usage_percentage: 1, end_timestamp: new Date(T(9, 1)).toISOString(), turn_duration: { secs: 60, nanos: 0 }, input_token_count: 0, output_token_count: 0 }] } } };
    const jl = [
      { kind: "Prompt", data: { message_id: "p1", content: [{ kind: "text", data: "brought over from classic" }], meta: { timestamp: T(8) / 1000 } } },
      { kind: "AssistantMessage", data: { message_id: "a1", content: [{ kind: "text", data: "y".repeat(800) }] } },
      { kind: "Prompt", data: { message_id: "p2", content: [{ kind: "text", data: "abcdefgh" }], meta: { timestamp: T(9) / 1000 } } },
      { kind: "ToolResults", data: { content: [{ kind: "toolResult", data: { content: [{ kind: "text", data: "z".repeat(40) }] } }] } },
      { kind: "AssistantMessage", data: { message_id: "a2", content: [{ kind: "text", data: "r".repeat(20) }] } },
    ].map(x => JSON.stringify(x));
    expect(KIRO_DEFAULT_WINDOW).toBe(200_000);
    // Input (8 prompt chars + 40 tool bytes) / 4 = 12; 1% of 200,000 − 12; output 20 / 4.
    expect(kiroTuiTurns(session, jl, 0)).toEqual([expect.objectContaining({ t: T(9), uncached: 12, read: 1988, output: 5 })]);
    // The same conversation's classic record holds a request inside the turn's window: it is that one's, dropped here.
    expect(kiroTuiTurns(session, jl, 0, [T(9, 0) + 30_000])).toEqual([]);
    expect(kiroTuiTurns(session, jl, 0, [T(8)])).toHaveLength(1);
  });
  it("V3: a turn runs to its turn_end; a converted session's turns from before it was created are not counted again", () => {
    const line = (ts: number, payload: object) => JSON.stringify({ id: String(ts), timestamp: new Date(ts).toISOString(), payload });
    const jl = [
      line(T(7), { type: "user", content: "copied from classic" }), line(T(7, 1), { type: "assistant", content: "x".repeat(400) }), line(T(7, 2), { type: "turn_end" }),
      line(T(9), { type: "user", content: "abcd" }), line(T(9, 1), { type: "tool_result", content: "t".repeat(8) }),
      line(T(9, 2), { type: "assistant", content: "a".repeat(40) }),
      line(T(9, 3), { type: "session_metadata", key: "contextUsage", value: { usagePercentage: 2 } }),
      line(T(9, 3), { type: "usage_summary", elapsedTime: 180_000, requestIds: ["r"] }), line(T(9, 3), { type: "turn_end", stopReason: "end_turn" }),
    ];
    const session = { id: "sess_x", modelId: "claude-sonnet-4.6", createdAt: new Date(T(8)).toISOString() };
    expect(kiroKasTurns(session, jl, 0)).toEqual([expect.objectContaining({ t: T(9), model: "claude-sonnet-4.6", uncached: 3, read: 3997, output: 10 })]);
    expect(kiroKasTurns({ ...session, createdAt: new Date(T(6)).toISOString() }, jl, 0)).toHaveLength(2);
    expect(kiroKasTurns(session, jl, 0, [T(9, 2)])).toEqual([]);
  });
});

/** Kiro's three stores in a temp dir, in the real layouts. */
function stores() {
  const root = tmp(), kiroHome = join(root, "kiro"), dbPath = join(root, "data.sqlite3"), cwd = join(root, "work"), other = join(root, "elsewhere");
  mkdirSync(cwd); mkdirSync(other); mkdirSync(join(kiroHome, "sessions", "cli"), { recursive: true });
  const db = new Database(dbPath);
  db.exec("CREATE TABLE conversations_v2 (key TEXT NOT NULL, conversation_id TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key, conversation_id))");
  const putRow = (key: string, id: string, history: unknown[], updated: number) =>
    db.prepare("INSERT OR REPLACE INTO conversations_v2 VALUES (?, ?, ?, ?, ?)").run(key, id, JSON.stringify(classicConversation(history)), updated, updated);
  const putTui = (id: string, at: string, start: number) => {
    const path = join(kiroHome, "sessions", "cli", `${id}.json`);
    writeFileSync(path, JSON.stringify({ session_id: id, cwd: at, session_state: { rts_model_state: { model_info: { model_id: "claude-sonnet-4.6" } }, conversation_metadata: {
      user_turn_metadatas: [{ message_ids: ["a"], user_prompt_length: 40, assistant_response_length: 80, context_usage_percentage: 1, end_timestamp: new Date(start + 60_000).toISOString(), turn_duration: { secs: 60, nanos: 0 } }] } } }));
    writeFileSync(path.replace(/json$/, "jsonl"), [JSON.stringify({ kind: "Prompt", data: { message_id: "p", content: [{ kind: "text", data: "q" }], meta: { timestamp: start / 1000 } } }),
      JSON.stringify({ kind: "AssistantMessage", data: { message_id: "a", content: [{ kind: "text", data: "r" }] } })].join("\n"));
    return path;
  };
  const putKas = (at: string, name: string, start: number) => {
    const dir = join(kiroHome, "sessions", kasBucket(at), name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.json"), JSON.stringify({ id: name, modelId: "claude-sonnet-4.6", createdAt: new Date(start - 60_000).toISOString(), workspacePaths: [at] }));
    writeFileSync(join(dir, "messages.jsonl"), [{ type: "user", content: "x".repeat(40) }, { type: "assistant", content: "y".repeat(80) }, { type: "turn_end" }]
      .map((p, i) => JSON.stringify({ timestamp: new Date(start + i * 1000).toISOString(), payload: p })).join("\n"));
  };
  return { root, kiroHome, dbPath, cwd, other, db, putRow, putTui, putKas };
}
const input = (s: ReturnType<typeof stores>, over: Partial<KiroScanInput> = {}): KiroScanInput =>
  ({ kiroHome: s.kiroHome, cutoff: NOW - 31 * DAY, maxBytes: 1e9, tuiIndex: {}, instances: [{ name: "w", cwds: [s.cwd], dbPath: s.dbPath, cursors: {} }], ...over });

describe("the scan: by working directory, incremental, bounded, read-only", () => {
  it("reads an instance's classic rows, TUI sessions and V3 bucket — and nobody else's", () => {
    const s = stores();
    s.putRow(s.cwd, "c1", [classicEntry(T(9))], T(9, 1));
    s.putRow(s.other, "c2", [classicEntry(T(9))], T(9, 1));
    s.putTui("t1", s.cwd, T(10)); s.putTui("t2", s.other, T(10));
    s.putKas(s.cwd, "sess_a", T(11)); s.putKas(s.other, "sess_b", T(11));
    const out = scanKiroUsage(input(s));
    const r = out.instances[0]!;
    expect(r.failed).toBe(false);
    expect(r.updates.map(u => [u.key.split(":")[0], u.turns.length]).sort()).toEqual([["classic", 1], ["kas", 1], ["tui", 1]]);
    expect(r.live).toHaveLength(3);
  });
  it("a source read once is not read again until it changes; then only its new turns come back", () => {
    const s = stores();
    s.putRow(s.cwd, "c1", [classicEntry(T(9))], T(9, 1));
    const first = scanKiroUsage(input(s)).instances[0]!.updates[0]!;
    const cursors = { [first.key]: { sig: first.sig, after: first.after } };
    expect(scanKiroUsage(input(s, { instances: [{ name: "w", cwds: [s.cwd], dbPath: s.dbPath, cursors }] })).instances[0]!.updates).toEqual([]);
    s.putRow(s.cwd, "c1", [classicEntry(T(9)), classicEntry(T(10))], T(10, 1));
    const next = scanKiroUsage(input(s, { instances: [{ name: "w", cwds: [s.cwd], dbPath: s.dbPath, cursors }] })).instances[0]!.updates;
    expect(next.map(u => u.turns.map(t => t.t))).toEqual([[T(10)]]);
  });
  it("past its byte budget a changed source waits for the next pass (behind), at least one is read", () => {
    const s = stores();
    s.putRow(s.cwd, "c1", [classicEntry(T(9))], T(9, 1)); s.putRow(s.cwd, "c2", [classicEntry(T(9))], T(9, 2));
    const out = scanKiroUsage(input(s, { maxBytes: 1 }));
    expect([out.instances[0]!.updates.length, out.behindSources]).toEqual([1, 1]);
    expect(out.instances[0]!.live).toHaveLength(2);
  });
  it("older than the cutoff: not read; no store at all: nothing, and no failure", () => {
    const s = stores();
    s.putRow(s.cwd, "old", [classicEntry(T(9) - 40 * DAY)], T(9) - 40 * DAY);
    const tui = s.putTui("t-old", s.cwd, T(9) - 40 * DAY);
    utimesSync(tui, new Date(T(9) - 40 * DAY), new Date(T(9) - 40 * DAY));
    s.putKas(s.cwd, "sess_old", T(9) - 40 * DAY);
    for (const f of ["session.json", "messages.jsonl"]) utimesSync(join(s.kiroHome, "sessions", kasBucket(s.cwd), "sess_old", f), new Date(T(9) - 40 * DAY), new Date(T(9) - 40 * DAY));
    expect(scanKiroUsage(input(s)).instances[0]).toMatchObject({ updates: [], live: [], failed: false });
    const none = scanKiroUsage({ ...input(s), kiroHome: join(s.root, "absent"), instances: [{ name: "w", cwds: [s.cwd], dbPath: join(s.root, "no-kiro-yet", "data.sqlite3"), cursors: {} }] });
    expect(none.instances[0]).toMatchObject({ updates: [], failed: false });
  });
  it("a store that is there and cannot be read fails the instance (no coverage), never reads as zero", () => {
    const s = stores();
    writeFileSync(join(s.root, "not-a-db.sqlite3"), "garbage, not sqlite");
    expect(scanKiroUsage(input(s, { instances: [{ name: "w", cwds: [s.cwd], dbPath: join(s.root, "not-a-db.sqlite3"), cursors: {} }] })).instances[0]!.failed).toBe(true);
  });
  it("never writes to Kiro's database", () => {
    const s = stores();
    s.putRow(s.cwd, "c1", [classicEntry(T(9))], T(9, 1));
    s.db.close();
    const before = new Database(s.dbPath, { readonly: true }).prepare("SELECT updated_at, value FROM conversations_v2").all();
    scanKiroUsage(input(s));
    expect(new Database(s.dbPath, { readonly: true }).prepare("SELECT updated_at, value FROM conversations_v2").all()).toEqual(before);
  });
  it("runs on a worker thread and answers the same", async () => {
    const s = stores();
    s.putRow(s.cwd, "c1", [classicEntry(T(9))], T(9, 1));
    const direct = scanKiroUsage(input(s)), threaded = await runKiroUsageScan(input(s), 60_000);
    expect(threaded.instances).toEqual(direct.instances);
  }, 90_000);
});

describe("Prism #2605: what a scan must never lose or double", () => {
  const svcFor = (s: ReturnType<typeof stores>, ledgerDir: string) => new CacheService({
    instances: () => [{ name: "w", backend: "kiro-cli", workingDirectory: s.cwd, ledgerPath: join(ledgerDir, "cache-ledger.json"), profile: "default" }],
    claudeProjectsDir: () => join(s.root, "claude"), claudeKey: (d) => d, codexSessionsDir: () => join(s.root, "codex"), listRollouts: () => [], metaPath: join(s.root, "meta.json"),
    now: () => NOW, zone: () => "UTC", kiroDbPath: () => s.dbPath, kiroHome: () => s.kiroHome, kiroScan: async (i) => scanKiroUsage(i) });
  const requests = async (svc: CacheService) => {
    const d = (await svc.usageData()).instances[0]!;
    return Object.values(d.ledger.hours).reduce((n, h) => n + Object.values(h.m).reduce((a, t) => a + t[0], 0), 0);
  };
  it("a store unreadable for a pass keeps the cursors: once it is readable again nothing is counted twice", async () => {
    const s = stores();
    s.putRow(s.cwd, "c1", [classicEntry(T(9))], T(9, 1));
    s.db.close();
    const svc = svcFor(s, join(s.root, "ledger"));
    await svc.pass();
    expect(await requests(svc)).toBe(1);
    const { renameSync } = await import("node:fs");
    renameSync(s.dbPath, `${s.dbPath}.away`); mkdirSync(s.dbPath);              // there, and not a database
    await svc.pass();
    rmSync(s.dbPath, { recursive: true }); renameSync(`${s.dbPath}.away`, s.dbPath);
    await svc.pass(); await svc.pass();
    expect(await requests(svc)).toBe(1);
  });
  it("a TUI session file that cannot be read fails the scan (no coverage); readable again, it is read", () => {
    const s = stores();
    mkdirSync(join(s.kiroHome, "sessions", "cli", "unreadable.json"));
    expect(scanKiroUsage(input(s)).instances[0]!.failed).toBe(true);
    rmSync(join(s.kiroHome, "sessions", "cli", "unreadable.json"), { recursive: true });
    s.putTui("t1", s.cwd, T(10));
    expect(scanKiroUsage(input(s)).instances[0]).toMatchObject({ failed: false, updates: [expect.objectContaining({ turns: [expect.anything()] })] });
  });
  for (const which of ["TUI", "V3"] as const) it(`a ${which} session caught mid-rewrite keeps its cursor and withholds coverage: rewritten whole, nothing is counted twice`, async () => {
    const s = stores();
    const path = which === "TUI" ? s.putTui("t1", s.cwd, T(10)) : (s.putKas(s.cwd, "sess_a", T(11)), join(s.kiroHome, "sessions", kasBucket(s.cwd), "sess_a", "session.json"));
    const svc = svcFor(s, join(s.root, "ledger"));
    await svc.pass();
    expect(await requests(svc)).toBe(1);
    const text = readFileSync(path, "utf8");
    writeFileSync(path, which === "TUI" ? '{"session_id":' : '{"id":');
    expect(scanKiroUsage(input(s)).instances[0]!.failed).toBe(true);
    await svc.pass();
    writeFileSync(path, text);
    await svc.pass(); await svc.pass();
    expect(await requests(svc)).toBe(1);
  });
  it("a V3 turn still being written is counted once it ends, whole", () => {
    const s = stores();
    const dir = join(s.kiroHome, "sessions", kasBucket(s.cwd), "sess_live");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "session.json"), JSON.stringify({ id: "sess_live", modelId: "claude-sonnet-4.6", createdAt: new Date(T(8)).toISOString() }));
    const l = (ts: number, p: object) => JSON.stringify({ timestamp: new Date(ts).toISOString(), payload: p });
    writeFileSync(join(dir, "messages.jsonl"), l(T(9), { type: "user", content: "abcd" }) + "\n");
    const first = scanKiroUsage(input(s)).instances[0]!.updates[0]!;
    expect(first.turns).toEqual([]);
    writeFileSync(join(dir, "messages.jsonl"), [l(T(9), { type: "user", content: "abcd" }), l(T(9, 1), { type: "assistant", content: "a".repeat(400) }),
      l(T(9, 2), { type: "usage_summary", requestIds: ["r1", "r2", "r3"] }), l(T(9, 2), { type: "turn_end" })].join("\n") + "\n");
    const second = scanKiroUsage(input(s, { instances: [{ name: "w", cwds: [s.cwd], dbPath: s.dbPath, cursors: { [first.key]: { sig: first.sig, after: first.after } } }] })).instances[0]!.updates[0]!;
    expect(second.turns).toEqual([expect.objectContaining({ output: 100, requests: 3 })]);
  });
  it("requests are model requests: a TUI turn of 4 counts 4", async () => {
    const s = stores();
    const path = s.putTui("t1", s.cwd, T(10));
    const v = JSON.parse(readFileSync(path, "utf8"));
    v.session_state.conversation_metadata.user_turn_metadatas[0].total_request_count = 4;
    writeFileSync(path, JSON.stringify(v));
    const svc = svcFor(s, join(s.root, "ledger"));
    await svc.pass();
    expect(await requests(svc)).toBe(4);
  });
});

describe("in the usage report: estimated, and said so", () => {
  function service(s: ReturnType<typeof stores>, insts: CacheInstance[]) {
    return new CacheService({
      instances: () => insts, claudeProjectsDir: () => join(s.root, "claude"), claudeKey: (d) => d.replace(/\//g, "-"), codexSessionsDir: () => join(s.root, "codex"),
      listRollouts: () => [], metaPath: join(s.root, "meta.json"), now: () => NOW, zone: () => "UTC",
      kiroDbPath: () => s.dbPath, kiroHome: () => s.kiroHome, kiroScan: async (i) => scanKiroUsage(i),
    });
  }
  const kiroInst = (s: ReturnType<typeof stores>, name = "coordinator", cwd = s.cwd): CacheInstance =>
    ({ name, backend: "kiro-cli", workingDirectory: cwd, ledgerPath: join(s.root, name, "cache-ledger.json"), profile: "default" });
  const report = (data: Awaited<ReturnType<CacheService["usageData"]>>) => buildUsageReport({ now: NOW, zone: "UTC", range: { kind: "7d" }, group: "instance", messages: [],
    scanning: data.scanning, instances: data.instances.map(d => ({ name: d.inst.name, backend: d.inst.backend, team: null, status: d.status, with: d.with, ledger: d.ledger, days: d.days })) });

  it("a Kiro instance's turns become estimated rows: flagged on the row, the day and the totals; priced at the named model's list price", async () => {
    const s = stores();
    s.putRow(s.cwd, "c1", [classicEntry(T(9), { prompt: "p".repeat(400), response: 800, pct: 1 })], T(9, 1));
    const svc = service(s, [kiroInst(s)]);
    await svc.pass();
    const data = await svc.usageData();
    expect(data.instances[0]!.status).toBe("ok");
    const r = report(data);
    const row = r.rows[0]!;
    expect(row).toMatchObject({ key: "coordinator", backends: ["kiro-cli"], profiles: ["default"], estimated: true, input: 100, output: 200, cacheRead: 9900, requests: 1 });
    expect(row.flags).toContain("estimated");
    const rates = ratesFor("claude-sonnet-4-6", 0)!;
    expect(row.amount).toBeCloseTo((100 * rates.input + 9900 * rates.read + 200 * rates.output) / 1e6, 12);
    expect(row.amountEstimated).toBe(row.amount);
    expect(r.totals).toMatchObject({ estimated: true, amountEstimated: row.amount });
    expect(r.totals.flags).toContain("includes_estimates");
    expect(r.daily[0]).toMatchObject({ estimated: true, flags: expect.arrayContaining(["estimated"]) });
    expect(r.notMeasured).toEqual([]);
  });
  it("auto is not priced (no model behind it); the cache analysis still leaves Kiro out", async () => {
    const s = stores();
    const e = classicEntry(T(9));
    s.db.prepare("INSERT INTO conversations_v2 VALUES (?, ?, ?, ?, ?)").run(s.cwd, "c1", JSON.stringify({ ...classicConversation([e]), model_info: { model_id: "auto", context_window_tokens: 200_000 } }), T(9, 1), T(9, 1));
    const svc = service(s, [kiroInst(s)]);
    await svc.pass();
    const r = report(await svc.usageData());
    expect(r.rows[0]).toMatchObject({ amount: null, priced: "none", estimated: true, amountEstimated: null, unpriced: ["auto"] });
    expect(r.totals.flags).toEqual(expect.arrayContaining(["includes_estimates", "not_priced"]));
    expect((await svc.report("7d")).instances[0]).toMatchObject({ name: "coordinator", status: "credit_billed" });
  });
  it("two Kiro instances on one working directory are shared, not read; a pass reads nothing twice", async () => {
    const s = stores();
    s.putRow(s.cwd, "c1", [classicEntry(T(9))], T(9, 1));
    const svc = service(s, [kiroInst(s, "a"), kiroInst(s, "b")]);
    await svc.pass();
    expect((await svc.usageData()).instances.map(d => [d.inst.name, d.status])).toEqual([["a", "shared"], ["b", "shared"]]);
    const one = service(s, [kiroInst(s)]);
    await one.pass(); await one.pass();
    expect(report(await one.usageData()).rows[0]!.requests).toBe(1);
  });
  it("Kiro turns keep no gap events (the cache analysis leaves Kiro out)", async () => {
    const s = stores();
    s.putRow(s.cwd, "c1", [classicEntry(T(6)), classicEntry(T(9))], T(9, 1));
    const svc = service(s, [kiroInst(s)]);
    await svc.pass();
    const ledger = JSON.parse(readFileSync(join(s.root, "coordinator", "cache-ledger.json"), "utf8"));
    expect([ledger.gaps, Object.values<any>(ledger.hours).reduce((n, h) => n + h.m["claude-sonnet-4.6|0"][0], 0)]).toEqual([[], 2]);
  });
  it("Kiro's dotted Claude ids price as the model they name; others stay exact", () => {
    expect(["claude-sonnet-4.6", "claude-opus-4.6", "auto", "gpt-5.6-terra", "claude-sonnet-4"].map(priceKey)).toEqual(["claude-sonnet-4-6", "claude-opus-4-6", null, "gpt-5.6-terra", "claude-sonnet-4"]);
  });
});
