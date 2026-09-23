import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  MuseUsageRelay,
  MuseUsageSseParser,
  clearMuseUsageSnapshot,
  parseMuseSubscriptionUsage,
  readMuseUsageSnapshot,
  rewriteMuseRelayPath,
  MUSE_USAGE_STALE_MS,
  writeMuseUsageSnapshot,
} from "../src/muse-usage-relay.js";
import { fetchMuseUsage } from "../src/usage/providers.js";

const dirs: string[] = [];
const originalAgendHome = process.env.AGEND_HOME;
afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalAgendHome === undefined) delete process.env.AGEND_HOME;
  else process.env.AGEND_HOME = originalAgendHome;
});

describe("Muse usage relay protocol", () => {
  it("rewrites only the two code-owned path forms", () => {
    expect(rewriteMuseRelayPath("/muse-code/responses?x=1")).toBe("/muse-code/responses?x=1");
    expect(rewriteMuseRelayPath("/muse-code/config")).toBe("/muse-code/config");
    expect(rewriteMuseRelayPath("/responses")).toBe("/v1/responses");
    expect(rewriteMuseRelayPath("/v1/responses")).toBe("/v1/responses");
  });

  it("parses a subscription_usage event without inventing percentages", () => {
    expect(parseMuseSubscriptionUsage(JSON.stringify({
      subscription: {
        window: { used_percent: 23, resets_at: 1_700_000_000, window_duration_mins: 300 },
        weekly: { used_percent: 41, resets_at: 1_700_500_000 },
        tier: "pro",
      },
      type: "response.subscription_usage",
    }))).toEqual({
      session: { usedPercent: 23, resetsAt: 1_700_000_000, windowMs: 18_000_000 },
      weekly: { usedPercent: 41, resetsAt: 1_700_500_000 },
      plan: "Pro",
    });
    expect(parseMuseSubscriptionUsage(JSON.stringify({ type: "response.other", used_percent: 99 }))).toBeNull();
    expect(parseMuseSubscriptionUsage(JSON.stringify({
      subscription: { window: { used_percent: 123, resets_at: 1_700_000_000 } },
      type: "response.subscription_usage",
    }))?.session?.usedPercent).toBe(123);
    expect(parseMuseSubscriptionUsage(JSON.stringify({
      subscription: { tier: "27681393394859588", window: { used_percent: 12, resets_at: 1_700_000_000 } },
      type: "response.subscription_usage",
    }))?.plan).toBeUndefined();
  });

  it("handles event and JSON boundaries split across stream chunks", () => {
    const parser = new MuseUsageSseParser();
    expect(parser.feed("event: response.subscription_usage\ndata: {\"subscription\":{\"window\":{\"used_percent\":")).toEqual([]);
    expect(parser.feed("12,\"resets_at\":1700000000,\"window_duration_mins\":300}}}\n\n")).toEqual([
      { session: { usedPercent: 12, resetsAt: 1_700_000_000, windowMs: 18_000_000 }, weekly: undefined, plan: undefined },
    ]);
  });

  it("persists token-free snapshots atomically and rejects stale data", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-muse-relay-"));
    dirs.push(dir);
    writeMuseUsageSnapshot(dir, {
      observedAt: Date.now(),
      plan: "Subscription",
      session: { usedPercent: 8, resetsAt: 1_700_000_000 },
    });
    expect(readMuseUsageSnapshot(dir)?.session?.usedPercent).toBe(8);
    clearMuseUsageSnapshot(dir);
    expect(readMuseUsageSnapshot(dir)).toBeNull();
  });

  it("binds loopback only and exposes a base URL before Muse starts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-muse-relay-"));
    dirs.push(dir);
    const relay = new MuseUsageRelay({ instanceDir: dir });
    const base = await relay.start();
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((relay as unknown as { server: { address: () => { address: string } } }).server.address().address).toBe("127.0.0.1");
    await relay.stop();
    expect(relay.baseUrl).toBeNull();
  });

  it("rejects a non-code-owned upstream outside the loopback test seam", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-muse-relay-"));
    dirs.push(dir);
    expect(() => new MuseUsageRelay({ instanceDir: dir, upstreamOrigin: "https://evil.example" })).toThrow(/api\.meta\.ai/);
  });

  it("reclaims its original port after an unexpected listener close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-muse-relay-"));
    dirs.push(dir);
    const relay = new MuseUsageRelay({ instanceDir: dir });
    const base = await relay.start();
    const port = Number(new URL(base).port);
    (relay as unknown as { server: { close: () => void } }).server.close();
    for (let i = 0; i < 20 && relay.port !== port; i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(relay.port).toBe(port);
    await relay.stop();
  });

  it("retries a transient EADDRINUSE while reclaiming the baked-in port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-muse-relay-"));
    dirs.push(dir);
    const relay = new MuseUsageRelay({ instanceDir: dir });
    const originalListen = (relay as unknown as { listen: (port: number) => Promise<void> }).listen;
    let attempts = 0;
    (relay as unknown as { listen: (port: number) => Promise<void> }).listen = async function(port: number) {
      attempts++;
      if (attempts === 2) {
        const error = Object.assign(new Error("address in use"), { code: "EADDRINUSE" });
        throw error;
      }
      return originalListen.call(this, port);
    };
    const base = await relay.start();
    const port = Number(new URL(base).port);
    (relay as unknown as { server: { close: () => void } }).server.close();
    for (let i = 0; i < 30 && attempts < 3; i++) await new Promise(resolve => setTimeout(resolve, 20));
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(relay.port).toBe(port);
    await relay.stop();
  });

  it("passes streamed bytes and authorization through while parsing a side channel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-muse-relay-"));
    dirs.push(dir);
    let seenPath = "";
    let seenAuth = "";
    const upstream = createServer((req, res) => {
      seenPath = req.url ?? "";
      seenAuth = String(req.headers.authorization ?? "");
      res.writeHead(200, { "content-type": "text/event-stream", "x-upstream": "yes" });
      res.write("event: response.subscription_usage\ndata: {\"session\":{\"used_percent\":");
      setTimeout(() => { res.end("12,\"resets_at\":1700000000}}\n\n"); }, 15);
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", () => resolve()));
    const port = (upstream.address() as { port: number }).port;
    const relay = new MuseUsageRelay({
      instanceDir: dir,
      upstreamOrigin: `http://127.0.0.1:${port}`,
      request: httpRequest,
    });
    const base = await relay.start();
    const chunks: Buffer[] = [];
    const startedAt = Date.now();
    let firstChunkAt = 0;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(`${base}/muse-code/responses`, { headers: { authorization: "Bearer test-only" } }, res => {
        res.on("data", chunk => { if (!firstChunkAt) firstChunkAt = Date.now(); chunks.push(Buffer.from(chunk)); });
        res.on("end", resolve);
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    });
    expect(seenPath).toBe("/muse-code/responses");
    expect(seenAuth).toBe("Bearer test-only");
    expect(firstChunkAt - startedAt).toBeLessThan(100);
    expect(Buffer.concat(chunks).toString()).toContain("used_percent");
    expect(readMuseUsageSnapshot(dir)?.session?.usedPercent).toBe(12);
    await relay.stop();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });

  it("parses gzip and brotli SSE side channels without changing response bytes", async () => {
    for (const [encoding, compress] of [["gzip", gzipSync], ["br", brotliCompressSync]] as const) {
      const dir = mkdtempSync(join(tmpdir(), "agend-muse-relay-"));
      dirs.push(dir);
      const plain = Buffer.from("event: response.subscription_usage\ndata: {\"session\":{\"used_percent\":27,\"resets_at\":1700000000}}\n\n");
      const compressed = compress(plain);
      const upstream = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": encoding });
        res.end(compressed);
      });
      await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", () => resolve()));
      const upstreamPort = (upstream.address() as { port: number }).port;
      const relay = new MuseUsageRelay({ instanceDir: dir, upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, request: httpRequest });
      const base = await relay.start();
      const body = await new Promise<Buffer>((resolve, reject) => {
        const req = httpRequest(`${base}/responses`, res => {
          const chunks: Buffer[] = [];
          res.on("data", chunk => chunks.push(Buffer.from(chunk)));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        });
        req.on("error", reject);
        req.end();
      });
      expect(body.equals(compressed)).toBe(true);
      // The raw response can finish before the decoder's side-channel flush;
      // wait briefly for the token-free snapshot without delaying the relay's
      // streamed response path.
      for (let i = 0; i < 50 && readMuseUsageSnapshot(dir)?.session?.usedPercent !== 27; i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      expect(readMuseUsageSnapshot(dir)?.session?.usedPercent).toBe(27);
      await relay.stop();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });

  it("rebinds while an old keep-alive stream is still draining", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-muse-relay-"));
    dirs.push(dir);
    let requests = 0;
    const upstream = createServer((_req, res) => {
      requests++;
      res.writeHead(200, { "content-type": "text/plain", connection: "keep-alive" });
      res.write(`request-${requests}`);
      if (requests > 1) res.end();
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", () => resolve()));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const relay = new MuseUsageRelay({
      instanceDir: dir,
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
      request: httpRequest,
    });
    const base = await relay.start();
    const first = httpRequest(`${base}/responses`, res => { res.on("data", () => {}); });
    first.end();
    await new Promise<void>(resolve => first.once("response", () => resolve()));
    const port = relay.port;
    (relay as unknown as { server: { close: () => void } }).server.close();
    for (let i = 0; i < 20 && relay.port !== port; i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(relay.port).toBe(port);
    const secondBody = await new Promise<string>((resolve, reject) => {
      const second = httpRequest(`${base}/responses`, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve(Buffer.concat(chunks).toString()));
        res.on("error", reject);
      });
      second.on("error", reject);
      second.end();
    });
    expect(secondBody).toBe("request-2");
    first.destroy();
    await relay.stop();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  });

  it("projects the exact Muse subscription payload into Session and Weekly usage", async () => {
    const home = mkdtempSync(join(tmpdir(), "agend-muse-usage-"));
    dirs.push(home);
    process.env.AGEND_HOME = home;
    writeFileSync(join(home, "fleet.yaml"), "instances:\n  muse-one:\n    backend: muse\n");
    const instance = join(home, "instances", "muse-one");
    writeMuseUsageSnapshot(instance, {
      observedAt: Date.now(),
      plan: "pro",
      session: { usedPercent: 23, resetsAt: 1_700_000_000, windowMs: 18_000_000 },
      weekly: { usedPercent: 41, resetsAt: 1_700_500_000 },
    });
    const usage = await fetchMuseUsage();
    expect(usage.plan).toBe("Pro");
    expect(usage.metrics.map(metric => [metric.label, metric.used, metric.windowMs])).toEqual([
      ["Session", 23, 18_000_000],
      ["Weekly", 41, 7 * 24 * 60 * 60 * 1000],
    ]);

    writeMuseUsageSnapshot(instance, {
      observedAt: Date.now(),
      plan: "27681393394859588",
      session: { usedPercent: 123, resetsAt: 1_700_000_000 },
    });
    const redactedPlan = await fetchMuseUsage();
    expect(redactedPlan.plan).toBe("Subscription");
    expect(redactedPlan.metrics[0]?.used).toBe(123);
  });

  it("treats the stale boundary as unavailable", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-muse-relay-"));
    dirs.push(dir);
    writeMuseUsageSnapshot(dir, {
      observedAt: Date.now() - MUSE_USAGE_STALE_MS - 1,
      session: { usedPercent: 8, resetsAt: 1_700_000_000 },
    });
    expect(readMuseUsageSnapshot(dir)).toBeNull();
  });
});
