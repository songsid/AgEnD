/**
 * #3292 offline acceptance: the real SignInKeepAlive (src/signin-keepalive.ts) with its REAL runners — the installed
 * `claude` and `codex` — against a mock OAuth service. Fake tokens only, scratch homes only, no account.
 *
 * Run inside a network namespace with only loopback (no route out, so nothing can reach a vendor):
 *   unshare -rn sh -c 'ip link set lo up; npx tsx scripts/manual/signin-keepalive/accept.mts'
 * - Claude Code: an explicit HTTPS proxy (HTTPS_PROXY) terminating TLS for platform.claude.com / api.anthropic.com with a
 *   scratch CA (NODE_EXTRA_CA_CERTS); every other CONNECT refused. No iptables, routes or resolv changes.
 * - Codex: CODEX_REFRESH_TOKEN_URL_OVERRIDE → the mock over plain HTTP.
 * Prints one line per case and a JSON summary; exits 1 when a case fails.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — plain ESM helpers next to this file
import { startMock, fakeJwt, codexIdClaims } from "./mock-oauth.mjs";
// @ts-ignore
import { makeCa, startProxy } from "./mitm-proxy.mjs";
import { SignInKeepAlive, SETTINGS_FILE, type KeepAliveBackend } from "../../../src/signin-keepalive.js";

const root = mkdtempSync(join(process.env.RIG_TMP ?? tmpdir(), "ka-accept-"));
const log = join(root, "mock.log");
let modeFor: (path: string) => string = () => "ok";
const { server: mock, port: mockPort } = await startMock({ mode: (path: string) => modeFor(path), log });
const hosts = ["platform.claude.com", "api.anthropic.com"];
const certs = makeCa(root, hosts);
const { port: proxyPort } = await startProxy({ hosts, certs, mock, log });
// What the real runners inherit (they copy process.env): the proxy and CA for Claude Code, the override for Codex.
Object.assign(process.env, {
  HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, https_proxy: `http://127.0.0.1:${proxyPort}`, NODE_EXTRA_CA_CERTS: certs.ca,
  CODEX_REFRESH_TOKEN_URL_OVERRIDE: `http://127.0.0.1:${mockPort}/oauth/token`,
});

const hits = (): Array<Record<string, string>> => { try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const DAY = 86_400_000;
const results: Array<{ name: string; ok: boolean; got: unknown }> = [];

async function runCase(name: string, backend: KeepAliveBackend, setup: (home: string) => void, mode: (path: string) => string,
  expect: (r: { outcome?: string; record: any; attention: string[]; hits: Array<Record<string, string>>; home: string; data: string }) => boolean, fallback = false) {
  const data = join(root, name), home = join(data, "credential-profiles", backend, "work");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  setup(home);
  modeFor = mode;
  const before = hits().length;
  const logs: unknown[] = [];
  const ka = new SignInKeepAlive({
    dataDir: data, log: (l, m, f) => { logs.push([l, m, f]); }, homeOf: () => home,
    acquire: () => ({ release() {} }), changed: () => {},
  });
  ka.set(backend, "work", true, fallback);
  await ka.tick({ force: true });
  const record = ka.list()[0]?.record;
  const r = { outcome: record?.outcome, record, attention: ka.attention().map(a => a.kind), hits: hits().slice(before), home, data };
  // Nothing a token was ever made of is in the log or the saved settings.
  const leak = /old-at-|old-rt-|rig-at-|rig-rt-|rrrrrrrrrrrrrrrrrrrr/.test(JSON.stringify(logs) + readFileSync(join(data, SETTINGS_FILE), "utf8"));
  const ok = !leak && expect(r);
  results.push({ name, ok, got: { outcome: r.outcome, attention: r.attention, paths: r.hits.filter(h => h.path).map(h => `${h.method} ${h.path} ${h.mode}`), leak } });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${r.outcome} ${JSON.stringify(r.attention)}`);
}

// ── Claude Code ─────────────────────────────────────────────────────────────────────────────────────────────────
const now = Date.now();
const claudeHome = (expiresAt: number, endsAt = now + 11 * DAY) => (home: string) => writeFileSync(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
  accessToken: `old-at-${"a".repeat(24)}`, refreshToken: `old-rt-${"r".repeat(24)}`, expiresAt, refreshTokenExpiresAt: endsAt,
  scopes: ["user:inference", "user:profile", "user:sessions:claude_code"], subscriptionType: "team", rateLimitTier: "default_claude_max_5x" } }), { mode: 0o600 });
const creds = (home: string) => JSON.parse(readFileSync(join(home, ".credentials.json"), "utf8")).claudeAiOauth;
const tokenCalls = (h: Array<Record<string, string>>) => h.filter(x => x.path === "/v1/oauth/token").length;

await runCase("claude-expired-renewed", "claude-code", claudeHome(now - 3600e3), () => "ok",
  r => r.outcome === "refreshed" && creds(r.home).expiresAt > now && creds(r.home).refreshTokenExpiresAt === r.record.endsAt && tokenCalls(r.hits) === 1 && r.attention.length === 0);
await runCase("claude-not-due", "claude-code", claudeHome(now + 3600e3), () => "ok",
  r => r.outcome === "not_needed" && r.hits.length === 0);
await runCase("claude-refused-sign-in-again", "claude-code", claudeHome(now - 3600e3), () => "invalid_grant",
  r => r.outcome === "needs_sign_in" && r.attention.includes("needs_sign_in"));
await runCase("claude-service-down-not-renewed", "claude-code", claudeHome(now - 3600e3), () => "server_error",
  r => r.outcome === "not_renewed" && r.attention.includes("not_renewed") && !r.hits.some(h => h.path?.startsWith("/v1/messages")));
// The fallback: the status check's refresh fails; the person allowed one tiny request, which renews first (then asks the model once).
let calls = 0;
await runCase("claude-fallback-renewed", "claude-code", claudeHome(now - 3600e3), path => path.startsWith("/v1/oauth/token") ? (++calls <= 2 ? "server_error" : "ok") : "ok",
  r => r.outcome === "fallback_refreshed" && creds(r.home).expiresAt > now && r.hits.filter(h => h.path?.startsWith("/v1/messages")).length >= 1, true);
await runCase("claude-ending-in-3-days", "claude-code", claudeHome(now - 3600e3, now + 3 * DAY), () => "ok",
  r => r.outcome === "refreshed" && r.attention.includes("ending"));

// ── Codex ───────────────────────────────────────────────────────────────────────────────────────────────────────
const codexHome = (lastRefreshAgo: number) => (home: string) => {
  const s = Math.floor(now / 1000);
  writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null,
    tokens: { id_token: fakeJwt(codexIdClaims("prolite", s - 7200)), access_token: fakeJwt({ exp: s + 3 * 86400 }), refresh_token: "r".repeat(32), account_id: "acc-rig" },
    last_refresh: new Date(now - lastRefreshAgo).toISOString() }, null, 2), { mode: 0o600 });
};
const auth = (home: string) => JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
await runCase("codex-due-renewed", "codex", codexHome(7 * DAY), () => "ok",
  r => r.outcome === "refreshed" && r.record.planType === "plus" && Date.parse(auth(r.home).last_refresh) > now - 60_000
    // Only the sign-in itself beside it (codex 0.167+ adds its own empty auth.json.lock next to the real file).
    && readdirSync(r.home).every(f => f === "auth.json" || f === "auth.json.lock") && !readdirSync(join(r.data, "signin-keepalive", "codex-home")).includes("auth.json"));
await runCase("codex-refused-sign-in-again", "codex", codexHome(7 * DAY), () => "expired",
  r => r.outcome === "needs_sign_in" && r.attention.includes("needs_sign_in"));
await runCase("codex-service-down-transient", "codex", codexHome(7 * DAY), () => "server_error",
  r => r.outcome === "transient" && r.attention.length === 0 && r.record.failCount === 1);
await runCase("codex-not-due", "codex", codexHome(2 * DAY), () => "ok",
  r => r.outcome === "not_needed" && r.hits.length === 0);

mock.close();
const versions = { claude: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(), codex: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim() };
console.log(JSON.stringify({ versions, results }, null, 1));
process.exit(results.every(r => r.ok) ? 0 : 1);
