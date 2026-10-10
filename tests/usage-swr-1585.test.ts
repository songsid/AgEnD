/**
 * #1585: the dashboard's usage panel opens from the last snapshot at once and refreshes behind it (stale-while-
 * revalidate), with vendors called exactly as before: the same expiry starts the same single shared fetch. Chat, tools
 * and Discord presence still wait for a fresh snapshot. A stale snapshot is never served across a fleet-config change,
 * past 60 minutes, or from a browser/proxy cache.
 */
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUsageSnapshot, handleUsageRequest, setUsageFetcherForTests, type UsageApiContext, type UsagePayload } from "../src/usage/usage-api.js";

const ctx = { fleetConfig: { defaults: {}, instances: {} }, logger: { debug() {}, info() {}, warn() {}, error() {} } } as unknown as UsageApiContext;
function get(path = "/api/ai-usage"): Promise<{ code: number; headers: Record<string, string>; body: UsagePayload; ms: number }> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const headers: Record<string, string> = {};
    let code = 0;
    const res = {
      writeHead(c: number, h?: Record<string, string>) { code = c; Object.assign(headers, h ?? {}); return res; },
      end(b?: string) { resolve({ code, headers, body: JSON.parse(b ?? "null"), ms: performance.now() - t0 }); },
    } as unknown as ServerResponse;
    handleUsageRequest({ method: "GET" } as IncomingMessage, res, new URL(path, "http://localhost:19280"), ctx);
  });
}

let home: string;
let calls = 0;
let gate: (() => void) | null = null;
const MIN = 60_000;
/** A fetcher that answers when `gate` is called, or at once when `slowMs` is 0. */
function fetcher(slowMs = 0) {
  return async (): Promise<UsagePayload> => {
    calls++;
    const n = calls;
    if (slowMs) await new Promise<void>((r) => { gate = r; setTimeout(r, slowMs); });
    return { fetchedAt: new Date().toISOString(), providers: [{ id: "claude", name: "Claude", status: "ok", metrics: [{ label: `fetch ${n}`, value: n } as never] }] };
  };
}
const label = (p: UsagePayload) => (p.providers[0]?.metrics[0] as unknown as { label: string }).label;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agend-usage-swr-"));
  vi.stubEnv("AGEND_HOME", home);
  writeFileSync(join(home, "fleet.yaml"), "instances: {}\n");
  calls = 0; gate = null;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
});
afterEach(() => {
  setUsageFetcherForTests(null);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("the panel opens from the last snapshot at once (#1585)", () => {
  it("an expired snapshot is answered at once, marked refreshing, while one fetch runs; then the fresh one", async () => {
    setUsageFetcherForTests(fetcher(200));
    const warm = getUsageSnapshot(); gate!(); await warm;   // fetch 1
    vi.setSystemTime(Date.now() + 6 * MIN);                 // past the 5-minute TTL
    const stale = await get();
    expect([stale.code, label(stale.body), stale.body.refreshing]).toEqual([200, "fetch 1", true]);
    expect(calls).toBe(2);                                   // the one refresh the expiry started
    gate!(); await new Promise((r) => setTimeout(r, 0));
    const fresh = await get();
    expect([label(fresh.body), fresh.body.refreshing]).toEqual(["fetch 2", undefined]);
    expect(calls).toBe(2);
  });

  it("vendors are called no more often: many panel reads of one expired snapshot start one fetch; within the TTL none", async () => {
    setUsageFetcherForTests(fetcher(200));
    const warm = getUsageSnapshot(); gate!(); await warm;
    expect(calls).toBe(1);
    await Promise.all([get(), get(), get()]);
    expect(calls).toBe(1);                                   // fresh: from the cache
    vi.setSystemTime(Date.now() + 6 * MIN);
    const answers = await Promise.all([get(), get(), get(), get()]);
    expect(answers.every((a) => a.body.refreshing === true)).toBe(true);
    expect(calls).toBe(2);                                   // one shared refresh
    gate!();
  });

  it("chat, tools and Discord presence (getUsageSnapshot) still wait for a fresh snapshot", async () => {
    setUsageFetcherForTests(fetcher(200));
    const warm = getUsageSnapshot(); gate!(); await warm;
    vi.setSystemTime(Date.now() + 6 * MIN);
    let settled = false;
    const chat = getUsageSnapshot().then((p) => { settled = true; return p; });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    gate!();
    expect([label(await chat), (await chat).refreshing]).toEqual(["fetch 2", undefined]);
  });

  it("not across a fleet-config change: a profile added since means other accounts — that read waits", async () => {
    setUsageFetcherForTests(fetcher(200));
    const warm = getUsageSnapshot(); gate!(); await warm;
    writeFileSync(join(home, "fleet.yaml"), "instances: {}\n# a profile was added\n");
    utimesSync(join(home, "fleet.yaml"), new Date(Date.now() + 1000), new Date(Date.now() + 1000));
    vi.setSystemTime(Date.now() + 6 * MIN);
    let settled = false;
    const panel = get().then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    gate!();
    expect(label((await panel).body)).toBe("fetch 2");
  });

  it("not past 60 minutes: so old a snapshot is not shown as the panel's numbers", async () => {
    setUsageFetcherForTests(fetcher(200));
    const warm = getUsageSnapshot(); gate!(); await warm;
    vi.setSystemTime(Date.now() + 61 * MIN);
    let settled = false;
    const panel = get().then((r) => { settled = true; return r; });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    gate!();
    expect((await panel).body.refreshing).toBeUndefined();
  });

  it("force still waits for its fetch (the Refresh button), and its 30 s floor holds", async () => {
    setUsageFetcherForTests(fetcher(200));
    const warm = getUsageSnapshot(); gate!(); await warm;
    vi.setSystemTime(Date.now() + 6 * MIN);
    const forced = get("/api/ai-usage?force=1");
    await new Promise((r) => setTimeout(r, 0));
    gate!();
    const r = await forced;
    expect([label(r.body), r.body.refreshing, calls]).toEqual(["fetch 2", undefined, 2]);
  });

  it("never a browser or proxy cache: Cache-Control: no-store", async () => {
    setUsageFetcherForTests(fetcher());
    expect((await get()).headers["Cache-Control"]).toBe("no-store");
  });
});

describe("open latency, measured on the real route (#1585)", () => {
  it("an expired snapshot answers in milliseconds where it used to wait for the vendors (2 s here)", async () => {
    vi.useRealTimers();
    setUsageFetcherForTests(fetcher(2_000));
    const cold = await get();                                // the first read after start: waits, as before
    expect(cold.ms).toBeGreaterThanOrEqual(1_900);
    // The same snapshot past its TTL: before #1585 this read waited ~2 s again; now it is answered at once.
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * MIN;
    try {
      const stale = await get();
      expect(stale.body.refreshing).toBe(true);
      expect(stale.ms).toBeLessThan(100);
      console.log(`[#1585] open latency: cold ${cold.ms.toFixed(0)} ms; expired snapshot ${stale.ms.toFixed(1)} ms (was ~${cold.ms.toFixed(0)} ms)`);
    } finally { Date.now = realNow; }
  }, 15_000);
});
