/**
 * #3066 §1: the measured weekly capacity — the estimate (usage/capacity.ts), its words (usage-api capacityText), its
 * serving (attached to weekly metrics on copies), the fleet's refresh (quota history × ledger hours, by account and
 * model), and the dialog (the line under the bar; a stale tab falls back to the server's English, never the bare key).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPACITY_MIN_DELTA, estimateCapacity as estimateOrNull, quotaWindows, type CapacityEstimate, type CapacityHour } from "../src/usage/capacity.js";
import { capacityText as textOrNull, getUsageSnapshot, setCapacityLookup, setUsageFetcherForTests } from "../src/usage/usage-api.js";
import { parseQuotaReading, quotaReadingsOf, setQuotaHistoryFileForTests, type QuotaReading } from "../src/usage/quota-history.js";
import { FleetManager } from "../src/fleet-manager.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const H = 3_600_000, T0 = Date.parse("2026-11-02T00:00:00.000Z"), WEEK = 7 * 24 * H;
const rd = (t: number, used: number, resetsAt = "2026-11-09T00:00:00.000Z", metric = "Weekly"): QuotaReading => ({ t, provider: "claude:hsinlin", profile: "hsinlin", metric, used, resetsAt, windowMs: WEEK });
/** The estimate, never null where a test expects one. */
const estimateCapacity = (...a: Parameters<typeof estimateOrNull>): any => { const e = estimateOrNull(...a); expect(e).not.toBeNull(); return e!; };
const capacityText = (e: CapacityEstimate) => { const c = textOrNull(e); expect(c).not.toBeNull(); return c!; };
const B = (median: number, low: number, high: number, cv: number | null, windows: number) => ({ median, low, high, cv, windows });
/** `n` whole hours from `from`, each using these amounts. */
const hours = (from: number, n: number, v: Partial<CapacityHour> = {}): CapacityHour[] =>
  Array.from({ length: n }, (_, i) => ({ hour: from + i * H, api: 1, output: 100, all: 1000, ...v }));

describe("the estimate (#3066 §1)", () => {
  it("one window: consumed ÷ Δ%, the range from the boundary hours and the whole-percent step", () => {
    // Readings at 10:30 (10%) and 20:30 (30%); usage 1000 tokens in each hour 10:00…20:00.
    const est = estimateCapacity([rd(T0 + 10.5 * H, 10), rd(T0 + 20.5 * H, 30)], hours(T0 + 10 * H, 11));
    expect(est.status).toBe("ok");
    if (est.status !== "ok") return;
    expect(est.windows).toBe(1);
    expect(est.deltaPct).toBe(20);
    const all = est.bases.all!;
    expect(all.median).toBeCloseTo(10_000 / 0.2);                  // the midpoint (9 inside, 11 touching hours) ÷ 20%
    expect(all.low).toBeCloseTo(9_000 / 0.21);                     // inside only ÷ (Δ+1)
    expect(all.high).toBeCloseTo(11_000 / 0.19);                   // touching ÷ (Δ−1)
    expect(est.bases.api!.median).toBeCloseTo(10 / 0.2);
  });
  it(`below Δ ${CAPACITY_MIN_DELTA} points: not enough yet, with how far it got`, () => {
    const est = estimateCapacity([rd(T0, 4), rd(T0 + 10 * H, 10)], hours(T0, 10));
    expect(est).toEqual({ status: "not_enough", deltaPct: 6 });
  });
  it("never across a reset: a new resetsAt, or a percent that went down, starts a new window", () => {
    const ws = quotaWindows([rd(T0, 50), rd(T0 + H, 80), rd(T0 + 2 * H, 2, "2026-11-16T00:00:00.000Z"), rd(T0 + 3 * H, 30, "2026-11-16T00:00:00.000Z"), rd(T0 + 4 * H, 1, "2026-11-16T00:00:00.000Z")]);
    expect(ws.map((w) => [w.p1, w.p2])).toEqual([[50, 80], [2, 30], [1, 1]]);
  });
  it("a model without a list price in the window: no API-equivalent basis (tokens only) — never priced as $0", () => {
    const est = estimateCapacity([rd(T0, 0), rd(T0 + 20 * H, 40)], [...hours(T0, 19), ...hours(T0 + 19 * H, 1, { api: null })]);
    expect(est.status === "ok" && est.bases.api).toBeUndefined();
    expect(est.status === "ok" && est.bases.all!.median).toBeGreaterThan(0);
  });
  it("three weeks: the basis that holds steadiest is named; tokens swinging while dollars hold → API-equivalent", () => {
    const readings: QuotaReading[] = [], hs: CapacityHour[] = [];
    for (let k = 0; k < 3; k++) {
      const start = T0 + k * WEEK, reset = new Date(start + WEEK).toISOString();
      readings.push(rd(start, 0, reset), rd(start + 50 * H, 50, reset));
      hs.push(...hours(start, 50, { api: 1, all: [1000, 3000, 600][k]!, output: [100, 300, 60][k]! }));   // same $, different mix
    }
    const est = estimateCapacity(readings, hs);
    expect(est.status === "ok" && est.windows).toBe(3);
    expect(est.status === "ok" && est.bestFit).toBe("api");
  });
  it("mixed: in a window the API-equivalent and the tokens disagree by more than 2× (each against its own median)", () => {
    const readings: QuotaReading[] = [], hs: CapacityHour[] = [];
    for (let k = 0; k < 2; k++) {
      const start = T0 + k * WEEK, reset = new Date(start + WEEK).toISOString();
      readings.push(rd(start, 0, reset), rd(start + 50 * H, 50, reset));
      hs.push(...hours(start, 50, { api: [1, 5][k]!, all: 1000 }));
    }
    expect(estimateCapacity(readings, hs)).toMatchObject({ status: "ok", mixed: true });
  });
});

describe("Prism #3073 review (the estimate)", () => {
  it("P1: windows with enough movement but no usage of this account on any basis: no estimate (null), not an empty ok", () => {
    expect(estimateOrNull([rd(T0, 0), rd(T0 + 20 * H, 30)], [])).toBeNull();
    expect(estimateOrNull([rd(T0, 0), rd(T0 + 20 * H, 30)], hours(T0 + 40 * H, 5))).toBeNull();   // only hours outside it
  });
  it("P2: a reset time drifting by seconds between reads is one window (sameReset); a real reset still splits", () => {
    const drift = (sec: number) => new Date(Date.parse("2026-11-09T00:00:00.000Z") + sec * 1000).toISOString();
    const one = quotaWindows([rd(T0, 0, drift(0)), rd(T0 + 10 * H, 12, drift(37)), rd(T0 + 20 * H, 25, drift(-21)), rd(T0 + 30 * H, 31, drift(64))]);
    expect(one.map((w) => [w.p1, w.p2])).toEqual([[0, 31]]);
    const est = estimateCapacity([rd(T0, 0, drift(0)), rd(T0 + 10 * H, 12, drift(37)), rd(T0 + 20 * H, 25, drift(-21))], hours(T0, 20));
    expect(est).toMatchObject({ status: "ok", windows: 1, deltaPct: 25 });
    // A real weekly reset moves the time by days — even with the percent climbing on both sides.
    const two = quotaWindows([rd(T0, 10, drift(0)), rd(T0 + 10 * H, 20, drift(0)), rd(T0 + 20 * H, 30, drift(WEEK / 1000)), rd(T0 + 30 * H, 40, drift(WEEK / 1000 + 30))]);
    expect(two.map((w) => [w.p1, w.p2])).toEqual([[10, 20], [30, 40]]);
  });
  it("P2: a window whose hours the ledger no longer has (or never scanned) is left out, never counted as zero use", () => {
    const readings = [rd(T0, 0), rd(T0 + 20 * H, 20), rd(T0 + WEEK, 0, "2026-11-16T00:00:00.000Z"), rd(T0 + WEEK + 20 * H, 20, "2026-11-16T00:00:00.000Z")];
    // Usage only in the second week: the ledger kept/scanned from T0 + WEEK on.
    const hs = hours(T0 + WEEK, 20);
    const keptFrom = T0 + WEEK;
    const est = estimateCapacity(readings, hs, (from) => from >= keptFrom);
    expect(est.windows).toBe(1);                                      // the first week is not a window of zero use
    expect(est.bases.all.median).toBeCloseTo(20_000 / 0.2);
    // Straddling the cutoff: the window starts an hour before the oldest kept hour — out.
    expect(estimateOrNull(readings.slice(2), hs, (from) => from >= keptFrom + H)).toBeNull();
    // Entirely unavailable: nothing to say (not "not enough").
    expect(estimateOrNull(readings, hs, () => false)).toBeNull();
    // Control: every hour available — the empty first week counts and halves nothing it should not (it has no usage,
    // so its bases are absent; the second week alone measures, the same as above).
    expect(estimateCapacity(readings, hs).bases.all.median).toBeCloseTo(20_000 / 0.2);
  });
  it("per basis, the windows it was measured over (an unpriced hour drops the API-equivalent from one window only)", () => {
    const readings: QuotaReading[] = [], hs: CapacityHour[] = [];
    for (let k = 0; k < 3; k++) {
      const start = T0 + k * WEEK, reset = new Date(start + WEEK).toISOString();
      readings.push(rd(start, 0, reset), rd(start + 50 * H, 50, reset));
      // Dollars steady; tokens swing — yet the API-equivalent, measured over two weeks only, cannot be the best fit.
      hs.push(...hours(start, 50, k === 2 ? { api: null } : { api: 1, all: [1000, 3000][k]!, output: [100, 300][k]! }));
    }
    const est = estimateCapacity(readings, hs);
    expect([est.windows, est.bases.api.windows, est.bases.all.windows]).toEqual([3, 2, 3]);
    expect(est.bases.api.cv).toBe(0);
    expect(est.bestFit).not.toBe("api");
    const c = capacityText(est);
    expect(c.line.i18n.args?.at(-1)).toBe(2);                         // "from 2 weeks": the dollars are from two
    expect(c.windows).toBe(2);
  });
});

describe("Prism #3073 P2: the quota history records a per-model quota's scope", () => {
  it("recorded from the metric, read back; anything else in the field is not a reading", () => {
    const rs = quotaReadingsOf({ id: "claude", name: "Claude", status: "ok", metrics: [
      { label: "Weekly", type: "percent", used: 10, windowMs: WEEK }, { label: "Sonnet (weekly)", scope: "model", type: "percent", used: 3, windowMs: WEEK },
      { label: "Luna Reserve (weekly)", type: "percent", used: 7, windowMs: WEEK }] } as any, T0);
    expect(rs.map((r) => [r.metric, r.scope])).toEqual([["Weekly", undefined], ["Sonnet (weekly)", "model"], ["Luna Reserve (weekly)", undefined]]);
    expect(parseQuotaReading(JSON.stringify(rs[1]))).toEqual(rs[1]);
    expect(parseQuotaReading(JSON.stringify({ ...rs[1], scope: "pool" }))).toBeNull();
  });
});

describe("the words (#3066 §1, the strings as approved)", () => {
  it("ok with API-equivalent: the line, and the fleet-only limit always", () => {
    const c = capacityText({ status: "ok", windows: 3, deltaPct: 40, bestFit: null, mixed: false,
      bases: { api: B(412, 378, 455, 0.07, 3), all: B(31e6, 29e6, 34e6, 0.2, 3), output: B(2e6, 1e6, 3e6, 0.3, 3) } });
    expect(c.line).toEqual({ text: "100% ≈ $412 ($378–$455) · ≈ 31.0M tokens · from 3 weeks", i18n: { key: "usage.capacity.line", args: ["$412", "$378", "$455", "31.0M", 3] } });
    expect(c.notes.map((n) => n.i18n.key)).toEqual(["usage.capacity.only_agend"]);
    expect(c).toMatchObject({ basis: "api", median: 412, tokens: 31e6 });
  });
  it("tokens only, best fit and mixed notes; not enough", () => {
    const c = capacityText({ status: "ok", windows: 4, deltaPct: 30, bestFit: "all", mixed: true, bases: { all: B(2.5e6, 2e6, 3e6, 0.12, 4) } });
    expect(c.line.text).toBe("100% ≈ 2.5M tokens (2.0M–3.0M) · from 4 weeks");
    expect(c.notes.map((n) => n.text)).toEqual(["Counts only this fleet's agents; use of the same account elsewhere makes this low.", "All tokens fit best: ±12% across 4 weeks", "Bases disagree — possibly used outside this fleet"]);
    expect(capacityText({ status: "not_enough", deltaPct: 6 }).line.text).toBe("Not enough usage yet to measure 100% (Δ 6% of 10%)");
  });
});

describe("served (#3066 §1)", () => {
  afterEach(() => { setCapacityLookup(null); setUsageFetcherForTests(null); });
  it("Prism #3073 P1: an ok estimate with no basis (or a lookup that throws) never fails the read; the bars stay", async () => {
    setUsageFetcherForTests(async () => ({ fetchedAt: new Date().toISOString(), providers: [{ id: "claude", name: "Claude", status: "ok", metrics: [
      { label: "Session", type: "percent", used: 4, windowMs: 5 * H }, { label: "Weekly", type: "percent", used: 62, windowMs: WEEK }, { label: "Sonnet (weekly)", type: "percent", used: 9, windowMs: WEEK }] }] }) as any);
    setCapacityLookup((_p, m) => { if (m === "Sonnet (weekly)") throw new Error("boom"); return { status: "ok", windows: 1, deltaPct: 30, bases: {}, bestFit: null, mixed: false }; });
    const snap = await getUsageSnapshot(true);
    const metrics = snap.providers[0]!.metrics as any[];
    expect(metrics.map((m) => [m.label, m.used, "capacity" in m])).toEqual([["Session", 4, false], ["Weekly", 62, false], ["Sonnet (weekly)", 9, false]]);
    expect(textOrNull({ status: "ok", windows: 1, deltaPct: 30, bases: {}, bestFit: null, mixed: false })).toBeNull();
  });
  it("a weekly percent metric gets `capacity`; the session window does not; the cached payload stays as read", async () => {
    setUsageFetcherForTests(async () => ({ fetchedAt: new Date().toISOString(), providers: [{ id: "claude:hsinlin", name: "Claude", status: "ok", profile: "hsinlin", metrics: [
      { label: "Session", type: "percent", used: 4, windowMs: 5 * H }, { label: "Weekly", type: "percent", used: 62, windowMs: WEEK }] }] }) as any);
    setCapacityLookup((p, m) => (p === "claude:hsinlin" && m === "Weekly" ? { status: "not_enough", deltaPct: 6 } : null));
    const metrics = (await getUsageSnapshot(true)).providers[0]!.metrics as any[];
    expect(metrics.map((m) => !!m.capacity)).toEqual([false, true]);
    expect(metrics[1].capacity.line.i18n.key).toBe("usage.capacity.not_enough");
    setCapacityLookup(null);
    expect(((await getUsageSnapshot(false)).providers[0]!.metrics as any[]).some((m) => m.capacity)).toBe(false);
  });
});

describe("the fleet's refresh (#3066 §1)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "agend-3066-cap-")); });
  beforeEach(() => { vi.useFakeTimers({ now: T0 + 3 * 24 * H, toFake: ["Date"] }); });
  afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); setCapacityLookup(null); await setQuotaHistoryFileForTests(null); rmSync(dir, { recursive: true, force: true }); });
  /** Everything from 40 days back to now scanned. */
  const scanned = () => ({ coverage: [[T0 - 40 * 24 * H, T0 + 3 * 24 * H]] });
  const hoursOf = (src: string, model: string, n: number, from = T0) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(from + i * H), { m: {}, g: [], src: { [src]: { [`${model}|0`]: [1, 100, 0, 0, 0, 0, 900] } } }]));
  let homes = 0;
  const fleetWith = async (lines: QuotaReading[], instances: Array<{ hours: Record<string, unknown>; days?: unknown; backend?: string }>, fleetConfig?: unknown, profileDirs: string[] = []) => {
    const home = join(dir, `home${++homes}`); mkdirSync(home, { recursive: true });
    const fm = new FleetManager(home);
    if (fleetConfig) (fm as any).fleetConfig = fleetConfig;
    for (const d of profileDirs) mkdirSync(join(home, "credential-profiles", d), { recursive: true });
    const hist = join(dir, "h.jsonl");
    writeFileSync(hist, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await setQuotaHistoryFileForTests(hist);
    vi.spyOn(fm as any, "cacheServiceFor").mockReturnValue({ usageData: async () => ({ scanning: {}, instances: instances.map((x, i) => ({ inst: { name: `i${i}`, backend: x.backend ?? "claude-code" }, status: "ok", ledger: { hours: x.hours }, days: x.days ?? scanned() })) }) });
    await fm.refreshCapacity();
    return (fm as any).capacityEstimates as Map<string, any>;
  };
  const host = (r: QuotaReading): QuotaReading => ({ ...r, provider: "claude", profile: undefined });
  it("Prism #3073 P2: a profile literally named \"default\" (or unknown/unrecorded) is ambiguous — neither account is estimated", async () => {
    const lines = [host(rd(T0, 0)), host(rd(T0 + 20 * H, 20)), { ...rd(T0, 0), provider: "claude:default", profile: "default" }, { ...rd(T0 + 20 * H, 20), provider: "claude:default", profile: "default" }];
    const cfg = (name: string) => ({ instances: { x: { backend: "claude-code", backend_options: { "claude-code": { credential_profile: name } } } } });
    // Configured now (and no other trace: no "claude:default" in the history, no directory) — config alone decides.
    const named = await fleetWith(lines.slice(0, 2), [{ hours: hoursOf("claude:default", "claude-opus-4-5", 20) }], cfg("default"));
    expect([...named.keys()]).toEqual([]);                        // never credited to the host account
    // Control: an ordinary named profile beside the host — the host is estimated from its own hours. (Its history
    // holds no "claude:default": that alone would make it ambiguous, r2.)
    const control = await fleetWith(lines.slice(0, 2), [{ hours: hoursOf("claude:default", "claude-opus-4-5", 20) }], cfg("hsinlin"));
    expect(control.get("claude\u0000Weekly")?.status).toBe("ok");
    // "unrecorded" named for codex: its hours are not dropped as no one's while the account is estimated without them.
    const cx = [{ ...rd(T0, 0), provider: "codex:unrecorded", profile: "unrecorded" }, { ...rd(T0 + 20 * H, 20), provider: "codex:unrecorded", profile: "unrecorded" }];
    const unrec = await fleetWith(cx, [{ hours: hoursOf("codex:unrecorded", "gpt-5.5", 20) }], { instances: { y: { backend: "codex", backend_options: { codex: { credential_profile: "unrecorded" } } } } });
    expect([...unrec.keys()]).toEqual([]);
  });
  it("Prism #3073 r2: a named reserved profile no longer configured still makes the account ambiguous (history, or its directory)", async () => {
    const hostLines = [host(rd(T0, 0)), host(rd(T0 + 20 * H, 20))];
    const namedLines = [{ ...rd(T0, 0), provider: "claude:default", profile: "default" }, { ...rd(T0 + 20 * H, 20), provider: "claude:default", profile: "default" }];
    const buckets = [{ hours: hoursOf("claude:default", "claude-opus-4-5", 20) }];
    // configure → record → remove: the binding is gone; its readings stay in the quota history.
    expect([...(await fleetWith([...hostLines, ...namedLines], buckets)).keys()]).toEqual([]);
    // … or only its profile directory is left on this host.
    expect([...(await fleetWith(hostLines, buckets, undefined, ["claude-code/default"])).keys()]).toEqual([]);
    // Control: no trace of a named "default" — the host's own hours are its.
    expect((await fleetWith(hostLines, buckets, undefined, ["claude-code/hsinlin"])).get("claude\u0000Weekly")?.status).toBe("ok");
  });
  it("Prism #3073 r2: an instance of the backend still waiting for its first scan (no hours, no coverage) holds the estimate back", async () => {
    const lines = [rd(T0, 0), rd(T0 + 20 * H, 20)];
    const hs = { hours: hoursOf("claude:hsinlin", "claude-opus-4-5", 20) };
    expect((await fleetWith(lines, [hs, { hours: {}, days: { coverage: [] } }])).has("claude:hsinlin\u0000Weekly")).toBe(false);
    // Control: the sibling was scanned and used nothing — zero is known, the estimate stands.
    expect((await fleetWith(lines, [hs, { hours: {} }])).get("claude:hsinlin\u0000Weekly")?.status).toBe("ok");
    // Another backend's pending instance is no contributor.
    expect((await fleetWith(lines, [hs, { hours: {}, days: { coverage: [] }, backend: "codex" }])).get("claude:hsinlin\u0000Weekly")?.status).toBe("ok");
  });
  it("Prism #3073 P2: only a vendor per-model weekly is filtered by model; a named pool (Luna Reserve) gets no estimate", async () => {
    const lines = [rd(T0, 0, undefined, "Luna Reserve (weekly)"), rd(T0 + 20 * H, 20, undefined, "Luna Reserve (weekly)"),
      { ...rd(T0, 0, undefined, "Sonnet (weekly)"), scope: "model" as const }, { ...rd(T0 + 20 * H, 20, undefined, "Sonnet (weekly)"), scope: "model" as const }];
    // Even a model whose name has the pool's word in it does not make the pool a per-model quota.
    const est = await fleetWith(lines, [{ hours: { ...hoursOf("claude:hsinlin", "claude-sonnet-4-5", 20) } }, { hours: hoursOf("claude:hsinlin", "luna reserve", 20) }]);
    expect(est.has("claude:hsinlin\u0000Luna Reserve (weekly)")).toBe(false);
    expect(est.get("claude:hsinlin\u0000Sonnet (weekly)")?.status).toBe("ok");
  });
  it("Prism #3073 P2: a window outside the scanned hours of an instance using the account is left out", async () => {
    const lines = [rd(T0, 0), rd(T0 + 20 * H, 20)];
    const hs = hoursOf("claude:hsinlin", "claude-opus-4-5", 20);
    // Instance b scanned only from T0 + 10 h: the window's first hours may hold its use — no estimate.
    const partly = await fleetWith(lines, [{ hours: hs }, { hours: hoursOf("claude:hsinlin", "claude-opus-4-5", 5, T0 + 12 * H), days: { coverage: [[T0 + 10 * H, T0 + 3 * 24 * H]] } }]);
    expect(partly.has("claude:hsinlin\u0000Weekly")).toBe(false);
    // Control: both scanned through the window.
    const whole = await fleetWith(lines, [{ hours: hs }, { hours: hoursOf("claude:hsinlin", "claude-opus-4-5", 5, T0 + 12 * H) }]);
    expect(whole.get("claude:hsinlin\u0000Weekly")?.status).toBe("ok");
    // Older than the ledger keeps (31 days): out, though the quota history still has it.
    vi.setSystemTime(T0 + 32 * 24 * H);
    const old = await fleetWith(lines, [{ hours: hs, days: { coverage: [[T0 - 40 * 24 * H, T0 + 40 * 24 * H]] } }]);
    expect(old.has("claude:hsinlin\u0000Weekly")).toBe(false);
  });
  it("by account (provider id ↔ ledger source by profile) and, for a per-model weekly, that model's tokens only", async () => {
    const home = join(dir, "home"); mkdirSync(home);
    const fm = new FleetManager(home);
    const hist = join(dir, "h.jsonl");
    const perModel = (r: QuotaReading): QuotaReading => ({ ...r, scope: "model" });
    const lines = [rd(T0, 0), rd(T0 + 20 * H, 20), perModel(rd(T0, 0, undefined, "Sonnet (weekly)")), perModel(rd(T0 + 20 * H, 10, undefined, "Sonnet (weekly)")),
      { ...rd(T0, 0), provider: "codex", profile: undefined }, { ...rd(T0 + 20 * H, 30), provider: "codex", profile: undefined }];
    writeFileSync(hist, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await setQuotaHistoryFileForTests(hist);
    vi.spyOn(fm as any, "cacheServiceFor").mockReturnValue({ usageData: async () => ({ scanning: {}, instances: [
      { inst: { name: "a" }, status: "ok", ledger: { hours: { ...hoursOf("claude:hsinlin", "claude-opus-4-5", 20) } }, days: scanned() },
      { inst: { name: "b" }, status: "ok", ledger: { hours: Object.fromEntries(Object.entries(hoursOf("claude:hsinlin", "claude-sonnet-4-5", 20)).map(([k, v]) => [String(Number(k) + 30 * 60_000 - 30 * 60_000), v])) }, days: scanned() },
      { inst: { name: "c" }, status: "ok", ledger: { hours: hoursOf("codex:unrecorded", "gpt-5.5", 20) }, days: scanned() },
    ] }) });
    expect(await fm.refreshCapacity()).toBe(2);
    const est = (fm as any).capacityEstimates as Map<string, any>;
    const weekly = est.get("claude:hsinlin\u0000Weekly"), sonnet = est.get("claude:hsinlin\u0000Sonnet (weekly)"), codex = est.get("codex\u0000Weekly");
    expect(weekly.status).toBe("ok");
    expect(sonnet.status).toBe("ok");
    // Weekly counts both models (2 × 1000 tokens an hour), Sonnet's only its own (1000), over 20% vs 10%.
    expect(weekly.bases.all.median / sonnet.bases.all.median).toBeCloseTo((2000 / 20) / (1000 / 10), 1);
    // Codex's hours were "unrecorded" — no account's: nothing measured for "codex", and nothing served (Prism #3073 P1).
    expect(codex).toBeUndefined();
  });
});

describe("the dialog (#3066 §1)", () => {
  let p: AppPage, D: any;
  beforeAll(async () => { p = page({ url: "http://127.0.0.1:19280/ui/fleet" }); D = await import("/assets/usage-dialog.js"); });
  afterAll(() => p.restore());
  const cap = { status: "ok", line: { text: "100% ≈ $412 ($378–$455) · ≈ 31.0M tokens · from 3 weeks", i18n: { key: "usage.capacity.line", args: ["$412", "$378", "$455", "31.0M", 3] } },
    notes: [{ text: "Counts only this fleet's agents; use of the same account elsewhere makes this low.", i18n: { key: "usage.capacity.only_agend", args: [] } }] };
  it("under the weekly bar: the line and the fleet-only limit", async () => {
    await p.mount(h(D.UsageMetric, { m: { label: "Weekly", type: "percent", used: 62, windowMs: WEEK, capacity: cap } })); await settle(2);
    expect(p.root.querySelector(".u-cap-line").textContent).toBe("100% ≈ $412 ($378–$455) · ≈ 31.0M tokens · from 3 weeks");
    expect(p.root.querySelectorAll(".u-cap-note").map((n: any) => n.textContent)).toEqual(["Counts only this fleet's agents; use of the same account elsewhere makes this low."]);
    await p.unmount();
  });
  it("a stale tab (its strings predate the key): the server's English, never the bare key", () => {
    expect(D.capacityLine({ text: "100% ≈ 2.5M tokens", i18n: { key: "usage.capacity.not_in_this_tab", args: [] } })).toBe("100% ≈ 2.5M tokens");
    expect(D.capacityLine(cap.line)).toBe("100% ≈ $412 ($378–$455) · ≈ 31.0M tokens · from 3 weeks");
  });
  it("no capacity: nothing more under the bar", async () => {
    await p.mount(h(D.UsageMetric, { m: { label: "Weekly", type: "percent", used: 62, windowMs: WEEK } })); await settle(2);
    expect(p.root.querySelector(".u-cap")).toBeNull();
    await p.unmount();
  });
});
