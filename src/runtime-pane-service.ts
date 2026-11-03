/** Long-lived local terminal host. Authenticated connection clients may come and go without respawning a CLI. */
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { RuntimePaneHost, type RuntimePaneHostOptions } from "./runtime-pane-host.js";
import { readPaneSystemBootId } from "./runtime-pane-boot.js";
import { RuntimePaneStore } from "./runtime-pane-store.js";
import { RuntimeClientStore } from "./runtime-client-store.js";
import { protectPaneDirectory, savePaneHostDescriptor, removePaneHostDescriptor, type PaneHostDescriptor } from "./runtime-pane-private.js";
import { validateRuntimePaneShutdown, type RuntimePaneSnapshot } from "./runtime-pane-protocol.js";
import { PaneMcpRelay } from "./runtime-pane-mcp-relay.js";
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
  let current: WebSocket | null = null, generation = 0, onlineUntil = 0, limit = 4, closing = false, leaseEpoch = "";
  const systemBootId = await readPaneSystemBootId();
  const store = new RuntimePaneStore(join(options.directory, "state")); store.recoverInterrupted(systemBootId);
  const output = new Map<string, RuntimePaneSnapshot>();
  let relay!: PaneMcpRelay;
  const hostOptions: RuntimePaneHostOptions = { store, bootId, ...(systemBootId ? { systemBootId } : {}), online: () => !!current && current.readyState === WebSocket.OPEN && performance.now() < onlineUntil,
    maxAgents: () => limit, mcpConnection: (owner, tools) => relay.connection(owner, tools), output: snapshot => { output.set(snapshot.paneId, snapshot); } };
  const host = options.createHost?.(hostOptions) ?? new RuntimePaneHost(hostOptions);
  const mcpPending = new Map<string, { epoch: string; socket: WebSocket; accept(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const cancelMcp = (): void => { for (const row of mcpPending.values()) { clearTimeout(row.timer); row.reject(Error("Pane MCP connection changed")); } mcpPending.clear(); };
  let port = 0, descriptor: PaneHostDescriptor | undefined, closePromise: Promise<void> | undefined;
  relay = new PaneMcpRelay({ secret: token, endpoint: () => `http://127.0.0.1:${port}/agent`,
    owned: owner => !closing && owner.hostBootId === bootId && host.owns(owner),
    forward: (body, owned) => {
      const socket = current, capturedEpoch = leaseEpoch;
      if (!socket || !hostOptions.online() || !owned() || mcpPending.size >= 32) return Promise.reject(Error("Pane MCP coordinator is unavailable"));
      const id = randomUUID();
      return new Promise((accept, reject) => {
        const timer = setTimeout(() => { mcpPending.delete(id); reject(Error("Pane MCP result is unconfirmed")); }, 90_000); timer.unref();
        mcpPending.set(id, { epoch: capturedEpoch, socket, timer, accept: value => owned() ? accept(value) : reject(Error("Pane MCP owner changed")), reject });
        send(socket, { type: "mcp.request", id, epoch: capturedEpoch, body });
      });
    } });
  const server = createServer((req, res) => { if (req.url === "/agent") void relay.handle(req, res); else { res.writeHead(404); res.end(); } });
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
    cancelMcp();
    const epoch = ++generation; const previous = current; current = socket; onlineUntil = 0; leaseEpoch = "";
    previous?.close(1008, "Pane client replaced");
    send(socket, { type: "hello", hostBootId: bootId });
    socket.on("error", () => {});
    socket.on("close", () => { if (current === socket) { current = null; onlineUntil = 0; generation++; cancelMcp(); } });
    let pending = 0;
    socket.on("message", (bytes, binary) => {
      if (current !== socket || generation !== epoch || binary || pending >= 64) { socket.close(1008, "Invalid pane connection"); return; }
      void (async () => {
        const value = JSON.parse(bytes.toString());
        if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid pane frame");
        if (value.type === "lease") {
          if (Object.keys(value).some(key => !["type", "epoch", "online", "maxAgents"].includes(key)) || typeof value.online !== "boolean" || !/^[a-f0-9-]{36}$/i.test(value.epoch)
            || !Number.isInteger(value.maxAgents) || value.maxAgents < 1 || value.maxAgents > 16) throw Error("Invalid pane lease");
          if (value.epoch !== leaseEpoch || !value.online) cancelMcp();
          leaseEpoch = value.epoch; onlineUntil = value.online ? performance.now() + 15_000 : 0; limit = value.maxAgents; return;
        }
        if (value.type === "mcp.result") {
          if (Object.keys(value).some(key => !["type", "id", "epoch", "ok", "result"].includes(key)) || !/^[a-f0-9-]{36}$/i.test(value.id) || typeof value.ok !== "boolean") throw Error("Invalid pane MCP reply");
          const row = mcpPending.get(value.id); if (!row) return;
          if (row.socket !== socket || row.epoch !== leaseEpoch || value.epoch !== leaseEpoch || !hostOptions.online()) return;
          mcpPending.delete(value.id); clearTimeout(row.timer);
          if (value.ok) row.accept(value.result); else row.reject(Error("Pane MCP coordinator refused the request"));
          return;
        }
        if (value.type !== "request" || Object.keys(value).some(key => !["type", "id", "epoch", "request"].includes(key)) || !/^[a-f0-9-]{36}$/i.test(value.id) || value.epoch !== leaseEpoch) throw Error("Invalid pane frame");
        pending++;
        try {
          const result = await host.request(value.request, () => current === socket && generation === epoch && value.epoch === leaseEpoch && hostOptions.online());
          if (value.request?.action === "shutdown") {
            validateRuntimePaneShutdown(result, bootId); closing = true;
            // Flush the positive no-live-work ACK before closing the link. A lost ACK still closes only an idle host.
            try {
              if (current === socket && socket.readyState === WebSocket.OPEN) await new Promise<void>(done => {
                const timer = setTimeout(done, 1000);
                socket.send(JSON.stringify({ type: "response", id: value.id, ok: true, result }), () => { clearTimeout(timer); done(); });
              });
            } finally { await closeService(); }
          } else if (current === socket) send(socket, { type: "response", id: value.id, ok: true, result });
        }
        catch { if (current === socket) send(socket, { type: "response", id: value.id, ok: false, error: "Pane operation refused; refresh its owned state before retrying" }); }
        finally { pending--; }
      })().catch(() => socket.close(1008, "Invalid pane frame"));
    });
  });
  const flush = setInterval(() => {
    if (current) for (const snapshot of output.values()) send(current, { type: "output", snapshot });
    output.clear();
  }, 100);
  const closeService = (): Promise<void> => closePromise ??= (async () => {
    closing = true; onlineUntil = 0; clearInterval(flush); cancelMcp();
    for (const socket of wss.clients) socket.terminate();
    await host.stop();
    const closed = new Promise<void>(done => server.close(() => done()));
    server.closeAllConnections(); await closed; wss.close();
    try { if (descriptor) removePaneHostDescriptor(options.directory, descriptor); } finally { unlock(); }
  })();
  try {
    await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); accept(); }); });
    const address = server.address(); if (!address || typeof address === "string") throw Error("Pane host listen failed");
    port = address.port;
    descriptor = { version: 1, scope: options.scope, hostBootId: bootId, ...(systemBootId ? { systemBootId } : {}), pid: process.pid, port: address.port, token };
    savePaneHostDescriptor(options.directory, descriptor);
    return { descriptor, close: closeService };
  } catch (error) { clearInterval(flush); server.close(); wss.close(); unlock(); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== "win32" || process.argv.length !== 4) process.exitCode = 1;
  else void startPaneService({ directory: process.argv[2], scope: process.argv[3] }).then(service => {
    const stop = (): void => { void service.close().catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  }).catch(() => { process.exitCode = 1; });
}
