import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { connect } from "node:net";
import { request } from "node:http";
import { join } from "node:path";
import { WebTerminalHttpServer, type WebTerminalHttpOptions } from "../src/web-terminal-http.js";
import { allowedHostNames } from "../src/web-host-guard.js";
import type { WebTerminalSession } from "../src/web-terminal.js";

/**
 * The per-login terminal listener is a second HTTP server with its own address. It checked that Origin
 * equals Host, which a DNS-rebinding page satisfies by construction, and it answered to any Host at all.
 * It now answers only to names it was told about, before it looks at the path — and it learns one extra
 * name, exactly, while a tunnel is in front of it.
 *
 * A fake session is enough: the listener only needs the session's few methods, and no tmux.
 */
const ASSETS = join(process.cwd(), "src", "ui", "web-terminal");
const SID = "ab".repeat(16);
const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() });
const servers: WebTerminalHttpServer[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });

function fakeSession(): WebTerminalSession {
  return Object.assign(new EventEmitter(), {
    sid: SID, state: "running",
    redeemToken: (t: string) => t === "good" ? { result: "ok", cookie: "cookie-value" } : { result: "bad", remaining: 2 },
    checkCookie: () => true,
    attachClient: () => () => {},
    input: () => true, resize: () => {}, cancel: async () => {},
  }) as unknown as WebTerminalSession;
}

async function start(opts: WebTerminalHttpOptions = {}, log = logger()) {
  const http = new WebTerminalHttpServer(fakeSession(), log, { assetsDir: ASSETS, hostname: "127.0.0.1", ...opts });
  servers.push(http);
  const { port } = await http.listen();
  return { http, port, log };
}

interface Res { status: number; body: string; headers: Record<string, string | string[] | undefined> }
function send(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, res => {
      let text = ""; res.on("data", c => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers }));
    });
    r.on("error", reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
function raw(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1", () => s.write(payload));
    let data = ""; s.on("data", c => { data += c; }); s.on("end", () => resolve(data)); s.on("close", () => resolve(data)); s.on("error", reject);
    setTimeout(() => { s.destroy(); resolve(data); }, 2000);
  });
}
const upgrade = (port: number, host: string, origin = `http://${host}`) => raw(port,
  `GET /t/${SID}/ws HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
  + `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);

const PATHS: Array<[string, string]> = [
  ["GET", `/t/${SID}/`], ["GET", `/t/${SID}`], ["GET", `/t/${SID}/assets/terminal.js`], ["GET", `/t/${SID}/assets/terminal-input.js`], ["GET", `/t/${SID}/ws`],
  ["POST", `/t/${SID}/open`], ["GET", "/"], ["GET", "/t/not-the-sid/"], ["GET", "/health"], ["GET", "/api/profiles"], ["POST", "/agent"],
];

describe("a foreign Host is refused before anything else", () => {
  it("answers 403, identically, on every path — real or not — including the ones that would 404, 405 or redirect", async () => {
    const { port } = await start();
    const answers = new Set<string>();
    for (const [method, path] of PATHS) {
      const res = await send(port, method, path, { host: "rebound.evil.example", origin: "http://rebound.evil.example" }, method === "POST" ? "{}" : undefined);
      expect(res.status, `${method} ${path}`).toBe(403);
      answers.add(`${res.status}|${res.body}|${res.headers["content-type"]}`);
    }
    // Same answer whether or not the path exists: nothing about the listener leaks to a refused Host.
    expect(answers.size).toBe(1);
  });

  it("defeats the rebinding shape itself: Origin == Host, both the attacker's", async () => {
    const { port } = await start();
    const open = await send(port, "POST", `/t/${SID}/open`, { host: "evil.example", origin: "http://evil.example", "content-type": "application/json" }, JSON.stringify({ token: "good" }));
    expect(open.status).toBe(403);
    expect(open.headers["set-cookie"]).toBeUndefined();
    expect((await upgrade(port, "evil.example")).startsWith("HTTP/1.1 403")).toBe(true);
  });

  it("refuses a WebSocket upgrade on a foreign Host even with a valid cookie and a matching Origin", async () => {
    const { port } = await start();
    expect((await upgrade(port, "evil.example:8080")).startsWith("HTTP/1.1 403")).toBe(true);
    expect((await upgrade(port, `127.0.0.1:${port}`)).startsWith("HTTP/1.1 101")).toBe(true);   // the same request on a known name
  });

  it("refuses a missing Host (HTTP/1.0) and a malformed one", async () => {
    const { port } = await start();
    const noHost = await raw(port, `GET /t/${SID}/ HTTP/1.0\r\n\r\n`);
    expect(/^HTTP\/1\.[01] 403/.test(noHost)).toBe(true);
    for (const host of ["", "a b", "localhost@evil.example", "http://localhost", "localhost/x", "[::1"]) {
      const r = await raw(port, `GET /t/${SID}/ HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      expect(/^HTTP\/1\.[01] (403|400)/.test(r), JSON.stringify(host)).toBe(true);
    }
  });

  it("does not take a name that merely contains an allowed one", async () => {
    const { port } = await start();
    for (const host of ["localhost.evil.example", "127.0.0.1.evil.example", "evil-localhost", "notlocalhost", "localhost.evil"]) {
      expect((await send(port, "GET", `/t/${SID}/`, { host })).status, host).toBe(403);
    }
  });
});

describe("the names it does answer to", () => {
  it("loopback names, the fleet hostname, and anything web.allowed_hosts adds — port ignored", async () => {
    const allowedHosts = allowedHostNames({ hostname: "Fleet.Example", web: { allowed_hosts: ["proxy.example:8443", "10.0.0.5"] } });
    const { port } = await start({ hostname: "fleet.example", allowedHosts });
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, "localhost", "fleet.example", "FLEET.example:9", "proxy.example", "10.0.0.5:1234"]) {
      expect((await send(port, "GET", `/t/${SID}/`, { host })).status, host).toBe(200);
    }
    expect((await send(port, "GET", `/t/${SID}/`, { host: "other.example" })).status).toBe(403);
  });

  it("defaults to loopback plus the hostname it hands out, and nothing else", async () => {
    const { port } = await start({ hostname: "nas.lan" });
    expect((await send(port, "GET", `/t/${SID}/`, { host: "nas.lan" })).status).toBe(200);
    expect((await send(port, "GET", `/t/${SID}/`, { host: `localhost:${port}` })).status).toBe(200);
    expect((await send(port, "GET", `/t/${SID}/`, { host: "proxy.example" })).status).toBe(403);
  });

  it("keeps the page, assets and /open exactly as they were for an allowed Host", async () => {
    const { port } = await start();
    const host = `127.0.0.1:${port}`;
    const page = await send(port, "GET", `/t/${SID}/`, { host });
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect((await send(port, "GET", `/t/${SID}/assets/terminal.js`, { host })).status).toBe(200);
    const input = await send(port, "GET", `/t/${SID}/assets/terminal-input.js`, { host });
    expect(input.status).toBe(200);
    expect(input.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    const open = await send(port, "POST", `/t/${SID}/open`, { host, origin: `http://${host}`, "content-type": "application/json" }, JSON.stringify({ token: "good" }));
    expect(open.status).toBe(204);
    expect(String(open.headers["set-cookie"])).toContain("HttpOnly");
  });
});

describe("a tunnel's name, exactly, while it is up", () => {
  const TUNNEL = "quiet-fox-lake.trycloudflare.com";

  it("is refused until told, answered while set, and refused again once cleared (a zombie tunnel finds nothing)", async () => {
    const { http, port } = await start();
    const asTunnel = () => send(port, "GET", `/t/${SID}/`, { host: TUNNEL });
    expect((await asTunnel()).status).toBe(403);
    http.setExternalHost(TUNNEL);
    expect((await asTunnel()).status).toBe(200);
    expect((await upgrade(port, TUNNEL, `https://${TUNNEL}`)).startsWith("HTTP/1.1 101")).toBe(true);
    http.setExternalHost(null);
    expect((await asTunnel()).status).toBe(403);
    expect((await upgrade(port, TUNNEL, `https://${TUNNEL}`)).startsWith("HTTP/1.1 403")).toBe(true);
  });

  it("is one name: a sibling on the same domain, a suffix, a prefix and a subdomain are all refused", async () => {
    const { http, port } = await start();
    http.setExternalHost(TUNNEL);
    for (const host of ["other-tunnel.trycloudflare.com", "trycloudflare.com", `x.${TUNNEL}`, `${TUNNEL}.evil.example`, "evil-" + TUNNEL, "quiet-fox-lake.trycloudflare.com.evil.example"]) {
      expect((await send(port, "GET", `/t/${SID}/`, { host })).status, host).toBe(403);
    }
  });

  it("is stored as the parsed name: case and a port in what it was told do not change who gets through", async () => {
    const { http, port } = await start();
    http.setExternalHost("Quiet-Fox-Lake.TryCloudflare.com:443");
    expect((await send(port, "GET", `/t/${SID}/`, { host: TUNNEL })).status).toBe(200);
    expect((await send(port, "GET", `/t/${SID}/`, { host: TUNNEL.toUpperCase() })).status).toBe(200);
  });

  it("ignores a value that is not a plain host name instead of widening the list", async () => {
    const { http, port } = await start();
    for (const bad of ["", "*.trycloudflare.com", "https://evil.example", "a b", "evil.example/x"]) {
      http.setExternalHost(bad);
      expect((await send(port, "GET", `/t/${SID}/`, { host: "evil.example" })).status, JSON.stringify(bad)).toBe(403);
    }
  });
});

describe("the session cookie is Secure by what we know, not by what a header says", () => {
  const TUNNEL = "quiet-fox-lake.trycloudflare.com";
  const open = (port: number, host: string, extra: Record<string, string> = {}) =>
    send(port, "POST", `/t/${SID}/open`, { host, origin: `https://${host}`, "content-type": "application/json", ...extra }, JSON.stringify({ token: "good" }));

  it("is always Secure on the tunnel's own name — whatever X-Forwarded-Proto claims, or does not", async () => {
    const { http, port } = await start();
    http.setExternalHost(TUNNEL);
    for (const proto of [undefined, "http", "https", "garbage"]) {
      const res = await open(port, TUNNEL, proto ? { "x-forwarded-proto": proto } : {});
      expect(res.status, String(proto)).toBe(204);
      expect(String(res.headers["set-cookie"]), String(proto)).toContain("; Secure");
      expect(String(res.headers["set-cookie"])).toContain(`Path=/t/${SID}`);
    }
  });

  it("is unchanged off the tunnel: Secure when the proxy says https, not otherwise", async () => {
    const { http, port } = await start();
    http.setExternalHost(TUNNEL);
    const host = `127.0.0.1:${port}`;
    const plain = await send(port, "POST", `/t/${SID}/open`, { host, origin: `http://${host}`, "content-type": "application/json" }, JSON.stringify({ token: "good" }));
    expect(String(plain.headers["set-cookie"])).not.toContain("Secure");
    const proxied = await send(port, "POST", `/t/${SID}/open`, { host, origin: `http://${host}`, "content-type": "application/json", "x-forwarded-proto": "https" }, JSON.stringify({ token: "good" }));
    expect(String(proxied.headers["set-cookie"])).toContain("; Secure");
  });

  it("does not become Secure for a request that is not on the tunnel's name just because a tunnel is set", async () => {
    const { http, port } = await start();
    http.setExternalHost(TUNNEL);
    const host = `localhost:${port}`;
    const res = await send(port, "POST", `/t/${SID}/open`, { host, origin: `http://${host}`, "content-type": "application/json" }, JSON.stringify({ token: "good" }));
    expect(String(res.headers["set-cookie"])).not.toContain("Secure");
  });
});

describe("refusals are logged once per name, without the raw header", () => {
  it("says what to do, once, and never repeats the header value", async () => {
    const { port, log } = await start();
    for (let i = 0; i < 3; i++) await send(port, "GET", `/t/${SID}/`, { host: "rebound.evil.example:6666" });
    await send(port, "GET", `/t/${SID}/`, { host: "other.evil.example" });
    const warns = log.warn.mock.calls;
    expect(warns).toHaveLength(2);
    expect(JSON.stringify(warns[0])).toContain("web.allowed_hosts");
    expect(JSON.stringify(warns[0])).toContain("rebound.evil.example");
    expect(JSON.stringify(warns)).not.toContain("6666");
  });

  it("is bounded: a scanner cannot grow the set without limit", async () => {
    const { port, log } = await start();
    for (let i = 0; i < 40; i++) await send(port, "GET", `/t/${SID}/`, { host: `scan-${i}.evil.example` });
    expect(log.warn.mock.calls.length).toBe(16);
  });
});

describe("the page carries a readiness marker for the tunnel's probe", () => {
  it("serves this session's marker, and the placeholder never leaks", async () => {
    const { http, port } = await start();
    const res = await send(port, "GET", `/t/${SID}/`, { host: `127.0.0.1:${port}` });
    expect(res.status).toBe(200);
    expect(http.readinessMarker).toBe(`agend-terminal:${SID}`);
    expect(res.body).toContain(`<meta name="agend-terminal" content="agend-terminal:${SID}">`);
    expect(res.body).not.toContain("__AGEND_TERMINAL_MARKER__");
  });

  it("is per session: another session's marker is not in this page", async () => {
    const { port } = await start();
    const res = await send(port, "GET", `/t/${SID}/`, { host: `127.0.0.1:${port}` });
    expect(res.body).not.toContain(`agend-terminal:${"cd".repeat(16)}`);
  });

  it("does not consume the token or touch the session (a probe is a plain GET)", async () => {
    const session = fakeSession();
    const redeem = vi.fn(session.redeemToken.bind(session));
    (session as unknown as { redeemToken: typeof redeem }).redeemToken = redeem;
    const http = new WebTerminalHttpServer(session, logger(), { assetsDir: ASSETS, hostname: "127.0.0.1" });
    servers.push(http);
    const { port } = await http.listen();
    await send(port, "GET", `/t/${SID}/`, { host: `127.0.0.1:${port}` });
    expect(redeem).not.toHaveBeenCalled();
  });
});
