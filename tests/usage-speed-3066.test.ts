/**
 * #3066 §2: output speed (tokdash, MIT — Claude's post_first_token, Codex's response_window): the readers' timing rules, the
 * ledger and rollup keeping it, the report's rate / coverage / spread, and the page's Speed column and card.
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CacheService, type CacheInstance } from "../src/cache-service.js";
import { SPEED_BUCKETS, addSpeed, claudeLine, codexLine, emptyLedger, emptySpeed, reviveLedger, speedBucket, type FileCursor, type Ledger } from "../src/cache-ledger.js";
import { emptyDays, foldHours, reviveDays } from "../src/usage-rollup.js";
import { SPEED_SPREAD_MIN, buildUsageReport, speedOf } from "../src/usage-report.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const T0 = Date.parse("2026-11-04T09:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();
/** One Claude Code transcript line (a content block of message `id`). */
const block = (id: string, at: number, o: { thinking?: number; stop?: boolean; out?: number; error?: boolean; model?: string } = {}) => {
  const content = o.thinking !== undefined ? [{ type: "thinking", thinking: "…" }] : [{ type: "text", text: "hi" }];
  return { whole: Buffer.from(JSON.stringify({ type: "assistant", timestamp: iso(at), ...(o.thinking ? { thinkingDurationMs: o.thinking } : {}), ...(o.error ? { isApiErrorMessage: true } : {}),
    message: { id, model: o.model ?? "claude-opus-4-5", stop_reason: o.stop ? "end_turn" : null, content, usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: o.out ?? 1 } } })) } as any;
};
const read = (lines: any[]): { file: FileCursor; samples: Array<{ tokens: number; ms: number }> } => {
  const file: FileCursor = { kind: "claude", ino: 1, offset: 0 };
  const samples: Array<{ tokens: number; ms: number }> = [];
  for (const l of lines) { claudeLine(l, file); for (const s of file.speeds ?? []) samples.push({ tokens: s.tokens, ms: s.ms }); delete file.speeds; }
  return { file, samples };
};

describe("Claude: timed after the first token (tokdash's rule)", () => {
  it("a leading thinking block: its stamp minus thinkingDurationMs is the first token; the window ends at the last block", () => {
    const { samples } = read([block("msg_a", 5_000, { thinking: 2_000, out: 50 }), block("msg_a", 9_000, { stop: true, out: 400 })]);
    expect(samples).toEqual([{ tokens: 400, ms: 9_000 - (5_000 - 2_000) }]);
  });
  it("not timed: no thinking block (only a request window), an API error, no stop_reason", () => {
    expect(read([block("msg_b", 5_000, { out: 100 }), block("msg_b", 8_000, { stop: true, out: 300 })]).samples).toEqual([]);
    expect(read([block("msg_c", 5_000, { thinking: 1_000 }), block("msg_c", 8_000, { stop: true, out: 300, error: true })]).samples).toEqual([]);
    expect(read([block("msg_d", 5_000, { thinking: 1_000 }), block("msg_d", 8_000, { out: 300 })]).samples).toEqual([]);
  });
  it("one sample per response, however many block lines; the tokens the turn counts are unchanged", () => {
    const { samples } = read([block("msg_e", 5_000, { thinking: 1_000 }), block("msg_e", 6_000, { out: 10 }), block("msg_e", 7_000, { stop: true, out: 90 }), block("msg_e", 7_500, { stop: true, out: 90 })]);
    expect(samples).toEqual([{ tokens: 90, ms: 3_000 }]);
  });
});

describe("Codex (0.147+): model items' clocks, closed by token_usage_record, counted by token_count (the shapes a real codex 0.165 wrote)", () => {
  const L = (o: unknown) => ({ whole: Buffer.from(JSON.stringify(o)) }) as any;
  const ev = (at: number, payload: Record<string, unknown>) => L({ timestamp: iso(at), type: "event_msg", payload });
  const start = (turn = "u", at = 0) => ev(at, { type: "task_started", turn_attribution: { turn_id: turn }, turn_id: turn });
  const done = (turn = "u", at = 0) => ev(at, { type: "task_complete", turn_id: turn });
  const abort = (turn = "u", at = 0) => ev(at, { type: "turn_aborted", turn_id: turn, reason: "interrupted" });
  const item = (type: string, s: number, e: number, turn = "u") => ev(e, { type: "item_completed", thread_id: "t", turn_id: turn, started_at_ms: T0 + s, completed_at_ms: T0 + e, item: { type, id: `${type}-${s}` } });
  const record = (out: number, turn = "u", at = 0) => L({ timestamp: iso(at), ordinal: 1, type: "token_usage_record", payload: { thread_id: "t", turn_id: turn, response_id: `r${at}`, usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: out } } });
  let total = 0;
  const count = (out: number, at = 0) => ev(at, { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: out }, total_token_usage: { total_tokens: total += 100 + out } } });
  /** A response: its record, then the token_count that counts it (as codex writes them). */
  const resp = (out: number, turn = "u", at = 0) => [record(out, turn, at), count(out, at)];
  const run = (lines: any[]) => { const file: FileCursor = { kind: "codex", ino: 1, offset: 0, model: "gpt-5.5" }; const out: Array<{ tokens: number; ms: number; t?: number }> = [];
    for (const l of lines.flat()) { codexLine(l, file); for (const s of file.speeds ?? []) out.push({ tokens: s.tokens, ms: s.ms }); delete file.speeds; } return out; };
  /** One turn: started, these lines, completed. */
  const turn = (...lines: any[]) => run([start(), ...lines, done()]);
  it("first model item's start → last model item's end; a client tool bounds nothing", () => {
    expect(turn(item("UserMessage", 0, 0), item("Reasoning", 1_000, 3_000), item("CommandExecution", 3_000, 60_000), item("AgentMessage", 3_000, 5_000), resp(400)))
      .toEqual([{ tokens: 400, ms: 4_000 }]);
  });
  it("hosted WebSearch time inside is the server's, not the model's: subtracted", () => {
    expect(turn(item("Reasoning", 0, 2_000), item("WebSearch", 2_000, 3_000), item("AgentMessage", 3_000, 5_000), resp(400))).toEqual([{ tokens: 400, ms: 4_000 }]);
  });
  it("not timed: no model item clock (an older rollout), a zero window, faster than 3000 tok/s; the record closes the response either way", () => {
    expect(turn(resp(400))).toEqual([]);
    expect(turn(item("AgentMessage", 1_000, 1_000), resp(2))).toEqual([]);                  // the mock's instant reply
    expect(turn(item("AgentMessage", 1_000, 1_100), resp(400))).toEqual([]);                // 4000 tok/s
    expect(turn(item("AgentMessage", 1_000, 1_100), resp(400), item("AgentMessage", 2_000, 4_000), resp(200))).toEqual([{ tokens: 200, ms: 2_000 }]);
  });
  it("a long item line (its text cut to head and tail) is read from its head, where the clocks are", () => {
    const head = Buffer.from(JSON.stringify({ timestamp: iso(5_000), type: "event_msg", payload: { type: "item_completed", thread_id: "t", turn_id: "u", started_at_ms: T0 + 1_000, completed_at_ms: T0 + 5_000, item: { type: "AgentMessage", id: "x", content: "…" } } }).slice(0, 300));
    expect(turn({ head, tail: Buffer.from("…}}"), length: 9_000_000 } as any, resp(800))).toEqual([{ tokens: 800, ms: 4_000 }]);
  });
  it("Prism #3075 #1: an aborted response's clocks never reach the next turn's response (an hour later)", () => {
    const next = [start("u2", 3_600_000), item("AgentMessage", 3_600_000, 3_604_000, "u2"), resp(400, "u2", 3_604_000), done("u2", 3_604_000)];
    expect(run([start("u1"), item("Reasoning", 0, 2_000, "u1"), abort("u1", 2_000), ...next])).toEqual([{ tokens: 400, ms: 4_000 }]);
    // … nor without the abort line (a new task alone ends the turn), nor an error mid-turn.
    expect(run([start("u1"), item("Reasoning", 0, 2_000, "u1"), ...next])).toEqual([{ tokens: 400, ms: 4_000 }]);
    expect(run([start("u2"), item("Reasoning", 0, 2_000, "u2"), ev(2_000, { type: "error", message: "x" }), item("AgentMessage", 10_000, 14_000, "u2"), resp(400, "u2"), done("u2")]))
      .toEqual([{ tokens: 400, ms: 4_000 }]);
    // Control: the next turn alone.
    expect(run(next)).toEqual([{ tokens: 400, ms: 4_000 }]);
    // An item of another turn inside this one: its owner is unproven — the response is not timed.
    expect(turn(item("Reasoning", 0, 2_000, "other"), item("AgentMessage", 2_000, 4_000), resp(400))).toEqual([]);
    // … nor a record naming another turn.
    expect(turn(item("AgentMessage", 0, 4_000), resp(400, "other"))).toEqual([]);
  });
  it("Prism #3075 #2: a WebSearch counts against the response whose window it is in — before or after that response's record", () => {
    const A = [item("Reasoning", 0, 5_000)], B = [item("AgentMessage", 10_000, 14_000), resp(400)], search = item("WebSearch", 1_000, 4_000);
    expect(turn(...A, search, resp(400), ...B)).toEqual([{ tokens: 400, ms: 2_000 }, { tokens: 400, ms: 4_000 }]);
    expect(turn(...A, resp(400), search, ...B)).toEqual([{ tokens: 400, ms: 2_000 }, { tokens: 400, ms: 4_000 }]);
    // Overlapping searches count each instant once; a search past the window's end is clipped to it.
    expect(turn(item("AgentMessage", 0, 10_000), item("WebSearch", 1_000, 4_000), item("WebSearch", 3_000, 5_000), item("WebSearch", 9_000, 30_000), resp(1_000)))
      .toEqual([{ tokens: 1_000, ms: 5_000 }]);
  });
  it("a response is a sample only once its usage is counted, filed at the count's time", () => {
    const file: FileCursor = { kind: "codex", ino: 1, offset: 0, model: "gpt-5.5" };
    for (const l of [start(), item("AgentMessage", 0, 4_000), record(400), count(400, 3_600_000), done()]) codexLine(l, file);
    expect(file.speeds).toEqual([{ t: T0 + 3_600_000, model: "gpt-5.5", prompt: 100, tokens: 400, ms: 4_000 }]);
    // Never counted (the turn ended first): no one's usage, no sample.
    expect(turn(item("AgentMessage", 0, 4_000), record(400))).toEqual([]);
  });
});

describe("Codex through the real scan: the speed lands with its usage (Prism #3075 #3, #4)", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const at = (iso: string) => Date.parse(iso);
  const line = (o: unknown) => JSON.stringify(o) + "\n";
  function rig() {
    const dir = mkdtempSync(join(tmpdir(), "agend-3075-")); dirs.push(dir);
    const wd = join(dir, "wd"); mkdirSync(wd); mkdirSync(join(dir, "sessions", "d"), { recursive: true });
    const file = join(dir, "sessions", "d", "rollout-1.jsonl");
    const inst: CacheInstance = { name: "cx", backend: "codex", workingDirectory: wd, ledgerPath: join(dir, "state", "cx.json"), profile: "unrecorded" };
    const service = (now: number) => new CacheService({ instances: () => [inst], claudeProjectsDir: () => join(dir, "projects"), claudeKey: (x) => x, codexSessionsDir: () => join(dir, "sessions"),
      listRollouts: () => [{ path: file, mtimeMs: statSync(file).mtimeMs }], metaPath: join(dir, "meta.json"), now: () => now });
    return { wd, file, service, inst };
  }
  /** One response from `s` to `e` (ISO), its record, and its count at `c`. */
  const rollout = (wd: string, s: string, e: string, c: string) => {
    const ev = (t: string, payload: unknown) => line({ timestamp: t, type: "event_msg", payload });
    return {
      head: line({ timestamp: s, type: "session_meta", payload: { id: "sess", cwd: wd } }) + line({ timestamp: s, type: "turn_context", payload: { turn_id: "u", cwd: wd, model: "gpt-5.5" } })
        + ev(s, { type: "task_started", turn_attribution: { turn_id: "u" }, turn_id: "u" })
        + ev(e, { type: "item_completed", thread_id: "t", turn_id: "u", started_at_ms: at(s), completed_at_ms: at(e), item: { type: "AgentMessage", id: "m" } })
        + line({ timestamp: e, type: "token_usage_record", payload: { thread_id: "t", turn_id: "u", response_id: "r1", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 400 } } }),
      tail: ev(c, { type: "token_count", info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 400 }, total_token_usage: { total_tokens: 500 } } })
        + ev(c, { type: "task_complete", turn_id: "u" }),
    };
  };
  const report = async (svc: CacheService, now: number) => {
    const d = (await svc.usageData()).instances;
    return buildUsageReport({ now, zone: "UTC", range: { kind: "all" } as any, group: "instance", scanning: { active: false, caughtUp: true, pendingBytes: 0, pendingFiles: 0 }, messages: [],
      instances: d.map((x) => ({ name: x.inst.name, backend: "codex", team: null, status: "ok", ledger: x.ledger, days: x.days })) as any });
  };
  it("#3: a response across midnight is filed with its count, in the count's hour — the report has its speed", async () => {
    const { wd, file, service } = rig();
    const r = rollout(wd, "2026-11-03T23:59:58.000Z", "2026-11-04T00:00:02.000Z", "2026-11-04T00:00:02.500Z");
    writeFileSync(file, r.head + r.tail);
    const now = at("2026-11-04T01:00:00.000Z"), svc = service(now);
    await svc.pass();
    const rep = await report(svc, now); svc.stop();
    expect(rep.rows[0]!.requests).toBe(1);
    expect(rep.rows[0]!.speed).toMatchObject({ tokPerSec: 100, timedRequests: 1 });
    expect(rep.speedByModel.map((m) => [m.model, m.speed?.tokPerSec])).toEqual([["gpt-5.5", 100]]);
    // The persisted ledger revives it in the same hour as its tokens.
    const saved = reviveLedger(JSON.parse(readFileSync(join(dirname(file), "..", "..", "state", "cx.json"), "utf8")));
    const hours = Object.entries(saved.hours).filter(([, v]) => v.sp);
    expect(hours.map(([k, v]) => [new Date(Number(k)).toISOString(), Object.keys(v.src ?? {})])).toEqual([["2026-11-04T00:00:00.000Z", ["codex:unrecorded"]]]);
  });
  it("#4: stopped after the record, restarted, then the count arrives — the speed is kept, once", async () => {
    const { wd, file, service } = rig();
    const r = rollout(wd, "2026-11-04T09:00:00.000Z", "2026-11-04T09:00:04.000Z", "2026-11-04T09:00:04.500Z");
    writeFileSync(file, r.head);
    const now = at("2026-11-04T10:00:00.000Z");
    const first = service(now); await first.pass(); first.stop();
    appendFileSync(file, r.tail);
    const second = service(now); await second.pass(); await second.pass();
    const rep = await report(second, now); second.stop();
    expect(rep.rows[0]!.requests).toBe(1);
    expect(rep.rows[0]!.speed).toMatchObject({ tokPerSec: 100, timedRequests: 1 });
  });
  it("controls: a whole scan, and a split scan without a restart, give the same — once", async () => {
    const now = at("2026-11-04T10:00:00.000Z");
    const one = rig(), r1 = rollout(one.wd, "2026-11-04T09:00:00.000Z", "2026-11-04T09:00:04.000Z", "2026-11-04T09:00:04.500Z");
    writeFileSync(one.file, r1.head + r1.tail);
    const whole = one.service(now); await whole.pass(); await whole.pass();
    expect((await report(whole, now)).rows[0]!.speed).toMatchObject({ tokPerSec: 100, timedRequests: 1 }); whole.stop();
    const two = rig(), r2 = rollout(two.wd, "2026-11-04T09:00:00.000Z", "2026-11-04T09:00:04.000Z", "2026-11-04T09:00:04.500Z");
    writeFileSync(two.file, r2.head);
    const split = two.service(now); await split.pass(); appendFileSync(two.file, r2.tail); await split.pass();
    expect((await report(split, now)).rows[0]!.speed).toMatchObject({ tokPerSec: 100, timedRequests: 1 }); split.stop();
  });
});

describe("kept: ledger hours and the daily rollup", () => {
  let l: Ledger;
  beforeEach(() => { l = emptyLedger(); });
  it("addSpeed sums tokens, ms and responses under source and model; the histogram holds the duration in the rate's bucket", () => {
    const f: FileCursor = { kind: "claude", ino: 1, offset: 0 };
    addSpeed(l, f, { t: T0, model: "claude-opus-4-5", prompt: 10, tokens: 600, ms: 6_000 }, 0, "hsinlin");   // 100 tok/s
    addSpeed(l, f, { t: T0 + 60_000, model: "claude-opus-4-5", prompt: 10, tokens: 200, ms: 1_000 }, 0, "hsinlin"); // 200 tok/s
    const a = l.hours[String(T0)]!.sp!["claude:hsinlin"]!["claude-opus-4-5|0"]!;
    expect(a.slice(0, 3)).toEqual([800, 7_000, 2]);
    expect(a[3 + speedBucket(100)]).toBe(6_000);
    expect(a[3 + speedBucket(200)]).toBe(1_000);
    expect(a.length).toBe(3 + SPEED_BUCKETS);
  });
  it("revive keeps a whole, finite speed for a known source; drops a bad one", () => {
    const f: FileCursor = { kind: "claude", ino: 1, offset: 0 };
    addSpeed(l, f, { t: T0, model: "m", prompt: 1, tokens: 10, ms: 100 }, 0, "default");
    l.hours[String(T0)]!.src = { "claude:default": { "m|0": [1, 1, 0, 0, 0, 0, 10] } };
    const raw = JSON.parse(JSON.stringify(l));
    expect(reviveLedger(raw).hours[String(T0)]!.sp!["claude:default"]!["m|0"]!.slice(0, 3)).toEqual([10, 100, 1]);
    raw.hours[String(T0)].sp["claude:default"]["m|0"] = [1, 2];
    expect(reviveLedger(raw).hours[String(T0)]!.sp).toBeUndefined();
  });
  it("folded into its day, and read back from the rollup file", () => {
    const f: FileCursor = { kind: "claude", ino: 1, offset: 0 };
    addSpeed(l, f, { t: T0, model: "m", prompt: 1, tokens: 10, ms: 100 }, 0, "default");
    l.hours[String(T0)]!.src = { "claude:default": { "m|0": [1, 1, 0, 0, 0, 0, 10] } };
    l.hours[String(T0)]!.m = { "m|0": [1, 1, 0, 0, 0, 0, 10] };
    const days = emptyDays();
    expect(foldHours(days, l, T0 + 2 * 3_600_000, "UTC")).toBe(true);
    expect(days.rows[0]!.s!["m|0"]!.slice(0, 3)).toEqual([10, 100, 1]);
    expect(reviveDays(JSON.parse(JSON.stringify(days))).rows[0]!.s!["m|0"]!.slice(0, 3)).toEqual([10, 100, 1]);
  });
});

describe("the report: Σ tokens ÷ Σ time, coverage, and a spread from 30 timed responses", () => {
  const agg = (n: number, tps: number, ms = 2_000) => { const a = emptySpeed(); a[0] = n * tps * ms / 1000; a[1] = n * ms; a[2] = n; a[3 + speedBucket(tps)] = n * ms; return a; };
  it("speedOf: the rate is the sums, never a mean of rates; p10/p90 only from 30", () => {
    const a = emptySpeed(); a[0] = 1_000; a[1] = 10_000; a[2] = 4;
    expect(speedOf(a, 8)).toEqual({ tokPerSec: 100, timedRequests: 4, coverage: 0.5, p10: null, p90: null });
    const many = agg(SPEED_SPREAD_MIN, 64);
    const s = speedOf(many, 60)!;
    expect(s.p10).not.toBeNull();
    expect(s.p10! <= 64 && 64 < s.p10! * Math.SQRT2 + 1e-9).toBe(true);
    expect(speedOf(emptySpeed(), 5)).toBeNull();
  });
  it("rows, totals and speedByModel, from the ledger's hours", () => {
    const l = emptyLedger();
    const f: FileCursor = { kind: "claude", ino: 1, offset: 0 };
    const now = Date.parse("2026-11-04T12:00:00.000Z"), at = now - 3 * 3_600_000;
    l.hours[String(at)] = { m: { "claude-opus-4-5|0": [4, 100, 0, 0, 0, 0, 1_000] }, g: [], src: { "claude:default": { "claude-opus-4-5|0": [4, 100, 0, 0, 0, 0, 1_000] } } } as any;
    addSpeed(l, f, { t: at, model: "claude-opus-4-5", prompt: 100, tokens: 1_000, ms: 10_000 }, 0, "default");
    const r = buildUsageReport({ now, zone: "UTC", range: { kind: "7d" }, group: "instance", scanning: { active: false, caughtUp: true, pendingBytes: 0, pendingFiles: 0 }, messages: [],
      instances: [{ name: "a", backend: "claude-code", team: null, status: "ok", ledger: l, days: emptyDays() }] });
    expect(r.rows[0]!.speed).toEqual({ tokPerSec: 100, timedRequests: 1, coverage: 0.25, p10: null, p90: null });
    expect(r.totals.speed?.tokPerSec).toBe(100);
    expect(r.speedByModel).toEqual([{ model: "claude-opus-4-5", backends: ["claude-code"], requests: 4, speed: r.rows[0]!.speed }]);
  });
});

describe("the page: the Speed column only when timed, and the card", () => {
  let p: AppPage, U: any;
  beforeAll(async () => { p = page({ url: "http://127.0.0.1:19280/ui/fleet/usage" }); U = await import("/ui/js/fleet-usage.js"); });
  afterAll(() => p.restore());
  const base = (rows: any[], speedByModel: any[] = []) => ({ range: { kind: "7d", from: "2026-10-29", to: "2026-11-04" }, zone: "UTC", granularity: "hour", basis: "b", pricesChecked: "2026-10-09",
    group: "instance", rows, totals: { ...rows[0], key: "all" }, daily: [], dailyTruncated: false, dailyFrom: null, messagesDaily: [], notMeasured: [], shared: [], coverage: [],
    scanning: { active: false, caughtUp: true, pendingBytes: 0, pendingFiles: 0 }, speedByModel });
  const row = (key: string, speed: unknown) => ({ key, input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0, requests: 4, total: 30, messages: 1,
    amount: 1, priced: "all", flags: [], unpriced: [], instances: [key], backends: ["claude-code"], models: ["claude-opus-4-5"], profiles: ["default"], reasoningReported: false, estimated: false, amountEstimated: null, speed });
  const mount = async (report: any) => { await p.mount(h(U.UsageReport, { report, fetchedAt: Date.now(), choice: { range: "7d", group: "instance" }, setChoice: () => {}, refresh: () => {} })); await settle(3); };
  const heads = () => p.root.querySelectorAll(".us-table thead th").map((t: any) => t.textContent);
  it("no response timed anywhere: no Speed column, no card", async () => {
    await mount(base([row("a", null)]));
    expect(heads()).not.toContain("Speed");
    expect(p.root.querySelector(".us-speed")).toBeNull();
    await p.unmount();
  });
  it("timed: the column says tok/s, an untimed row says why; the card gives rate, coverage and spread", async () => {
    const s = { tokPerSec: 87.3, timedRequests: 3, coverage: 0.75, p10: 45.3, p90: 128 };
    await mount(base([row("a", s), row("b", null)], [{ model: "claude-opus-4-5", backends: ["claude-code"], requests: 4, speed: s }]));
    expect(heads().at(-1)).toBe("Speed");
    const cells = p.root.querySelectorAll(".us-row").map((r: any) => r.querySelectorAll("td").at(-1));
    expect(cells[0].textContent).toBe("87 tok/s");
    expect(cells[1].textContent).toBe("—");
    const dash = cells[1].querySelector(".us-none");
    expect([dash.getAttribute("role"), dash.getAttribute("aria-label"), dash.getAttribute("title")]).toEqual(["img", "no timing in its transcripts", "no timing in its transcripts"]);
    expect(p.root.querySelector(".us-speed .row-item").textContent).toBe("claude-opus-4-587 tok/s3 of 4 requests timed · p10–p90: 45–128 tok/s");
    expect(p.root.querySelector(".us-speed .note").textContent).toBe("Output tokens ÷ the model's own response time (tool time excluded); method after tokdash.");
    await p.unmount();
  });
});
