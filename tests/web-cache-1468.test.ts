/**
 * #1468: Fleet → Cache on the web — the route and the page.
 * - GET /ui/cache?window=… answers the service's report; signed in only; the public link admits the GET only; it is a
 *   person's navigation (not a passive read). FleetManager.cacheReport takes an unknown window as 7 days.
 * - The page reads once per opening and per window chosen, never on a timer (#1374); Refresh reads again.
 * - It shows the fleet row, a card per instance (recommendation, reason, numbers, gap histogram with the TTL), the
 *   estimate and price notes, and the instances it cannot analyse — read-only, nothing to change.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleWebRequest } from "../src/web-api.js";
import { isPublicWebRoute } from "../src/public-web-gateway.js";
import { isPassiveWebRead } from "../src/web-auth.js";
import { FleetManager } from "../src/fleet-manager.js";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const token = "c".repeat(48);
function call(path: string, over: Record<string, unknown> = {}, headers: Record<string, string> = { "x-agend-token": token }) {
  const req = Object.assign(new EventEmitter(), { method: "GET", url: path, headers: { host: "127.0.0.1:19280", ...headers } });
  let status = 0, body = "";
  const done = new Promise<void>((resolve) => {
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead: (c: number) => { status = c; }, end: (t = "") => { body = t; resolve(); } });
    const ctx = { webToken: token, logger: { info() {}, debug() {}, error() {} }, sseClients: new Set(), ...over } as any;
    handleWebRequest(req as never, res as never, new URL(path, "http://127.0.0.1:19280"), ctx);
  });
  return done.then(() => ({ status, body: body ? JSON.parse(body) : null }));
}

describe("the route", () => {
  it("answers the report for the window asked; 404 when not offered; 500 when it fails; 401 signed out", async () => {
    const cacheReport = vi.fn(async (w: string) => ({ window: w, instances: [] }));
    expect(await call("/ui/cache?window=24h", { cacheReport })).toEqual({ status: 200, body: { window: "24h", instances: [] } });
    expect(cacheReport).toHaveBeenCalledWith("24h");
    await call("/ui/cache", { cacheReport });
    expect(cacheReport).toHaveBeenLastCalledWith("7d");
    expect((await call("/ui/cache")).status).toBe(404);
    expect((await call("/ui/cache", { cacheReport: async () => { throw new Error("boom"); } })).status).toBe(500);
    expect((await call("/ui/cache", { cacheReport }, {})).status).toBe(401);
  });
  it("the public link admits the GET only; opening it counts as use", () => {
    expect(isPublicWebRoute("GET", "/ui/cache")).toBe(true);
    for (const m of ["POST", "PUT", "DELETE"]) expect(isPublicWebRoute(m, "/ui/cache"), m).toBe(false);
    expect(isPassiveWebRead("GET", "/ui/cache")).toBe(false);
  });
  it("FleetManager.cacheReport: an unknown window is 7 days; an empty fleet is an empty report", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cache-fm-"));
    try {
      const fake: any = { fleetConfig: { instances: {} }, dataDir: dir, getInstanceDir: (n: string) => join(dir, n), backendNameOf: () => "claude-code",
        logger: { info() {}, warn() {}, debug() {}, error() {} } };
      const r = await (FleetManager.prototype as any).cacheReport.call(fake, "__proto__");
      expect(r.window).toBe("7d");
      expect(r.instances).toEqual([]);
      fake.cacheService.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── The page ──
const sim = (o: Record<string, number>) => ({ pastTtl: 0, expired: 0, rewriteTokens: 0, expiryCost: 0, pings: 0, pingCost: 0, tailPings: 0, tailCost: 0, net: 0, priced: true, ...o });
const analysis = (o: Record<string, unknown>) => ({ requests: 120, ttlSec: 3600, estimate: false, priced: true, models: ["claude-opus-5-5"],
  gapBuckets: [100, 10, 3, 1, 1, 0, 2], totalCost: 20, share: 0.095, recommendation: { on: false, reason: "never_expired" }, sim: sim({}), ...o });
const REPORT = {
  window: "7d", from: 0, to: 1, pricesChecked: "2026-10-09", priceSources: [], scanning: { active: true, caughtUp: true, pendingBytes: 0, pendingFiles: 0 },
  fleet: { expiryCost: 1.9 + 7.4, saving: 0.8, recommended: 1, analysed: 3, priced: true },
  instances: [
    { name: "nightly", backend: "claude-code", status: "ok", analysis: analysis({ sim: sim({ pastTtl: 7, expired: 6, rewriteTokens: 6e6, expiryCost: 7.4, pings: 156, pingCost: 15.6, tailPings: 16, tailCost: 1.6, net: -5.8 }),
      recommendation: { on: false, reason: "costs_more", pingsPerExpiry: 29 } }) },
    { name: "worker", backend: "claude-code", status: "ok", analysis: analysis({ sim: sim({ pastTtl: 1, expired: 1, rewriteTokens: 1e6, expiryCost: 1.9, pings: 11, pingCost: 1.1, net: 0.8 }),
      recommendation: { on: true, reason: "saves" } }) },
    { name: "cx", backend: "codex", status: "ok", analysis: analysis({ ttlSec: 1800, estimate: true, models: ["gpt-6.1-sol"], gapBuckets: [50, 2, 1, 0, 0, 0, 0],
      sim: sim({ pastTtl: 2 }), recommendation: { on: false, reason: "never_expired" } }) },
    { name: "kiro", backend: "kiro-cli", status: "credit_billed" },
    { name: "idle", backend: "claude-code", status: "no_data" },
  ],
};

type Req = { method: string; url: string };
let reqs: Req[] = [];
let answer: unknown = REPORT;
const fetchFake = async (url: string, init: any = {}) => { reqs.push({ method: init.method || "GET", url }); return { ok: true, status: 200, json: async () => answer }; };
let p: AppPage;
let fleet: any, F: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/cache" });
  (globalThis as any).fetch = fetchFake;
  fleet = await import("/ui/js/panel-fleet.js");
  F = await import("/ui/js/fleet-cache.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => { vi.useRealTimers(); await p.unmount(); reqs = []; answer = REPORT; });
const mount = () => p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "cache" }, navKey: "fleet:cache|1|en" }));
const card = (name: string) => p.root.querySelectorAll(".ch-card").find((c: any) => c.querySelector("h3").textContent === name);
const metric = (c: any, label: string) => c.querySelectorAll(".ch-metric").find((m: any) => m.querySelector("dt").textContent === label)?.querySelector("dd").textContent;

describe("the page reads once per opening and per window; never on a timer", () => {
  it("one GET for 7 days on opening, none in ten minutes; choosing 24 h reads that window; Refresh reads again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"] });
    const m = mount(); await vi.advanceTimersByTimeAsync(50); await m;
    expect(reqs).toEqual([{ method: "GET", url: "/ui/cache?window=7d" }]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(reqs).toHaveLength(1);
    vi.useRealTimers();
    const btn = (text: string) => p.root.querySelectorAll(".ch-bar .btn").find((b: any) => b.textContent.trim() === text);
    expect(btn("7 days").getAttribute("aria-pressed")).toBe("true");
    btn("24 h").click(); await settle(6);
    expect(reqs.at(-1)).toEqual({ method: "GET", url: "/ui/cache?window=24h" });
    expect(btn("24 h").getAttribute("aria-pressed")).toBe("true");
    // Caught up, and the incremental check this read started has nothing behind: nothing to say.
    expect(!!p.root.querySelector(".ch-scan"), ".ch-scan").toBe(false);
    answer = { ...REPORT, scanning: { active: true, caughtUp: true, pendingBytes: 120e6, pendingFiles: 3 } };
    btn("30 days").click(); await settle(6);
    expect(p.root.querySelector(".ch-scan").textContent).toContain("120 MB left");
    p.root.querySelector(".ch-scan .btn").click(); await settle(6);
    expect(reqs.map((r) => r.url)).toEqual(["/ui/cache?window=7d", "/ui/cache?window=24h", "/ui/cache?window=30d", "/ui/cache?window=30d"]);
  });
});

describe("what it shows", () => {
  it("the fleet row; cards by expiry cost; the recommendation and its reason in numbers", async () => {
    await mount(); await settle(4);
    expect(p.root.querySelectorAll(".ch-fleet dd").map((e: any) => e.textContent)).toEqual(["$9.30", "$0.80", "1 of 3"]);
    expect(p.root.querySelectorAll(".ch-card h3").map((e: any) => e.textContent)).toEqual(["nightly", "worker", "cx"]);
    expect(card("worker").querySelector(".ch-rec").textContent).toBe("Keep warm");
    expect(card("worker").className).toContain("on");
    expect(card("worker").querySelector(".ch-reason").textContent).toBe("Often idle past the 1 h TTL and then used again: keep-warm would save $0.80 (42% of the expiry cost).");
    expect(card("nightly").querySelector(".ch-rec").textContent).toBe("Leave off");
    expect(card("nightly").querySelector(".ch-reason").textContent).toBe("Keep-warm would send about 29 pings per expired request — it would cost $5.80 more than it saves.");
    expect(card("cx").querySelector(".ch-reason").textContent).toBe("2 gaps outlasted the 30 min TTL, but the cache was still there. estimate");
    expect(metric(card("nightly"), "Keep-warm pings")).toBe("17216 after its last request");
    expect(card("nightly").querySelectorAll(".ch-metric dt").map((e: any) => e.textContent)[1]).toBe("Past the TTL (1 h)");
    expect(metric(card("nightly"), "Expiry cost")).toBe("$7.409.5% of its cost");
    expect(metric(card("nightly"), "Net with keep-warm")).toBe("−$5.80");
    expect(metric(card("worker"), "Net with keep-warm")).toBe("+$0.80");
    expect(metric(card("nightly"), "Tokens rewritten")).toBe("6.0M");
  });

  it("before the first catch-up ends: it says so; an instance whose sessions only ever went quiet: the pings nobody reads", async () => {
    answer = { ...REPORT, scanning: { active: true, caughtUp: false, pendingBytes: 0, pendingFiles: 0 }, instances: [{ name: "daily", backend: "claude-code", status: "ok",
      analysis: analysis({ sim: sim({ tailPings: 162, tailCost: 6.68, net: -6.68 }), recommendation: { on: false, reason: "never_expired" } }) }] };
    await mount(); await settle(4);
    expect(p.root.querySelector(".ch-scan span").textContent).toBe("Reading transcripts for the first time — Refresh to see more.");
    expect(card("daily").querySelector(".ch-reason").textContent).toBe("No request ever came back to an expired cache: each session went quiet for good. Keep-warm would only send 162 pings nobody reads.");
    expect(metric(card("daily"), "Expiry cost")).toBe("$0");                    // no share line for nothing
  });

  it("the notes: prices checked on a date, the subscription caveat, the Codex estimate", async () => {
    await mount(); await settle(4);
    const notes = p.root.querySelector(".ch-notes").textContent;
    expect(notes).toContain("List prices checked 2026-10-09.");
    expect(notes).toContain("an estimate in quota terms");
    expect(notes).toContain("Codex does not record cache writes");
  });

  it("the instances it cannot analyse, and why", async () => {
    await mount(); await settle(4);
    expect(p.root.querySelectorAll(".ch-rest .row-item").map((e: any) => [e.querySelector(".strong").textContent, e.querySelector(".muted").textContent]))
      .toEqual([["kiro", "kiro-cli · Not available (credit-billed; no cache data)"], ["idle", "claude-code · no requests read yet"]]);
  });

  it("the gap histogram: a bar per bucket, the TTL line after its edge, the buckets past it marked; no inline style anywhere", async () => {
    await mount(); await settle(4);
    const svg = card("worker").querySelector("svg.ch-hist");
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Gaps between requests: ≤5m 100, ≤30m 10, ≤1h 3, ≤2h 1, ≤6h 1, ≤24h 0, >24h 2");
    expect(svg.querySelectorAll("g.ch-col").map((g: any) => g.getAttribute("class"))).toEqual(["ch-col", "ch-col", "ch-col", "ch-col past", "ch-col past", "ch-col past", "ch-col past"]);
    expect(svg.querySelector(".ch-ttl text").textContent).toBe("TTL 1 h");
    expect(card("cx").querySelector(".ch-ttl text").textContent).toBe("TTL 30 min");
    expect(card("cx").querySelectorAll("g.ch-col.past")).toHaveLength(5);
    const all = [p.root, ...p.root.querySelectorAll("*")];
    expect(all.filter((e: any) => e.getAttribute && e.getAttribute("style") != null)).toEqual([]);
  });

  it("an instance not priced: no dollars, a tag, the note", async () => {
    answer = { ...REPORT, fleet: { ...REPORT.fleet, priced: false }, instances: [{ name: "odd", backend: "codex", status: "ok",
      analysis: analysis({ priced: false, models: ["gpt-reserve"], sim: sim({ expired: 2, expiryCost: 3, pings: 9, pingCost: 1, net: -1 }),
        recommendation: { on: false, reason: "costs_more", pingsPerExpiry: 5 } }) }] };
    await mount(); await settle(4);
    expect(metric(card("odd"), "Expiry cost")).toBe("—");
    expect(card("odd").querySelector(".ch-reason").textContent).toBe("Keep-warm would send about 5 pings per expired request — it would cost more than it saves. not priced");
    expect(p.root.querySelector(".ch-notes").textContent).toContain("input-price units");
  });

  it("an answer that is not a report: the error state, with Retry", async () => {
    answer = { error: "Not available" };
    await mount(); await settle(4);
    expect(!!p.root.querySelector(".ch"), ".ch").toBe(false);
    expect(p.root.querySelector(".error-state button").textContent).toBe("Try again");
  });
});

describe("formatting", () => {
  it("money, tokens, TTLs", () => {
    expect([F.money(0), F.money(0.004), F.money(1.234), F.money(1234.5)]).toEqual(["$0", "<$0.01", "$1.23", "$1,235"]);
    expect([F.tokens(950), F.tokens(12_345), F.tokens(6e6), F.tokens(2.5e9)]).toEqual(["950", "12k", "6.0M", "2.5B"]);
    expect([F.ttlText(3600), F.ttlText(1800), F.ttlText(300)]).toEqual(["1 h", "30 min", "5 min"]);
  });
});
