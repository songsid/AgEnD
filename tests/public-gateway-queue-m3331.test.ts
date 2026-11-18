/**
 * M-3331 (found in M-3329): since #4160 a page asks for its ~150 modules at once. A tunnel that opens one connection to
 * the public gateway per request went past the gateway's 32 connections, and every one past them was destroyed — a
 * reset, and a module that "could not be loaded". Now:
 * - the 32 are still the most served at once; a connection past them waits (paused, nothing read) for a free slot, and
 *   while any waits, a served response closes its connection so the next one gets the slot;
 * - a burst of 150 connections, one request each, all complete — no resets;
 * - the abuse guard stays: past PUBLIC_GATEWAY_QUEUE waiting connections a new one is destroyed, and one that has
 *   waited PUBLIC_GATEWAY_WAIT_MS is destroyed;
 * - under the cap nothing changes: connections are kept alive, nothing waits.
 */
import { afterEach, describe, expect, it } from "vitest";
import { request, Agent } from "node:http";
import { connect } from "node:net";
import { createPublicWebGateway, PUBLIC_GATEWAY_MAX_SOCKETS, PUBLIC_GATEWAY_QUEUE, PUBLIC_GATEWAY_WAIT_MS } from "../src/public-web-gateway.js";

const HOST = "sample.trycloudflare.com";
const closers: Array<() => void> = [];
afterEach(() => { for (const c of closers.splice(0)) c(); });

/** A gateway whose every admitted request is answered after `delayMs` (the dashboard's handler, stubbed). */
async function gateway(delayMs = 5, limits?: { max?: number; queue?: number; waitMs?: number }) {
  const seen = { now: 0, most: 0 };
  const g = createPublicWebGateway({
    exposureId: "e1", isCurrent: () => true, isOpen: () => true, limits,
    dispatch: (_req, res) => {
      seen.now++; seen.most = Math.max(seen.most, seen.now);
      setTimeout(() => { seen.now--; res.writeHead(200, { "Content-Type": "text/javascript" }); res.end("export {};\n"); }, delayMs);
    },
  });
  const url = await g.listen();
  g.setHost(HOST);
  closers.push(() => g.close());
  return { g, port: Number(url.port), seen };
}
const idle = (port: number) => new Promise<ReturnType<typeof connect>>((ok) => { const s = connect(port, "127.0.0.1", () => ok(s)); s.on("error", () => {}); });
/** One request on a connection of its own (as a tunnel opening one per request): its status, or the error it got. */
function oneShot(port: number, path = "/assets/app.js"): Promise<{ status?: number; error?: string; connection?: string }> {
  return new Promise((resolve) => {
    const r = request({ host: "127.0.0.1", port, path, headers: { host: HOST }, agent: new Agent({ keepAlive: false }) }, (res) => {
      res.resume(); res.on("end", () => resolve({ status: res.statusCode, connection: String(res.headers.connection ?? "") }));
    });
    r.on("error", (e: NodeJS.ErrnoException) => resolve({ error: e.code ?? e.message }));
    r.end();
  });
}

describe("public gateway: a burst past the connection cap (M-3331)", () => {
  it("150 connections at once, one request each: all answered, none reset", async () => {
    const { port, seen } = await gateway(20);
    const out = await Promise.all(Array.from({ length: 150 }, () => oneShot(port)));
    const errors = out.filter((o) => o.error).map((o) => o.error);
    expect(errors).toEqual([]);
    expect(out.every((o) => o.status === 200)).toBe(true);
    expect(seen.most).toBeLessThanOrEqual(PUBLIC_GATEWAY_MAX_SOCKETS);              // the cap still holds: the rest waited
    expect(out.some((o) => o.connection === "close")).toBe(true);                 // served while others waited: closed
  });

  it("a waiting connection is served when a slot frees — even after longer than the 5 s headers timeout", async () => {
    const { port } = await gateway(5, { max: 1, queue: 4, waitMs: 9_000 });
    const holder = await idle(port);
    const asked = oneShot(port);
    setTimeout(() => holder.destroy(), 6_000);
    expect(await asked).toMatchObject({ status: 200 });
  }, 20_000);

  it("a connection that waited PUBLIC_GATEWAY_WAIT_MS without a slot is dropped", async () => {
    const { port } = await gateway(5, { max: 1, queue: 4, waitMs: 300 });
    const holder = await idle(port);
    closers.push(() => holder.destroy());
    const t0 = performance.now();
    const out = await oneShot(port);
    expect(out.error).toMatch(/ECONNRESET|socket hang up|EPIPE/);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it("the guard stays: past the queue a new connection is destroyed at once", async () => {
    expect(PUBLIC_GATEWAY_MAX_SOCKETS).toBe(32);
    expect(PUBLIC_GATEWAY_QUEUE).toBeGreaterThanOrEqual(150);
    expect(PUBLIC_GATEWAY_WAIT_MS).toBeLessThan(15_000);                         // under the gateway's own socket timeout
    const { port } = await gateway();
    // Idle connections that send nothing hold every slot and every place in the queue.
    const held = await Promise.all(Array.from({ length: PUBLIC_GATEWAY_MAX_SOCKETS + PUBLIC_GATEWAY_QUEUE }, () => idle(port)));
    closers.push(() => { for (const s of held) s.destroy(); });
    await new Promise((r) => setTimeout(r, 100));
    const past = await oneShot(port);
    expect(past.error).toMatch(/ECONNRESET|EPIPE|socket hang up/);
  }, 20_000);
});

describe("public gateway: under the cap nothing changes", () => {
  it("a connection is kept alive and its response does not close it", async () => {
    const { port } = await gateway();
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    const ask = () => new Promise<{ status?: number; connection: string }>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, path: "/assets/app.js", headers: { host: HOST }, agent }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode, connection: String(res.headers.connection ?? "") })); });
      r.on("error", reject); r.end();
    });
    const a = await ask(), b = await ask();
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.connection, b.connection]).toEqual(["keep-alive", "keep-alive"]);
    agent.destroy();
  });
});
