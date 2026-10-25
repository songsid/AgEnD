/** Actual dialog + auth-gated API, scratch cookie jar and inert backend; no fleet/native/account. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BrowserBackendSignIns } from "../../src/browser-backend-signins.js";
import { writePendingBackendSignIns } from "../../src/backend-signin-pending.js";
import { WebSessionStore, csrfTokenFor, tokenEpoch } from "../../src/web-session.js";
import { handleWebRequest, type WebApiContext } from "../../src/web-api.js";
const out = resolve(process.env.OUT!), pw = createRequire(join(resolve(process.env.PW_DIR!), "package.json"))("playwright");
mkdirSync(out, { recursive: true }); const home = mkdtempSync(join(tmpdir(), "ag2599dash-"));
const token = "scratch-dashboard-token", sessions = new WebSessionStore({}), made = sessions.create({ tier: "admin", surface: "local", label: "Scratch Chrome", tokenEpoch: tokenEpoch(token) });
writePendingBackendSignIns(home, { version: 1, selected: ["codex"], pending: ["codex"] });
let starts = 0, closes = 0, valid = false;
const events: unknown[] = [], errors: string[] = [], external: string[] = [];
const service = new BrowserBackendSignIns({ dataDir: home, current: owner => owner === made.record && sessions.isCurrent(made.record, tokenEpoch(token)), installed: async () => ["codex"], checkAuth: async () => valid ? "valid" : "invalid",
  transport: () => ({ start: async () => { starts++; }, capture: async () => "https://auth.openai.com/codex/device\nTEST-CODE", status: async () => ({ alive: !valid }), write: async () => { throw Error("device auth needs no input"); }, close: async () => { closes++; } }), changed: event => events.push(event) });
const ctx = { webToken: token, webSessions: sessions, browserBackendSignIns: service } as WebApiContext;
const server = createServer((req, res) => {
  const url = new URL(req.url!, "http://localhost"), path = url.pathname;
  if (path === "/audit") { res.setHeader("Content-Type", "text/html"); res.end(`<!doctype html><html lang="en"><head><link rel="stylesheet" href="/assets/app.css"><script src="/assets/agend-auth.js"></script></head><body><main id="root"></main><script type="module">import { h, render } from '/assets/app-html.js';import { BrowserSignInDialog } from '/ui/js/backend-signin.js';render(h(BrowserSignInDialog,{backend:'codex',onClose:()=>{}}),document.getElementById('root'));</script></body></html>`); return; }
  if (path === "/auth/session") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ csrf: csrfTokenFor(made.sessionId), handle: made.record.handle, tier: "admin", surface: "local" })); return; }
  if (path === "/ui/backend-login") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ targets: [], login: null })); return; }
  if (path.startsWith("/assets/") || path.startsWith("/ui/js/")) {
    const name = path.split("/").at(-1)!;
    if (!/^[a-z0-9_.-]+\.(?:js|css)$/.test(name)) { res.writeHead(404); res.end(); return; }
    try { res.setHeader("Content-Type", name.endsWith(".css") ? "text/css" : "text/javascript"); res.end(readFileSync(join("src/ui", path.startsWith("/assets/") ? "shared" : "", name))); }
    catch { res.writeHead(404); res.end(); } return;
  }
  if (!handleWebRequest(req, res, url, ctx)) { res.writeHead(404); res.end(); }
});
let browser: any;
try {
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  browser = await pw.chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
  await context.addCookies([{ name: "agend_session", value: made.sessionId, url: origin }]); const page = await context.newPage();
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); } return route.continue(); });
  await page.goto(origin + "/audit"); await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("TEST-CODE", { exact: true }).waitFor(); assert.equal(starts, 1);
  await page.screenshot({ path: join(out, "device-code.png"), fullPage: true });
  await page.reload(); await page.getByText("TEST-CODE", { exact: true }).waitFor(); assert.equal(starts, 1);
  valid = true; await page.getByText("Signed in ✓", { exact: true }).waitFor(); assert.equal(closes, 1);
  assert(!JSON.stringify(events).includes("TEST-CODE")); assert(!JSON.stringify(events).includes("auth.openai")); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await page.screenshot({ path: join(out, "verified.png"), fullPage: true });
  writeFileSync(join(out, "results.json"), JSON.stringify({ passed: 8, starts, closes, errors, external, ownerCookie: true, csrfViaSharedWrapper: true, refreshKeptAttempt: true, safeEvents: true }, null, 2) + "\n");
  console.log("8/8 dashboard browser checks PASS");
} finally { try { await browser?.close(); } finally { await service.close(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(home, { recursive: true, force: true }); } }
