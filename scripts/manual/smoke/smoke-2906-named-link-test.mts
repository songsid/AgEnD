// #2906 smoke: the fixed address's Test connection, end to end, with NO real tunnel or token (the leader: none from
// this host). A REAL stub `cloudflared` executable is spawned (it records its argv and whether TUNNEL_TOKEN reached its
// environment, prints what a real connector prints, and stays up until it is killed); the origin is the runner's own
// listener on a real port; the "edge" forwards the HTTPS request for the hostname to 127.0.0.1:<port> (what Cloudflare
// does with a published application route), so ⑤'s nonce check is the real one. Requests go through the real Settings
// route (POST /api/settings/public-link/test) with a real admin web session, and over the "public link" (refused).
//   npx tsx scripts/manual/smoke/smoke-2906-named-link-test.mts
import { createServer, request, type Server } from "node:http";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { namedTestLane, runNamedLinkTest } from "../../../src/tunnel/named-link-test.ts";
import { TunnelPurposeLane } from "../../../src/tunnel/purpose-lane.ts";
import { ManagedTunnel } from "../../../src/tunnel/manager.ts";
import { handleSettingsRequest } from "../../../src/settings-api.ts";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../../../src/web-session.ts";
import { bindGatewayRequest } from "../../../src/web-request-context.ts";

const dir = mkdtempSync(join(tmpdir(), "smoke-2906-"));
const TOKEN = Buffer.from(JSON.stringify({ a: "0".repeat(32), t: "00000000-0000-4000-8000-000000000001", s: Buffer.alloc(32, 1).toString("base64") })).toString("base64");
const HOST = "agend.example.com";
// The stub connector. MODE picks what it prints; it writes what it saw and its pid, then waits to be killed.
const stub = join(dir, "cloudflared");
// The connector gets no PATH (minimalChildEnv, as for the real static binary): the stub names its interpreter.
writeFileSync(stub, `#!${process.execPath}
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(join(dir, "seen.json"))}, JSON.stringify({ argv: process.argv.slice(2), tokenInEnv: process.env.TUNNEL_TOKEN === ${JSON.stringify(TOKEN)}, tokenOnArgv: process.argv.join(" ").includes(${JSON.stringify(TOKEN)}), pid: process.pid }));
const mode = fs.readFileSync(${JSON.stringify(join(dir, "mode"))}, "utf8").trim();
if (mode === "ignore-term") process.on("SIGTERM", () => {});     // only SIGKILL ends it
setTimeout(() => {
  if (mode === "ok" || mode === "ignore-term") process.stderr.write("2026-11-01T00:00:00Z INF Registered tunnel connection connIndex=0 location=tpe01 protocol=http2\\n");
  if (mode === "auth") { process.stderr.write("ERR Provided Tunnel token is not valid (unexpected end of JSON input)\\n"); process.exit(1); }
  if (mode === "network") process.stderr.write("ERR Failed to dial a quic connection: i/o timeout\\n");
}, 200);
setInterval(() => {}, 1000);
`);
chmodSync(stub, 0o755);
const mode = (m: string) => writeFileSync(join(dir, "mode"), m);
const seen = () => JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function freePort(): Promise<number> {
  const s = createServer(); await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as { port: number }).port; await new Promise<void>(r => s.close(() => r())); return p;
}
let port = await freePort();
let edge: "origin" | "reset" | 530 = "origin";
const edgeFetch = async (url: string) => {
  if (edge === "reset") throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  if (edge === 530) return { status: 530, contentType: "text/html", body: "" };
  return new Promise<{ status: number; contentType: string; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: new URL(url).pathname, headers: { host: HOST } }, res => {
      let body = ""; res.on("data", c => { body += c; }); res.on("end", () => resolve({ status: res.statusCode!, contentType: String(res.headers["content-type"]), body }));
    }); req.on("error", reject); req.end();
  });
};
let dnsAnswer: string[] | "ENOTFOUND" = ["104.16.1.1"];
const testNamedLink = (input: { hostname: unknown; port: unknown; protocol: unknown; token?: unknown; current?: () => boolean }) => runNamedLinkTest(
  { hostname: input.hostname, port: input.port, protocol: input.protocol, token: typeof input.token === "string" ? input.token : TOKEN },
  // The production lane: the one tunnel lane, its managed start (lease, proven stop), a connector ready once registered.
  { healthPort: 19280, ensureBinary: async () => stub, liveMarker: () => null, reserve: namedTestLane(lane, { registerMs: 5_000 }),
    resolve4: async () => { if (dnsAnswer === "ENOTFOUND") throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); return dnsAnswer; },
    systemLookup: async () => ({}), fetchPage: edgeFetch, reachMs: 2_000, retryMs: 100, current: input.current });
const lane = new TunnelPurposeLane(new ManagedTunnel({ dataDir: dir }));

// The real Settings route, a real admin session.
const webToken = "c".repeat(48), sessions = new WebSessionStore({});
let gateway = false;
const ctx = { webToken, webSessions: sessions, testNamedLink, logger: { warn() {}, info() {}, debug() {}, error() {} } } as never;
const server: Server = createServer((req, res) => {
  if (gateway) bindGatewayRequest(req, { surface: "gateway", exposureId: "e".repeat(32), expectedOrigin: origin, isCurrent: () => true });
  if (!handleSettingsRequest(req, res, new URL(req.url!, origin), ctx)) { res.writeHead(404); res.end(); }
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const admin = (surface: "local" | "gateway" = "local") => {
  const s = sessions.create({ tier: "admin", surface, label: "smoke", tokenEpoch: tokenEpoch(webToken), ...(surface === "gateway" ? { exposureId: "e".repeat(32) } : {}) });
  return { cookie: `agend_session=${s.sessionId}`, origin, "x-agend-csrf": csrfTokenFor(s.sessionId), "content-type": "application/json" };
};
const post = (headers: Record<string, string>, body: unknown) => new Promise<{ status: number; raw: string }>((resolve, reject) => {
  const req = request(origin + "/api/settings/public-link/test", { method: "POST", headers }, res => {
    let raw = ""; res.on("data", c => { raw += c; }); res.on("end", () => resolve({ status: res.statusCode!, raw }));
  }); req.on("error", reject); req.end(JSON.stringify(body));
});

const rows: string[] = [];
let pass = true;
async function scenario(name: string, setup: () => void | Promise<void>, expect: string, body: Record<string, unknown> = {}, check?: () => boolean) {
  await setup();
  const t0 = Date.now();
  const r = await post(admin(), { hostname: HOST, origin_port: String(port), protocol: "http2", ...body });
  const ms = Date.now() - t0;
  const parsed = r.status === 200 ? JSON.parse(r.raw) : null;
  const got = parsed ? parsed.steps.map((s: { step: string; ok: boolean; code: string }) => `${s.ok ? "✓" : "✗"}${s.step}:${s.code}`).join(" ") : `HTTP ${r.status}`;
  const leak = r.raw.includes(TOKEN);
  const s = existsSync(join(dir, "seen.json")) ? seen() : null;
  const ok = got === expect && !leak && (check ? check() : true);
  pass &&= ok;
  rows.push(`| ${name} | ${got} | ${ms} ms | ${leak ? "LEAK" : "no"} | ${s ? `${s.tokenInEnv ? "env" : "-"}/${s.tokenOnArgv ? "ARGV" : "not argv"}/${alive(s.pid) ? "ALIVE" : "gone"}` : "not started"} | ${ok ? "PASS" : "FAIL"} |`);
  rmSync(join(dir, "seen.json"), { force: true });
}
const portIsFree = async (p: number) => { const s = createServer(); return new Promise<boolean>(r => { s.once("error", () => r(false)); s.listen(p, "127.0.0.1", () => s.close(() => r(true))); }); };

await scenario("all good", () => { mode("ok"); edge = "origin"; dnsAnswer = ["104.16.1.1"]; }, "✓values:ok ✓origin:ok ✓tunnel:ok ✓dns:ok ✓reach:ok", {}, () => true);
const after = await portIsFree(port);
rows.push(`| (after "all good") the test's port free again | ${after} | | | | ${after ? "PASS" : "FAIL"} |`); pass &&= after;
await scenario("① a bad token typed", () => { mode("ok"); }, "✗values:bad-token", { token: "eyJ-not-a-token" });
await scenario("② the dashboard's own port", () => {}, "✓values:ok ✗origin:dashboard-port", { origin_port: "19280" });
const holder = createServer(); await new Promise<void>(r => holder.listen(port, "127.0.0.1", r));
await scenario("② a port another program holds", () => { mode("ok"); }, "✓values:ok ✗origin:port-in-use");
await new Promise<void>(r => holder.close(() => r()));
await scenario("③ token refused by Cloudflare", () => { mode("auth"); }, "✓values:ok ✓origin:ok ✗tunnel:auth");
await scenario("③ cannot reach Cloudflare", () => { mode("network"); }, "✓values:ok ✓origin:ok ✗tunnel:network");
await scenario("④ the domain is not in DNS", () => { mode("ok"); dnsAnswer = "ENOTFOUND"; }, "✓values:ok ✓origin:ok ✓tunnel:ok ✗dns:dns-missing");
await scenario("⑤ route to the wrong service (530/1033)", () => { dnsAnswer = ["104.16.1.1"]; edge = 530; }, "✓values:ok ✓origin:ok ✓tunnel:ok ✓dns:ok ✗reach:wrong-service");
await scenario("⑤ tunnel up, this machine's network resets its own address", () => { edge = "reset"; }, "✓values:ok ✓origin:ok ✓tunnel:ok ✓dns:ok ✗reach:self-unreachable");
edge = "origin";
await scenario("a connector that ignores SIGTERM (SIGKILL proves its exit)", () => { mode("ignore-term"); edge = "origin"; }, "✓values:ok ✓origin:ok ✓tunnel:ok ✓dns:ok ✓reach:ok");
mode("ok");
const laneFree = lane.holder() === null;
rows.push(`| (after every run) the tunnel lane is free | ${laneFree} | | | | ${laneFree ? "PASS" : "FAIL"} |`); pass &&= laneFree;
gateway = true;
await scenario("over the public link (even an admin)", () => {}, "HTTP 403");
gateway = false;
const noSession = await post({ "content-type": "application/json", origin }, { hostname: HOST });
rows.push(`| no session | HTTP ${noSession.status} | | | | ${noSession.status >= 401 ? "PASS" : "FAIL"} |`); pass &&= noSession.status >= 401;

console.log("| scenario | result (steps) | took | token in answer | stub: token / argv / after | |\n|---|---|---|---|---|---|\n" + rows.join("\n"));
console.log(`\nRESULT ${pass ? "PASS" : "FAIL"}`);
server.close(); rmSync(dir, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
