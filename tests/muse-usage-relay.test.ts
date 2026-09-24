import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { formatDiscordUsageActivity } from "../src/usage/usage-api.js";

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

  it("rejects a non-loopback origin even through the request seam", () => {
    // M8b: the seam exists for loopback test doubles only — a custom request
    // impl must not turn the relay into an arbitrary proxy.
    const dir = mkdtempSync(join(tmpdir(), "agend-muse-relay-"));
    dirs.push(dir);
    expect(() => new MuseUsageRelay({ instanceDir: dir, upstreamOrigin: "http://192.168.1.10:8080", request: httpRequest }))
      .toThrow(/api\.meta\.ai/);
    expect(() => new MuseUsageRelay({ instanceDir: dir, upstreamOrigin: "http://example.com/", request: httpRequest }))
      .toThrow(/api\.meta\.ai/);
  });

  it("ignores a renamed subscription event instead of parsing its payload", () => {
    // M2: only the canonical event name feeds the snapshot. Parser-level on
    // purpose: loopback dials are unusable in some sandboxes, and record() is
    // only ever fed by parser output, so gating the parse gates the write.
    const parser = new MuseUsageSseParser();
    expect(parser.feed(
      "event: response.subscription_usage_changed\n" +
      "data: {\"session\":{\"used_percent\":99,\"resets_at\":1800000000}}\n\n",
    )).toEqual([]);
    expect(parser.end()).toEqual([]);
    // The canonical name still parses — the gate is the name, not the shape.
    const canonical = new MuseUsageSseParser();
    expect(canonical.feed(
      "event: response.subscription_usage\n" +
      "data: {\"session\":{\"used_percent\":99,\"resets_at\":1800000000}}\n\n",
    )).toEqual([{ session: { usedPercent: 99, resetsAt: 1800000000 }, weekly: undefined, plan: undefined }]);
  });

  it("does not cut a slow upstream off at 30s — the stream stays open", async () => {
    // M13: pin the ABSENCE of an upstream timeout. Socket-free on purpose
    // (loopback dials are unusable in some sandboxes): handle() is driven
    // with a stub transport whose response never ends, the clock jumps past
    // 30s, and a re-added cutoff would destroy the stream (red) while no
    // cutoff leaves it untouched (green).
    const dir = mkdtempSync(join(tmpdir(), "agend-muse-relay-"));
    dirs.push(dir);
    const { EventEmitter } = await import("node:events");
    const req = new EventEmitter() as any;
    req.url = "/responses"; req.method = "GET"; req.headers = {};
    const res = new EventEmitter() as any;
    res.headersSent = false; res.destroyed = false;
    res.writeHead = vi.fn(); res.end = vi.fn();
    res.destroy = vi.fn(() => { res.destroyed = true; });
    const upstreamRes = new EventEmitter() as any;
    upstreamRes.headers = {}; upstreamRes.statusCode = 200;
    upstreamRes.pipe = vi.fn();
    const clientReq = new EventEmitter() as any;
    clientReq.end = vi.fn();
    clientReq.destroy = vi.fn();
    clientReq.setTimeout = vi.fn((ms: number) => setTimeout(() => clientReq.emit("timeout"), ms));
    const fakeTransport = vi.fn((_opts: unknown, cb: (r: unknown) => void) => { cb(upstreamRes); return clientReq; });
    const relay = new MuseUsageRelay({
      instanceDir: dir,
      upstreamOrigin: "http://127.0.0.1:9",
      request: fakeTransport as any,
    });
    vi.useFakeTimers();
    try {
      const pending = (relay as unknown as { handle: (q: unknown, s: unknown) => Promise<void> }).handle(req, res);
      pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(60_000);
      expect(clientReq.destroy).not.toHaveBeenCalled();
      expect(res.destroy).not.toHaveBeenCalled();
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.anything());
    } finally {
      vi.useRealTimers();
    }
    await relay.stop();
  });

  it("on exhausted recovery clears the snapshot and reports unavailable", async () => {
    // Relay-level half of M20 (the daemon half lives in
    // muse-relay-exhaustion.test.ts): reclaiming can never succeed, so the
    // snapshot from the dead port must go and onUnavailable must fire once.
    const dir = mkdtempSync(join(tmpdir(), "agend-muse-relay-"));
    dirs.push(dir);
    const onUnavailable = vi.fn();
    const relay = new MuseUsageRelay({ instanceDir: dir, onUnavailable });
    await relay.start();
    writeMuseUsageSnapshot(dir, {
      observedAt: Date.now(),
      session: { usedPercent: 8, resetsAt: 1_800_000_000 },
    });
    (relay as unknown as { listen: () => Promise<void> }).listen = async () => { throw new Error("EADDRINUSE"); };
    (relay as unknown as { server: { close: () => void } }).server.close();
    for (let i = 0; i < 100 && onUnavailable.mock.calls.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(readMuseUsageSnapshot(dir)).toBeNull();
    await relay.stop();
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

  it("shows a fresh snapshot with no stale marker", async () => {
    const home = mkdtempSync(join(tmpdir(), "agend-muse-usage-"));
    dirs.push(home);
    process.env.AGEND_HOME = home;
    writeFileSync(join(home, "fleet.yaml"), "instances:\n  muse-one:\n    backend: muse\n");
    const instance = join(home, "instances", "muse-one");
    const reset = Math.floor(Date.now() / 1000) + 3600;
    writeMuseUsageSnapshot(instance, {
      observedAt: Date.now(),
      plan: "pro",
      session: { usedPercent: 23, resetsAt: reset },
      weekly: { usedPercent: 41, resetsAt: reset + 100_000 },
    });

    const usage = await fetchMuseUsage();

    expect(usage.metrics.map(metric => metric.label)).toEqual(["Session", "Weekly"]);
    expect(usage.hint).toBeUndefined();
  });

  it("retains an idle snapshot while its windows stand and marks it cached", async () => {
    // #904: past the 15m idle threshold but neither window has flipped, so the
    // last-known percentages are still the truth — kept, but honestly labelled.
    const home = mkdtempSync(join(tmpdir(), "agend-muse-usage-"));
    dirs.push(home);
    process.env.AGEND_HOME = home;
    writeFileSync(join(home, "fleet.yaml"), "instances:\n  muse-one:\n    backend: muse\n");
    const instance = join(home, "instances", "muse-one");
    const reset = Math.floor(Date.now() / 1000) + 3600;
    writeMuseUsageSnapshot(instance, {
      observedAt: Date.now() - MUSE_USAGE_STALE_MS - 60_000,
      plan: "pro",
      session: { usedPercent: 23, resetsAt: reset },
      weekly: { usedPercent: 41, resetsAt: reset + 100_000 },
    });

    expect(readMuseUsageSnapshot(instance)?.session?.usedPercent).toBe(23);
    const usage = await fetchMuseUsage();
    expect(usage.metrics.map(metric => metric.label)).toEqual(["Session", "Weekly"]);
    expect(usage.hint).toMatch(/^cached \d+m ago/);
    const activity = formatDiscordUsageActivity({
      fetchedAt: new Date().toISOString(),
      providers: [{ id: "muse", name: "Muse", ...usage }],
    });
    expect(activity).toBe("⚡ Muse: stale");
  });

  it("drops only the flipped window when the session reset but weekly stands", async () => {
    const home = mkdtempSync(join(tmpdir(), "agend-muse-usage-"));
    dirs.push(home);
    process.env.AGEND_HOME = home;
    writeFileSync(join(home, "fleet.yaml"), "instances:\n  muse-one:\n    backend: muse\n");
    const instance = join(home, "instances", "muse-one");
    writeMuseUsageSnapshot(instance, {
      observedAt: Date.now() - MUSE_USAGE_STALE_MS - 60_000,
      plan: "pro",
      session: { usedPercent: 23, resetsAt: Math.floor(Date.now() / 1000) - 60 },
      weekly: { usedPercent: 41, resetsAt: Math.floor(Date.now() / 1000) + 100_000 },
    });

    const retained = readMuseUsageSnapshot(instance);
    expect(retained?.session).toBeUndefined();
    expect(retained?.weekly?.usedPercent).toBe(41);
    const usage = await fetchMuseUsage();
    expect(usage.metrics.map(metric => metric.label)).toEqual(["Weekly"]);
    expect(usage.hint).toMatch(/^cached \d+m ago/);
  });

  it("discards an idle snapshot once every window has reset", async () => {
    const home = mkdtempSync(join(tmpdir(), "agend-muse-usage-"));
    dirs.push(home);
    process.env.AGEND_HOME = home;
    writeFileSync(join(home, "fleet.yaml"), "instances:\n  muse-one:\n    backend: muse\n");
    const instance = join(home, "instances", "muse-one");
    writeMuseUsageSnapshot(instance, {
      observedAt: Date.now() - MUSE_USAGE_STALE_MS - 60_000,
      plan: "pro",
      session: { usedPercent: 23, resetsAt: Math.floor(Date.now() / 1000) - 60 },
      weekly: { usedPercent: 41, resetsAt: Math.floor(Date.now() / 1000) - 30 },
    });

    expect(readMuseUsageSnapshot(instance)).toBeNull();
    const usage = await fetchMuseUsage();
    expect(usage.metrics).toEqual([]);
    expect(usage.hint).toMatch(/unavailable/);
  });

  // #909: stale-path boundaries. Time is frozen so the exact edges are
  // deterministic — a live clock would drift a few ms between seeding the file
  // and reading it. Fake timers are restored in `finally` because other tests
  // in this file depend on real socket timeouts.
  it("prunes a stale window with a missing or unusable reset while keeping the live one", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-muse-relay-"));
    dirs.push(dir);
    const NOW = 1_700_000_000_000;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const badResets: Array<{ name: string; value: unknown }> = [
        { name: "undefined", value: undefined },
        { name: "null", value: null },
        { name: "non-numeric", value: "tomorrow" },
        { name: "zero", value: 0 },
        { name: "negative", value: -60 },
        { name: "NaN", value: NaN },
        { name: "Infinity", value: Infinity },
      ];
      for (const bad of badResets) {
        writeMuseUsageSnapshot(dir, {
          observedAt: NOW - MUSE_USAGE_STALE_MS - 60_000,
          session: { usedPercent: 8, resetsAt: bad.value as number },
          weekly: { usedPercent: 41, resetsAt: 1_800_000_000 },
        });
        const retained = readMuseUsageSnapshot(dir);
        expect(retained, `reset=${bad.name} must fail closed`).not.toBeNull();
        expect(retained?.session, `reset=${bad.name} must prune the window`).toBeUndefined();
        expect(retained?.weekly?.usedPercent).toBe(41);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("prunes a stale window whose reset is exactly now — the bound is > now, not >=", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-muse-relay-"));
    dirs.push(dir);
    const NOW = 1_700_000_000_000;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      writeMuseUsageSnapshot(dir, {
        observedAt: NOW - MUSE_USAGE_STALE_MS - 60_000,
        session: { usedPercent: 8, resetsAt: NOW / 1000 },
        weekly: { usedPercent: 41, resetsAt: 1_800_000_000 },
      });
      const retained = readMuseUsageSnapshot(dir);
      expect(retained?.session).toBeUndefined();
      expect(retained?.weekly?.usedPercent).toBe(41);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats observedAt exactly at the idle threshold as fresh, +1ms as stale", async () => {
    const home = mkdtempSync(join(tmpdir(), "agend-muse-usage-"));
    dirs.push(home);
    process.env.AGEND_HOME = home;
    writeFileSync(join(home, "fleet.yaml"), "instances:\n  muse-one:\n    backend: muse\n");
    const instance = join(home, "instances", "muse-one");
    const NOW = 1_700_000_000_000;
    const seed = (observedAt: number) => writeMuseUsageSnapshot(instance, {
      observedAt,
      plan: "pro",
      session: { usedPercent: 23, resetsAt: 1_800_000_000 },
      weekly: { usedPercent: 41, resetsAt: 1_800_000_000 },
    });
    // An expired session window tells fresh-passthrough apart from stale-retain:
    // only the retain path prunes, so `session` being defined pins the `<=`.
    const seedExpiredSession = (observedAt: number) => writeMuseUsageSnapshot(instance, {
      observedAt,
      plan: "pro",
      session: { usedPercent: 23, resetsAt: Math.floor(NOW / 1000) - 60 },
      weekly: { usedPercent: 41, resetsAt: 1_800_000_000 },
    });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      seed(NOW - MUSE_USAGE_STALE_MS);
      const fresh = await fetchMuseUsage();
      expect(fresh.metrics.map(metric => metric.label)).toEqual(["Session", "Weekly"]);
      expect(fresh.hint).toBeUndefined();

      seed(NOW - MUSE_USAGE_STALE_MS - 1);
      const stale = await fetchMuseUsage();
      expect(stale.metrics.map(metric => metric.label)).toEqual(["Session", "Weekly"]);
      expect(stale.hint).toMatch(/^cached \d+m ago/);

      seedExpiredSession(NOW - MUSE_USAGE_STALE_MS);
      expect(readMuseUsageSnapshot(instance)?.session?.usedPercent).toBe(23);

      seedExpiredSession(NOW - MUSE_USAGE_STALE_MS - 1);
      expect(readMuseUsageSnapshot(instance)?.session).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
