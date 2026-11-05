/**
 * #3066 §1: the measured weekly capacity — the estimate (usage/capacity.ts), its words (usage-api capacityText), its
 * serving (attached to weekly metrics on copies), the fleet's refresh (quota history × ledger hours, by account and
 * model), and the dialog (the line under the bar; a stale tab falls back to the server's English, never the bare key).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPACITY_MIN_DELTA, estimateCapacity, quotaWindows, type CapacityHour } from "../src/usage/capacity.js";
import { capacityText, getUsageSnapshot, setCapacityLookup, setUsageFetcherForTests } from "../src/usage/usage-api.js";
import { setQuotaHistoryFileForTests, type QuotaReading } from "../src/usage/quota-history.js";
import { FleetManager } from "../src/fleet-manager.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const H = 3_600_000, T0 = Date.parse("2026-11-02T00:00:00.000Z"), WEEK = 7 * 24 * H;
const rd = (t: number, used: number, resetsAt = "2026-11-09T00:00:00.000Z", metric = "Weekly"): QuotaReading => ({ t, provider: "claude:hsinlin", profile: "hsinlin", metric, used, resetsAt, windowMs: WEEK });
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

describe("the words (#3066 §1, the strings as approved)", () => {
  it("ok with API-equivalent: the line, and the fleet-only limit always", () => {
    const c = capacityText({ status: "ok", windows: 3, deltaPct: 40, bestFit: null, mixed: false,
      bases: { api: { median: 412, low: 378, high: 455, cv: 0.07 }, all: { median: 31e6, low: 29e6, high: 34e6, cv: 0.2 }, output: { median: 2e6, low: 1e6, high: 3e6, cv: 0.3 } } });
    expect(c.line).toEqual({ text: "100% ≈ $412 ($378–$455) · ≈ 31.0M tokens · from 3 weeks", i18n: { key: "usage.capacity.line", args: ["$412", "$378", "$455", "31.0M", 3] } });
    expect(c.notes.map((n) => n.i18n.key)).toEqual(["usage.capacity.only_agend"]);
    expect(c).toMatchObject({ basis: "api", median: 412, tokens: 31e6 });
  });
  it("tokens only, best fit and mixed notes; not enough", () => {
    const c = capacityText({ status: "ok", windows: 4, deltaPct: 30, bestFit: "all", mixed: true, bases: { all: { median: 2.5e6, low: 2e6, high: 3e6, cv: 0.12 } } });
    expect(c.line.text).toBe("100% ≈ 2.5M tokens (2.0M–3.0M) · from 4 weeks");
    expect(c.notes.map((n) => n.text)).toEqual(["Counts only this fleet's agents; use of the same account elsewhere makes this low.", "All tokens fit best: ±12% across 4 weeks", "Bases disagree — possibly used outside this fleet"]);
    expect(capacityText({ status: "not_enough", deltaPct: 6 }).line.text).toBe("Not enough usage yet to measure 100% (Δ 6% of 10%)");
  });
});

describe("served (#3066 §1)", () => {
  afterEach(() => { setCapacityLookup(null); setUsageFetcherForTests(null); });
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
  afterEach(async () => { vi.restoreAllMocks(); setCapacityLookup(null); await setQuotaHistoryFileForTests(null); rmSync(dir, { recursive: true, force: true }); });
  it("by account (provider id ↔ ledger source by profile) and, for a per-model weekly, that model's tokens only", async () => {
    const home = join(dir, "home"); mkdirSync(home);
    const fm = new FleetManager(home);
    const hist = join(dir, "h.jsonl");
    const lines = [rd(T0, 0), rd(T0 + 20 * H, 20), rd(T0, 0, undefined, "Sonnet (weekly)"), rd(T0 + 20 * H, 10, undefined, "Sonnet (weekly)"),
      { ...rd(T0, 0), provider: "codex", profile: undefined }, { ...rd(T0 + 20 * H, 30), provider: "codex", profile: undefined }];
    writeFileSync(hist, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await setQuotaHistoryFileForTests(hist);
    const hoursOf = (src: string, model: string, n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [String(T0 + i * H), { m: {}, g: [], src: { [src]: { [`${model}|0`]: [1, 100, 0, 0, 0, 0, 900] } } }]));
    vi.spyOn(fm as any, "cacheServiceFor").mockReturnValue({ usageData: async () => ({ scanning: {}, instances: [
      { inst: { name: "a" }, status: "ok", ledger: { hours: { ...hoursOf("claude:hsinlin", "claude-opus-4-5", 20) } }, days: {} },
      { inst: { name: "b" }, status: "ok", ledger: { hours: Object.fromEntries(Object.entries(hoursOf("claude:hsinlin", "claude-sonnet-4-5", 20)).map(([k, v]) => [String(Number(k) + 30 * 60_000 - 30 * 60_000), v])) }, days: {} },
      { inst: { name: "c" }, status: "ok", ledger: { hours: hoursOf("codex:unrecorded", "gpt-5.5", 20) }, days: {} },
    ] }) });
    expect(await fm.refreshCapacity()).toBe(3);
    const est = (fm as any).capacityEstimates as Map<string, any>;
    const weekly = est.get("claude:hsinlin\u0000Weekly"), sonnet = est.get("claude:hsinlin\u0000Sonnet (weekly)"), codex = est.get("codex\u0000Weekly");
    expect(weekly.status).toBe("ok");
    expect(sonnet.status).toBe("ok");
    // Weekly counts both models (2 × 1000 tokens an hour), Sonnet's only its own (1000), over 20% vs 10%.
    expect(weekly.bases.all.median / sonnet.bases.all.median).toBeCloseTo((2000 / 20) / (1000 / 10), 1);
    // Codex's hours were "unrecorded" — no account's: nothing measured for "codex".
    expect(codex).toEqual({ status: "ok", windows: 1, deltaPct: 30, bases: {}, bestFit: null, mixed: false });
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
