// #3226 C: My shared agents and Administration as Settings-like pages, in a real browser on a REAL Hub web listener (as
// smoke-hub-chat-b.mts: createHubHttp behind node:https, the s3b rig, a fake directory; no fleet runs).
// - the owner (olivia): the list of her shared agents (who may ask, the state), a pairing to confirm; an agent's page —
//   who may ask (a row's ⋯ → Revoke, confirmed), Allow… (a dialog: the login and how long), the recent questions (who,
//   when, how it went; never the text), Pause questions;
// - the administrator: the three pairing steps (a code made), the pending pairing, the paired fleets (a row's ⋯ menu);
// - Hub-only boot, no page error, no CSP report; desk light/en and phone dark/zh-TW; screenshots under OUT/hub-owner-admin-c.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-hub-owner-admin-c.mts
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:https";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const REPO = process.env.REPO!, OUT = process.env.OUT!, PW = process.env.PW_DIR!;
const OLD_REF = process.env.OLD_REF ?? "songsid/release/2.3.5-alpha";   // B, before C
const old = (path: string): string | null => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD_REF}:src/ui/${path}`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { return null; } };
const { s3bRig } = await import(REPO + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(REPO + "/src/hub/tls.ts");
const r: Record<string, unknown> = {};
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };
const shot = (name: string) => { const d = join(OUT, "hub-owner-admin-c"); mkdirSync(d, { recursive: true }); return join(d, `${name}.png`); };

const port = 49000 + Math.floor(Math.random() * 90), origin = `https://127.0.0.1:${port}`;
const rig = await s3bRig({ webOrigin: origin });
const http = rig.http;
mkdirSync(OUT, { recursive: true });
const keys = mkdtempSync(join(OUT, "hub-c-keys-")); chmodSync(keys, 0o700);
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!http.handle(req, res)) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found"); } });
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

const olivia = rig.addPerson("olivia", "Olivia Chen"); rig.addPerson("alex", "Alex Lin"); rig.addPerson("bea", "Bea Ho");
const fleetId = randomUUID(), link = rig.link(fleetId, olivia), sales = randomUUID(), design = randomUUID();
const exposure = (id: string, name: string) => ({ id, fleetId, owner: olivia, displayName: name, revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
await http.receive(rig.frame("exposure.snapshot", { revision: 1, exposures: [exposure(sales, "Sales numbers"), exposure(design, "Design guide")] }, link) as never, link);

const pw = createRequire(PW + "/")("playwright-core");
const browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });
const CASES = [{ device: "desk", lang: "en", theme: "light", viewport: { width: 1366, height: 860 } }, { device: "phone", lang: "zh-TW", theme: "dark", viewport: { width: 390, height: 844 } }] as const;
// The Hub's own /ui/js list as the listener serves it (a later Hub module is allowed by the same list, never hand-copied).
const { HUB_UI_MODULES } = await import(REPO + "/src/hub/http/compose.ts");
const ALLOWED = new RegExp(`^/(hub/v1/|assets/|ui/js/(${(HUB_UI_MODULES as readonly string[]).map((f) => f.replace(/\.js$/, "").replace(/[-]/g, "\\-")).join("|")})\\.js|ui/hub|favicon)`);
async function open(c: (typeof CASES)[number], path: string, route?: (page: any) => Promise<void>) {
  const ctx = await browser.newContext({ viewport: c.viewport, colorScheme: c.theme, locale: c.lang === "zh-TW" ? "zh-TW" : "en-US", ignoreHTTPSErrors: true,
    isMobile: c.device === "phone", hasTouch: c.device === "phone", deviceScaleFactor: 2 });
  await ctx.addInitScript({ content: `try { localStorage.setItem("agend_lang", ${JSON.stringify(c.lang)}); localStorage.setItem("agend_tour_done", "1"); } catch {}
    window.__csp = []; document.addEventListener("securitypolicyviolation", e => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || "")));` });
  const page = await ctx.newPage();
  const errs: string[] = [], foreign: string[] = [];
  page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  page.on("request", (q: any) => { const u = new URL(q.url()); if (u.origin === origin && !ALLOWED.test(u.pathname)) foreign.push(u.pathname); });
  if (route) await route(page);
  await page.goto(origin + path); await page.waitForTimeout(1000);
  return { ctx, page, errs, foreign, csp: () => page.evaluate("window.__csp || []") as Promise<string[]> };
}
async function signIn(page: any, login: string) {
  await page.waitForSelector("#hubLogin", { timeout: 10000 });
  await page.fill("#hubLogin", login); await page.fill("#hubPassword", `pw-${login}`);
  await page.click(".hub-signin button[type=submit]");
}

try {
  for (const l of ["olivia", "alex", "bea"]) await rig.signIn(l);
  const o0 = await rig.signIn("olivia");
  const g = (await rig.call(o0, "POST", "/hub/v1/grants", { exposureId: sales, exposureRevision: 1, login: "alex", days: 7 })).json.grant;
  const a0 = await rig.signIn("alex");
  const room = (await rig.call(a0, "POST", "/hub/v1/rooms", { exposureId: sales, grantId: g.id })).json.room.id;
  await rig.call(a0, "POST", `/hub/v1/rooms/${room}/messages`, { idempotencyKey: randomUUID(), text: "What were Q3 sales?" });
  const ad0 = await rig.signIn("admin");
  const offer = await rig.call(ad0, "POST", "/hub/v1/admin/pairings", { login: "olivia" });
  rig.pairing.pair({ code: offer.json.code });

  for (const c of CASES) {
    const tag = `${c.device}-${c.theme}-${c.lang}`;
    // ── the owner ──
    const o = await open(c, "/ui/hub/exposures");
    await signIn(o.page, "olivia");
    await o.page.waitForSelector(".hub-shared .hub-row-link", { timeout: 10000 });
    await o.page.waitForSelector(".hub-pairings", { timeout: 10000 });
    const list = await o.page.evaluate(`[...document.querySelectorAll(".hub-shared .hub-row-link strong")].map((x) => x.textContent)`);
    await o.page.screenshot({ path: shot(`${tag}-1-my-shared-agents`), fullPage: true });
    await o.page.evaluate(`[...document.querySelectorAll(".hub-shared .hub-row-link")].find((x) => x.querySelector("strong").textContent === "Sales numbers").click()`);
    await o.page.waitForSelector(".hub-owner .hub-card-head button", { timeout: 10000 });
    const agent = await o.page.evaluate(`(() => { const recent = [...document.querySelectorAll(".card")].find((x) => /Recent questions|最近的提問/.test(x.querySelector("h3")?.textContent || ""));
      return { title: document.querySelector(".s-page-head h2")?.textContent, asks: [...document.querySelectorAll(".card .hub-row strong")].map((x) => x.textContent),
        recent: recent ? [...recent.querySelectorAll(".hub-row strong")].map((x) => x.textContent) : null, recentText: recent?.textContent || "" }; })()`);
    for (let i = 0; i < 20 && !(agent.recent || []).length; i++) { await o.page.waitForTimeout(250); Object.assign(agent, await o.page.evaluate(`({ recent: [...([...document.querySelectorAll(".card")].find((x) => /Recent questions|最近的提問/.test(x.querySelector("h3")?.textContent || ""))?.querySelectorAll(".hub-row strong") || [])].map((x) => x.textContent) })`)); }
    await o.page.screenshot({ path: shot(`${tag}-2-agent-page`), fullPage: true });
    await o.page.click(".hub-owner .hub-card-head button"); await o.page.waitForSelector(".hub-grant input");
    await o.page.screenshot({ path: shot(`${tag}-3-allow-dialog`) });
    await o.page.fill(".hub-grant input", "bea");
    await o.page.evaluate(`[...document.querySelectorAll("dialog button, .dlg button")].find((b) => /^(Allow|允許)$/.test(b.textContent.trim())).click()`);
    const allowed = await o.page.waitForFunction ? await (async () => { for (let i = 0; i < 40; i++) { const n = await o.page.evaluate(`[...document.querySelectorAll(".card .hub-row strong")].map((x) => x.textContent)`); if (n.includes("Bea Ho")) return true; await o.page.waitForTimeout(250); } return false; })() : false;
    // A row's ⋯ → Revoke… asks first (we cancel).
    await o.page.locator(".card .hub-row", { hasText: "Bea Ho" }).locator(".menu button").first().click();
    let items = 0;
    for (let i = 0; i < 20 && !items; i++) { await o.page.waitForTimeout(150); items = await o.page.evaluate(`[...document.querySelectorAll("[role=menuitem]")].filter((x) => /Revoke|撤銷/.test(x.textContent)).length`); }
    await o.page.screenshot({ path: shot(`${tag}-4-row-menu`) });
    if (!items) throw new Error(`${tag}: the row's menu shows no Revoke: ${await o.page.evaluate(`document.querySelector(".hub-owner")?.innerHTML.slice(0, 600)`)}`);
    await o.page.evaluate(`[...document.querySelectorAll("[role=menuitem]")].find((x) => /Revoke|撤銷/.test(x.textContent)).click()`);
    await o.page.waitForTimeout(400);
    const asked = await o.page.evaluate(`!!document.querySelector("[role=alertdialog], dialog[open]")`);
    await o.page.screenshot({ path: shot(`${tag}-5-revoke-confirm`) });
    await o.page.keyboard.press("Escape"); await o.page.waitForTimeout(300);
    const stillThere = await o.page.evaluate(`[...document.querySelectorAll(".card .hub-row strong")].some((x) => x.textContent === "Bea Ho")`);
    check(`${tag}-owner`, list.length === 2 && agent.title === "Sales numbers" && agent.asks.includes("Alex Lin") && (agent.recent || []).includes("Alex Lin")
      && !/Q3 sales/.test(agent.recentText) && allowed && asked && stillThere && o.errs.length === 0 && o.foreign.length === 0 && (await o.csp()).length === 0,
      { list, agent: { ...agent, recentText: agent.recentText.slice(0, 120) }, allowed, asked, stillThere, errs: o.errs, foreign: o.foreign });
    await o.ctx.close();
    // ── the administrator ──
    const d = await open(c, "/ui/hub/admin");
    await signIn(d.page, "admin");
    await d.page.waitForSelector(".hub-steps", { timeout: 10000 });
    await d.page.fill(".hub-step-form input", "bea"); await d.page.click(".hub-step-form button[type=submit]");
    await d.page.waitForSelector(".hub-code");
    const admin = await d.page.evaluate(`({ code: document.querySelector(".hub-code")?.textContent, steps: document.querySelectorAll(".hub-steps > li").length,
      pending: document.querySelectorAll(".hub-steps ~ .hub-rows .hub-row").length, fleets: document.querySelectorAll(".card:last-child .hub-row").length })`);
    await d.page.screenshot({ path: shot(`${tag}-6-administration`), fullPage: true });
    check(`${tag}-admin`, /^[a-f0-9]{12}$/.test(admin.code) && admin.steps === 3 && admin.pending >= 1 && d.errs.length === 0 && d.foreign.length === 0 && (await d.csp()).length === 0,
      { admin, errs: d.errs, foreign: d.foreign });
    await d.ctx.close();
  }
  // ── SKEW (#3261 review): a tab that holds B's own modules (its client without activity(), its words, its stylesheet)
  // when this panel loads; and the control, B's panel against this server. EN and zh-TW. ──
  const serveOld = (files: string[]) => async (page: any) => page.route((u: URL) => files.some((f) => u.pathname === `/ui/js/${f}` || u.pathname === `/assets/${f}`), (route: any) => {
    const p = new URL(route.request().url()).pathname, f = p.replace(/^\/(ui\/js|assets)\//, "");
    const body = p.startsWith("/assets/") ? old(`shared/${f}`) : old(f);
    return body === null ? route.continue() : route.fulfill({ status: 200, contentType: f.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body });
  });
  for (const c of CASES) {
    const tag = `skew-${c.device}-${c.lang}`;
    const k = await open(c, `/ui/hub/exposures?agent=${sales}`, serveOld(["hub-client.js", "hub-chat-strings.js", "hub-chat.css"]));
    await signIn(k.page, "olivia");
    await k.page.waitForSelector(".hub-owner .hub-card-head", { timeout: 10000 });
    let recent: string[] = [];
    for (let i = 0; i < 40 && !recent.length; i++) { await k.page.waitForTimeout(250); recent = await k.page.evaluate(`[...([...document.querySelectorAll(".card")].find((x) => /Recent questions|最近的提問/.test(x.querySelector("h3")?.textContent || ""))?.querySelectorAll(".hub-row strong") || [])].map((x) => x.textContent)`); }
    const facts = await k.page.evaluate(`({ raw: /\\bhub(Owner|Chat)\\.[a-zA-Z]+/.test(document.body.innerText), owned: !!document.querySelector('link[data-hub-owner-css="1"]'),
      rowFlex: getComputedStyle(document.querySelector(".hub-rows .hub-row")).display })`);
    await k.page.screenshot({ path: shot(`${tag}-retained-b-modules`), fullPage: true });
    check(`${tag}-retained-b-modules`, recent.includes("Alex Lin") && !facts.raw && facts.owned && facts.rowFlex === "flex" && k.errs.length === 0, { recent, facts, errs: k.errs });
    await k.ctx.close();
  }
  {
    const k = await open(CASES[0], "/ui/hub/exposures", serveOld(["panel-hub.js"]));
    await signIn(k.page, "olivia");
    const ok = await k.page.waitForSelector(".hub-exposure-card, .hub-shared", { timeout: 10000 }).then(() => true, () => false);
    await k.page.screenshot({ path: shot("skew-old-panel-new-server"), fullPage: true });
    check("skew-old-panel-new-server", ok && k.errs.length === 0, { ok, errs: k.errs });
    await k.ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  mkdirSync(join(OUT, "hub-owner-admin-c"), { recursive: true });
  writeFileSync(join(OUT, "hub-owner-admin-c", "result.json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await rig.close();
  rmSync(keys, { recursive: true, force: true });
  process.exit(fail.length ? 1 : 0);
}
