/**
 * #3066 §2: output speed after the first token (tokdash's post_first_token, MIT): the Claude reader's timing rules, the
 * ledger and rollup keeping it, the report's rate / coverage / spread, and the page's Speed column and card.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

describe("Codex (0.147+): model items' clocks, closed by token_usage_record (the shapes a real codex 0.165 wrote)", () => {
  const L = (o: unknown) => ({ whole: Buffer.from(JSON.stringify(o)) }) as any;
  const item = (type: string, s: number, e: number) => L({ timestamp: iso(e), type: "event_msg", payload: { type: "item_completed", thread_id: "t", turn_id: "u", started_at_ms: T0 + s, completed_at_ms: T0 + e, item: { type, id: "x" } } });
  const record = (out: number) => L({ timestamp: iso(0), ordinal: 1, type: "token_usage_record", payload: { thread_id: "t", turn_id: "u", response_id: "r", usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: out } } });
  const run = (lines: any[]) => { const file: FileCursor = { kind: "codex", ino: 1, offset: 0, model: "gpt-5.5" }; const out: Array<{ tokens: number; ms: number }> = [];
    for (const l of lines) { codexLine(l, file); for (const s of file.speeds ?? []) out.push({ tokens: s.tokens, ms: s.ms }); delete file.speeds; } return out; };
  it("first model item's start → last model item's end; a client tool bounds nothing", () => {
    expect(run([item("UserMessage", 0, 0), item("Reasoning", 1_000, 3_000), item("CommandExecution", 3_000, 60_000), item("AgentMessage", 3_000, 5_000), record(400)]))
      .toEqual([{ tokens: 400, ms: 4_000 }]);
  });
  it("hosted WebSearch time inside is the server's, not the model's: subtracted", () => {
    expect(run([item("Reasoning", 0, 2_000), item("WebSearch", 2_000, 3_000), item("AgentMessage", 3_000, 5_000), record(400)])).toEqual([{ tokens: 400, ms: 4_000 }]);
  });
  it("not timed: no model item clock (an older rollout), a zero window, faster than 3000 tok/s; the record closes the response either way", () => {
    expect(run([record(400)])).toEqual([]);
    expect(run([item("AgentMessage", 1_000, 1_000), record(2)])).toEqual([]);                  // the mock's instant reply
    expect(run([item("AgentMessage", 1_000, 1_100), record(400)])).toEqual([]);                // 4000 tok/s
    expect(run([item("AgentMessage", 1_000, 1_100), record(400), item("AgentMessage", 2_000, 4_000), record(200)])).toEqual([{ tokens: 200, ms: 2_000 }]);
  });
  it("a long item line (its text cut to head and tail) is read from its head, where the clocks are", () => {
    const head = Buffer.from(JSON.stringify({ timestamp: iso(5_000), type: "event_msg", payload: { type: "item_completed", thread_id: "t", turn_id: "u", started_at_ms: T0 + 1_000, completed_at_ms: T0 + 5_000, item: { type: "AgentMessage", id: "x", content: "…" } } }).slice(0, 300));
    expect(run([{ head, tail: Buffer.from("…}}"), length: 9_000_000 } as any, record(800)])).toEqual([{ tokens: 800, ms: 4_000 }]);
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
