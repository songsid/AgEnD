import { afterEach, describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  handleUsageRequest,
  isUsagePath,
  setUsageFetcherForTests,
  type UsageApiContext,
} from "../src/usage/usage-api.js";

function fakeCtx(overrides: Partial<UsageApiContext> = {}): UsageApiContext {
  return {
    fleetConfig: { defaults: {}, instances: {} } as unknown as UsageApiContext["fleetConfig"],
    logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as UsageApiContext["logger"],
    ...overrides,
  };
}

function fakeRes() {
  const out = { code: 0, headers: {} as Record<string, string>, body: "", done: Promise.resolve() };
  let resolve!: () => void;
  out.done = new Promise<void>(r => { resolve = r; });
  const res = {
    writeHead(code: number, headers?: Record<string, string>) { out.code = code; Object.assign(out.headers, headers ?? {}); return res; },
    end(body?: string) { out.body = body ?? ""; resolve(); },
  } as unknown as ServerResponse;
  return { res, out };
}

const fakeReq = (method = "GET") => ({ method } as unknown as IncomingMessage);
const urlFor = (path: string) => new URL(path, "http://localhost:19280");

afterEach(() => setUsageFetcherForTests(null));

describe("isUsagePath", () => {
  it("claims only /api/ai-usage", () => {
    expect(isUsagePath("/api/ai-usage")).toBe(true);
    expect(isUsagePath("/api/ai-usage/extra")).toBe(false);
    expect(isUsagePath("/api/profiles")).toBe(false);
    expect(isUsagePath("/view")).toBe(false);
  });
});

describe("GET /api/ai-usage", () => {
  it("returns the fetched payload and caches it", async () => {
    let calls = 0;
    setUsageFetcherForTests(async () => {
      calls++;
      return {
        fetchedAt: "2026-01-01T00:00:00.000Z",
        providers: [{ id: "claude", name: "Claude", status: "ok" as const, plan: "Team 5x", metrics: [] }],
      };
    });

    const first = fakeRes();
    expect(handleUsageRequest(fakeReq(), first.res, urlFor("/api/ai-usage"), fakeCtx())).toBe(true);
    await first.out.done;
    expect(first.out.code).toBe(200);
    const body = JSON.parse(first.out.body);
    expect(body.providers[0].plan).toBe("Team 5x");

    // Second request within the TTL is served from cache — the fetcher runs once.
    const second = fakeRes();
    handleUsageRequest(fakeReq(), second.res, urlFor("/api/ai-usage"), fakeCtx());
    await second.out.done;
    expect(second.out.code).toBe(200);
    expect(calls).toBe(1);

    // ?force=1 bypasses the cache.
    const third = fakeRes();
    handleUsageRequest(fakeReq(), third.res, urlFor("/api/ai-usage?force=1"), fakeCtx());
    await third.out.done;
    expect(calls).toBe(2);
  });

  it("ignores paths that are not ours", () => {
    const { res } = fakeRes();
    expect(handleUsageRequest(fakeReq(), res, urlFor("/api/profiles"), fakeCtx())).toBe(false);
  });

  it("rejects non-GET methods", async () => {
    const { res, out } = fakeRes();
    expect(handleUsageRequest(fakeReq("POST"), res, urlFor("/api/ai-usage"), fakeCtx())).toBe(true);
    await out.done;
    expect(out.code).toBe(405);
  });

  it("returns 404 when web.usage_panel is false", async () => {
    const ctx = fakeCtx({
      fleetConfig: { defaults: {}, instances: {}, web: { usage_panel: false } } as unknown as UsageApiContext["fleetConfig"],
    });
    const { res, out } = fakeRes();
    expect(handleUsageRequest(fakeReq(), res, urlFor("/api/ai-usage"), ctx)).toBe(true);
    await out.done;
    expect(out.code).toBe(404);
  });

  it("reports fetcher failures as 500 with an error body", async () => {
    setUsageFetcherForTests(async () => { throw new Error("boom"); });
    const { res, out } = fakeRes();
    handleUsageRequest(fakeReq(), res, urlFor("/api/ai-usage"), fakeCtx());
    await out.done;
    expect(out.code).toBe(500);
    expect(JSON.parse(out.body).error).toContain("boom");
  });
});
