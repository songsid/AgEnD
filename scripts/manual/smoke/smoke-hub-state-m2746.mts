// Real Settings shell + confirmed Run writer; publication response seam is scripted. Real Hub HTTPS/rooms/CSRF
// with synthetic directory and a controlled group-permit boundary. No CLI, account, fleet start or tmux.
import { mkdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { createServer } from "node:https";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { bootFixture, caseName, matrix } from "../smoke-fixture/index.mts";
const repo = process.env.REPO!, out = process.env.OUT!;
if (!repo || !out) throw Error("REPO / OUT required"); mkdirSync(out, { recursive: true });
const before = process.env.BEFORE === "1", skew = process.env.SKEW === "1", oldRef = process.env.OLD_REF || "v2.3.5-alpha.9";
const old = (file: string) => execFileSync("git", ["show", `${oldRef}:src/ui/${file}`], { encoding: "utf8" });
const records: string[] = [];
const fx = await bootFixture({ port: Number(process.env.FLEET_PORT || 49910), instances: 3, classic: false, host: true });
const { default: yaml } = await import(repo + "/node_modules/js-yaml/dist/js-yaml.mjs");
const yamlFile = join(fx.dir, "fleet.yaml"), base = readFileSync(yamlFile, "utf8"), agent = fx.instances[0]!.name;
const hubBlock = { enabled: true, hubId: randomUUID(), name: "Team Hub", webOrigin: "https://hub.example.test:8444", memberOrigin: "https://hub.example.test:8443", webListen: { host: "127.0.0.1", port: 8444 }, memberListen: { host: "127.0.0.1", port: 8443 } };
const { s3bRig } = await import(repo + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(repo + "/src/hub/tls.ts");
const { HubGroupAuthorizationError } = await import(repo + "/src/hub/group-policy/authorization.ts");
const hubPort = Number(process.env.HUB_PORT || 49920), origin = `https://127.0.0.1:${hubPort}`, rig = await s3bRig({ webOrigin: origin });
const keys = mkdtempSync(join(out, "keys-")); await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) }, (req, res) => { if (!rig.http.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(hubPort, "127.0.0.1", resolve); });
const owner = rig.addPerson("olivia", "Olivia Chen"), asker = rig.addPerson("alex", "Alex Lin"), fleetId = randomUUID(), exposureId = randomUUID();
const link = rig.link(fleetId, owner, 1, ["welcome-caps-v1", "quota-band-v1"]);
rig.store.mutate({ at: Date.now(), requestId: randomUUID(), actor: { kind: "local-host" }, action: "fixture.fleet", result: "completed" }, s => { s.fleets.push({ id: fleetId, owner, credentialHash: null, generation: 1, status: "active" }); });
await rig.http.receive(rig.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId, owner, displayName: "Team assistant", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link) as never, link);
await rig.http.receive(rig.frame("exposure.quota", { exposureId, quota: { band: "available" } }, link) as never, link);
await rig.signIn("alex"); const own = await rig.signIn("olivia");
const grant = await rig.call(own, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "alex", days: 7 });
if (grant.status !== 200) throw Error("fixture grant failed");
let deny = false;
const permit = async () => { if (deny) throw new HubGroupAuthorizationError("denied"); return { source: "legacy", assertCurrent() { if (deny) throw new HubGroupAuthorizationError("denied"); } }; };
rig.httpDeps.groups = { asker: permit, check: permit } as any;
async function prepare(page: any) {
  if (before) for (const name of ["settings-hub.js", "settings-hub-run.js", "settings-confirm.js", "panel-hub.js", "hub-chat-store.js"]) await page.route(`**/ui/js/${name}`, (r: any) => r.fulfill({ contentType: "text/javascript", body: old(name) }));
  if (skew) for (const name of ["app.css", "app-shell.js", "app-i18n.js"]) await page.route(`**/assets/${name}*`, (r: any) => r.fulfill({ contentType: name.endsWith("css") ? "text/css" : "text/javascript", body: old("shared/" + name) }));
}
async function shot(page: any, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) throw Error("overflow " + name);
  await page.screenshot({ path: join(out, name + ".png") }); records.push(name);
}
try {
  for (const c of matrix(process.env.MATRIX || "desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW")) {
    const tag = caseName(c), en = c.lang === "en"; deny = false;
    writeFileSync(yamlFile, base + yaml.dump({ hub: hubBlock, hub_member: { enabled: true } }));
    fx.fm.loadConfig(yamlFile, { remember: false });
    const { page, ctx, csp } = await fx.page(c); const errors: string[] = [];
    page.on("pageerror", (e: any) => errors.push(String(e))); await prepare(page);
    let published = false, submitted = false;
    const pendingId = "a".repeat(32);
    await page.route("**/api/hub/member/**", async (r: any) => {
      const u = new URL(r.request().url());
      if (u.pathname.endsWith("/pairing")) return r.fulfill({ json: { pairing: { state: "paired", link: "online", hub: { name: "Team Hub", webOrigin: origin, memberOrigin: origin, hubId: rig.hubId, fingerprint: { kind: "hub-key", digest: "a".repeat(64) } } } } });
      if (u.pathname.endsWith("/exposures") && r.request().method() === "GET") return r.fulfill({ json: { exposures: [{ agent, display: "Team assistant", enforceable: true, revision: published ? 1 : 0, state: published ? "published" : "private", pending: submitted && !published ? { expiresAt: Date.now() + 300000 } : null, ...(published ? { exposureId, policy: { dataView: "agent", tools: [] } } : {}) }] } });
      if (u.pathname.endsWith("/exposures") && r.request().method() === "POST") { submitted = true; return r.fulfill({ status: 202, json: { result: "pending_confirmation", pending_change: { id: pendingId, state: "pending", section: "access", summary: [], remaining_ms: 300000, expires_at: Date.now() + 300000, confirmation: { kind: "posting" } } } }); }
      return r.fallback();
    });
    await page.route(`**/api/settings/pending/${pendingId}`, async (r: any) => { published = true; return r.fulfill({ json: { id: pendingId, state: "applied", summary: [], confirmation: { kind: "web" }, outcome: { result: { ok: true } } } }); });
    await page.goto(fx.base + "/settings/hub"); await page.waitForSelector(".hub-exposure input");
    await page.locator(".hub-exposure input").click(); await page.waitForSelector(".hub-exposure.is-shared"); await page.waitForTimeout(250);
    if (!before && (await page.locator(".hub-exposures").innerText()).includes(en ? "Sent for confirmation" : "已送出確認")) throw Error("stale publication hint");
    await page.locator(".hub-exposures").scrollIntoViewIfNeeded(); await shot(page, tag + "-published");
    // Dismiss the unrelated, already-applied publication card through its real close button.
    for (const button of await page.locator(".pending-card.applied .pending-head button").all()) await button.click();
    await page.locator("#hubRunOn").click(); await page.waitForSelector("[data-confirm=yes]"); await page.click("[data-confirm=yes]");
    await page.waitForSelector(".hub-run-settings [role=status]");
    const status = await page.locator(".hub-run-settings").innerText();
    if (!before && status.includes(en ? "This Hub is running" : "這個 Hub 正在執行")) throw Error("running label after stop");
    if (!before && !en && (await page.locator(".pending-summary").allInnerTexts()).some((s: string) => s.includes("Stop this fleet"))) throw Error("mixed confirmation language");
    if ((yaml.load(readFileSync(yamlFile, "utf8")) as any).hub.enabled !== false) throw Error("stop not saved");
    if (await page.locator(".pending-card").count()) { await page.evaluate(() => document.querySelector(".pending-card")?.scrollIntoView({block:"center",behavior:"instant"})); await shot(page, tag + "-confirmation"); }
    await page.locator(".hub-run-settings").scrollIntoViewIfNeeded(); await shot(page, tag + "-stopped");
    if (errors.length || (await csp()).length) throw Error(JSON.stringify({ errors, csp: await csp() })); await ctx.close();
    const hc = await fx.browser.newContext({ viewport: { width: c.device === "desk" ? 1366 : 390, height: c.device === "desk" ? 900 : 844 }, colorScheme: c.theme, locale: c.lang === "zh-TW" ? "zh-TW" : "en-US", ignoreHTTPSErrors: true, isMobile: c.device === "phone", hasTouch: c.device === "phone" });
    await hc.addInitScript({ content: `localStorage.setItem('agend_lang',${JSON.stringify(c.lang)}); localStorage.setItem('agend_tour_done','1')` });
    const hp = await hc.newPage(); const hubErrors: string[] = []; hp.on("pageerror", (e: any) => hubErrors.push(String(e))); await prepare(hp);
    await hp.goto(origin + "/ui/hub"); await hp.fill("#hubLogin", "alex"); await hp.fill("#hubPassword", "pw-alex"); await hp.click(".hub-signin button[type=submit]");
    await hp.waitForSelector(".hub-home");
    // Real browser's signed-in session opens the room through the real CSRF/client/room service.
    await hp.evaluate(async ({ exposureId, grantId }: any) => { const { hubClient } = await import("/ui/js/hub-client.js"); const r = await hubClient().openRoom(exposureId, grantId); if (!r.ok) throw Error(JSON.stringify(r)); location.href = '/ui/hub?room=' + encodeURIComponent(r.room.id); }, { exposureId, grantId: grant.json.grant.id });
    await hp.waitForSelector(".hub-chat-main #msgIn"); deny = true;
    const delivered = rig.sent.filter(x => x.frame.type === "question").length;
    await hp.fill("#msgIn", en ? "May I ask now?" : "現在可以提問嗎？"); await hp.click("#sendBtn"); await hp.waitForSelector(".hub-chat-main [role=alert]");
    if (!before) {
      if ((await hp.locator(".hub-chat-head").innerText()).includes(en ? "Can ask" : "可提問")) throw Error("optimistic header after refusal");
      if (!(await hp.locator("#sendBtn").isDisabled())) throw Error("send not held");
    }
    if (rig.sent.filter(x => x.frame.type === "question").length !== delivered) throw Error("denied question delivered");
    await shot(hp, tag + "-refused");
    if (c.device === "phone") await hp.locator(".hub-chat-head button").click();
    await hp.waitForSelector(".hub-kv");
    if (!before && (await hp.locator(".hub-kv").innerText()).includes(en ? "Ask, and read your own chat" : "提問、看自己的紀錄")) throw Error("optimistic access card");
    await shot(hp, tag + "-access");
    if (!before) {
      if (c.device === "phone") await hp.keyboard.press("Escape"); deny = false;
      await hp.locator(".hub-banner button").click(); await hp.waitForSelector(".hub-chat-head .tag.ok", { timeout: 15000 });
      if (await hp.locator("#msgIn").inputValue() !== (en ? "May I ask now?" : "現在可以提問嗎？")) throw Error("draft lost");
    }
    if (hubErrors.length) throw Error(JSON.stringify(hubErrors)); await hc.close();
  }
} catch (error) {
  for (const context of fx.browser.contexts()) for (const page of context.pages()) { try { await page.screenshot({path:join(out, "failure.png")}); writeFileSync(join(out, "failure.txt"), await page.locator("body").innerText()); } catch {} }
  throw error;
} finally {
  await fx.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rig.close(); rmSync(keys, { recursive: true, force: true });
  writeFileSync(join(out, "checks.json"), JSON.stringify(records, null, 2));
}
console.log(JSON.stringify({ checkpoints: records.length, before, skew }));
