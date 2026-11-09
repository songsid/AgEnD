import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type Server } from "node:https";
import { connect } from "node:tls";
import { readFileSync, rmSync } from "node:fs";
import { connect as tcpConnect } from "node:net";
import { makeTestCerts } from "./support/hub-init-fixtures.js";
import { HubDirectoryResponseOwner, type HubDirectoryResponse, type HubDirectoryResponseListener } from "../src/hub/directory-response-owner.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function rig(owner = new HubDirectoryResponseOwner(), proof: () => boolean = () => true, early = false) {
  const certs = makeTestCerts(), entered = deferred<HubDirectoryResponse>(), refused = deferred<string>(), unleased = deferred(), companion = deferred();
  let listener!: HubDirectoryResponseListener, socket: import("node:tls").TLSSocket | undefined;
  const server = createServer({ key: readFileSync(certs.key), cert: readFileSync(certs.cert) }, (req, res) => {
    if (req.url === "/companion") companion.resolve();
    if (!listener.enter(req, res)) return;
    const capture = () => {
      try { entered.resolve(listener.capture(req, res, proof)); }
      catch (error) { refused.resolve((error as { code: string }).code); res.writeHead((error as { code: string }).code === "backpressure" ? 429 : 400); res.end("{}"); }
    };
    if (early) { capture(); return; }
    req.resume(); req.once("end", () => {
      if (req.url === "/unleased") { unleased.resolve(); return; }
      if (req.url !== "/held") { res.end("{}"); return; }
      capture();
    });
  });
  server.on("secureConnection", connected => { socket = connected; });
  listener = owner.listener(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  cleanup.push(async () => { try { await owner.close(); } finally { await listener.close(); rmSync(certs.dir, { recursive: true, force: true }); } });
  const call = (path = "/held") => new Promise<{ status: number; body: string; cookie?: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, servername: "hub.example.test", ca: readFileSync(certs.caCert), agent: false,
      path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": 2 } }, res => {
      let body = ""; res.setEncoding("utf8"); res.on("data", part => { body += part; });
      res.on("end", () => resolve({ status: res.statusCode!, body, cookie: res.headers["set-cookie"]?.[0] })); res.on("error", reject);
    });
    req.on("error", reject); req.end("{}");
  });
  return { owner, server, listener, get socket() { return socket!; }, entered: entered.promise, refused: refused.promise, unleased: unleased.promise,
    companion: companion.promise, call, certs, port };
}
const response = { status: 200, json: '{"ok":true}', cookie: "__Host-fictional=opaque; Path=/; Secure; HttpOnly; SameSite=Strict" };

describe("private directory response ownership", () => {
  it("refuses capture before the request body finishes", async () => {
    const r = await rig(new HubDirectoryResponseOwner(), () => true, true);
    const socket = connect({ host: "127.0.0.1", port: r.port, servername: "hub.example.test", ca: readFileSync(r.certs.caCert) });
    socket.on("error", () => {}); socket.resume();
    await new Promise<void>(resolve => socket.once("secureConnect", resolve));
    socket.write("POST /held HTTP/1.1\r\nHost: hub.example.test\r\nContent-Length: 2\r\n\r\n{");
    expect(await Promise.race([r.refused, r.entered.then(() => "captured")])).toBe("invalid"); expect(r.owner.pending).toBe(0);
  });
  it("releases the slot after reply so another listener can capture", async () => {
    const owner = new HubDirectoryResponseOwner(), first = await rig(owner), second = await rig(owner);
    const firstReply = first.call(), lease = await first.entered;
    await lease.reply(() => response, () => true); expect((await firstReply).status).toBe(200);
    const next = second.call().catch(() => null);
    const attempt = await Promise.race([second.entered.then(lease => ({ kind: "captured", lease })), next.then(() => ({ kind: "refused" }))]);
    expect(attempt.kind).toBe("captured");
    if (attempt.kind === "captured" && "lease" in attempt) await attempt.lease.reply(() => response, () => true);
    expect((await next)?.status).toBe(200); expect(owner.pending).toBe(0);
  });
  it("does not acquire ownership when its admission proof fences the owner", async () => {
    const owner = new HubDirectoryResponseOwner(), r = await rig(owner, () => { owner.fence(); return true; });
    const call = r.call().catch(() => null);
    expect(await Promise.race([call.then(reply => reply?.status), r.entered.then(() => "captured")])).toBe(400);
    expect(await r.refused).toBe("unavailable"); expect(owner.pending).toBe(0);
  });
  it.each(["false", "throw"])("refuses a %s admission proof without acquiring ownership", async mode => {
    const r = await rig(new HubDirectoryResponseOwner(), () => { if (mode === "throw") throw Error("inert proof"); return false; });
    const call = r.call().catch(() => null);
    expect(await Promise.race([call.then(reply => reply?.status), r.entered.then(() => "captured")])).toBe(400);
    expect(await r.refused).toBe("unavailable"); expect(r.owner.pending).toBe(0);
  });
  it("rebinds the exact port while owning the old response, then confirms its flush and the old server close", async () => {
    const r = await rig(), result = r.call(); const lease = await r.entered;
    let closed = false; r.server.once("close", () => { closed = true; });
    expect(r.owner.pending).toBe(1); await r.listener.close();
    expect(r.server.listening).toBe(false); expect(closed).toBe(false); expect(lease.current()).toBe(true);
    const successor = createServer({ key: readFileSync(r.certs.key), cert: readFileSync(r.certs.cert) }, (_req, res) => res.end("new"));
    await new Promise<void>((resolve, reject) => { successor.once("error", reject); successor.listen(r.port, "127.0.0.1", resolve); });
    cleanup.push(() => new Promise<void>((resolve, reject) => successor.close(e => e ? reject(e) : resolve())));
    const sending = lease.reply(() => response, () => true);
    expect(await result).toEqual({ status: 200, body: response.json, cookie: response.cookie }); await sending;
    expect(closed).toBe(true); expect(r.owner.pending).toBe(0);
    await expect(lease.reply(() => response, () => true)).rejects.toThrow();
  });
  it("holds at most one response across distinct listener generations", async () => {
    const owner = new HubDirectoryResponseOwner(), first = await rig(owner), second = await rig(owner);
    const lost = first.call().catch(() => null), lease = await first.entered;
    const next = second.call().catch(() => null);
    expect(await Promise.race([next.then(reply => reply?.status), second.entered.then(() => "captured")])).toBe(429); expect(owner.pending).toBe(1);
    await lease.discard(); expect(await lost).toBeNull(); expect(owner.pending).toBe(0);
  });
  it("rejects a late invalidation after building without publishing cookie bytes", async () => {
    const r = await rig(), lost = r.call().catch(() => null), lease = await r.entered; let current = true;
    await r.listener.close();
    await expect(lease.reply(() => { current = false; return response; }, () => current)).rejects.toThrow();
    expect(await lost).toBeNull(); await r.owner.close(); expect(r.owner.pending).toBe(0);
  });
  it.each([1, 2])("checks lifetime after proof callback %s, before effects or bytes", async invocation => {
    const r = await rig(), lost = r.call().catch(() => null), lease = await r.entered; let calls = 0;
    const build = vi.fn(() => response);
    await expect(lease.reply(build, () => { if (++calls === invocation) r.owner.fence(); return true; })).rejects.toThrow();
    expect(build).toHaveBeenCalledTimes(invocation - 1); expect(await lost).toBeNull(); await r.owner.close();
  });
  it.each(["expired", "backwards"])("refuses %s time before callback effects", async mode => {
    let clock = 1000; const r = await rig(new HubDirectoryResponseOwner({ now: () => clock }));
    const lost = r.call().catch(() => null), lease = await r.entered, build = vi.fn(() => response);
    clock = mode === "expired" ? 31_000 : 999;
    await expect(lease.reply(build, () => true)).rejects.toThrow(); expect(build).not.toHaveBeenCalled();
    expect(await lost).toBeNull(); await r.owner.close();
  });
  it("fences Stop synchronously before any late reply callback", async () => {
    const r = await rig(), lost = r.call().catch(() => null), lease = await r.entered, build = vi.fn(() => response);
    const destroy = vi.spyOn(r.socket, "destroy");
    await r.listener.close(); r.owner.fence(); expect(lease.current()).toBe(false);
    expect(destroy).toHaveBeenCalled();
    await expect(lease.reply(build, () => true)).rejects.toThrow(); expect(build).not.toHaveBeenCalled();
    await r.owner.close(); expect(await lost).toBeNull(); expect(r.owner.pending).toBe(0);
  });
  it("aborts a pipelined companion on the selected TLS socket", async () => {
    const r = await rig(); let bytes = "";
    const socket = connect({ host: "127.0.0.1", port: r.port, servername: "hub.example.test", ca: readFileSync(r.certs.caCert) });
    const closed = new Promise<void>((resolve, reject) => { socket.once("close", () => resolve()); socket.once("error", reject); });
    socket.on("data", part => { bytes += part.toString(); });
    await new Promise<void>(resolve => socket.once("secureConnect", resolve));
    socket.write("POST /held HTTP/1.1\r\nHost: hub.example.test\r\nContent-Length: 2\r\n\r\n{}");
    const lease = await r.entered;
    socket.write("GET /companion HTTP/1.1\r\nHost: hub.example.test\r\n\r\n"); await r.companion;
    expect(lease.current()).toBe(false); await closed; expect(bytes).not.toContain("Set-Cookie"); await r.owner.close(); expect(r.owner.pending).toBe(0);
  });
  it("closes unrelated active HTTP and pre-TLS sockets while preserving exactly the selected response", async () => {
    const r = await rig(), result = r.call(), lease = await r.entered;
    const other = r.call("/unleased").catch(() => null); await r.unleased;
    const raw = tcpConnect({ host: "127.0.0.1", port: r.port });
    const gone = new Promise<void>(resolve => raw.once("close", () => resolve()));
    await new Promise<void>((resolve, reject) => { raw.once("connect", resolve); raw.once("error", reject); });
    await r.listener.close(); await gone; expect(await other).toBeNull();
    expect(lease.current()).toBe(true); expect(r.owner.pending).toBe(1);
    const sending = lease.reply(() => response, () => true); expect((await result).cookie).toBe(response.cookie); await sending;
    expect(r.owner.pending).toBe(0);
  });
  it("does not capture a socket with an earlier unfinished pipelined response", async () => {
    const r = await rig(), socket = connect({ host: "127.0.0.1", port: r.port, servername: "hub.example.test", ca: readFileSync(r.certs.caCert) });
    socket.on("error", () => {});
    await new Promise<void>(resolve => socket.once("secureConnect", resolve));
    socket.write("POST /unleased HTTP/1.1\r\nHost: hub.example.test\r\nContent-Length: 2\r\n\r\n{}"); await r.unleased;
    socket.write("POST /held HTTP/1.1\r\nHost: hub.example.test\r\nContent-Length: 2\r\n\r\n{}");
    const answer = await Promise.race([r.refused.then(code => ({ kind: "refused", code })), r.entered.then(() => ({ kind: "captured" }))]);
    expect(answer).toEqual({ kind: "refused", code: "invalid" }); expect(r.owner.pending).toBe(0);
  });
  it("does not capture a socket with a later unfinished pipelined response", async () => {
    const r = await rig(), socket = connect({ host: "127.0.0.1", port: r.port, servername: "hub.example.test", ca: readFileSync(r.certs.caCert) });
    socket.on("error", () => {});
    await new Promise<void>(resolve => socket.once("secureConnect", resolve));
    socket.write("POST /held HTTP/1.1\r\nHost: hub.example.test\r\nContent-Length: 2\r\n\r\n{}POST /unleased HTTP/1.1\r\nHost: hub.example.test\r\nContent-Length: 2\r\n\r\n{}");
    await r.unleased;
    const answer = await Promise.race([r.refused.then(code => ({ kind: "refused", code })), r.entered.then(() => ({ kind: "captured" }))]);
    expect(answer).toEqual({ kind: "refused", code: "invalid" }); expect(r.owner.pending).toBe(0);
  });
  it("the scheduled expiry fences the response before its physical close", async () => {
    const r = await rig(), real = globalThis.setTimeout; let expire: (() => void) | undefined;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) => {
      if (ms === 30_000) expire = () => { callback(...args); };
      return real(callback, ms, ...args);
    });
    try {
      const lost = r.call().catch(() => null), lease = await r.entered;
      expect(expire).toEqual(expect.any(Function)); expire!(); expect(lease.current()).toBe(false);
      expect(await lost).toBeNull(); await r.owner.close(); expect(r.owner.pending).toBe(0);
    } finally { spy.mockRestore(); }
  });
  it("refuses asynchronous response builders without publishing or leaving an unhandled rejection", async () => {
    const r = await rig(), lost = r.call().catch(() => null), lease = await r.entered;
    await expect(lease.reply((() => Promise.reject(Error("inert async callback"))) as unknown as () => typeof response, () => true)).rejects.toThrow();
    expect(await lost).toBeNull(); await r.owner.close(); expect(r.owner.pending).toBe(0);
  });

  it("retains ownership when the old server's physical close acknowledgment is held, then retries", async () => {
    const r = await rig(new HubDirectoryResponseOwner({ cleanupMs: 20 }));
    const lost = r.call().catch(() => null), lease = await r.entered;
    const original = r.server.close; let release!: () => void; const acknowledged = deferred();
    const spy = vi.spyOn(r.server, "close").mockImplementation(function(this: Server, callback?: (error?: Error) => void) {
      return original.call(this, error => { release = () => callback?.(error); acknowledged.resolve(); });
    });
    try {
      await r.listener.close();
      await expect(lease.discard()).rejects.toThrow(); await acknowledged.promise;
      expect(r.owner.pending).toBe(1); expect(await lost).toBeNull(); release(); await r.owner.close(); expect(r.owner.pending).toBe(0);
    } finally { release?.(); spy.mockRestore(); }
  });
});
