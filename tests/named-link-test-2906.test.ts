/**
 * #2906 (the user, hmsg-9fbabce8): the fixed address's "Test connection", and the launch-time split of
 * named-connection-failed (the tunnel is down vs the tunnel is up but this machine can't open its own address).
 *
 * The runner is driven with a stub cloudflared (a fake child that prints what a real one prints) and a REAL local
 * origin: ⑤ is proven by fetching the stand-in's page through a fake edge that forwards to 127.0.0.1:<port>, so the
 * nonce check is the real one. No real tunnel, token or network (the leader: none from this host).
 */
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createServer, request, type Server } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runNamedLinkTest, type NamedLinkTestDeps, type NamedTestResult } from "../src/tunnel/named-link-test.js";
import { CloudflaredProvider } from "../src/tunnel/cloudflared.js";
import { NAMED_TUNNEL_FAILURE_MESSAGES } from "../src/tunnel/named-diagnostics.js";
import { failureOf } from "../src/public-link-progress.js";
import { getLocale, setLocale, t } from "../src/locale.js";
import { syntheticTunnelToken } from "./helpers/named-tunnel-token.js";
import { handleSettingsRequest } from "../src/settings-api.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import type { TunnelStartContext } from "../src/tunnel/types.js";

const TOKEN = syntheticTunnelToken();
const HOST = "agend.example.com";
const locale = getLocale();
const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); setLocale(locale);
  for (const s of servers.splice(0)) { s.closeAllConnections?.(); await new Promise<void>(r => s.close(() => r())); }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

class Child extends EventEmitter {
  stdout = new Readable({ read() {} }); stderr = new Readable({ read() {} }); pid = 2906001;
  exitCode: number | null = null; signalCode: string | null = null;
  kill = vi.fn((signal?: string) => { if (this.exitCode === null) { this.exitCode = 0; this.signalCode = signal ?? null; this.emit("exit", 0, signal); this.emit("close"); } return true; });
  say(text: string) { this.stderr.emit("data", Buffer.from(text)); }
}
/** A port nothing listens on right now (freed again before use). */
async function freePort(): Promise<number> {
  const s = createServer(); await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port; await new Promise<void>(r => s.close(() => r())); return port;
}
/** The fake edge: what Cloudflare would do with a request to the hostname — forward it to the test's origin. */
function edgeTo(port: number) {
  return async (url: string): Promise<{ status: number; contentType: string; body: string }> => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: new URL(url).pathname, headers: { host: new URL(url).host } }, res => {
      let body = ""; res.on("data", c => { body += c; }); res.on("end", () => resolve({ status: res.statusCode!, contentType: String(res.headers["content-type"] ?? ""), body }));
    }); req.on("error", reject); req.end();
  });
}
interface Rig { deps: NamedLinkTestDeps; child: Child; spawn: ReturnType<typeof vi.fn>; released: ReturnType<typeof vi.fn>; port: number }
async function rig(over: Partial<NamedLinkTestDeps> & { output?: string | null; port?: number } = {}): Promise<Rig> {
  const port = over.port ?? await freePort();
  const child = new Child(), released = vi.fn();
  const spawn = vi.fn(() => {
    // A real connector prints its registration a moment after it starts.
    if (over.output !== null) setTimeout(() => child.say(over.output ?? "INF Registered tunnel connection connIndex=0 location=tpe01 protocol=http2\n"), 5);
    return child;
  });
  const deps: NamedLinkTestDeps = {
    healthPort: 19280, ensureBinary: async () => "/private/cloudflared", liveMarker: () => null,
    reserve: () => ({ release: released }), spawnProcess: spawn as never, env: { PATH: "/usr/bin", SECRET_OF_THE_HOST: "x" },
    resolve4: async () => ["104.16.1.1"], systemLookup: async () => ({}), fetchPage: edgeTo(port),
    registerMs: 300, reachMs: 300, retryMs: 20, stopGraceMs: 50, ...over,
  };
  return { deps, child, spawn, released, port };
}
const codes = (r: NamedTestResult) => r.steps.map(s => `${s.step}:${s.ok ? "✓" : "✗"}${s.code}`);
const input = (port: number, extra: Record<string, unknown> = {}) => ({ hostname: HOST, port, protocol: "http2", token: TOKEN, ...extra });
/** Nothing is left listening on the test's port once it returns. */
async function portFree(port: number): Promise<boolean> {
  const s = createServer();
  return new Promise(r => { s.once("error", () => r(false)); s.listen(port, "127.0.0.1", () => s.close(() => r(true))); });
}

describe("#2906 the Test connection runner: every step and every ✗", () => {
  it("all five steps pass against a real local origin through the fake edge: the nonce proves THIS AgEnD", async () => {
    const h = await rig();
    const result = await runNamedLinkTest(input(h.port), h.deps);
    expect(codes(result)).toEqual(["values:✓ok", "origin:✓ok", "tunnel:✓ok", "dns:✓ok", "reach:✓ok"]);
    expect([result.hostname, result.port]).toEqual([HOST, h.port]);
    // The token is in the child's environment only: never argv, and the host's own environment is not passed on.
    const [binary, argv, opts] = h.spawn.mock.calls[0]! as [string, string[], { env: Record<string, string>; shell: boolean }];
    expect([binary, argv, opts.shell, opts.env.TUNNEL_TOKEN === TOKEN, "SECRET_OF_THE_HOST" in opts.env])
      .toEqual(["/private/cloudflared", ["tunnel", "--no-autoupdate", "--config", "/dev/null", "--protocol", "http2", "run"], false, true, false]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    // Torn down: the child stopped, the port free again, the lane released.
    expect([h.child.kill.mock.calls[0]?.[0], await portFree(h.port), h.released.mock.calls.length]).toEqual(["SIGTERM", true, 1]);
  });
  it.each([
    [{ hostname: "https://agend.example.com/path" }, "values:✗bad-hostname"],
    [{ hostname: "localhost" }, "values:✗bad-hostname"],
    [{ port: 80 }, "values:✗bad-port"],
    [{ port: "x" }, "values:✗bad-port"],
    [{ token: "" }, "values:✗no-token"],
    [{ token: null }, "values:✗no-token"],
    [{ token: "eyJ-not-a-token" }, "values:✗bad-token"],
  ])("① %j → %s, and nothing is started", async (bad, expected) => {
    const h = await rig();
    const result = await runNamedLinkTest({ ...input(h.port), ...bad }, h.deps);
    expect(codes(result).at(-1)).toBe(expected);
    expect([h.spawn.mock.calls.length, h.released.mock.calls.length]).toEqual([0, 0]);
  });
  it("② the dashboard's own port, a port another program holds, a link open with other values, another tunnel", async () => {
    const dash = await rig();
    expect(codes(await runNamedLinkTest(input(19280), dash.deps)).at(-1)).toBe("origin:✗dashboard-port");
    const held = await rig();
    const other = createServer(); servers.push(other); await new Promise<void>(r => other.listen(held.port, "127.0.0.1", r));
    expect(codes(await runNamedLinkTest(input(held.port), held.deps)).at(-1)).toBe("origin:✗port-in-use");
    expect([held.spawn.mock.calls.length, held.released.mock.calls.length]).toEqual([0, 1]);      // released, never started
    const open = await rig({ reserve: () => ({ busy: "link-open" }) });
    expect(codes(await runNamedLinkTest(input(open.port), open.deps)).at(-1)).toBe("origin:✗link-open-other");
    const busy = await rig({ reserve: () => ({ busy: "other" }) });
    expect(codes(await runNamedLinkTest(input(busy.port), busy.deps)).at(-1)).toBe("origin:✗tunnel-busy");
    expect([open.spawn.mock.calls.length, busy.spawn.mock.calls.length]).toEqual([0, 0]);
  });
  it("② with the link open on exactly these values: tested as it is — nothing started, the open link's page is the proof", async () => {
    const h = await rig({ liveMarker: v => v.hostname === HOST && v.token === TOKEN ? "marker-of-the-open-link" : null,
      fetchPage: async () => ({ status: 200, contentType: "text/html", body: "<p>marker-of-the-open-link</p>" }) });
    const reserve = vi.spyOn(h.deps, "reserve");
    expect(codes(await runNamedLinkTest(input(h.port), h.deps))).toEqual(["values:✓ok", "origin:✓live", "tunnel:✓live", "dns:✓ok", "reach:✓ok"]);
    expect([h.spawn.mock.calls.length, reserve.mock.calls.length]).toEqual([0, 0]);
  });
  it("③ a refused token is said at once, not after the registration budget", async () => {
    const h = await rig({ output: "ERR Provided Tunnel token is not valid (unexpected end of JSON input)\n", registerMs: 10_000 });
    const t0 = performance.now();
    expect(codes(await runNamedLinkTest(input(h.port), h.deps)).at(-1)).toBe("tunnel:✗auth");
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
  it.each([
    ["auth: the token refused", "ERR Provided Tunnel token is not valid (unexpected end of JSON input)\n", "tunnel:✗auth"],
    ["network: no registration in time", "ERR Failed to dial a quic connection: i/o timeout\n", "tunnel:✗network"],
    ["network: silence", "", "tunnel:✗network"],
  ])("③ %s", async (_why, output, expected) => {
    const h = await rig({ output });
    const result = await runNamedLinkTest(input(h.port), h.deps);
    expect(codes(result).at(-1)).toBe(expected);
    expect([h.child.kill.mock.calls.length, await portFree(h.port), h.released.mock.calls.length]).toEqual([1, true, 1]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
  it("③ the connector exits before registering, a spawn that throws, a binary that cannot be prepared", async () => {
    const exits = await rig({ output: null });
    exits.spawn.mockImplementation(() => { setTimeout(() => { exits.child.say("something unexpected\n"); exits.child.exitCode = 1; exits.child.emit("exit", 1, null); }, 5); return exits.child; });
    expect(codes(await runNamedLinkTest(input(exits.port), exits.deps)).at(-1)).toBe("tunnel:✗stopped");
    const throws = await rig(); throws.spawn.mockImplementation(() => { throw new Error("EACCES"); });
    expect(codes(await runNamedLinkTest(input(throws.port), throws.deps)).at(-1)).toBe("tunnel:✗stopped");
    const missing = await rig({ ensureBinary: async () => { throw new Error("download failed"); } });
    expect(codes(await runNamedLinkTest(input(missing.port), missing.deps)).at(-1)).toBe("tunnel:✗no-binary");
    expect(await portFree(missing.port)).toBe(true);
  });
  it("④ not in DNS (public resolver), the public resolver unreachable but the system finds it, neither can answer", async () => {
    const notFound = Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" }), timeout = Object.assign(new Error("ETIMEOUT"), { code: "ETIMEOUT" });
    const missing = await rig({ resolve4: async () => { throw notFound; } });
    expect(codes(await runNamedLinkTest(input(missing.port), missing.deps)).at(-1)).toBe("dns:✗dns-missing");
    const fallback = await rig({ resolve4: async () => { throw timeout; } });
    expect(codes(await runNamedLinkTest(input(fallback.port), fallback.deps)).at(-1)).toBe("reach:✓ok");
    const blocked = await rig({ resolve4: async () => { throw timeout; }, systemLookup: async () => { throw timeout; } });
    expect(codes(await runNamedLinkTest(input(blocked.port), blocked.deps)).at(-1)).toBe("dns:✗dns-failed");
    const privateOnly = await rig({ resolve4: async () => ["10.0.0.5"] });
    expect(codes(await runNamedLinkTest(input(privateOnly.port), privateOnly.deps)).at(-1)).toBe("dns:✗dns-missing");
  });
  it.each([
    ["502 from the edge", { status: 502 }, "reach:✗wrong-service"],
    ["530 (error 1033)", { status: 530 }, "reach:✗wrong-service"],
    ["404", { status: 404 }, "reach:✗route-missing"],
    ["200 without the nonce", { status: 200, body: "<p>some other site</p>" }, "reach:✗other-page"],
    ["a reset while the tunnel is up", { error: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }, "reach:✗self-unreachable"],
    ["a timeout while the tunnel is up", { error: Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }) }) }, "reach:✗self-unreachable"],
    ["something else", { error: new Error("certificate has expired") }, "reach:✗reach-failed"],
  ])("⑤ %s", async (_why, answer: { status?: number; body?: string; error?: unknown }, expected) => {
    const h = await rig({ fetchPage: async () => { if (answer.error) throw answer.error; return { status: answer.status!, contentType: "text/html", body: answer.body ?? "" }; } });
    const result = await runNamedLinkTest(input(h.port), h.deps);
    expect(codes(result).slice(0, 4)).toEqual(["values:✓ok", "origin:✓ok", "tunnel:✓ok", "dns:✓ok"]);
    expect(codes(result).at(-1)).toBe(expected);
    expect([h.child.kill.mock.calls.length, await portFree(h.port)]).toEqual([1, true]);
  });
  it("⑤ retries while the edge learns the new connector, then passes", async () => {
    const h = await rig({ reachMs: 2_000 });
    let n = 0; const edge = edgeTo(h.port);
    h.deps.fetchPage = async (url, signal) => (++n < 3 ? { status: 530, contentType: "text/html", body: "" } : edge(url));
    expect(codes(await runNamedLinkTest(input(h.port), h.deps)).at(-1)).toBe("reach:✓ok");
    expect(n).toBe(3);
  });
  it("a protocol other than http2/quic/auto is http2; auto passes no --protocol", async () => {
    const h = await rig();
    await runNamedLinkTest(input(h.port, { protocol: "auto" }), h.deps);
    const g = await rig();
    await runNamedLinkTest(input(g.port, { protocol: "--evil" }), g.deps);
    expect([(h.spawn.mock.calls[0]![1] as string[]).includes("--protocol"), (g.spawn.mock.calls[0]![1] as string[]).join(" ")]).toEqual([false, "tunnel --no-autoupdate --config /dev/null --protocol http2 run"]);
  });
  it("an outer abort ends it at once and still tears everything down", async () => {
    const h = await rig({ output: "" , registerMs: 10_000 });
    const outer = new AbortController();
    const running = runNamedLinkTest(input(h.port), h.deps, outer.signal);
    setTimeout(() => outer.abort(), 30);
    expect(codes(await running).at(-1)).toBe("tunnel:✗network");
    expect([h.child.kill.mock.calls.length, await portFree(h.port), h.released.mock.calls.length]).toEqual([1, true, 1]);
  });
});

describe("#2906 at launch: a registered tunnel whose self-probe cannot connect is this machine's network", () => {
  function fixture(log: string, error: unknown) {
    const dir = mkdtempSync(join(tmpdir(), "agend-2906-")); roots.push(dir);
    const binary = join(dir, "inert-cloudflared"); writeFileSync(binary, "#!/bin/sh\n", { mode: 0o755 });
    const child = new Child();
    const p = new CloudflaredProvider({ binaryName: binary, named: { hostname: HOST, token: TOKEN }, spawnProcess: (() => child) as never,
      probe: () => ({ kind: "gone" }), deadlineMs: 5, graceMs: 1,
      fetchPage: async () => { child.say(log); throw error; } });
    const ctx: TunnelStartContext = { sid: "inert2906", origin: new URL("http://127.0.0.1:19282"), pagePath: "/signin", readinessMarker: "m2906", expiresAt: Date.now() + 60_000, signal: new AbortController().signal };
    return { p, ctx };
  }
  const reset = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  async function kind(log: string) {
    vi.useFakeTimers();
    const f = fixture(log, reset);
    const out = f.p.start(f.ctx).then(() => null, e => e);
    await vi.runAllTimersAsync();
    return (await out)?.errorKind;
  }
  it("registered (4 connections) + the self-probe reset → named-self-unreachable, even with transient dial errors in its output", async () => {
    expect(await kind("INF Registered tunnel connection connIndex=0\nINF Registered tunnel connection connIndex=1\nERR failed to dial edge: i/o timeout\n")).toBe("named-self-unreachable");
  });
  it("not registered + the same reset → named-connection-failed (the tunnel is down)", async () => {
    expect(await kind("ERR Failed to dial a quic connection: i/o timeout\n")).toBe("named-connection-failed");
    expect(await kind("")).toBe("named-connection-failed");
  });
  it("registered + a token refusal still says the token (output evidence wins)", async () => {
    expect(await kind("INF Registered tunnel connection connIndex=0\nERR Provided Tunnel token is not valid\n")).toBe("named-auth-failed");
  });
  it("the new reason reaches the progress line in both languages", () => {
    expect(failureOf("named-self-unreachable")).toBe("named-self-unreachable");
    expect(NAMED_TUNNEL_FAILURE_MESSAGES["named-self-unreachable"]).toMatch(/connected to Cloudflare, but this machine could not open its own address/);
    setLocale("en");
    expect(t("dashboard.progress.fail.named-self-unreachable")).toMatch(/^the tunnel is connected to Cloudflare, but this machine can't open its own address — this machine's network may block/);
    expect(t("dashboard.progress.fail.named-connection-failed")).toMatch(/^the tunnel could not connect to Cloudflare from this machine — ask the network administrator/);
    setLocale("zh-TW");
    expect(t("dashboard.progress.fail.named-self-unreachable")).toMatch(/^tunnel 已連上 Cloudflare，但這台主機打不開自己的網址 — 這台主機所在的網路可能擋了/);
    expect(t("dashboard.progress.fail.named-connection-failed")).toMatch(/^這台主機連不上 Cloudflare，tunnel 沒有連線 — 請網路管理員/);
  });
});

describe("#2906 wording (the user: never 公司 / company)", () => {
  it("no locale string, server or page, says 公司, company or corporate", () => {
    const files = ["src/locale.ts", ...readdirSync("src/ui").filter(f => f.endsWith(".js")).map(f => `src/ui/${f}`),
      ...readdirSync("src/ui/shared").filter(f => f.endsWith(".js")).map(f => `src/ui/shared/${f}`)];
    // Only quoted strings (what a person reads), not comments.
    const hits = files.flatMap(f => (readFileSync(f, "utf8").match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? [])
      .filter(s => /公司|\bcompany\b|\bcorporate\b/i.test(s)).map(s => `${f}: ${s.slice(0, 80)}`));
    expect(hits).toEqual([]);
  });
});

describe("#2906 the route: admin only, never over the public link, closed codes only", () => {
  async function api() {
    const token = "c".repeat(48), sessions = new WebSessionStore({});
    let gateway = false;
    const testNamedLink = vi.fn(async (_input: unknown) => ({ steps: [{ step: "values", ok: true, code: "ok" }], hostname: HOST, port: 19282 }));
    const ctx = { webToken: token, webSessions: sessions, testNamedLink, logger: { warn() {}, info() {}, debug() {}, error() {} } } as never;
    const server = createServer((req, res) => {
      if (gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: origin, isCurrent: () => true });
      if (!handleSettingsRequest(req, res, new URL(req.url!, origin), ctx)) { res.writeHead(404); res.end(); }
    });
    servers.push(server);
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const session = (tier: "admin" | "read" | "guest", surface: "local" | "gateway" = "local") => {
      const made = sessions.create({ tier, surface, label: "scratch", tokenEpoch: tokenEpoch(token), ...(surface === "gateway" ? { exposureId: "e".repeat(32) } : {}), ...(tier === "guest" ? { owner: { adapterId: "web", userId: "g" } } : {}) });
      return { cookie: `agend_session=${made.sessionId}`, origin, "x-agend-csrf": csrfTokenFor(made.sessionId), "content-type": "application/json" } as Record<string, string>;
    };
    const post = (headers: Record<string, string>, body: unknown) => new Promise<{ status: number; raw: string }>((resolve, reject) => {
      const req = request(origin + "/api/settings/public-link/test", { method: "POST", headers }, res => {
        let raw = ""; res.on("data", c => { raw += c; }); res.on("end", () => resolve({ status: res.statusCode!, raw }));
      }); req.on("error", reject); req.end(JSON.stringify(body));
    });
    return { post, session, testNamedLink, setGateway: (v: boolean) => { gateway = v; } };
  }
  it("an admin's request reaches the test with the typed token; the answer never carries it", async () => {
    const h = await api();
    const r = await h.post(h.session("admin"), { hostname: HOST, origin_port: "19282", protocol: "http2", token: TOKEN });
    expect(r.status).toBe(200);
    expect(h.testNamedLink.mock.calls[0]![0]).toEqual({ hostname: HOST, port: "19282", protocol: "http2", token: TOKEN });
    expect(r.raw).not.toContain(TOKEN);
    expect(JSON.parse(r.raw)).toEqual({ steps: [{ step: "values", ok: true, code: "ok" }], hostname: HOST, port: 19282 });
  });
  it("refused: a read or guest session, no session, and anything over the public link (even an admin's)", async () => {
    const h = await api();
    for (const headers of [h.session("read"), h.session("guest"), { "content-type": "application/json" }]) expect((await h.post(headers, { hostname: HOST })).status).toBeGreaterThanOrEqual(401);
    h.setGateway(true);
    const over = await h.post(h.session("admin", "gateway"), { hostname: HOST });
    expect([over.status, JSON.parse(over.raw).error]).toEqual([403, "web_settings_not_over_public_link"]);
    expect(h.testNamedLink).not.toHaveBeenCalled();
  });
  it("one at a time: a second request while one runs is told so (409)", async () => {
    const h = await api();
    h.testNamedLink.mockResolvedValueOnce({ busy: true } as never);
    expect((await h.post(h.session("admin"), { hostname: HOST })).status).toBe(409);
  });
});
