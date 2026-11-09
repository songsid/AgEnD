/** One owned scratch rig, real Hub HTTPS + fleet HTTP/D3, inert directory, actual durable decision/notice APIs. */
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import Database from "better-sqlite3";
const REPO = process.env.REPO ?? process.cwd(), OUT = process.env.OUT ?? join(REPO, ".artifacts/directory-notice-ui");
mkdirSync(OUT, { recursive: true });
const home = mkdtempSync(join(tmpdir(), "hub-notice-ui-")); process.env.AGEND_HOME = home;
const { FleetManager } = await import(REPO + "/src/fleet-manager.ts");
const { HubRuntime } = await import(REPO + "/src/hub/runtime.ts");
const { createHubInitializer } = await import(REPO + "/src/hub/init/initializer.ts");
const { hubIdentityProvider } = await import(REPO + "/src/hub/init/identity.ts");
const { createHubSettingsWriter } = await import(REPO + "/src/hub/settings-commit.ts");
const { atomicWriteFileSync } = await import(REPO + "/src/atomic-write.ts");
const { ADMIN, makeTestCerts } = await import(REPO + "/tests/support/hub-init-fixtures.ts");
const { freeHubPort } = await import(REPO + "/tests/helpers/hub-rig.ts");
const pw = createRequire(join(process.env.PW_DIR ?? join(REPO, ".artifacts/browser-deps"), "package.json"))("playwright-core");
const browser = await pw.chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox", "--no-proxy-server", "--host-resolver-rules=MAP hub.example.test 127.0.0.1"] });
const certs = makeTestCerts(), checks: Record<string, unknown> = {}, contexts: any[] = [];
let runtime: any, fm: any;
const check = (name: string, ok: boolean, detail?: unknown) => { checks[name] = ok ? "PASS" : { FAIL: detail }; if (!ok) throw Error(name + ": " + JSON.stringify(detail)); };
const inspect = (sql: string, ...args: any[]) => { const db = new Database(join(home, "hub/hub.sqlite")); try { return db.prepare(sql).all(...args); } finally { db.close(); } };
try {
  const webPort = await freeHubPort(); let memberPort = await freeHubPort(); while (memberPort === webPort) memberPort = await freeHubPort();
  const origin = `https://hub.example.test:${webPort}`, configPath = join(home, "fleet.yaml");
  const plan = { name: "Fictional Hub", webOrigin: origin, memberOrigin: `https://127.0.0.1:${memberPort}`,
    webListen: { host: "127.0.0.1", port: webPort }, memberListen: { host: "127.0.0.1", port: memberPort }, webTls: { certFile: certs.cert, keyFile: certs.key },
    directory: { realm: "corp", url: "ldaps://directory.example.test:636", baseDn: "DC=example,DC=test", bindDn: "CN=Reader,DC=example,DC=test", profile: "ad" },
    bindPasswordRef: "file:hub/secrets/directory-bind", administrator: ADMIN.key, retention: { contentDays: 30, eventDays: 90 }, coexistence: "dedicated" };
  const init = createHubInitializer({ home, identity: hubIdentityProvider(), probe: { pidAlive: () => false } });
  const confirmation = await init.prepareConfirmation(plan, { bindPassword: "Dummy-service-only" }); await init.commit(plan, confirmation.reference);
  const config: any = yaml.load(readFileSync(configPath, "utf8")); config.web = { preview: false, verified_authority: { enabled: true } }; writeFileSync(configPath, yaml.dump(config), { mode: 0o600 });
  const writer = createHubSettingsWriter({ home, readHub: () => config.hub, directoryDecision: () => runtime.directoryDecision(), saveHub: (patches: any[]) => {
    for (const patch of patches) { if (patch.remove) delete config.hub[patch.path[1]]; else config.hub[patch.path[1]] = patch.value; }
    atomicWriteFileSync(configPath, yaml.dump(config), { mode: 0o600 });
  } });
  runtime = new HubRuntime({ home, settingsWriter: writer, log: () => {}, createDirectory: () => ({ realm: "corp",
    signIn: async (login: string, password: string) => login === "avery" && password === "Dummy-person-only" ? { ok: true, person: { ...ADMIN, login: "avery", displayName: "Avery" } } : { ok: false, reason: "invalid-credentials" },
    checkEligibility: async () => ({ eligible: true, person: { ...ADMIN, login: "avery", displayName: "Avery" } }), close: async () => {} }) });
  await runtime.apply(config); check("initial-mount", runtime.serverHealth(config.hub) === "ready");
  fm = new FleetManager(home); const noop = () => {}; fm.logger = { info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop, child: () => fm.logger };
  fm.loadConfig(configPath); fm.initializeWebAuthTokens(); fm.startHealthServer(0);
  while (!fm.getDashboardAccess().ready) await new Promise(resolve => setTimeout(resolve, 10));
  const hostOrigin = `http://127.0.0.1:${fm.healthServer.address().port}`;
  const api = await browser.newContext({ ignoreHTTPSErrors: true }); contexts.push(api);
  const issue = await api.request.post(hostOrigin + "/auth/issue-code", { headers: { "x-agend-token": fm.getDashboardAccess().token, origin: hostOrigin } });
  const login = await api.request.post(hostOrigin + "/auth/login", { headers: { origin: hostOrigin }, data: { code: (await issue.json()).code } }); check("host-d3-login", login.status() === 200);
  const hostCookies = await api.cookies();
  const cases = [ ["desktop", "en", 1440, 1000], ["phone", "en", 390, 844], ["desktop", "zh-TW", 1440, 1000], ["phone", "zh-TW", 390, 844] ] as const;
  for (const [device, lang, width, height] of cases) {
    const tag = `${device}-${lang}`, actor = { kind: "host-owner", sessionId: "owned-browser-fixture", requestId: randomUUID() }, mounted = runtime.directorySettings();
    const draft = writer.directory.prepare({ directory: { ...plan.directory, url: `ldaps://change-${tag.toLowerCase()}.example.test:636` }, bindPassword: "Dummy-service-only",
      changes: ["server", "ca", "search", "service-account", "secret", "query"], recipients: [{ kind: "host", sink: "owner-needs-you" }, { kind: "person", person: ADMIN.key }] }, actor, mounted.current);
    const saved = writer.directory.commit(draft.ref, actor, mounted.current); await runtime.apply(config); check(tag + ":mount", runtime.serverHealth(config.hub) === "ready");
    const id = (inspect("SELECT id FROM hub_settings_security_notices WHERE operation_id=?", saved.receiptId)[0] as any)?.id
      ?? (inspect("SELECT id FROM hub_settings_security_notices ORDER BY rowid DESC LIMIT 1")[0] as any).id;
    const ctx = await browser.newContext({ viewport: { width, height }, ignoreHTTPSErrors: true, locale: lang, isMobile: device === "phone", hasTouch: device === "phone" }); contexts.push(ctx);
    await ctx.addCookies(hostCookies); await ctx.addInitScript(({ lang }: any) => { localStorage.setItem("agend_lang", lang); localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); localStorage.setItem("agend_usage_rail", "0"); }, { lang });
    fm.webPrefs.write("operator", new Map([["lang", lang], ["theme", "light"]]));
    const page = await ctx.newPage(), errors: string[] = [], requests: string[] = [];
    page.on("pageerror", (e: Error) => errors.push(e.message)); page.on("request", (r: any) => { if (r.url().includes("security-notices/directory")) requests.push(r.method() + " " + new URL(r.url()).pathname); });
    await page.goto(hostOrigin + "/ui/needs"); await page.locator(`[data-directory-notice="${id}"]`).waitFor(); await page.waitForTimeout(150);
    check(tag + ":host-shell", await page.locator("#sidebar").count() === 1 && await page.locator(".p-needs").count() === 1);
    check(tag + ":host-unacknowledged", (inspect("SELECT state FROM hub_settings_security_targets WHERE notice_id=? AND kind='host'", id)[0] as any).state === "queued");
    await page.screenshot({ path: join(OUT, `${tag}-host.png`), fullPage: true });
    await page.locator(`[data-directory-notice="${id}"] button`).click(); await page.locator(`[data-directory-notice="${id}"] button`).waitFor({ state: "detached" });
    check(tag + ":host-exact-ack", (inspect("SELECT state FROM hub_settings_security_targets WHERE notice_id=? AND kind='host'", id)[0] as any).state === "delivered");
    check(tag + ":person-still-unread", (inspect("SELECT state FROM hub_settings_security_targets WHERE notice_id=? AND kind='person'", id)[0] as any).state === "queued");
    await page.goto(origin + "/ui/hub?view=notices"); await page.locator("#hubLogin").fill("avery"); await page.locator("#hubPassword").fill("Dummy-person-only"); await page.locator(".hub-signin-go").click();
    await page.locator(`[data-directory-notice="${id}"]`).waitFor(); await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    check(tag + ":hub-no-overflow", !overflow); check(tag + ":hub-shell", await page.locator(".p-hub-notices .panel-head").count() === 1);
    await page.screenshot({ path: join(OUT, `${tag}-hub.png`), fullPage: true });
    await page.locator(`[data-directory-notice="${id}"] button`).click(); await page.locator(`[data-directory-notice="${id}"] button`).waitFor({ state: "detached" });
    check(tag + ":person-exact-ack", (inspect("SELECT state FROM hub_settings_security_targets WHERE notice_id=? AND kind='person'", id)[0] as any).state === "delivered");
    check(tag + ":no-page-errors", errors.length === 0, errors); check(tag + ":one-read-each", requests.filter(r => r.startsWith("GET ")).length === 2, requests);
    await ctx.close(); contexts.splice(contexts.indexOf(ctx), 1);
  }
  // Retained-shell skew: stripping only the display mark must not cause any host notice request.
  const stale = await browser.newContext(); contexts.push(stale); await stale.addCookies(hostCookies);
  const page = await stale.newPage(); let calls = 0;
  page.on("request", (r: any) => { if (r.url().includes("security-notices/directory")) calls++; });
  await page.route(hostOrigin + "/ui/needs", async (route: any) => { const response = await route.fetch(); await route.fulfill({ response, body: (await response.text()).replace(' data-hub-directory-notices="1"', "") }); });
  await page.goto(hostOrigin + "/ui/needs"); await page.locator(".p-needs").waitFor(); await page.waitForTimeout(200);
  check("skew-old-host-shell-no-private-read", calls === 0); await stale.close(); contexts.splice(contexts.indexOf(stale), 1);
} finally {
  for (const ctx of contexts) await ctx.close(); await browser.close();
  if (fm) { const preview = fm.previewListener?.server; const previewClosed = preview ? new Promise<void>(resolve => preview.once("close", resolve)) : Promise.resolve(); fm.stopPreviewListener(); await previewClosed; const server = fm.healthServer; fm.healthServer = null; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fm.webSessions?.flush?.(); }
  if (runtime) await runtime.close();
  rmSync(home, { recursive: true, force: true }); rmSync(certs.dir, { recursive: true, force: true }); checks.cleanup = !existsSync(home) && !existsSync(certs.dir) ? "PASS" : "FAIL";
  writeFileSync(join(OUT, "checks.json"), JSON.stringify({ limits: "Owned scratch HTTP/HTTPS and inert immutable directory only; no real AD/account/CLI/native/pilot/live fleet. API replies are never browser-stubbed; only old-shell skew changes HTML.", checks }, null, 2));
}
