import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyModelBuckets, agyPoolMetrics, agyQuotaBuckets, agyUsageBuckets, DEFAULT_PROVIDER_DEADLINE_MS, fetchAllUsage, fetchAntigravityUsage, readAgyToken, setUsageProvidersForTests } from "../src/usage/providers.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const grouped = fixture("agy-quota-summary-grouped-2026-10.json");
// #2174: agy 1.4.2's live answers, the same minute (2026-10-19).
const summary142 = fixture("agy-1.4.2-quota/summary.json"), models142 = fixture("agy-1.4.2-quota/models.json");

/**
 * Antigravity quota pooling. Two payload shapes exist for
 * `retrieveUserQuotaSummary`; both were seen in the wild:
 * - pooled bucket ids (gemini-5h / 3p-weekly …) — OpenUsage's documented shape
 * - per-model buckets (gemini-3.6-flash-high, claude-sonnet-4-6, …) — what this
 *   machine's live account returned on 2026-08-02
 */

describe("agyPoolMetrics", () => {
  it("maps pooled bucket ids directly", () => {
    const metrics = agyPoolMetrics([
      { bucketId: "gemini-5h", remainingFraction: 0.66, resetTime: "2026-08-02T10:00:00Z" },
      { bucketId: "3p-weekly", remainingFraction: 0.9, resetTime: "2026-08-08T10:00:00Z" },
    ]);
    expect(metrics).toMatchObject([
      { label: "Gemini (session)", type: "percent", used: expect.closeTo(34, 5), resetsAt: "2026-08-02T10:00:00Z" },
      { label: "Claude & others (weekly)", type: "percent", used: expect.closeTo(10, 5), resetsAt: "2026-08-08T10:00:00Z" },
    ]);
  });

  it("aggregates per-model buckets into two pools, keeping the worst fraction", () => {
    // Verbatim ids from the live 2026-08-02 response (fractions varied for the test).
    const metrics = agyPoolMetrics([
      { bucketId: "gemini-3.6-flash-high", remainingFraction: 1, resetTime: "2026-08-08T16:12:24Z" },
      { bucketId: "gemini-3.1-pro-low", remainingFraction: 0.4, resetTime: "2026-08-08T16:12:24Z" },
      { bucketId: "claude-sonnet-4-6", remainingFraction: 0.75, resetTime: "2026-08-08T16:12:24Z" },
      { bucketId: "gpt-oss-120b-medium", remainingFraction: 0.5, resetTime: "2026-08-08T16:12:24Z" },
    ]);

    // The binding constraint is the model that runs out first — eleven per-model
    // meters would be noise; the worst per pool is the honest single number.
    expect(metrics).toMatchObject([
      { label: "Gemini", type: "percent", used: expect.closeTo(60, 5), resetsAt: "2026-08-08T16:12:24Z", note: "busiest of 2 models" },
      { label: "Claude & others", type: "percent", used: expect.closeTo(50, 5), resetsAt: "2026-08-08T16:12:24Z", note: "busiest of 2 models" },
    ]);
  });

  it("drops buckets without a usable fraction instead of fabricating 0% or 100%", () => {
    const metrics = agyPoolMetrics([
      { bucketId: "gemini-3.6-flash-high" },                       // no fraction
      { bucketId: "claude-sonnet-4-6", remainingFraction: NaN },   // unusable
      { displayName: "no id", remainingFraction: 0.5 },            // no bucket id
    ]);
    expect(metrics).toEqual([]);
  });

  it("prefers pooled ids over per-model aggregation when both appear", () => {
    const metrics = agyPoolMetrics([
      { bucketId: "gemini-weekly", remainingFraction: 0.8, resetTime: null as unknown as string },
      { bucketId: "gemini-3.6-flash-high", remainingFraction: 0.1 },
    ]);
    // The pooled id is the authoritative merged number; a per-model bucket must
    // not out-vote it.
    expect(metrics).toHaveLength(1);
    expect(metrics[0].label).toBe("Gemini (weekly)");
  });
});

describe("agy grouped quota summary (#1898)", () => {
  it("shows Gemini and Claude & others, session and weekly, when only the Claude group keeps the pooled ids", () => {
    const metrics = agyPoolMetrics(agyQuotaBuckets(grouped));
    expect(metrics.map(m => m.label)).toEqual([
      "Gemini (session)", "Gemini (weekly)", "Claude & others (session)", "Claude & others (weekly)",
    ]);
    expect(metrics[0]).toMatchObject({ used: expect.closeTo(4.15, 2), resetsAt: "2026-10-16T04:21:00Z" });
    expect(metrics[1]).toMatchObject({ used: expect.closeTo(1.82, 2), resetsAt: "2026-10-23T03:00:00Z" });
    expect(metrics[2]).toMatchObject({ used: 0 });
    expect(metrics[0].note).toBeUndefined(); // one bucket per limit: no "busiest of" note
  });

  it("takes the pool from the group and the limit from the bucket when no id is a known one", () => {
    const body = structuredClone(grouped);
    body.groups[1].buckets = [
      { bucketId: "q1", displayName: "Weekly Limit", remainingFraction: 0.5 },
      { bucketId: "q2", displayName: "Five Hour Limit", remainingFraction: 0.25 },
    ];
    body.groups[0].buckets = [{ bucketId: "q3", window: "5h", remainingFraction: 0.9 }];
    expect(agyPoolMetrics(agyQuotaBuckets(body)).map(m => [m.label, Math.round(m.used!)])).toEqual([
      ["Gemini (session)", 10], ["Claude & others (session)", 75], ["Claude & others (weekly)", 50],
    ]);
  });

  it("leaves disabled buckets out and uses the deprecated top-level list only without grouped buckets", () => {
    const body = structuredClone(grouped);
    body.groups[0].buckets[0].disabled = true;
    expect(agyPoolMetrics(agyQuotaBuckets(body)).map(m => m.label)).not.toContain("Gemini (weekly)");
    expect(agyQuotaBuckets({ groups: [], buckets: [{ bucketId: "gemini-5h", remainingFraction: 1 }] })).toHaveLength(1);
    expect(agyQuotaBuckets({ ...grouped, buckets: [{ bucketId: "gemini-5h", remainingFraction: 1 }] })).toHaveLength(4);
  });

  it("never lets the Claude group's pooled ids hide a Gemini group of per-model buckets", () => {
    const body = structuredClone(grouped);
    body.groups[0].buckets = [
      { bucketId: "gemini-3.6-flash", remainingFraction: 0.7 },
      { bucketId: "gemini-3.1-pro", remainingFraction: 0.4 },
    ];
    expect(agyPoolMetrics(agyQuotaBuckets(body))).toMatchObject([
      { label: "Gemini", used: expect.closeTo(60, 5), note: "busiest of 2 models" },
      { label: "Claude & others (session)" }, { label: "Claude & others (weekly)" },
    ]);
  });

  // Prism's witnesses on r1 (synthetic; the live ids and window values are not known).
  it.each(["5-hour", "5_hour", "5 hours", "5h"])("reads a five-hour limit written %j next to the weekly one", (form) => {
    const metrics = agyPoolMetrics(agyQuotaBuckets({ groups: [{ displayName: "Gemini Models", buckets: [
      { bucketId: "q-a", window: form, displayName: `${form} limit`, remainingFraction: 0.25 },
      { bucketId: "q-b", window: "weekly", displayName: "Weekly Limit", remainingFraction: 0.75 },
    ] }] }));
    expect(metrics.map(m => [m.label, m.used])).toEqual([["Gemini (session)", 75], ["Gemini (weekly)", 25]]);
  });

  it("reads the five-hour limit from the display name alone when window and id say nothing", () => {
    const metrics = agyPoolMetrics(agyQuotaBuckets({ groups: [{ displayName: "Gemini Models", buckets: [
      { bucketId: "q-a", displayName: "5-hour limit", remainingFraction: 0.25 },
      { bucketId: "q-b", displayName: "Weekly Limit", remainingFraction: 0.75 },
    ] }] }));
    expect(metrics.map(m => m.label)).toEqual(["Gemini (session)", "Gemini (weekly)"]);
  });

  it("a bucket's stated window wins over a word in an opaque id", () => {
    const metrics = agyPoolMetrics(agyQuotaBuckets({ groups: [{ displayName: "Gemini Models", buckets: [
      { bucketId: "opaque-session-quota", window: "WEEKLY", displayName: "Weekly Limit", remainingFraction: 0.75 },
      { bucketId: "q-a", window: "5h", displayName: "Five Hour Limit", remainingFraction: 0.25 },
    ] }] }));
    expect(metrics.map(m => [m.label, m.used, m.note])).toEqual([["Gemini (session)", 75, undefined], ["Gemini (weekly)", 25, undefined]]);
  });

  it("a per-model id or name with a 5 or 7 in it is no limit", () => {
    const metrics = agyPoolMetrics([
      { bucketId: "gemini-2.5-high", displayName: "Gemini 2.5 High", remainingFraction: 0.5 },
      { bucketId: "claude-opus-4-5-haiku", remainingFraction: 0.5 },
      { bucketId: "gpt-5-high", remainingFraction: 0.5 },
      { bucketId: "gemini-2.5h-preview", remainingFraction: 0.5 },   // 2.5 h, 15 h: not a five-hour limit
      { bucketId: "claude-15h", remainingFraction: 0.5 },
    ]);
    expect(metrics.map(m => m.label)).toEqual(["Gemini", "Claude & others"]);
  });

  it("names an unknown group by its own display name", () => {
    const metrics = agyPoolMetrics(agyQuotaBuckets({ groups: [{ displayName: "Imagen", buckets: [{ bucketId: "x", window: "weekly", remainingFraction: 0.5 }] }] }));
    expect(metrics).toMatchObject([{ label: "Imagen (weekly)", used: 50 }]);
  });
});

describe("a pool the summary leaves out (#2174, agy 1.4.2)", () => {
  const shown = (ms: any[]) => ms.map(m => [m.label, Math.round(m.used * 10) / 10, m.resetsAt, m.note ?? null]);
  it("the live summary alone has only Claude & others — the row the user reported", () => {
    expect(shown(agyPoolMetrics(agyQuotaBuckets(summary142)))).toEqual([
      ["Claude & others (session)", 0, "2026-10-19T08:16:13Z", null],
      ["Claude & others (weekly)", 2.4, "2026-10-23T08:04:22Z", null],
    ]);
  });
  it("the models' own quotas bring Gemini back, and leave the pool the summary names alone", () => {
    expect(shown(agyPoolMetrics(agyUsageBuckets(summary142, models142)))).toEqual([
      ["Claude & others (session)", 0, "2026-10-19T08:16:13Z", null],
      ["Claude & others (weekly)", 2.4, "2026-10-23T08:04:22Z", null],
      ["Gemini", 2.6, "2026-10-19T05:00:28Z", "busiest of 12 models"],   // the 12 Gemini models with a reset time
    ]);
  });
  it("only models with a reset time count: agy's internal tab and chat models report a bare 1", () => {
    const ids = agyModelBuckets(models142).map(b => b.bucketId);
    expect(ids).not.toContain("tab_flash_lite_preview");
    expect(ids).not.toContain("chat_23310");
    expect(ids.filter(id => id!.startsWith("gemini"))).toHaveLength(12);
  });
  it("a summary that names both pools takes nothing from the models", () => {
    expect(agyPoolMetrics(agyUsageBuckets(grouped, models142))).toEqual(agyPoolMetrics(agyQuotaBuckets(grouped)));
  });
  it("nor does a summary of per-model buckets: a pool it names is never counted twice", () => {
    const perModel = { buckets: [
      { bucketId: "gemini-3.6-flash-high", remainingFraction: 0.5, resetTime: "2026-10-19T05:00:00Z" },
      { bucketId: "claude-sonnet-4-6", remainingFraction: 0.75, resetTime: "2026-10-19T05:00:00Z" },
    ] };
    expect(agyPoolMetrics(agyUsageBuckets(perModel, models142))).toEqual(agyPoolMetrics(agyQuotaBuckets(perModel)));
  });
  it("a model's provider decides its pool before its id does", () => {
    const models = { models: { "nano-banana": { modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 0.5, resetTime: "2026-10-19T05:00:00Z" } } } };
    expect(agyPoolMetrics(agyUsageBuckets(summary142, models)).map(m => m.label)).toContain("Gemini");
  });
  it("without the models (their call failed) the summary still answers", () => {
    expect(agyPoolMetrics(agyUsageBuckets(summary142, null))).toEqual(agyPoolMetrics(agyQuotaBuckets(summary142)));
  });
  it("a provider or id nobody recognises is a pool of its own, under its own name — never folded into another", () => {
    const models = { models: {
      "grok-5": { modelProvider: "MODEL_PROVIDER_XAI", quotaInfo: { remainingFraction: 0.5, resetTime: "2026-10-19T05:00:00Z" } },
      "gemini-3-flash": { modelProvider: "MODEL_PROVIDER_GOOGLE", quotaInfo: { remainingFraction: 0.9, resetTime: "2026-10-19T05:00:00Z" } },
    } };
    expect(shown(agyPoolMetrics(agyUsageBuckets(summary142, models))).map(r => r[0])).toEqual(["Claude & others (session)", "Claude & others (weekly)", "XAI", "Gemini"]);
    // A summary bucket with an id no rule knows, outside any group: its own pool, not "Claude & others".
    expect(agyPoolMetrics([{ bucketId: "flash-5h", remainingFraction: 0.5 }])).toMatchObject([{ label: "flash-5h (session)", used: 50 }]);
  });
});

describe("fetchAntigravityUsage asks for the models' quotas beside the summary (#2174)", () => {
  const dirs: string[] = [];
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function login() {
    const home = mkdtempSync(join(tmpdir(), "agy-2174-")); dirs.push(home);
    mkdirSync(join(home, "antigravity-cli"), { recursive: true });
    writeFileSync(join(home, "antigravity-cli", "antigravity-oauth-token"), JSON.stringify({ token: { access_token: "test-token", expiry: new Date(Date.now() + 3_600_000).toISOString() } }));
    vi.stubEnv("GEMINI_HOME", home);
  }
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  it("on the base that answers, both reads; the row has Gemini again", async () => {
    login();
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith(":retrieveUserQuotaSummary")) return json(summary142);
      if (url.endsWith(":fetchAvailableModels")) return json(models142);
      return new Response("", { status: 404 });
    }));
    const r = await fetchAntigravityUsage();
    expect(r.status).toBe("ok");
    expect(r.metrics.map(m => m.label)).toEqual(["Claude & others (session)", "Claude & others (weekly)", "Gemini"]);
    expect(calls).toEqual(["https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"]);
  });
  it("a failing models read costs nothing: the summary's rows", async () => {
    login();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith(":retrieveUserQuotaSummary") ? json(summary142) : new Response("nope", { status: 500 })));
    expect((await fetchAntigravityUsage()).metrics.map(m => m.label)).toEqual(["Claude & others (session)", "Claude & others (weekly)"]);
  });
  it("nor does one that never answers (a network error)", async () => {
    login();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { if (url.endsWith(":retrieveUserQuotaSummary")) return json(summary142); throw new TypeError("fetch failed"); }));
    const r = await fetchAntigravityUsage();
    expect([r.status, r.metrics.map(m => m.label)]).toEqual(["ok", ["Claude & others (session)", "Claude & others (weekly)"]]);
  });
});

describe("the models' read never costs the row its summary (#2176 review: the 16s provider deadline)", () => {
  // The real fetchAntigravityUsage inside the real fetchAllUsage deadline, on fake timers. The models' read is optional:
  // once the summary has answered it gets what is left before the deadline, less a 1s margin, and is then cancelled.
  const DAILY = "https://daily-cloudcode-pa.googleapis.com/v1internal:", PROD = "https://cloudcode-pa.googleapis.com/v1internal:";
  const dirs: string[] = [];
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); setUsageProvidersForTests(null); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  type Answer = { at: number; status?: number; body?: unknown } | "stall" | "stall-ignoring-abort";
  async function run(answers: Record<string, Answer>, token: Record<string, string> = { access_token: "test-token", expiry: "2026-10-19T04:20:00Z" }) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    vi.setSystemTime(new Date("2026-10-19T03:20:00Z"));
    const t0 = performance.now(), elapsed = () => performance.now() - t0;
    const home = mkdtempSync(join(tmpdir(), "agy-2176-")); dirs.push(home);
    mkdirSync(join(home, "antigravity-cli"), { recursive: true });
    writeFileSync(join(home, "antigravity-cli", "antigravity-oauth-token"), JSON.stringify({ token }));
    vi.stubEnv("GEMINI_HOME", home);
    const calls: Array<{ url: string; at: number; signal?: AbortSignal }> = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init: { signal?: AbortSignal } = {}) => {
      calls.push({ url, at: elapsed(), signal: init.signal });
      const a = answers[url] ?? { at: 0, status: 404 };
      if (a === "stall" || a === "stall-ignoring-abort") return new Promise((_resolve, reject) => {
        if (a === "stall") init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return new Promise(resolve => setTimeout(() => resolve(new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200 })), a.at));
    }));
    setUsageProvidersForTests([{ id: "antigravity", name: "Antigravity", fetch: fetchAntigravityUsage }]);
    let settledAt: number | null = null;
    const snapshot = fetchAllUsage(null as never).then(r => { settledAt = elapsed(); return r; });
    while (calls.length === 0) await new Promise(r => setImmediate(r));   // the token file is read for real first
    await vi.advanceTimersByTimeAsync(DEFAULT_PROVIDER_DEADLINE_MS + 1_000);
    const row = (await snapshot).providers.find(p => p.id === "antigravity")!;
    return { row, settledAt: settledAt as number | null, calls, labels: row.metrics.map(m => m.label) };
  }
  const CLAUDE = ["Claude & others (session)", "Claude & others (weekly)"];

  it("the first base fails at 3s, the second's summary answers, its models stall: the summary's rows, at 15s", async () => {
    const { row, settledAt, calls, labels } = await run({
      [`${DAILY}retrieveUserQuotaSummary`]: { at: 3_000, status: 503 }, [`${DAILY}fetchAvailableModels`]: "stall",
      [`${PROD}retrieveUserQuotaSummary`]: { at: 0, body: summary142 }, [`${PROD}fetchAvailableModels`]: "stall",
    });
    expect([row.status, labels]).toEqual(["ok", CLAUDE]);
    expect(settledAt).toBe(DEFAULT_PROVIDER_DEADLINE_MS - 1_000);          // what was left, less the margin
    expect(calls.every(c => c.signal?.aborted || c.url.endsWith("retrieveUserQuotaSummary")), "both stalled models reads are cancelled").toBe(true);
  });
  it("even a models read that ignores its cancel cannot hold the row", async () => {
    const { row, settledAt, labels } = await run({ [`${DAILY}retrieveUserQuotaSummary`]: { at: 2_000, body: summary142 }, [`${DAILY}fetchAvailableModels`]: "stall-ignoring-abort" });
    expect([row.status, labels, settledAt]).toEqual(["ok", CLAUDE, DEFAULT_PROVIDER_DEADLINE_MS - 1_000]);
  });
  it("the summary at 15.5s: no time left for the models — the summary's rows, inside the deadline", async () => {
    const { row, labels, settledAt } = await run({ [`${DAILY}retrieveUserQuotaSummary`]: { at: 15_500, body: summary142 }, [`${DAILY}fetchAvailableModels`]: "stall" });
    expect([row.status, labels, settledAt]).toEqual(["ok", CLAUDE, 15_500]);
  });
  it("a token refresh first (2s) counts against the same deadline: the summary's rows at 15s", async () => {
    vi.stubEnv("AGY_OAUTH_CLIENT_ID", "test-client"); vi.stubEnv("AGY_OAUTH_CLIENT_SECRET", "test-secret");
    const { row, labels, settledAt, calls } = await run({
      "https://oauth2.googleapis.com/token": { at: 2_000, body: { access_token: "refreshed", expires_in: 3600 } },
      [`${DAILY}retrieveUserQuotaSummary`]: { at: 0, body: summary142 }, [`${DAILY}fetchAvailableModels`]: "stall",
    }, { access_token: "old", refresh_token: "test-refresh", expiry: "2026-10-19T03:00:00Z" });
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect([row.status, labels, settledAt]).toEqual(["ok", CLAUDE, DEFAULT_PROVIDER_DEADLINE_MS - 1_000]);
  });
  it("models that answer in time bring Gemini back", async () => {
    const { row, labels, settledAt } = await run({ [`${DAILY}retrieveUserQuotaSummary`]: { at: 2_000, body: summary142 }, [`${DAILY}fetchAvailableModels`]: { at: 4_000, body: models142 } });
    expect([row.status, labels, settledAt]).toEqual(["ok", [...CLAUDE, "Gemini"], 4_000]);
  });
});

describe("readAgyToken", () => {
  it("reads the nested shape this machine writes", () => {
    // { token: {...}, id_token, auth_method } — the shape agy actually stores.
    expect(readAgyToken({
      token: { access_token: "ya29.a", refresh_token: "1//r", expiry: "2026-08-02T10:00:00Z" },
      id_token: "eyJ", auth_method: "consumer",
    })).toEqual({ access_token: "ya29.a", refresh_token: "1//r", expiry: "2026-08-02T10:00:00Z" });
  });

  it("reads a flat shape too", () => {
    expect(readAgyToken({ access_token: "ya29.b", refresh_token: "1//s", expiry: "x" }))
      .toMatchObject({ access_token: "ya29.b", refresh_token: "1//s" });
  });

  it("falls back to the outer object when `token` holds no credentials", () => {
    // A nested key that is present but useless must not shadow a flat token.
    expect(readAgyToken({ token: { expiry: "x" }, access_token: "ya29.c" }))
      .toMatchObject({ access_token: "ya29.c" });
  });

  it("survives junk without throwing", () => {
    expect(readAgyToken(null)).toEqual({});
    expect(readAgyToken({})).toEqual({});
  });
});
