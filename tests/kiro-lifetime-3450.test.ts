import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyLedger, type HourTotals } from "../src/cache-ledger.js";
import { CacheService, type CacheServiceOptions } from "../src/cache-service.js";
import { officeLevels } from "../src/office-levels.js";
import { emptyDays, emptyLifetime } from "../src/usage-rollup.js";
import { scanKiroUsage } from "../src/kiro-usage-scan.js";
import { scanKiroHistory, type KiroHistoryInput } from "../src/kiro-history-scan.js";
import { runKiroHistoryScan } from "../src/kiro-usage-run.js";
import { buildUsageReport } from "../src/usage-report.js";
import { historyBefore } from "../src/kiro-history.js";

const DAY = 86_400_000, NOW = Date.UTC(2026, 10, 8, 12);
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });
const entry = (t: number) => ({ user: { content: { Prompt: { prompt: "abcd" } } }, request_metadata: {
  request_start_timestamp_ms: t, response_size: 8, context_usage_percentage: 1, model_id: "claude-sonnet-4.6",
} });
function rig() {
  const root = mkdtempSync(join(tmpdir(), "agend-3450-")); dirs.push(root);
  const cwd = join(root, "work"), home = join(root, "kiro"), dbPath = join(root, "kiro.sqlite3"), own = join(root, "instance");
  mkdirSync(cwd); mkdirSync(own); mkdirSync(join(home, "sessions", "cli"), { recursive: true });
  const db = new Database(dbPath);
  db.exec("CREATE TABLE conversations_v2 (key TEXT, conversation_id TEXT, value TEXT, created_at INTEGER, updated_at INTEGER, PRIMARY KEY(key,conversation_id))");
  const classic = (id: string, times: number[], at = cwd) => {
    const value = JSON.stringify({ history: times.map(entry), model_info: { context_window_tokens: 200_000 } });
    db.prepare("INSERT OR REPLACE INTO conversations_v2 VALUES (?,?,?,?,?)").run(at, id, value, times[0], times.at(-1));
  };
  const tui = (id: string, t: number) => {
    const path = join(home, "sessions", "cli", `${id}.json`);
    writeFileSync(path, JSON.stringify({ session_id: id, cwd, session_state: { rts_model_state: { model_info: { model_id: "claude-sonnet-4.6" } },
      conversation_metadata: { user_turn_metadatas: [{ message_ids: ["a"], user_prompt_length: 4, assistant_response_length: 8,
        context_usage_percentage: 1, end_timestamp: new Date(t + 1000).toISOString(), turn_duration: { secs: 1, nanos: 0 } }] } } }));
    writeFileSync(path.replace(/json$/, "jsonl"), [
      { kind: "Prompt", data: { message_id: "p", content: [{ kind: "text", data: "abcd" }], meta: { timestamp: t / 1000 } } },
      { kind: "AssistantMessage", data: { message_id: "a", content: [{ kind: "text", data: "abcdefgh" }] } },
    ].map(x => JSON.stringify(x)).join("\n"));
  };
  const service = (options: Partial<CacheServiceOptions> = {}) => new CacheService({
    instances: () => [{ name: "k", backend: "kiro-cli", workingDirectory: cwd, ledgerPath: join(own, "cache-ledger.json"), profile: "default" }],
    claudeProjectsDir: () => join(root, "claude"), claudeKey: x => x, codexSessionsDir: () => join(root, "codex"),
    listRollouts: () => [], metaPath: join(root, "meta.json"), now: () => NOW, zone: () => "UTC",
    kiroDbPath: () => dbPath, kiroHome: () => home, kiroScan: async i => scanKiroUsage(i),
    ...options,
  });
  return { root, cwd, home, dbPath, db, own, classic, tui, service };
}

describe("#3450 Office scoring is backend-specific", () => {
  it.each([
    ["A", [3406, 591455, 1277950684, 0, 0, 0, 271416], 113],
    ["B", [1481, 372267, 625645548, 0, 0, 0, 206921], 79],
  ] as const)("reporter's Kiro classic %s includes re-sent context as Office work", (_name, tuple, level) => {
    const days = emptyDays();
    days.rows.push({ date: "2026-11-01", zone: "UTC", be: "kiro-cli", pf: "default", m: { "claude-sonnet-4.6|0": [...tuple] as HourTotals } });
    const before = structuredClone(days);
    const out = officeLevels({ now: NOW, zone: "UTC", instances: [{ name: "k", ledger: emptyLedger(), days, life: emptyLifetime() }] }).k!;
    expect(out).toMatchObject({ level, estimated: true, workTokens: tuple[1] + tuple[2] + tuple[6] });
    expect(days).toEqual(before); // no report input/cache split or cost mutation
    days.rows[0]!.be = "claude-code";
    expect(officeLevels({ now: NOW, zone: "UTC", instances: [{ name: "c", ledger: emptyLedger(), days, life: emptyLifetime() }] }).c!.workTokens)
      .toBe(tuple[1] + tuple[6]);
  });
});

describe("#3450 automatic historical Kiro backfill", () => {
  it("imports old classic and TUI days once, dedupes classic conversion, and fixes first seen", async () => {
    const r = rig();
    r.classic("classic", [NOW - 600 * DAY, NOW - 50 * DAY, NOW - DAY]);
    r.tui("classic", NOW - 50 * DAY); // same request already in classic
    r.tui("tui-only", NOW - 45 * DAY);
    r.classic("other", [NOW - 700 * DAY], join(r.root, "other"));
    r.db.close();
    const svc = r.service(); await svc.kick();
    const level = (await svc.officeLevels(NOW)).k!;
    expect(level).toMatchObject({ workTokens: 4 * 2002, firstSeen: "2025-03-18", estimated: true });
    const life = JSON.parse(readFileSync(join(r.own, "usage-lifetime.json"), "utf8"));
    expect(life.by["kiro-cli"][0]).toBe(3);
    expect(life.kiroBackfill).toBeTruthy();
    const data = (await svc.usageData()).instances[0]!;
    expect(data.days.rows.filter(x => x.be === "kiro-cli").map(x => x.date).sort()).toEqual(["2026-09-19", "2026-09-24"]);
    const report = buildUsageReport({ now: NOW, zone: "UTC", range: { kind: "custom", from: "2026-09-01", to: "2026-09-30" },
      group: "instance", messages: [], scanning: svc.scanning(), instances: [{ name: "k", backend: "kiro-cli", team: null, status: "ok", ledger: data.ledger, days: data.days }] });
    expect(report.rows[0]).toMatchObject({ requests: 2, estimated: true, input: 2, cacheRead: 3998, output: 4 });
    await svc.stop();
    const restarted = r.service(); await restarted.kick();
    expect((await restarted.officeLevels(NOW)).k).toEqual(level);
    await restarted.stop();
  }, 90_000);

  it("skips whole recorded days, including partial boundary days and already carried lifetime dates", async () => {
    const r = rig();
    r.classic("classic", [NOW - 600 * DAY, NOW - 500 * DAY, NOW - 50 * DAY, NOW - 50 * DAY + 1000, NOW - DAY]);
    const days = emptyDays();
    days.rows.push({ date: "2026-09-19", zone: "UTC", be: "kiro-cli", pf: "default", m: { "claude-sonnet-4.6|0": [1, 1, 1999, 0, 0, 0, 2] } });
    writeFileSync(join(r.own, "usage-days.json"), JSON.stringify(days));
    const life = emptyLifetime(); life.first = "2025-06-26"; life.through = "2025-06-26";
    life.by["kiro-cli"] = [1, 1, 1999, 0, 0, 0, 2];
    writeFileSync(join(r.own, "usage-lifetime.json"), JSON.stringify(life));
    r.db.close();
    const svc = r.service(); await svc.kick();
    expect((await svc.officeLevels(NOW)).k).toMatchObject({ workTokens: 4 * 2002, firstSeen: "2025-03-18" });
    await svc.stop();
  }, 90_000);

  it("persists page rows with their cursor and resumes after restart, including equal timestamps", async () => {
    const r = rig();
    for (const id of ["a", "b", "c"]) r.classic(id, [NOW - 50 * DAY]);
    r.db.close();
    const scan = vi.fn(async (i: KiroHistoryInput) => scanKiroHistory({ ...i, maxSources: 1 }));
    const first = r.service({ kiroHistoryScan: scan }); await first.pass(); await first.stop();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(r.own, "kiro-history-v1.json"), "utf8"))).toMatchObject({ phase: "scanning", cursor: { id: "a" } });
    const second = r.service({ kiroHistoryScan: scan }); await second.kick();
    expect((await second.officeLevels(NOW)).k!.workTokens).toBe(3 * 2002);
    await second.stop();
    const thirdScan = vi.fn(async (i: KiroHistoryInput) => scanKiroHistory(i));
    const third = r.service({ kiroHistoryScan: thirdScan }); await third.kick();
    expect(thirdScan).not.toHaveBeenCalled(); await third.stop();
  });

  it.each(["usage-lifetime.json", "usage-days.json"])("retries %s write failure without losing or doubling history", async file => {
    const r = rig(); r.classic("old", [NOW - 600 * DAY]); r.db.close();
    const path = join(r.own, file); mkdirSync(path);
    const scan = vi.fn(async (i: KiroHistoryInput) => scanKiroHistory(i));
    const first = r.service({ kiroHistoryScan: scan }); await first.pass(); await first.stop();
    expect(JSON.parse(readFileSync(join(r.own, "kiro-history-v1.json"), "utf8"))).toMatchObject({ phase: "ready" });
    rmSync(path, { recursive: true });
    const second = r.service({ kiroHistoryScan: scan }); await second.kick();
    expect((await second.officeLevels(NOW)).k!.workTokens).toBe(2002);
    expect(JSON.parse(readFileSync(join(r.own, "kiro-history-v1.json"), "utf8"))).toMatchObject({ phase: "done" });
    await second.stop(); expect(scan).toHaveBeenCalledTimes(1);
    const third = r.service({ kiroHistoryScan: scan }); await third.kick();
    expect((await third.officeLevels(NOW)).k!.workTokens).toBe(2002); await third.stop();
  });

  it("a malformed old store stays pending and retries automatically after repair", async () => {
    const r = rig(); r.classic("old", [NOW - 50 * DAY]);
    r.db.prepare("UPDATE conversations_v2 SET value='{' WHERE conversation_id='old'").run();
    const log = vi.fn(), svc = r.service({ kiroHistoryScan: async i => scanKiroHistory(i), log });
    await svc.pass();
    expect(existsSync(join(r.own, "kiro-history-v1.json"))).toBe(false);
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("remains pending"), expect.anything());
    r.classic("old", [NOW - 50 * DAY]); r.db.close(); await svc.kick();
    expect((await svc.officeLevels(NOW)).k!.workTokens).toBe(2002); await svc.stop();
  });

  it("rejects a held page if the instance profile changed while the worker was reading", async () => {
    const r = rig(); r.classic("old", [NOW - 50 * DAY]); r.db.close();
    let profile = "first", release!: () => void, entered!: () => void;
    const ready = new Promise<void>(r => { entered = r; });
    const held = new Promise<void>(r => { release = r; });
    const svc = r.service({ instances: () => [{ name: "k", backend: "kiro-cli", workingDirectory: r.cwd, ledgerPath: join(r.own, "cache-ledger.json"), profile }],
      kiroHistoryScan: async i => { const out = scanKiroHistory(i); entered(); await held; return out; } });
    const pass = svc.pass(); await ready; profile = "second"; release(); await pass;
    expect(existsSync(join(r.own, "kiro-history-v1.json"))).toBe(false);
    await svc.kick(); expect((await svc.officeLevels(NOW)).k!.workTokens).toBe(2002);
    expect((await svc.usageData()).instances[0]!.days.rows[0]!.pf).toBe("second"); await svc.stop();
  });

  it("shared workspaces get no historical attribution", async () => {
    const r = rig(); r.classic("old", [NOW - 50 * DAY]); r.db.close();
    const scan = vi.fn(async (i: KiroHistoryInput) => scanKiroHistory(i));
    const svc = r.service({ instances: () => ["a", "b"].map(name => ({ name, backend: "kiro-cli", workingDirectory: r.cwd, ledgerPath: join(r.root, name, "cache-ledger.json") })), kiroHistoryScan: scan });
    await svc.kick(); expect(scan).not.toHaveBeenCalled(); await svc.stop();
  });
});

describe("#3450 history pages", () => {
  const input = (r: ReturnType<typeof rig>): KiroHistoryInput => ({ dbPath: r.dbPath, kiroHome: r.home, cwds: [r.cwd],
    profile: "work", zone: "UTC", before: "2026-10-08", cursor: { phase: "classic", key: "", id: "" } });
  it("time/byte/source-slices full classic/TUI history, retains equal timestamps and skips the boundary day", async () => {
    const r = rig();
    for (const id of ["a", "b", "c"]) r.classic(id, [NOW - 50 * DAY, NOW - 50 * DAY, Date.UTC(2026, 9, 8, 1)]);
    r.tui("z", NOW - 45 * DAY); r.db.close();
    let i = input(r), count = 0, pages = 0;
    for (;;) {
      const out = scanKiroHistory({ ...i, maxSources: 1, maxBytes: 1 }); pages++;
      expect(out.sources).toBeLessThanOrEqual(1);
      count += out.rows.flatMap(x => Object.values(x.m)).reduce((n, t) => n + t[0], 0);
      if (out.done) break;
      expect(out.cursor).not.toEqual(i.cursor); i = { ...i, cursor: out.cursor };
      expect(pages).toBeLessThan(10);
    }
    expect([pages, count]).toEqual([4, 7]);
    expect(await runKiroHistoryScan(input(r), 60_000)).toEqual(scanKiroHistory(input(r)));
  }, 90_000);
  it("classic/TUI dedup is bound to cwd, not a matching conversation id in somebody else's workspace", () => {
    const r = rig(); r.classic("same-id", [NOW - 50 * DAY], join(r.root, "other")); r.tui("same-id", NOW - 50 * DAY); r.db.close();
    const out = scanKiroHistory(input(r));
    expect(out.rows.flatMap(x => Object.values(x.m)).reduce((n, t) => n + t[0], 0)).toBe(1);
  });
  it("a truncated TUI sidecar refuses completion rather than silently discarding a line", () => {
    const r = rig(); r.tui("bad", NOW - 50 * DAY); r.db.close();
    writeFileSync(join(r.home, "sessions", "cli", "bad.jsonl"), "{\n");
    expect(() => scanKiroHistory(input(r))).toThrow();
  });
  it("uses the cutoff hour's day in a half-hour zone, keeping the live boundary hour out of history", () => {
    const at = Date.UTC(2026, 9, 8, 18, 45); // Kathmandu: Oct 9 00:30; hour began Oct 8 23:45
    expect(historyBefore(at, "Asia/Kathmandu", emptyDays(), emptyLifetime(), emptyLedger())).toBe("2026-10-08");
  });
});
