/** Long-lived local terminal host. Authenticated connection clients may come and go without respawning a CLI. */
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { RuntimePaneHost, type RuntimePaneHostOptions } from "./runtime-pane-host.js";
import { RuntimePaneStore } from "./runtime-pane-store.js";
import { RuntimeClientStore } from "./runtime-client-store.js";
import { protectPaneDirectory, savePaneHostDescriptor, type PaneHostDescriptor } from "./runtime-pane-private.js";
import type { RuntimePaneSnapshot } from "./runtime-pane-protocol.js";
export interface PaneServiceOptions {
  directory: string;
  scope: string;
  createHost?(options: RuntimePaneHostOptions): RuntimePaneHost;
}
const MAX_FRAME = 256 * 1024;
export async function startPaneService(options: PaneServiceOptions): Promise<{ descriptor: PaneHostDescriptor; close(): Promise<void> }> {
  if (!/^[a-f0-9]{64}$/.test(options.scope)) throw Error("Invalid pane enrollment scope");
  await protectPaneDirectory(options.directory);
  const bootId = randomUUID(), token = randomBytes(32).toString("hex");
  const unlock = new RuntimeClientStore(options.directory).lock(bootId);
  let current: WebSocket | null = null, generation = 0, onlineUntil = 0, limit = 4, closing = false;
  const store = new RuntimePaneStore(join(options.directory, "state")); store.recoverInterrupted();
  const output = new Map<string, RuntimePaneSnapshot>();
  const hostOptions: RuntimePaneHostOptions = { store, bootId, online: () => !!current && current.readyState === WebSocket.OPEN && performance.now() < onlineUntil,
    maxAgents: () => limit, output: snapshot => { output.set(snapshot.paneId, snapshot); } };
  const host = options.createHost?.(hostOptions) ?? new RuntimePaneHost(hostOptions);
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.maxConnections = 64; server.headersTimeout = 10_000; server.requestTimeout = 10_000; server.keepAliveTimeout = 2000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  const send = (socket: WebSocket, value: unknown): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_FRAME || socket.bufferedAmount > MAX_FRAME) { socket.terminate(); return; }
    socket.send(text);
  };
  server.on("upgrade", (req, socket, head) => {
    const supplied = req.headers.authorization;
    if (closing || req.method !== "GET" || req.url !== "/pane/v1" || req.headers.origin || req.headers.cookie
      || typeof supplied !== "string" || Buffer.byteLength(supplied) !== 71
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(`Bearer ${token}`))) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, peer => wss.emit("connection", peer));
  });
  wss.on("connection", (socket: WebSocket) => {
    const epoch = ++generation; const previous = current; current = socket; onlineUntil = 0;
    previous?.close(1008, "Pane client replaced");
    send(socket, { type: "hello", hostBootId: bootId });
    socket.on("error", () => {});
    socket.on("close", () => { if (current === socket) { current = null; onlineUntil = 0; generation++; } });
    let pending = 0;
    socket.on("message", (bytes, binary) => {
      if (current !== socket || generation !== epoch || binary || pending >= 64) { socket.close(1008, "Invalid pane connection"); return; }
      const valid = (): boolean => current === socket && generation === epoch && hostOptions.online();
      void (async () => {
        const value = JSON.parse(bytes.toString());
        if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid pane frame");
        if (value.type === "lease") {
          if (Object.keys(value).some(key => !["type", "online", "maxAgents"].includes(key)) || typeof value.online !== "boolean"
            || !Number.isInteger(value.maxAgents) || value.maxAgents < 1 || value.maxAgents > 16) throw Error("Invalid pane lease");
          onlineUntil = value.online ? performance.now() + 15_000 : 0; limit = value.maxAgents; return;
        }
        if (value.type !== "request" || Object.keys(value).some(key => !["type", "id", "request"].includes(key)) || !/^[a-f0-9-]{36}$/i.test(value.id)) throw Error("Invalid pane frame");
        pending++;
        try { const result = await host.request(value.request, valid); if (current === socket) send(socket, { type: "response", id: value.id, ok: true, result }); }
        catch { if (current === socket) send(socket, { type: "response", id: value.id, ok: false, error: "Pane operation refused; refresh its owned state before retrying" }); }
        finally { pending--; }
      })().catch(() => socket.close(1008, "Invalid pane frame"));
    });
  });
  const flush = setInterval(() => {
    if (current) for (const snapshot of output.values()) send(current, { type: "output", snapshot });
    output.clear();
  }, 100);
  try {
    await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); accept(); }); });
    const address = server.address(); if (!address || typeof address === "string") throw Error("Pane host listen failed");
    const descriptor: PaneHostDescriptor = { version: 1, scope: options.scope, hostBootId: bootId, pid: process.pid, port: address.port, token };
    savePaneHostDescriptor(options.directory, descriptor);
    return { descriptor, close: async () => {
      if (closing) return; closing = true; onlineUntil = 0; clearInterval(flush);
      for (const socket of wss.clients) socket.terminate();
      await host.stop(); await new Promise<void>(done => server.close(() => done())); wss.close(); unlock();
    } };
  } catch (error) { clearInterval(flush); server.close(); wss.close(); unlock(); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== "win32" || process.argv.length !== 4) process.exitCode = 1;
  else void startPaneService({ directory: process.argv[2], scope: process.argv[3] }).then(service => {
    const stop = (): void => { void service.close().catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  }).catch(() => { process.exitCode = 1; });
}
