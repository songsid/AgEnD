/**
 * #1489 on a real socket: what a client actually receives from POST /agent, and how much the server takes off the
 * wire. (agent-endpoint-auth-1489.test.ts proves the order with fake req/res; a fake res records a 413 even when the
 * real socket is already destroyed.) A real http server runs the real handler; nothing else of the fleet.
 *
 * The client is raw TCP speaking HTTP/1.1 with `Connection: keep-alive` (Prism r1: Node's http client with
 * `agent: false` implies `Connection: close`, which hides a server that drains a keep-alive upload). It sends the
 * headers first and holds the body, so the answer it gets is the server's own status line — never a reset counted as
 * a refusal — then keeps uploading, respecting backpressure, as a hostile client would.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleAgentRequest } from "../src/agent-endpoint.js";
import { agentTokenHeader } from "../src/agent-token-header.js";

const TOKEN = "t".repeat(64);
const MiB = 1024 * 1024;
const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

async function serve(ctxExtra: Record<string, unknown> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "agend-ep-socket-"));
  mkdirSync(join(dataDir, "instances", "dev"), { recursive: true });
  writeFileSync(join(dataDir, "instances", "dev", "agent.token"), TOKEN, { mode: 0o600 });
  const ctx = { dataDir, fleetConfig: { defaults: {}, instances: { dev: {} } }, logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }, ...ctxExtra } as never;
  /** Bytes each connection's socket has taken off the wire so far (live). */
  const socketRead: number[] = [];
  const server: Server = createServer((req, res) => handleAgentRequest(req, res, ctx));
  server.on("connection", (s: Socket) => { const i = socketRead.push(0) - 1; s.on("data", (c: Buffer) => { socketRead[i]! += c.length; }); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => { server.closeAllConnections?.(); server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { port: (server.address() as { port: number }).port, socketRead };
}

/** A raw keep-alive HTTP/1.1 client: send the head, read answers, pump a body. */
function rawClient(port: number) {
  const sock = connect(port, "127.0.0.1");
  let received = "";
  let closed = false;
  const waiters: Array<() => void> = [];
  sock.on("data", (c: Buffer) => { received += c.toString("latin1"); waiters.splice(0).forEach(w => w()); });
  const onEnd = () => { closed = true; waiters.splice(0).forEach(w => w()); };
  sock.on("close", onEnd); sock.on("end", onEnd); sock.on("error", onEnd);
  const head = (headers: Record<string, string>) => {
    sock.write(`POST /agent HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`);
  };
  /** The next complete response head (status line + headers), or null if the socket closed without one. */
  const nextHead = (from = 0, timeoutMs = 5_000): Promise<{ status: number; headers: string; end: number } | null> => new Promise(resolve => {
    const deadline = setTimeout(() => resolve(null), timeoutMs);
    const check = () => {
      const at = received.indexOf("\r\n\r\n", from);
      if (at >= 0) {
        const block = received.slice(from, at);
        const m = /^HTTP\/1\.1 (\d{3})/.exec(block);
        clearTimeout(deadline);
        resolve(m ? { status: Number(m[1]), headers: block, end: at + 4 } : null);
        return;
      }
      if (closed) { clearTimeout(deadline); resolve(null); return; }
      waiters.push(check);
    };
    check();
  });
  /** Keep writing 64 KiB chunks up to `total`, respecting backpressure, until done or the server ends the socket. */
  const pump = (total: number): Promise<number> => new Promise(resolve => {
    let sent = 0;
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const step = (): void => {
      while (sent < total && !closed && !sock.destroyed) {
        sent += chunk.length;
        if (!sock.write(chunk)) { sock.once("drain", step); return; }
      }
      resolve(sent);
    };
    sock.on("close", () => resolve(sent));
    step();
  });
  return { sock, head, nextHead, pump, received: () => received, isClosed: () => closed };
}
const settle = () => new Promise(r => setTimeout(r, 150));

describe("#1489: POST /agent on a real socket, keep-alive client", () => {
  const refusals: Array<[string, Record<string, string>, number]> = [
    ["no token", {}, 401],
    ["a wrong token", { "X-Agend-Instance-Token": agentTokenHeader("dev", "x".repeat(64)) }, 401],
    ["a malformed token header", { "X-Agend-Instance-Token": "%E0%A4%A:" + TOKEN }, 401],
    ["a valid token, declared 64 MiB (over the 512 KiB cap)", { "X-Agend-Instance-Token": agentTokenHeader("dev", TOKEN) }, 413],
  ];

  it.each(refusals)("%s: the client RECEIVES %s before sending any body, and the server closes the connection", async (_l, headers, status) => {
    const s = await serve();
    const c = rawClient(s.port);
    c.head({ "Content-Type": "application/json", "Content-Length": String(64 * MiB), ...headers });
    const answer = await c.nextHead();                       // the body is held: this is the server's own answer
    expect(answer?.status).toBe(status);
    expect(answer?.headers).toMatch(/\r\nConnection: close/i);
    c.sock.destroy();
  });

  it.each(refusals)("%s: a client that keeps uploading after the answer is cut off after a few MiB — never drained", async (_l, headers) => {
    const s = await serve();
    const c = rawClient(s.port);
    c.head({ "Content-Type": "application/json", "Content-Length": String(64 * MiB), ...headers });
    await c.nextHead();
    await c.pump(64 * MiB);                                  // keeps going after the refusal, as a hostile client would
    await settle();
    expect(s.socketRead.length).toBeGreaterThan(0);
    expect(Math.max(...s.socketRead)).toBeLessThan(16 * MiB);
    expect(c.isClosed()).toBe(true);
    c.sock.destroy();
  });

  it("a valid token, chunked (no length) past the cap: cut off at the cap — never buffered beyond it", async () => {
    const s = await serve();
    const before = process.memoryUsage().heapUsed;
    const c = rawClient(s.port);
    c.head({ "Content-Type": "application/json", "Transfer-Encoding": "chunked", "X-Agend-Instance-Token": agentTokenHeader("dev", TOKEN) });
    // One huge chunk header announcing 64 MiB, then its bytes.
    c.sock.write(`${(64 * MiB).toString(16)}\r\n`);
    await c.pump(64 * MiB);
    await settle();
    expect(Math.max(...s.socketRead)).toBeLessThan(16 * MiB);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(32 * MiB);
    c.sock.destroy();
  });

  it("control: an authenticated keep-alive client gets 200, and the connection stays open for its next request", async () => {
    const s = await serve({
      fleetConfig: { defaults: {}, instances: { dev: { tool_set: "worker" }, target: {} } },
      instanceIpcClients: new Map([["target", { connected: true }]]),
      sessionRegistry: new Map(), lifecycle: { daemons: new Map() },
      getInstanceStatus: () => "running", getDaemonBootId: () => "boot-1",
      admitDurableDelivery: vi.fn(() => ({ deliveryId: "d1", state: "queued", duplicate: false })),
      eventLog: { logActivity: vi.fn() }, queueMirrorMessage: vi.fn(),
    });
    const c = rawClient(s.port);
    const body = JSON.stringify({ instance: "dev", op: "send", args: { instance_name: "target", message: "hello" } });
    const send = () => {
      c.head({ "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)), "X-Agend-Instance-Token": agentTokenHeader("dev", TOKEN) });
      c.sock.write(body);
    };
    send();
    const first = await c.nextHead();
    expect(first?.status).toBe(200);
    expect(first?.headers).not.toMatch(/\r\nConnection: close/i);
    await new Promise(r => setTimeout(r, 100));
    const offset = c.received().length;
    send();                                                  // the same socket: still open
    const second = await c.nextHead(offset);
    expect(second?.status).toBe(200);
    expect(c.isClosed()).toBe(false);
    c.sock.destroy();
  });
});
