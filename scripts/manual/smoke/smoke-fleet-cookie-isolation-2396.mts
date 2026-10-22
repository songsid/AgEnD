/** Scratch HTTP auth listeners + one real Chromium jar. Never starts a fleet/CLI/adapter/tmux/tunnel. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const repo = resolve(process.env.REPO || process.cwd()), out = resolve(process.env.OUT || join(repo, ".artifacts/fleet-cookies/browser"));
const scratch = mkdtempSync(join(tmpdir(), "agend-cookie-browser-2396-")); process.env.AGEND_HOME = scratch;
mkdirSync(out, { recursive: true });
const { cookieListener } = await import(join(repo, "tests/helpers/web-cookie-listener.ts"));
const { fleetCookieName } = await import(join(repo, "src/web-cookie-names.ts"));
const { tokenEpoch } = await import(join(repo, "src/web-session.ts"));
const pw = createRequire((process.env.PW_DIR || "/home/han/.cache/agend-smoke/pw") + "/")("playwright-core");
let a: any, b: any, browser: any; const external: string[] = [], errors: string[] = [];
const results: any = {};
try {
  a = await cookieListener(join(scratch, "fleet-a")); b = await cookieListener(join(scratch, "fleet-b"));
  browser = await pw.chromium.launch({ executablePath: process.env.CHROME || "/home/han/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome", args: ["--no-sandbox"] });
  const context = await browser.newContext();
  // Browser storage semantics, no requests or DNS to these illustrative hosts.
  const matrix = await browser.newContext();
  await matrix.addCookies([
    { name: "agend_session", value: "first", url: "http://fleet.test:19280" },
    { name: "agend_session", value: "second", url: "http://fleet.test:19281" },
    { name: "__Host-agend_session", value: "first-secure", url: "https://fleet.test:19280", secure: true },
    { name: "__Host-agend_session", value: "second-secure", url: "https://fleet.test:19281", secure: true },
    { name: "agend_session", value: "other", url: "http://other.test:19280" },
    { name: "__Host-agend_session", value: "one", url: "https://one.trycloudflare.com", secure: true },
    { name: "__Host-agend_session", value: "two", url: "https://two.trycloudflare.com", secure: true },
  ]);
  const httpSlot = await matrix.cookies("http://fleet.test:19280");
  const httpsSlot = await matrix.cookies("https://fleet.test:19280");
  assert.equal(httpSlot.find((c: any) => c.name === "agend_session")?.value, "second");
  assert.equal(httpsSlot.find((c: any) => c.name === "__Host-agend_session")?.value, "second-secure");
  assert.equal(httpsSlot.length, 2); // Plain/secure prefixes are different names, not scheme isolation.
  assert.equal((await matrix.cookies("http://other.test:19280"))[0]?.value, "other");
  assert.equal((await matrix.cookies("https://one.trycloudflare.com"))[0]?.value, "one");
  assert.equal((await matrix.cookies("https://two.trycloudflare.com"))[0]?.value, "two");
  results.scopeMatrix = { httpPortsCollide: true, httpsPortsCollide: true, distinctHostsIsolated: true, plainAndHostNamesCoexist: true };
  await matrix.close();
  await context.route("**/*", async (route: any) => {
    const url = new URL(route.request().url());
    if (![a.origin, b.origin].includes(url.origin)) { external.push(url.origin); await route.abort(); }
    else await route.continue();
  });
  const pa = await context.newPage(), pb = await context.newPage();
  for (const page of [pa, pb]) page.on("pageerror", (e: Error) => errors.push(e.name));
  await pa.goto(a.origin + "/probe"); await pb.goto(b.origin + "/probe");
  await pa.evaluate(() => localStorage.setItem("agend_cookie_probe", "fleet-a"));
  await pb.evaluate(() => localStorage.setItem("agend_cookie_probe", "fleet-b"));
  results.originStorage = [await pa.evaluate(() => localStorage.getItem("agend_cookie_probe")), await pb.evaluate(() => localStorage.getItem("agend_cookie_probe"))];
  assert.deepEqual(results.originStorage, ["fleet-a", "fleet-b"]);
  const request = (page: any, path: string, method = "GET", body?: unknown, csrf?: string) => page.evaluate(async (v: any) => {
    const r = await fetch(v.path, { method: v.method, headers: { ...(v.body === undefined ? {} : { "content-type": "application/json" }), ...(v.csrf ? { "x-agend-csrf": v.csrf } : {}) }, ...(v.body === undefined ? {} : { body: JSON.stringify(v.body) }) });
    return { status: r.status, body: await r.json() };
  }, { path, method, body, csrf });
  assert.equal((await request(pa, "/auth/login", "POST", { code: a.issue() })).status, 200);
  assert.equal((await request(pb, "/auth/login", "POST", { code: b.issue() })).status, 200);
  results.simultaneous = [(await request(pa, "/auth/session")).status, (await request(pb, "/auth/session")).status];
  assert.deepEqual(results.simultaneous, [200, 200]);
  results.cookieNames = (await context.cookies()).map((c: any) => c.name).sort(); // Never write bearer values.
  assert.equal(results.cookieNames.length, 2);
  assert.notEqual(results.cookieNames[0], results.cookieNames[1]);

  await context.clearCookies();
  const legacy = a.sessions.create({ tier: "admin", surface: "local", label: "legacy browser", tokenEpoch: tokenEpoch(a.token) });
  await context.addCookies([{ name: "agend_session", value: legacy.sessionId, url: a.origin, httpOnly: true, sameSite: "Strict" }]);
  const migrated = await request(pa, "/auth/session");
  assert.equal(migrated.status, 200); assert.equal(migrated.body.expiresAt, legacy.record.absoluteExpiry);
  assert((await context.cookies()).some((c: any) => c.name === fleetCookieName("agend_session", a.token) && c.value === legacy.sessionId));
  results.legacyMigration = true;
  assert.equal((await request(pb, "/auth/login", "POST", { code: b.issue() })).status, 200);
  assert.equal((await request(pa, "/auth/logout", "POST", undefined, migrated.body.csrf)).status, 200);
  results.afterLogout = [(await request(pa, "/auth/session")).status, (await request(pb, "/auth/session")).status];
  assert.deepEqual(results.afterLogout, [401, 200]);
  assert(!(await context.cookies()).some((c: any) => c.name === "agend_session" || c.name === fleetCookieName("agend_session", a.token)));

  await context.clearCookies();
  const ownA = a.sessions.create({ tier: "admin", surface: "local", label: "fleet A only", tokenEpoch: tokenEpoch(a.token) });
  await context.addCookies([{ name: fleetCookieName("agend_session", a.token), value: ownA.sessionId, url: a.origin, httpOnly: true, sameSite: "Strict" }, { name: fleetCookieName("agend_session", b.token), value: ownA.sessionId, url: b.origin, httpOnly: true, sameSite: "Strict" }, { name: "agend_session", value: ownA.sessionId, url: b.origin, httpOnly: true, sameSite: "Strict" }]);
  results.crossFleet = [(await request(pa, "/auth/session")).status, (await request(pb, "/auth/session")).status];
  assert.deepEqual(results.crossFleet, [200, 401]);
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  results.errors = errors; results.externalRequests = external;
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results));
} finally {
  await browser?.close(); await a?.close(); await b?.close(); rmSync(scratch, { recursive: true, force: true });
}
