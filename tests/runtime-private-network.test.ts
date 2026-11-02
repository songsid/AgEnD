/** Protocol acceptance through a private reverse proxy; this fixture is not a Tailscale installation test. */
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer, request as tlsRequest } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient, pairRuntime, type RuntimeBridge } from "../src/runtime-client.js";
import { RuntimeClientStore, validateRuntimeServer } from "../src/runtime-client-store.js";
import { RuntimeCoordinator } from "../src/runtime-coordinator.js";

const directories: string[] = [], clients: RuntimeClient[] = [], hubs: RuntimeCoordinator[] = [], servers: Server[] = [];
const sockets = new Set<Duplex>();
function home(): string { const dir = mkdtempSync(join(tmpdir(), "agend-private-runtime-")); directories.push(dir); return dir; }
async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("Missing private fixture port");
  return address.port;
}
function tlsFixture() {
  const dir = home(), key = join(dir, "test-only.key"), cert = join(dir, "test-only.crt");
  // Existing TLS suites require OpenSSL too. Git for Windows also ships it, without requiring a PATH edit.
  const gitOpenSsl = join(process.env.ProgramFiles ?? "C:/Program Files", "Git/usr/bin/openssl.exe");
  const openssl = process.platform === "win32" && existsSync(gitOpenSsl) ? gitOpenSsl : "openssl";
  execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore", timeout: 10_000 });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}
function post(origin: string, path: string, value: unknown, ca?: Buffer): Promise<{ status: number; body: any }> {
  return new Promise((accept, reject) => {
    const req = (origin.startsWith("https:") ? tlsRequest : request)(new URL(path, origin), {
      method: "POST", agent: false, ...(ca ? { ca } : {}), headers: { "Content-Type": "application/json" }, timeout: 5000,
    }, res => {
      let text = ""; res.setEncoding("utf8").on("data", part => { text += part; });
      res.on("end", () => { try { accept({ status: res.statusCode!, body: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(Error("Private network fixture timed out")));
    req.end(JSON.stringify(value));
  });
}
afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  for (const hub of hubs.splice(0)) hub.close();
  for (const socket of sockets) socket.destroy(); sockets.clear();
  for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()));
  for (const dir of directories.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + sep)) throw Error("Unsafe private runtime fixture cleanup");
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("runtime pairing and execution-channel proxy compatibility", () => {
  it.each([false, true])("forwards pair/claim POSTs and authenticated WebSocket upgrades through a TLS=%s private proxy", async tls => {
    const hub = new RuntimeCoordinator(home()); hubs.push(hub);
    const seen: Array<{ method?: string; path?: string; authorization?: string; origin?: string; cookie?: string; upgrade?: string }> = [];
    const observe = (req: IncomingMessage) => seen.push({ method: req.method, path: req.url, authorization: req.headers.authorization,
      origin: req.headers.origin, cookie: req.headers.cookie, upgrade: req.headers.upgrade });
    const backend = createServer((req, res) => {
      observe(req);
      if (!hub.handlePublicRequest(req, res, new URL(req.url!, "http://localhost"))) { res.writeHead(404); res.end(); }
    });
    backend.on("upgrade", (req, socket, head) => { observe(req); if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); });
    const backendPort = await listen(backend);
    const forward = (req: IncomingMessage, res: ServerResponse) => {
      const upstream = request({ hostname: "127.0.0.1", port: backendPort, path: req.url, method: req.method, headers: req.headers, agent: false }, response => {
        res.writeHead(response.statusCode!, response.headers); response.pipe(res);
      });
      upstream.on("error", () => { res.writeHead(502); res.end(); }); req.pipe(upstream);
    };
    const certificate = tls ? tlsFixture() : undefined;
    const proxy = certificate ? createTlsServer(certificate, forward) : createServer(forward);
    proxy.on("upgrade", (req, socket, head) => {
      // A raw stream after the incoming TLS terminator preserves Authorization and Upgrade exactly.
      const upstream = connect(backendPort, "127.0.0.1", () => {
        const headers = req.rawHeaders.reduce((out, item, i) => i % 2 ? out : out + `${item}: ${req.rawHeaders[i + 1]}\r\n`, "");
        upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      sockets.add(upstream); upstream.once("close", () => sockets.delete(upstream));
      upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
      socket.once("close", () => upstream.destroy()); upstream.once("close", () => socket.destroy());
    });
    const proxyPort = await listen(proxy), origin = `${tls ? "https" : "http"}://127.0.0.1:${proxyPort}`;
    const pairing = hub.createPairing();
    if (tls) {
      // Trust is scoped to this fixture request/socket. Certificate verification is never disabled globally.
      await expect(post(origin, "/runtime/v1/pair", { code: pairing.code, name: "TLS fixture", platform: "win32" })).rejects.toThrow();
      expect(seen).toHaveLength(0);
    }
    const paired = await post(origin, "/runtime/v1/pair", { code: pairing.code, name: "Private Windows", platform: "win32" }, certificate?.cert);
    expect(paired.status).toBe(201); expect(paired.body.status).toBe("pending");
    const claim = { machineId: paired.body.machineId, claimSecret: paired.body.claimSecret };
    expect((await post(origin, "/runtime/v1/claim", claim, certificate?.cert)).status).toBe(202);
    hub.approve(claim.machineId);
    const approved = await post(origin, "/runtime/v1/claim", claim, certificate?.cert);
    expect(approved.status).toBe(200); expect(approved.body.status).toBe("approved");
    expect(seen.map(req => [req.method, req.path])).toEqual([["POST", "/runtime/v1/pair"], ["POST", "/runtime/v1/claim"], ["POST", "/runtime/v1/claim"]]);

    const store = new RuntimeClientStore(home());
    store.saveCredentials({ server: origin, machineId: claim.machineId, credential: approved.body.credential, name: "Private Windows" });
    const bridge: RuntimeBridge = { probe: vi.fn(async () => ({ home: "C:\\fixture", clis: [], probedAt: 1 })),
      prepareWorkspace: vi.fn(async id => `C:\\fixture\\${id}`), start: vi.fn(() => { throw Error("No CLI may run in this test"); }),
      get: () => null, cancel: () => { throw Error("No CLI may run in this test"); }, close() {}, releaseUnknown() {} };
    const client = new RuntimeClient({ store, bridge, pollMs: 20, ...(certificate ? {
      socketFactory: (url: string, credential: string) => new WebSocket(url, { ca: certificate.cert,
        headers: { Authorization: `Bearer ${credential}` }, followRedirects: false, perMessageDeflate: false }),
    } : {}) });
    clients.push(client); await client.start();
    await vi.waitFor(() => expect(client.online()).toBe(true));
    expect(hub.machine(claim.machineId)?.status).toBe("online");
    expect(await hub.call(claim.machineId, "probe", { force: true })).toEqual({ home: "C:\\fixture", clis: [], probedAt: 1 });
    const upgrade = seen.find(req => req.path === "/runtime/v1/connect");
    expect(upgrade).toMatchObject({ method: "GET", upgrade: "websocket", authorization: `Bearer ${approved.body.credential}` });
    expect(seen.every(req => req.origin === undefined && req.cookie === undefined)).toBe(true);
    expect(bridge.start).not.toHaveBeenCalled();
    hub.revoke(claim.machineId); await vi.waitFor(() => expect(client.online()).toBe(false));
    expect(hub.machine(claim.machineId)?.status).toBe("revoked");
  }, 20_000);

  it.each(["http://192.168.1.25:19280", "http://10.0.0.8:19280", "http://100.64.0.9:19280"])("refuses insecure non-loopback %s before sending the pairing code", async server => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(() => validateRuntimeServer(server)).toThrow(/HTTPS.*loopback/);
    await expect(pairRuntime({ server, code: "test-only-pairing-code", name: "Test", store: new RuntimeClientStore(home()) })).rejects.toThrow(/HTTPS.*loopback/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
