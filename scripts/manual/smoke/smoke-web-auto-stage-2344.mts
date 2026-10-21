/** #2344 item 6: private web-only Settings smoke. No fleet, backend, CLI, tmux, or cloudflared starts. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const repo = resolve(process.env.REPO || process.cwd()), out = resolve(process.env.OUT || join(repo, ".artifacts/web-auto-stage-2344"));
const scratch = mkdtempSync(join(tmpdir(), "agend-web-auto-stage-2344-")); process.env.AGEND_HOME = scratch;
mkdirSync(out, { recursive: true });
const { TmuxManager } = await import(repo + "/src/tmux-manager.ts");
for (const target of [TmuxManager, TmuxManager.prototype]) for (const name of Object.getOwnPropertyNames(target)) {
  const d = Object.getOwnPropertyDescriptor(target, name);
  if (name !== "constructor" && typeof d?.value === "function") Object.defineProperty(target, name, { ...d, value() { throw Error(`smoke forbids tmux ${name}`); } });
}
const { InstanceLifecycle } = await import(repo + "/src/instance-lifecycle.ts");
for (const name of Object.getOwnPropertyNames(InstanceLifecycle.prototype)) if (/^(?:start|spawn|restart|wake|stop|pause|resume|launch|reconcile)/i.test(name) && typeof InstanceLifecycle.prototype[name] === "function") InstanceLifecycle.prototype[name] = () => { throw Error(`smoke forbids lifecycle ${name}`); };
const { FleetManager } = await import(repo + "/src/fleet-manager.ts");
for (const name of Object.getOwnPropertyNames(FleetManager.prototype)) if ((name === "loadConfig" || /^(?:start|spawn|restart|wake|stop|pause|resume|launch|reconcile)/i.test(name)) && !["startHealthServer", "startPreviewListener", "stopPreviewListener"].includes(name) && typeof FleetManager.prototype[name] === "function") FleetManager.prototype[name] = () => { throw Error(`smoke forbids fleet ${name}`); };
const { tokenEpoch } = await import(repo + "/src/web-session.ts");
const pw = createRequire((process.env.PW_DIR || "/home/han/.cache/agend-smoke/pw") + "/")("playwright-core");
const port = Number(process.env.HP || 48770);
for (const value of [port, port + 1]) await new Promise<void>((done, fail) => { const s = createServer(); s.once("error", fail); s.listen(value, "127.0.0.1", () => s.close(() => done())); });
let fm: any, browser: any, page: any;
const writes: any[] = [], approved: string[] = [], pageErrors: string[] = [], externalRequests: string[] = [], results: any = {};
try {
  fm = new FleetManager(scratch); const quiet = () => {};
  fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  fm.lifecycle = { daemons: new Map(), isPaused: () => false, hasWorkLease: () => false };
  fm.fleetConfig = { defaults: { locale: "en" }, instances: {}, channels: [], web: { preview_port: port + 1, public_link: { hostname: "old.example.com", tunnel_token_env: "SYNTHETIC_CONNECTOR" } } };
  fm.configPath = join(scratch, "fleet.yaml"); fm.savedFleetConfigSnapshot = structuredClone(fm.fleetConfig); fm.rawFleetConfig = structuredClone(fm.fleetConfig);
  writeFileSync(fm.configPath, JSON.stringify(fm.fleetConfig));
  fm.getUiStatus = () => ({ instances: [], uptime: 1, connections: 0, version: "private-smoke" });
  // Only the owned memory store is approved, without a real human receipt or General. Actual proposal, replay,
  // settings validation and disk save remain production paths. No real tunnel is opened by editing this config.
  fm.promptSettingsChange = async (store: any, view: any) => {
    assert.equal(view.source, "web_session"); assert.equal(view.state, "pending");
    const decided = await store.decide(view.id, "confirm", { label: "private smoke approval", current: () => true });
    approved.push(decided.state); assert.equal(decided.state, "applied");
  };
  // The client runner's final reconcile is inert; production lifecycle methods above deliberately reject starts.
  fm.startSettingsApply = (key: string) => ({ reused: false, job: { id: "private-web-apply", status: "done", targets: [], idempotency_key: key } });
  fm.initializeWebAuthTokens(); fm.startHealthServer(port);
  await new Promise<void>((done, fail) => { let n = 0; const timer = setInterval(() => { if (fm.healthServerListening && fm.previewListening) { clearInterval(timer); done(); } else if (++n > 200) { clearInterval(timer); fail(Error("private listeners did not bind")); } }, 25); });
  assert.equal(fm.healthServer.address().address, "127.0.0.1");
  browser = await pw.chromium.launch({ executablePath: process.env.CHROME || "/home/han/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome", args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, colorScheme: "dark" });
  const base = `http://127.0.0.1:${port}`;
  await context.route("**/*", async (route: any) => { const u = new URL(route.request().url()); if (u.origin === base || u.origin === `http://127.0.0.1:${port + 1}` || ["blob:", "data:"].includes(u.protocol)) return route.continue(); externalRequests.push(u.origin); await route.abort(); });
  await context.addInitScript(() => { try { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); } catch {} });
  page = await context.newPage(); page.on("pageerror", (error: any) => pageErrors.push(String(error)));
  page.on("request", (request: any) => { const path = new URL(request.url()).pathname; if (request.method() !== "GET" && path.startsWith("/api/settings")) writes.push({ method: request.method(), path, body: request.postDataJSON() }); });
  fm.initializeWebSessions(); const code = fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fm.webToken) }).display;
  await page.goto(base + "/signin"); await page.fill("#code", code); await page.click("#go"); await page.waitForURL(base + "/ui");
  await page.goto(base + "/settings/web"); await page.waitForSelector("#publicWebHostname"); await page.waitForTimeout(200);
  assert.equal(await page.locator(".s-pending").count(), 0); assert.deepEqual(writes, []);
  await page.fill("#publicWebHostname", "chat.example.com"); await page.waitForSelector(".s-pending");
  assert.equal(await page.locator(".s-pending").count(), 1); assert.deepEqual(writes, []);
  // A real Settings section round trip must retain the visible draft as well as the bar. A later edit merges with
  // that pending hostname rather than silently replacing it with the old value still on disk.
  await page.locator('a[href="/settings/general"]').click(); await page.waitForURL(base + "/settings/general");
  await page.locator('a[href="/settings/web"]').click(); await page.waitForURL(base + "/settings/web"); await page.waitForSelector("#publicWebHostname");
  assert.equal(await page.inputValue("#publicWebHostname"), "chat.example.com"); await page.fill("#publicWebOriginPort", "19300");
  assert.equal(await page.locator(".s-pending").count(), 1); assert.deepEqual(writes, []);
  await page.locator("#publicWebHostname").evaluate((element: HTMLElement) => element.scrollIntoView({ block: "center" })); await page.screenshot({ path: join(out, "hostname-auto-staged.png"), fullPage: true });
  results.stagedWithoutReview = { pending: await page.locator(".s-pending").innerText(), writesBeforeApply: writes.length, draftRestoredAfterSettingsNavigation: true };
  await page.fill("#publicWebTtl", "999"); await page.waitForFunction(() => !document.querySelector(".s-pending")); assert.equal(await page.locator("#publicWebTtl").getAttribute("class"), "invalid"); assert.deepEqual(writes, []);
  await page.screenshot({ path: join(out, "invalid-unstaged.png"), fullPage: true });
  await page.fill("#publicWebTtl", "90"); await page.waitForSelector(".s-pending"); assert.deepEqual(writes, []);
  await page.locator('.s-pending button').filter({ hasText: "Apply changes" }).click();
  await page.waitForFunction(() => !(document.querySelector(".s-pending")) && (document.querySelector("#publicWebHostname") as HTMLInputElement)?.value === "chat.example.com");
  for (let n = 0; n < 100 && writes.length < 2; n++) await page.waitForTimeout(50);
  assert.deepEqual(writes.map(x => [x.method, x.path]), [["PUT", "/api/settings/fleet/web"], ["POST", "/api/settings/apply"]]);
  assert.deepEqual(writes[0].body, { public_link: { hostname: "chat.example.com", origin_port: 19300, ttl_minutes: 90 } });
  assert.equal(fm.fleetConfig.web.public_link.tunnel_token_env, "SYNTHETIC_CONNECTOR"); assert.match(readFileSync(fm.configPath, "utf8"), /chat\.example\.com/);
  assert.deepEqual(approved, ["applied"]); assert.deepEqual(pageErrors, []); assert.deepEqual(externalRequests, []);
  results.saved = { writes, approved, customReferencePreserved: true }; await page.screenshot({ path: join(out, "saved.png"), fullPage: true });
  writeFileSync(join(out, "results.json"), JSON.stringify({ results, pageErrors, externalRequests }, null, 2)); console.log(JSON.stringify(results));
} catch (error) {
  writeFileSync(join(out, "failure.json"), JSON.stringify({ error: String(error), results, writes, approved, pageErrors, externalRequests, text: await page?.locator("body").innerText().catch(() => null) }, null, 2));
  await page?.screenshot({ path: join(out, "failure.png"), fullPage: true }).catch(() => {}); throw error;
} finally {
  await browser?.close(); if (fm?.healthServer) await new Promise<void>(done => { fm.healthServer.closeAllConnections?.(); fm.healthServer.close(() => done()); });
  await fm?.stopPreviewListener?.(); rmSync(scratch, { recursive: true, force: true });
}
