/** Real B+G chat acceptance. REPO points to a checkout containing both PRs; no live fleet, tmux or CLI. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

const repo = resolve(process.env.REPO ?? "."), out = resolve(process.env.OUT ?? "docs/screenshots/hub-quota-g-chat");
const { s3bRig } = await import(repo + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(repo + "/src/hub/tls.ts");
mkdirSync(out, { recursive: true });
const keys = mkdtempSync(join(out, ".keys-")), port = 49000 + Math.floor(Math.random() * 200);
const origin = `https://127.0.0.1:${port}`;
let now = Date.now();
const r = await s3bRig({ now: () => now, webOrigin: origin });
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!r.http.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>(done => server.listen(port, "127.0.0.1", done));
const owner = r.addPerson("owner", "Olivia"), asker = r.addPerson("asker", "Alex"); void asker;
const link = r.link(randomUUID(), owner), exposureId = randomUUID();
link.features.add("welcome-caps-v1"); link.features.add("quota-band-v1");
await r.http.receive(r.frame("exposure.snapshot", { revision: 1, exposures: [{ id: exposureId, fleetId: link.fleetId, owner,
  displayName: "Atlas", revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link), link);
const o = await r.signIn("owner"), a = await r.signIn("asker");
const grant = (await r.call(o, "POST", "/hub/v1/grants", { exposureId, exposureRevision: 1, login: "asker", days: 7 })).json.grant;
const room = (await r.call(a, "POST", "/hub/v1/rooms", { exposureId, grantId: grant.id })).json.room;
const visibility = async (visible: boolean) => {
  now += 30_000;
  assert.equal((await r.call(o, "POST", `/hub/v1/exposures/${exposureId}/quota`, { revision: 1, visible })).status, 200);
};
const update = async (band: string) => {
  now += 30_000;
  await r.http.receive(r.frame("exposure.quota", { exposureId, quota: { band, ...(band === "exhausted" ? { resetsAt: Math.round((now + 3_600_000) / 300_000) * 300_000 } : {}) } }, link), link);
};
const pw = createRequire(resolve(process.env.PW_DIR!, "package.json"))("playwright-core");
const browser = await pw.chromium.launch({ args: ["--no-sandbox"] });
const results: unknown[] = [];
try {
  for (const c of [{ device: "desktop", lang: "en", theme: "light", viewport: { width: 1366, height: 900 } },
    { device: "phone", lang: "zh-TW", theme: "dark", viewport: { width: 390, height: 844 } }]) {
    await visibility(false);
    const context = await browser.newContext({ viewport: c.viewport, colorScheme: c.theme, ignoreHTTPSErrors: true });
    await context.addInitScript(({ lang }) => { localStorage.setItem("agend_lang", lang); localStorage.setItem("agend_tour_done", "1"); }, { lang: c.lang });
    const p = await context.newPage(), errors: string[] = [], foreign: string[] = [], csp: string[] = [];
    p.on("pageerror", (e: Error) => errors.push(e.message));
    p.on("request", (q: any) => { if (new URL(q.url()).origin !== origin) foreign.push(q.url()); });
    await p.exposeFunction("captureCsp", (value: string) => csp.push(value));
    await p.addInitScript(() => document.addEventListener("securitypolicyviolation", e => (window as any).captureCsp(e.violatedDirective)));
    await p.goto(`${origin}/ui/hub?room=${room.id}`);
    await p.fill("#hubLogin", "asker"); await p.fill("#hubPassword", "pw-asker"); await p.click(".hub-signin button[type=submit]");
    await p.waitForSelector(".hub-chat-main");
    assert.equal(await p.locator(".hub-quota-card,.hub-quota-chip,.hub-quota-banner").count(), 0);
    assert(await p.locator(".hub-chat-head .tag").innerText());
    const prefix = `${c.device}-${c.lang}`;
    await p.screenshot({ path: join(out, `${prefix}-before.png`), fullPage: true });
    await visibility(true);
    for (const band of ["available", "near_limit", "unknown", "exhausted"]) {
      await update(band);
      await p.waitForResponse(async response => response.url().includes(`/rooms/${room.id}/messages`) && response.status() === 200
        && (await response.json()).room?.quota?.band === band, { timeout: 20_000 });
      await p.waitForFunction(({ band, zh }) => {
        const text = document.querySelector(".hub-chat-head")?.textContent ?? "";
        const expected = zh ? { available: "可提問", near_limit: "快用完", unknown: "未知", exhausted: "用完" }
          : { available: "Can ask", near_limit: "Near limit", unknown: "Unknown", exhausted: "Exhausted" };
        return text.includes(expected[band]);
      }, { band, zh: c.lang === "zh-TW" }, { timeout: 20_000 });
      assert.equal(await p.locator(".hub-quota-chip").count(), band === "available" ? 0 : 1);
      assert.equal(await p.locator(".hub-quota-banner").count(), band === "exhausted" ? 1 : 0);
      assert(!(await p.locator(".hub-chat-main").innerText()).includes("%"));
      if (band === "exhausted") {
        await p.fill("#msgIn", c.lang === "zh-TW" ? "可以排隊嗎？" : "Can this question queue?");
        assert(await p.locator("#sendBtn").isEnabled());
        await p.screenshot({ path: join(out, `${prefix}-after.png`), fullPage: true });
      }
    }
    if (c.device === "phone") await p.click(".hub-chat-head button[aria-label]:last-of-type");
    await p.waitForSelector(".hub-quota-card");
    const cards = p.locator(c.device === "phone" ? "dialog .u-provider" : ".hub-chat .u-rail .u-provider");
    assert.equal(await cards.nth(1).locator(".u-status").count(), 1);
    await p.screenshot({ path: join(out, `${prefix}-context.png`), fullPage: true });
    if (c.device === "phone") await p.keyboard.press("Escape");
    await visibility(false);
    await p.waitForFunction(() => !document.querySelector(".hub-quota-chip,.hub-quota-banner,.hub-quota-card"), null, { timeout: 20_000 });
    assert(await p.locator(".hub-chat-head .tag").innerText());
    assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.deepEqual(errors, []); assert.deepEqual(foreign, []); assert.deepEqual(csp, []);
    results.push({ ...c, allBands: true, ownerHideClearsCachedBand: true, enabledComposer: true, errors, foreign, csp });
    await context.close();
  }
  mkdirSync(".artifacts/hub-quota-chat", { recursive: true });
  writeFileSync(".artifacts/hub-quota-chat/results.json", JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify({ cases: results.length, pngs: results.length * 3, out }));
} finally {
  await browser.close(); await new Promise<void>(done => server.close(() => done())); await r.close(); rmSync(keys, { recursive: true, force: true });
}
