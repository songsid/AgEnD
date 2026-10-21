/** #2275: scratch web-only browser smoke. No fleet.start/loadConfig/reconcile/backend/tmux execution. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { SNOW_EFFECT } from "../smoke-fixture/seed.mts";
const repo = resolve(process.env.REPO || process.cwd()), out = resolve(process.env.OUT || join(repo, ".artifacts/cw-smoke"));
process.env.REPO = repo;
const scratch = mkdtempSync(join(tmpdir(), "agend-cw-2275-")); process.env.AGEND_HOME = scratch;
mkdirSync(out, { recursive: true });
// Refuse every tmux access before FleetManager is even imported/constructed.
const { TmuxManager } = await import(repo + "/src/tmux-manager.ts");
for (const target of [TmuxManager, TmuxManager.prototype]) for (const name of Object.getOwnPropertyNames(target)) {
  const d = Object.getOwnPropertyDescriptor(target, name);
  if (name !== "constructor" && typeof d?.value === "function") Object.defineProperty(target, name, { ...d, value() { throw Error(`smoke forbids tmux ${name}`); } });
}
const { InstanceLifecycle } = await import(repo + "/src/instance-lifecycle.ts");
for (const name of Object.getOwnPropertyNames(InstanceLifecycle.prototype)) if (/^(?:start|spawn|restart|wake|stop|pause|resume|launch|reconcile)/i.test(name) && typeof InstanceLifecycle.prototype[name] === "function") InstanceLifecycle.prototype[name] = () => { throw Error(`smoke forbids lifecycle ${name}`); };
const { FleetManager } = await import(repo + "/src/fleet-manager.ts");
for (const name of Object.getOwnPropertyNames(FleetManager.prototype)) if ((name === "loadConfig" || /^(?:start|spawn|restart|wake|stop|pause|resume|launch|reconcile)/i.test(name)) && !["startHealthServer", "startPreviewListener", "stopPreviewListener"].includes(name) && typeof FleetManager.prototype[name] === "function") FleetManager.prototype[name] = () => { throw Error(`smoke forbids fleet ${name}`); };
FleetManager.prototype.getPaneContextSource = () => null;
FleetManager.prototype.getInstanceStatus = () => "running";
const { tokenEpoch } = await import(repo + "/src/web-session.ts");
const { checkAmbient } = await import(repo + "/src/web-ambient.ts");
const pw = createRequire((process.env.PW_DIR || "/home/han/.cache/agend-smoke/pw") + "/")("playwright-core");
const port = Number(process.env.HP || 48760);
for (const value of [port, port + 1]) await new Promise<void>((done, fail) => { const s = createServer(); s.once("error", fail); s.listen(value, "127.0.0.1", () => s.close(() => done())); });
let fm: any, browser: any, publicLink: any, debugPage: any;
const allRequests: string[] = [], errors: string[] = [], networkViolations: string[] = [], workers: string[] = [], results: any = {};
const approvedChanges: Array<{ id: string; state: string }> = [];
const cwPath = (url: string) => /\/(?:assets\/(?:effect-[^/]+|owner-effect-prefs|display-metadata)\.js|ui\/js\/(?:app-effects|chat-effects|chat-effect-posters|effect-trial[^/]*|effects-waker|settings-effects|settings-owner-effects)\.js|effect-bootstrap|ui\/(?:effects|effect-trials))\b/.test(url);
try {
  fm = new FleetManager(scratch);
  const quiet = () => {}; fm.logger = { info: quiet, warn: quiet, error: quiet, debug: quiet, trace: quiet, fatal: quiet, child: () => fm.logger };
  fm.notifyFleetError = () => true;
  fm.lifecycle = { daemons: new Map(), isPaused: () => false, hasWorkLease: () => false };
  fm.fleetConfig = { health_port: port, instances: { demo: { working_directory: scratch, backend: "claude-code" } }, web: { preview_port: port + 1, experimental: { canvas_worker: false } } };
  writeFileSync(join(scratch, "fleet.yaml"), `health_port: ${port}\ninstances:\n  demo:\n    working_directory: ${JSON.stringify(scratch)}\n    backend: claude-code\nweb:\n  preview_port: ${port + 1}\n  experimental:\n    canvas_worker: false\n`);
  fm.configPath = join(scratch, "fleet.yaml"); fm.savedFleetConfigSnapshot = structuredClone(fm.fleetConfig); fm.rawFleetConfig = structuredClone(fm.fleetConfig);
  // Private authority seam only: no General, human receipt, CLI, or real fleet is involved. The browser still uses
  // the actual HTTP proposal, captured local-admin capability, baseline/replay, and production settings handler.
  fm.promptSettingsChange = async (store: any, view: any) => {
    assert.equal(view.source, "web_session"); assert.equal(view.state, "pending");
    const decided = await store.decide(view.id, "confirm", { label: "private smoke approval", current: () => true });
    approvedChanges.push({ id: view.id, state: decided.state }); assert.equal(decided.state, "applied");
  };
  fm.getUiStatus = () => ({ instances: [{ name: "demo", display_name: "Experimental effects demo", status: "running", state: "idle", backend: "claude-code", effect_chat_v: createHash("sha256").update(JSON.stringify(fm.themeStore.get("demo").placements.effects)).digest("hex").slice(0, 32) }], uptime: 1, connections: 1, themes_rev: fm.themeStore.rev(), prefs_rev: fm.webPrefs.rev(), canvas_worker: fm.canvasWorkerEnabled() });
  fm.initializeWebAuthTokens(); fm.startHealthServer(port);
  await new Promise<void>((done, fail) => { let n = 0; const t = setInterval(() => { if (fm.healthServerListening && fm.previewListening) { clearInterval(t); done(); } else if (++n > 200) { clearInterval(t); fail(Error("private listener did not bind")); } }, 25); });
  assert.equal(fm.healthServer.address().address, "127.0.0.1"); assert.equal(fm.healthServer.address().port, port);
  const files = new Map([["effect.json", Buffer.from(JSON.stringify(SNOW_EFFECT.manifest))], ["worker.js", Buffer.from(SNOW_EFFECT.worker)], ["poster.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64")]]);
  const staged = fm.effectLibrary.stage(files, { kind: "human", id: "operator" }); assert.equal(staged.ok, true); const committed = fm.effectLibrary.commit(staged.stageId); assert.equal(committed.ok, true); const id = committed.ids[0];
  assert.equal(fm.themeStore.setPlacements("demo", { effects: [id] }, "human", () => null).ok, true);
  const ambient = checkAmbient({ preset: "fall", glyphs: ["🌸", "✿"], count: 8 }); assert.equal(ambient.ok, true); assert.equal(fm.themeStore.setAmbient("demo", ambient.value, "human").ok, true);
  fm.webPrefs.write("operator", new Map([["fx.page", id], ["theme", "dark"], ["lang", "en"]]));
  fm.webChatHistory.record({ instance: "demo", role: "agent", sender: "demo", text: "Welcome to the demo chat. Falling petals add a quiet touch to this conversation.", ts: new Date().toISOString() });
  fm.webChatHistory.recordEffectTrial("demo", { v: 1, offer: "a".repeat(32), id, title: "Saved trial offer", expiresAt: Date.now() + 600000 }, new Date().toISOString());
  const saved = JSON.stringify({ placements: fm.themeStore.get("demo").placements, ownerSlot: fm.webPrefs.read("operator").values["fx.page"] });
  browser = await pw.chromium.launch({ executablePath: process.env.CHROME || "/home/han/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome", args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, colorScheme: "dark", reducedMotion: "no-preference" });
  await context.route("**/*", async (route: any) => { const u = new URL(route.request().url()); if ([`http://127.0.0.1:${port}`, `http://127.0.0.1:${port + 1}`].includes(u.origin) || ["blob:", "data:"].includes(u.protocol)) return route.continue(); networkViolations.push(u.origin); await route.abort(); });
  await context.addInitScript(() => { try { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); } catch { /* opaque effect frames have no storage */ } (window as any).__cwWorkers = 0; const Native = window.Worker; window.Worker = class extends Native { constructor(...args: any[]) { (window as any).__cwWorkers++; super(...args); } } as any; });
  const page = await context.newPage(); debugPage = page; page.on("worker", (worker: any) => workers.push(worker.url())); page.on("request", (request: any) => allRequests.push(request.url())); page.on("pageerror", (error: any) => errors.push(String(error)));
  const base = `http://127.0.0.1:${port}`;
  fm.initializeWebSessions(); const code = fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fm.webToken) }).display;
  await page.goto(base + "/signin"); await page.fill("#code", code); await page.click("#go"); await page.waitForURL(base + "/ui");
  await page.goto(base + "/ui/chat/demo"); await page.waitForSelector(".p-chat .amb-layer .amb-p", { timeout: 30000 });
  await page.waitForTimeout(700);
  const snapshot = async () => page.evaluate(() => ({ frames: document.querySelectorAll("iframe.agend-effect-frame").length, layers: document.querySelectorAll(".agend-effect-layer").length, posters: document.querySelectorAll(".agend-effect-poster").length, trials: document.querySelectorAll(".effect-trial-offer").length, ambient: document.querySelectorAll(".amb-p").length, parentWorkerConstructions: (window as any).__cwWorkers }));
  results.off = { ...await snapshot(), cwRequests: allRequests.filter(cwPath) }; assert.equal(results.off.cwRequests.length, 0); assert.equal(results.off.parentWorkerConstructions, 0); assert.equal(workers.length, 0); assert.equal(results.off.trials, 0); assert.equal(results.off.frames, 0); assert.ok(results.off.ambient > 0);
  await page.screenshot({ path: join(out, "off-chat.png"), fullPage: true });
  // Keep the chat page mounted throughout both episodes. A second tab drives the actual Settings control and
  // server confirmation path; no direct config mutation or artificial status event performs these three toggles.
  const settingsPage = await context.newPage();
  settingsPage.on("request", (request: any) => allRequests.push(request.url())); settingsPage.on("pageerror", (error: any) => errors.push(String(error)));
  await settingsPage.goto(base + "/settings/appearance"); await settingsPage.waitForSelector(".s-experimental-effects input");
  assert.equal(await settingsPage.locator(".s-effects").count(), 0); await settingsPage.screenshot({ path: join(out, "off-settings.png"), fullPage: true });
  await settingsPage.locator(".s-experimental-effects").scrollIntoViewIfNeeded(); await settingsPage.locator(".s-experimental-effects").screenshot({ path: join(out, "off-controls.png") });
  const chatDocument = await page.evaluate(() => { (window as any).__smokeThread = document.querySelector(".thread"); return location.href; });
  const toggle = async (value: boolean) => {
    const before = approvedChanges.length, checkbox = settingsPage.locator(".s-experimental-effects input");
    assert.equal(await checkbox.isChecked(), !value); await checkbox.click(); await settingsPage.waitForFunction(() => !(document.querySelector(".s-experimental-effects input") as HTMLInputElement)?.disabled);
    if (value) {
      for (let n = 0; n < 100 && approvedChanges.length === before; n++) await settingsPage.waitForTimeout(50);
      assert.equal(approvedChanges.length, before + 1); assert.equal(approvedChanges.at(-1)?.state, "applied");
    } else assert.equal(approvedChanges.length, before); // narrowing applies immediately through the same handler
    assert.equal(fm.canvasWorkerEnabled(), value); assert.match(readFileSync(fm.configPath, "utf8"), new RegExp(`canvas_worker: ${value}`));
    assert.equal(await checkbox.isChecked(), value); assert.equal(await settingsPage.locator('.s-experimental-effects [role="alert"]').count(), 0);
  };
  await toggle(true); await page.waitForSelector(".effect-trial-offer .effect-trial-start");
  await page.waitForFunction(() => document.querySelectorAll("iframe.agend-effect-frame").length > 0, { timeout: 30000 });
  for (let n = 0; n < 100 && !workers.length; n++) await page.waitForTimeout(50); assert.ok(workers.length > 0, "on must create a real isolated Worker"); await page.waitForTimeout(300);
  results.on = { ...await snapshot(), workerEvents: workers.length, usableTry: await page.locator(".effect-trial-start").isEnabled() };
  assert.ok(results.on.frames > 0); assert.ok(results.on.ambient > 0); assert.equal(results.on.usableTry, true); await page.screenshot({ path: join(out, "on-chat.png"), fullPage: true });
  await toggle(false); await page.waitForFunction(() => !document.querySelector("iframe.agend-effect-frame,.agend-effect-layer,.effect-trial-offer")); results.disabled = await snapshot(); assert.ok(results.disabled.ambient > 0);
  const oldWorkerEvents = workers.length; await toggle(true);
  await page.waitForSelector(".effect-trial-offer .effect-trial-start"); await page.waitForFunction(() => document.querySelectorAll("iframe.agend-effect-frame").length > 0);
  for (let n = 0; n < 100 && workers.length <= oldWorkerEvents; n++) await page.waitForTimeout(50); assert.ok(workers.length > oldWorkerEvents, "restoring must create a fresh real Worker");
  results.restored = { ...await snapshot(), workerEvents: workers.length, usableTry: await page.locator(".effect-trial-start").isEnabled(), sameThread: await page.evaluate(() => (window as any).__smokeThread === document.querySelector(".thread")) };
  assert.equal(results.restored.usableTry, true); assert.equal(results.restored.sameThread, true); assert.equal(page.url(), chatDocument);
  assert.doesNotMatch(await page.locator(".effect-trial-offer").innerText(), /Checking this session/);
  await page.screenshot({ path: join(out, "restored-chat.png"), fullPage: true });
  await settingsPage.waitForSelector(".s-effects"); await settingsPage.screenshot({ path: join(out, "on-settings.png"), fullPage: true });
  await settingsPage.locator(".s-experimental-effects").scrollIntoViewIfNeeded(); await settingsPage.locator(".s-experimental-effects").screenshot({ path: join(out, "on-controls.png") });
  await settingsPage.locator(".s-effects").scrollIntoViewIfNeeded(); await settingsPage.locator(".s-effects").screenshot({ path: join(out, "on-library.png") });
  assert.equal(approvedChanges.length, 2); results.confirmedChanges = approvedChanges; await settingsPage.close();
  assert.equal(saved, JSON.stringify({ placements: fm.themeStore.get("demo").placements, ownerSlot: fm.webPrefs.read("operator").values["fx.page"] })); assert.deepEqual(errors, []); assert.deepEqual(networkViolations, []);
  // A true guest session, with channel scope inertly supplied by this web-only fixture.
  fm.fleetConfig.web.experimental.canvas_worker = false; fm.fleetConfig.web.guests = { enabled: true };
  fm.guestScope = () => new Set(["demo"]); fm.guestCurrent = () => true;
  const guest = fm.webSessions.create({ tier: "guest", surface: "local", label: "Smoke guest", tokenEpoch: tokenEpoch(fm.webToken), owner: { adapterId: "demo", userId: "guest" } });
  const guestContext = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await guestContext.addCookies([{ name: "agend_session", value: guest.sessionId, url: base }]);
  await guestContext.route("**/*", async (route: any) => { const u = new URL(route.request().url()); if (u.origin === base || u.origin === `http://127.0.0.1:${port + 1}` || ["blob:", "data:"].includes(u.protocol)) return route.continue(); networkViolations.push(u.origin); await route.abort(); });
  const guestPage = await guestContext.newPage(), guestRequests: string[] = [];
  guestPage.on("request", (request: any) => guestRequests.push(request.url()));
  await guestPage.goto(base + "/ui/chat/demo"); await guestPage.waitForSelector(".p-chat"); await guestPage.waitForTimeout(500);
  assert.equal(await guestPage.locator("body").getAttribute("data-tier"), "guest"); assert.equal(guestRequests.filter(cwPath).length, 0); assert.equal(await guestPage.locator(".effect-trial-offer,.agend-effect-layer").count(), 0);
  results.guestOff = { cwRequests: guestRequests.filter(cwPath) }; await guestPage.screenshot({ path: join(out, "off-guest.png"), fullPage: true }); await guestContext.close();
  // Real private public gateway; only its tunnel provider and HTTPS transport are modeled. No cloudflared call.
  for (const key of Object.keys(fm.webPrefs.readForViewer(null).values)) fm.webPrefs.write("operator", new Map([[key, null]]));
  const { openPublicLink } = await import("../smoke-fixture/from-defaults.mts");
  publicLink = await openPublicLink({ fm, browser });
  const publicRequests: string[] = [];
  const publicPage = await publicLink.publicPage({ device: "desk", theme: "light", lang: "en" }, { path: "/ui/chat/demo", beforeNavigate: async (ctx: any, page: any) => { await ctx.route("**/*", async (route: any) => { const u = new URL(route.request().url()); if (u.origin === `https://${publicLink.host}`) return route.fallback(); if ([base, `http://127.0.0.1:${port + 1}`].includes(u.origin) || ["blob:", "data:"].includes(u.protocol)) return route.continue(); networkViolations.push(u.origin); await route.abort(); }); page.on("request", (request: any) => publicRequests.push(request.url())); } });
  await publicPage.page.waitForSelector(".p-chat"); await publicPage.page.waitForTimeout(500);
  assert.equal(await publicPage.page.locator("body").getAttribute("data-public-link"), "1"); assert.equal(publicRequests.filter(cwPath).length, 0); assert.equal(await publicPage.page.locator(".effect-trial-offer,.agend-effect-layer").count(), 0);
  results.publicOff = { cwRequests: publicRequests.filter(cwPath) }; await publicPage.page.screenshot({ path: join(out, "off-public.png"), fullPage: true }); await publicPage.ctx.close();
  assert.deepEqual(networkViolations, []);
  writeFileSync(join(out, "results.json"), JSON.stringify({ results, errors, networkViolations, workers, allRequests }, null, 2)); console.log(JSON.stringify(results));
} catch (error) {
  writeFileSync(join(out, "failure.json"), JSON.stringify({ error: String(error), results, errors, workers, networkViolations, allRequests, state: await debugPage?.evaluate(() => ({ text: document.body.innerText, data: { ...document.body.dataset }, nodes: [...document.querySelectorAll(".fx-row,.chat-fx-notice")].map(e => e.textContent), marked: [...document.querySelectorAll("[data-trust]")].map(e => e.outerHTML.slice(0, 450)) })).catch(() => null) }, null, 2));
  await debugPage?.screenshot({ path: join(out, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await publicLink?.close();
  await browser?.close();
  if (fm?.healthServer) await new Promise<void>(done => { fm.healthServer.closeAllConnections?.(); fm.healthServer.close(() => done()); });
  await fm?.stopPreviewListener?.(); await fm?.webChatHistory?.flush?.();
  rmSync(scratch, { recursive: true, force: true });
}
