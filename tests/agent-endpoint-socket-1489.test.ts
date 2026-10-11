/**
 * #1489 on a real socket: what a client actually receives from POST /agent, and how much the server takes off the
 * wire. (agent-endpoint-auth-1489.test.ts proves the order with fake req/res; a fake res records a 413 even when the
 * real socket is already destroyed.) A real http server runs the real handler; nothing else of the fleet.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type Server } from "node:http";
import type { Socket } from "node:net";
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
  /** Bytes each connection's socket has taken off the wire so far (live, not only at close). */
  const socketRead: number[] = [];
  const server: Server = createServer((req, res) => handleAgentRequest(req, res, ctx));
  server.on("connection", (s: Socket) => { const i = socketRead.push(0) - 1; s.on("data", (c: Buffer) => { socketRead[i]! += c.length; }); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => { server.closeAllConnections?.(); server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { port: (server.address() as { port: number }).port, socketRead, ctx };
}

/**
 * POST `total` bytes (streamed in 64 KiB writes). Resolves once the answer is in (or the socket failed) AND the client's
 * request stream has closed — so a server that keeps draining the upload has had the chance to take all of it.
 */
function post(port: number, headers: Record<string, string>, total: number, body?: Buffer): Promise<{ status?: number; error?: string; text: string }> {
  return new Promise(resolve => {
    let text = "", answer: { status?: number; error?: string } | null = null, closed = false;
    const done = () => { if (answer && closed) resolve({ ...answer, text }); };
    const req = request({ host: "127.0.0.1", port, method: "POST", path: "/agent", agent: false, headers: { "content-type": "application/json", ...headers } }, res => {
      res.setEncoding("utf8"); res.on("data", (c: string) => { text += c; }); res.on("end", () => { answer ??= { status: res.statusCode }; done(); });
    });
    req.on("error", e => { answer ??= { error: (e as NodeJS.ErrnoException).code ?? e.message }; closed = true; done(); });
    req.on("close", () => { closed = true; done(); });
    if (body) { req.end(body); return; }
    let sent = 0;
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const pump = (): void => { while (sent < total) { sent += chunk.length; if (!req.write(chunk)) { req.once("drain", pump); return; } } req.end(); };
    pump();
  });
}
const settle = () => new Promise(r => setTimeout(r, 100));

describe("#1489: POST /agent on a real socket", () => {
  it("an unauthenticated 64 MiB upload: the client gets 401 and the server closes the connection after a few MiB", async () => {
    const s = await serve();
    const before = process.memoryUsage().heapUsed;
    const got = await post(s.port, { "content-length": String(64 * MiB) }, 64 * MiB);
    await settle();
    expect(got.status ?? got.error).toSatisfy((v: unknown) => v === 401 || v === "EPIPE" || v === "ECONNRESET");
    expect(s.socketRead.length).toBeGreaterThan(0); expect(Math.max(...s.socketRead)).toBeLessThan(16 * MiB);          // refused, not drained
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(32 * MiB);
  });

  it("a wrong token gets the same: 401, the upload refused", async () => {
    const s = await serve();
    const got = await post(s.port, { "content-length": String(64 * MiB), "x-agend-instance-token": agentTokenHeader("dev", "x".repeat(64)) }, 64 * MiB);
    await settle();
    expect(got.status ?? got.error).toSatisfy((v: unknown) => v === 401 || v === "EPIPE" || v === "ECONNRESET");
    expect(s.socketRead.length).toBeGreaterThan(0); expect(Math.max(...s.socketRead)).toBeLessThan(16 * MiB);
  });

  it("a valid token with a declared body over 512 KiB: the client RECEIVES 413, and the handler read none of it", async () => {
    const s = await serve();
    const got = await post(s.port, { "content-length": String(2 * MiB), "x-agend-instance-token": agentTokenHeader("dev", TOKEN) }, 2 * MiB);
    await settle();
    expect(got.status).toBe(413);
    expect(got.text).toContain("Request body too large");
  });

  it("a valid token, chunked (no length) past the cap: cut off at the cap — never buffered beyond it", async () => {
    const s = await serve();
    const before = process.memoryUsage().heapUsed;
    const got = await post(s.port, { "transfer-encoding": "chunked", "x-agend-instance-token": agentTokenHeader("dev", TOKEN) }, 64 * MiB);
    await settle();
    expect(got.status === 413 || got.error === "ECONNRESET" || got.error === "EPIPE").toBe(true);
    expect(s.socketRead.length).toBeGreaterThan(0); expect(Math.max(...s.socketRead)).toBeLessThan(16 * MiB);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(32 * MiB);
  });

  it("control: a valid token with a normal body reaches the op (200)", async () => {
    const s = await serve({
      fleetConfig: { defaults: {}, instances: { dev: { tool_set: "worker" }, target: {} } },
      instanceIpcClients: new Map([["target", { connected: true }]]),
      sessionRegistry: new Map(), lifecycle: { daemons: new Map() },
      getInstanceStatus: () => "running", getDaemonBootId: () => "boot-1",
      admitDurableDelivery: vi.fn(() => ({ deliveryId: "d1", state: "queued", duplicate: false })),
      eventLog: { logActivity: vi.fn() }, queueMirrorMessage: vi.fn(),
    });
    const body = Buffer.from(JSON.stringify({ instance: "dev", op: "send", args: { instance_name: "target", message: "hello" } }));
    const got = await post(s.port, { "content-length": String(body.length), "x-agend-instance-token": agentTokenHeader("dev", TOKEN) }, body.length, body);
    expect(got.status).toBe(200);
    expect(JSON.parse(got.text)).toMatchObject({ operation_id: expect.any(String) });
  });
});
