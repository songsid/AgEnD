import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent, createServer, request, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { trackWebServer, WEB_DRAIN_MS } from "../src/web-server-drain.js";

const homes: string[] = [];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

// Only the HTTP listener: no fleet start, daemons, tmux, adapters or lifecycle processes.
async function scratchListener() {
  const home = mkdtempSync(join(tmpdir(), "agend-web-close-1738-")); homes.push(home);
  const fm = new FleetManager(home);
  const quiet = vi.fn();
  fm.logger = { info: quiet, debug: quiet, warn: quiet, error: quiet, trace: quiet, fatal: quiet, child: () => fm.logger } as any;
  (fm as any).fleetConfig = { instances: {}, defaults: {} };
  vi.spyOn(fm as any, "startPreviewListener").mockImplementation(() => {});
  (fm as any).startHealthServer(0);
  await vi.waitFor(() => expect(fm.getDashboardAccess().ready).toBe(true));
  const server = (fm as any).healthServer as Server;
  const port = (server.address() as { port: number }).port;
  const requests: ReturnType<typeof request>[] = [];
  cleanup.push(async () => { for (const r of requests) r.destroy(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  function stream() {
    let body = "", ended = false, aborted = false;
    let response: IncomingMessage | undefined;
    const ready = new Promise<void>((ok, no) => {
      const r = request({ host: "127.0.0.1", port, path: "/ui/events", headers: { host: "127.0.0.1", "x-agend-token": fm.getDashboardAccess().token! }, agent: false }, res => {
        response = res;
        res.on("data", c => { body += String(c); ok(); });
        res.on("end", () => { ended = true; });
        res.on("aborted", () => { aborted = true; });
      });
      r.on("error", no); requests.push(r); r.end();
    });
    return { ready, get body() { return body; }, get ended() { return ended; }, get aborted() { return aborted; }, get response() { return response; } };
  }
  return { fm, server, port, stream };
}

describe("web shutdown over private loopback sockets", () => {
  it("ends all 30 real SSE responses with an advisory and drains before stop settles", async () => {
    const h = await scratchListener();
    const streams = Array.from({ length: 30 }, () => h.stream());
    await Promise.all(streams.map(s => s.ready));
    expect((h.fm as any).sseClients.size).toBe(30);
    await h.fm.stopAll();
    await vi.waitFor(() => expect(streams.every(s => s.ended)).toBe(true), { timeout: 500 });
    expect(streams.every(s => !s.aborted)).toBe(true);
    expect(streams.every(s => s.body.includes('event: shutdown\ndata: {"retry_ms":10000}'))).toBe(true);
    expect((h.fm as any).sseClients.size).toBe(0);
    expect(await new Promise<number>(r => h.server.getConnections((_e, count) => r(count)))).toBe(0);
  });

  it("closes idle keep-alive and permits a new listener on the same private port", async () => {
    const h = await scratchListener(); const agent = new Agent({ keepAlive: true });
    cleanup.push(async () => agent.destroy());
    await new Promise<void>((ok, no) => { const r = request({ host: "127.0.0.1", port: h.port, path: "/health", agent }, res => { res.resume(); res.on("end", ok); }); r.on("error", no); r.end(); });
    expect(await new Promise<number>(r => h.server.getConnections((_e, n) => r(n)))).toBe(1);
    const a = h.fm.stopAll(); expect(h.fm.stopAll()).toBe(a); await a;
    expect(await new Promise<number>(r => h.server.getConnections((_e, n) => r(n)))).toBe(0);
    const replacement = createServer((_req, res) => res.end("new"));
    cleanup.push(async () => { replacement.closeAllConnections(); await new Promise<void>(r => replacement.close(() => r())); });
    await new Promise<void>((ok, no) => { replacement.once("error", no); replacement.listen(h.port, "127.0.0.1", ok); });
    expect(replacement.listening).toBe(true);
  });

  it.each(["unfinished HTTP", "upgrade", "partial headers"])("bounds %s cleanup and shares the exact close promise", async mode => {
    const server = createServer((_req, res) => { res.writeHead(200); res.write("held"); });
    server.on("upgrade", (_req, socket) => socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n"));
    const drain = trackWebServer(server);
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const client = connect((server.address() as { port: number }).port, "127.0.0.1");
    client.on("error", () => {}); client.resume();
    cleanup.push(async () => { client.destroy(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
    await new Promise<void>(r => client.once("connect", r));
    if (mode === "partial headers") client.write("GET / HTTP/1.1\r\nHost:");
    else {
      const ready = new Promise<void>(r => client.once("data", () => r()));
      client.write(mode === "upgrade" ? "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n" : "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
      await ready;
    }
    const t0 = performance.now();
    const closing = drain.close(new Set()); expect(drain.close(new Set())).toBe(closing);
    expect(drain.closing).toBe(true);
    let settled = false; void closing.then(() => { settled = true; });
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: WEB_DRAIN_MS + 800 });
    await closing;
    expect(performance.now() - t0).toBeLessThan(WEB_DRAIN_MS + 1500);
    expect(await new Promise<number>(r => server.getConnections((_e, n) => r(n)))).toBe(0);
  });

  it("retains Host admission and refuses fresh HTTP dispatch while its own listener drains", async () => {
    const h = await scratchListener(); let held: ServerResponse | undefined;
    const original = (h.fm as any).dispatchWebHttp;
    vi.spyOn(h.fm as any, "dispatchWebHttp").mockImplementation((...args: any[]) => {
      if (args[0].url === "/fixture-hold") { held = args[1]; held!.writeHead(200); held!.write("held"); }
      else original.apply(h.fm, args);
    });
    const client = request({ host: "127.0.0.1", port: h.port, path: "/fixture-hold", agent: false });
    client.on("error", () => {}); cleanup.push(async () => { client.destroy(); });
    const ready = new Promise<void>(r => client.once("response", res => { res.resume(); res.once("data", () => r()); })); client.end(); await ready;
    const drain = (h.fm as any).healthServerDrain;
    const stopping = h.fm.stopAll(); let settled = false; void stopping.then(() => { settled = true; });
    await vi.waitFor(() => expect(drain.closing).toBe(true));
    await new Promise(r => setTimeout(r, 30));
    expect(settled).toBe(false);
    for (const [host, status] of [["127.0.0.1", 503], ["attacker.invalid", 403]] as const) {
      const res = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
      // Invoke the real registered HTTP listener, with no platform or process effect.
      h.server.emit("request", { method: "GET", url: "/health", headers: { host } }, res);
      expect(res.writeHead.mock.calls[0][0]).toBe(status);
      if (status === 503) expect(res.writeHead.mock.calls[0][1]).toEqual({ Connection: "close", "Retry-After": "10" });
    }
    held!.end(); await stopping;
  });
});
