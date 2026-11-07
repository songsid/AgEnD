// #3298 S-89: the Hub's signed-in welcome and Administration → Group permissions, in a real browser on a REAL Hub web listener
// (createHubHttp behind node:https, the s3b rig, a fake directory; no fleet runs). Until S-88's control is composed, the group
// routes and the session's "group-policy-v1" mark don't exist on the server: this smoke supplies exactly those in the browser
// (page.route) — the session is the real one plus the mark, the group answers are the agreed contract's shapes (M-2624,
// admin-dto.ts) — and serves the three new lazy modules the listener's HUB_UI_MODULES doesn't list yet. Everything else is real.
// - the welcome: no actions / ask only / full with nothing shared;
// - Administration: the Group permissions entry; the editor with groups, a change's preview (impact listed) and Save;
// - desktop and phone, light and dark, EN and zh-TW; no page error, no CSP report, no request outside the Hub's own list;
// - SKEW: an older hub-client.js (no group calls) under this panel; an older panel-hub.js under this server; an older hub-chat.css.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-hub-groups-s89.mts
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";

const REPO = process.env.REPO!, OUT = process.env.OUT!, PW = process.env.PW_DIR!;
const OLD_REF = process.env.OLD_REF ?? "origin/release/2.3.5-alpha";
const old = (path: string): string | null => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD_REF}:src/ui/${path}`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { return null; } };
const { s3bRig } = await import(REPO + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(REPO + "/src/hub/tls.ts");
const r: Record<string, unknown> = {};
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };
const shot = (name: string) => { const d = join(OUT, "hub-groups-s89"); mkdirSync(d, { recursive: true }); return join(d, `${name}.png`); };

const port = 49100 + Math.floor(Math.random() * 90), origin = `https://127.0.0.1:${port}`;
const rig = await s3bRig({ webOrigin: origin });
const http = rig.http;
mkdirSync(OUT, { recursive: true });
const keys = mkdtempSync(join(OUT, "hub-g-keys-")); chmodSync(keys, 0o700);
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!http.handle(req, res)) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found"); } });
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
rig.addPerson("bo", "Bo Wu"); rig.addPerson("cy", "Cy Tan");

const pw = createRequire(PW + "/")("playwright-core");
const browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });
const ALL_CASES = [
  { device: "desk", lang: "en", theme: "light", viewport: { width: 1366, height: 860 } }, { device: "desk", lang: "zh-TW", theme: "dark", viewport: { width: 1366, height: 860 } },
  { device: "desk", lang: "zh-TW", theme: "light", viewport: { width: 1366, height: 860 } },
  { device: "phone", lang: "en", theme: "light", viewport: { width: 390, height: 844 } }, { device: "phone", lang: "zh-TW", theme: "dark", viewport: { width: 390, height: 844 } },
] as const;
// ONLY=desk-light-zh-TW,… runs just those cases (e.g. pictures for an early review); SKEW runs unless ONLY is set.
const ONLY = (process.env.ONLY ?? "").split(",").filter(Boolean);
const CASES = ONLY.length ? ALL_CASES.filter((c) => ONLY.includes(`${c.device}-${c.theme}-${c.lang}`)) : ALL_CASES;
const { HUB_UI_MODULES } = await import(REPO + "/src/hub/http/compose.ts");
const NEW_MODULES = ["hub-welcome.js", "hub-group-policy.js", "hub-group-strings.js"];
const listed = [...(HUB_UI_MODULES as readonly string[]), ...NEW_MODULES];
const ALLOWED = new RegExp(`^/(hub/v1/|assets/|ui/js/(${listed.map((f) => f.replace(/\.js$/, "").replace(/[-]/g, "\\-")).join("|")})\\.js|ui/hub|favicon)`);

const ID1 = "0f1e2d3c-4b5a-4968-8776-655443322110", ID2 = "1f1e2d3c-4b5a-4968-8776-655443322111";
const POLICY = { realm: "corp", generation: "gen-1", revision: 4, state: "enabled", groups: [
  { group: { realm: "corp", objectId: ID1 }, dn: "CN=Hub-Members,OU=Groups,DC=example,DC=test", allow: ["ask_agents"], maxFleets: 0 },
  { group: { realm: "corp", objectId: ID2 }, dn: "CN=Hub-Owners,OU=Groups,DC=example,DC=test", allow: ["ask_agents", "publish_agents", "pair_fleet"], maxFleets: 1 }], denies: [] };
const IMPACT = { losingActions: [{ personId: { realm: "corp", objectId: ID1 }, name: "Bo Wu", login: "bo" }], losingPublication: [],
  grandfathered: [{ kind: "exposure", id: "x1", revision: 2, label: "Sales numbers", owner: { name: "Cy Tan" } }], suspendedOnSave: [], adminLosesChat: false,
  held: [{ personId: "corp/" + "3f1e2d3c-4b5a-4968-8776-655443322113", name: "Dee Lin", login: "dee", capabilities: ["ask_agents"], reason: "membership-unknown" }] };
const WELCOME: Record<string, unknown> = {
  none: { ok: true, v: 1, mode: "enabled", chat: { state: "deny", reason: "no-group" }, publish: { state: "deny", reason: "no-group" }, connect: { state: "deny", reason: "no-group", maxFleets: 0, fleets: [] } },
  ask: { ok: true, v: 1, mode: "enabled", chat: { state: "allow", reason: "group" }, publish: { state: "deny", reason: "no-group" }, connect: { state: "deny", reason: "no-group", maxFleets: 0, fleets: [] } },
  full: { ok: true, v: 1, mode: "enabled", chat: { state: "allow", reason: "group" }, publish: { state: "allow", reason: "group" }, connect: { state: "allow", reason: "group", maxFleets: 2, fleets: [] } },
};
const json = (route: any, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
/** The group contract's routes and the session's mark, supplied in the browser until S-88 composes them; the new lazy modules from REPO. */
async function contract(page: any, welcome: keyof typeof WELCOME, opts: { mark?: boolean; roomsDenied?: boolean; policyState?: string } = {}) {
  const mark = opts.mark !== false;
  await page.route((u: URL) => u.pathname === "/hub/v1/session", async (route: any) => {
    // Both the read (GET) and the sign-in's answer (POST) carry the session the page keeps; DELETE (sign out) passes as is.
    if (route.request().method() === "DELETE") return route.continue();
    const real = await route.fetch(); const body = await real.json();
    return json(route, mark && body.signedIn ? { ...body, features: ["group-policy-v1"] } : body, real.status());
  });
  await page.route((u: URL) => NEW_MODULES.some((f) => u.pathname === `/ui/js/${f}`), (route: any) =>
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: readFileSync(join(REPO, "src/ui", new URL(route.request().url()).pathname.slice("/ui/js/".length)), "utf8") }));
  await page.route((u: URL) => u.pathname === "/hub/v1/me/welcome", (route: any) => json(route, WELCOME[welcome]));
  // As the real Hub answers a person whose groups don't include chatting (Cairn #3372 browser run).
  if (opts.roomsDenied) await page.route((u: URL) => u.pathname === "/hub/v1/rooms", (route: any) => route.request().method() === "GET" ? json(route, { code: "denied" }, 403) : route.continue());
  await page.route((u: URL) => u.pathname.startsWith("/hub/v1/admin/group-policy"), (route: any) => {
    const p = new URL(route.request().url()).pathname, m = route.request().method();
    if (p === "/hub/v1/admin/group-policy" && m === "GET") return json(route, { ok: true, groupPolicyV1: true, supported: true, binding: "ready", policy: { ...POLICY, ...(opts.policyState ? { state: opts.policyState } : {}) }, paused: [] });
    if (p.endsWith("/preview")) return json(route, { ok: true, previewDigest: "d".repeat(64), expiresAt: Date.now() + 60_000, policyRevision: 4, authorizationVersion: 1, impact: IMPACT });
    if (p.endsWith("/resolve")) return json(route, { ok: true, realm: "corp", objectId: "2f1e2d3c-4b5a-4968-8776-655443322112", dn: "CN=Hub-MultiFleet,OU=Groups,DC=example,DC=test" });
    if (m === "PUT") return json(route, { ok: true, policyRevision: 5, state: "enabled" });
    return json(route, { code: "not-found" }, 404);
  });
}
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
  await page.goto(origin + path); await page.waitForTimeout(800);
  return { ctx, page, errs, foreign, csp: () => page.evaluate("window.__csp || []") as Promise<string[]> };
}
async function signIn(page: any, login: string) {
  await page.waitForSelector("#hubLogin", { timeout: 10000 });
  await page.fill("#hubLogin", login); await page.fill("#hubPassword", `pw-${login}`);
  await page.click(".hub-signin button[type=submit]");
}
const clean = async (o: any) => o.errs.length === 0 && o.foreign.length === 0 && (await o.csp()).length === 0;
const overflow = (page: any) => page.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth + 1`);

try {
  for (const c of CASES) {
    const tag = `${c.device}-${c.theme}-${c.lang}`;
    // ── the welcome, in its three states ──
    for (const state of ["none", "ask", "full"] as const) {
      const o = await open(c, "/ui/hub", (p) => contract(p, state, { roomsDenied: state === "none" }));
      await signIn(o.page, "bo");
      await o.page.waitForSelector(".hub-welcome-page .hub-welcome-card", { timeout: 10000 });
      await o.page.waitForTimeout(300);
      const w = await o.page.evaluate(`({ cards: [...document.querySelectorAll(".hub-welcome-card")].map((x) => [x.dataset.entry, x.getAttribute("aria-disabled"), !!x.querySelector(".btn")]),
        none: !!document.querySelector('[data-welcome="no-actions"]'), alerts: document.querySelectorAll('.error-state, [role=alert]').length, nothing: !!document.querySelector('[data-welcome="nothing-shared"]'), fleets: document.querySelector('[data-welcome="fleets"]')?.textContent || "" })`);
      await o.page.screenshot({ path: shot(`${tag}-welcome-${state}`), fullPage: true });
      const want = state === "none" ? [["chat", "true", false], ["connect", "true", false]] : state === "ask" ? [["chat", "false", true], ["connect", "true", false]] : [["chat", "false", true], ["connect", "false", false]];
      check(`${tag}-welcome-${state}`, JSON.stringify(w.cards) === JSON.stringify(want) && w.none === (state === "none") && w.nothing === (state !== "none")     /* Bo has nothing shared: chat-allowed states say so */
        && w.alerts === 0 && (state !== "full" || /0/.test(w.fleets)) && !(await overflow(o.page)) && await clean(o), { w, errs: o.errs, foreign: o.foreign, csp: await o.csp() });
      await o.ctx.close();
    }
    // ── Administration: the entry, then the editor ──
    const d = await open(c, "/ui/hub/admin", (p) => contract(p, "full"));
    await signIn(d.page, "admin");
    await d.page.waitForSelector('[data-entry="group-permissions"]', { timeout: 10000 });
    await d.page.screenshot({ path: shot(`${tag}-admin-entry`), fullPage: true });
    await d.page.click('[data-entry="group-permissions"] .btn');
    await d.page.waitForSelector(".hub-group-row", { timeout: 10000 });
    await d.page.screenshot({ path: shot(`${tag}-editor`), fullPage: true });
    await d.page.locator(".hub-group-row").first().locator("input[type=checkbox]").nth(1).check();
    await d.page.waitForSelector(".hub-groups-preview .btn-primary", { timeout: 10000 });
    // The panel scrolls inside itself (a full-page capture stops at the window): bring the preview and its Save into view.
    await d.page.evaluate(`document.querySelector(".hub-groups-preview .btn-primary").scrollIntoView({ block: "end" })`); await d.page.waitForTimeout(200);
    await d.page.screenshot({ path: shot(`${tag}-editor-preview`) });
    const ed = await d.page.evaluate(`({ rows: document.querySelectorAll(".hub-group-row").length, url: location.pathname + location.search,
      preview: document.querySelector(".hub-groups-preview")?.textContent || "" })`);
    check(`${tag}-editor`, ed.rows === 2 && ed.url === "/ui/hub/admin?view=groups" && /Bo Wu/.test(ed.preview) && /Sales numbers/.test(ed.preview) && /Dee Lin/.test(ed.preview) && !(await overflow(d.page)) && await clean(d),
      { ed: { ...ed, preview: ed.preview.slice(0, 160) }, errs: d.errs, foreign: d.foreign, csp: await d.csp() });
    await d.ctx.close();
    // ── never enabled: Turn on is pending until saved; the card keeps the saved state (Cairn #3372) ──
    const n = await open(c, "/ui/hub/admin", (p) => contract(p, "full", { policyState: "never-enabled" }));
    await signIn(n.page, "admin");
    await n.page.waitForSelector('[data-entry="group-permissions"] .btn', { timeout: 10000 }); await n.page.click('[data-entry="group-permissions"] .btn');
    await n.page.waitForSelector(".hub-groups-state .btn", { timeout: 10000 });
    const head0 = await n.page.evaluate(`document.querySelector(".hub-groups-state h3").textContent`);
    await n.page.click(".hub-groups-state .btn"); await n.page.waitForTimeout(400);
    const nv = await n.page.evaluate(`({ head: document.querySelector(".hub-groups-state h3").textContent, pending: document.querySelector(".hub-groups-state [data-pending]")?.getAttribute("data-pending") || null,
      save: document.querySelector(".hub-groups-preview .btn-primary")?.textContent || "" })`);
    await n.page.evaluate(`document.querySelector(".hub-groups-state").scrollIntoView({ block: "start" })`); await n.page.waitForTimeout(150);
    await n.page.screenshot({ path: shot(`${tag}-editor-pending-on`) });
    check(`${tag}-editor-pending`, nv.head === head0 && nv.pending === "on" && !(await overflow(n.page)) && await clean(n), { head0, nv, errs: n.errs, csp: await n.csp() });
    await n.ctx.close();
  }
  // ── SKEW ──
  const serveOld = (files: string[]) => async (page: any) => page.route((u: URL) => files.some((f) => u.pathname === `/ui/js/${f}` || u.pathname === `/assets/${f}`), (route: any) => {
    const p = new URL(route.request().url()).pathname, f = p.replace(/^\/(ui\/js|assets)\//, "");
    const body = p.startsWith("/assets/") ? old(`shared/${f}`) : old(f);
    return body === null ? route.continue() : route.fulfill({ status: 200, contentType: f.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body });
  });
  for (const c of ONLY.length ? [] : [ALL_CASES[0], ALL_CASES[4]]) {
    const tag = `skew-${c.device}-${c.lang}`;
    // 1. An older hub-client.js (no group calls) under this panel, with the server's mark: nothing of the feature shows; the admin page works.
    const a = await open(c, "/ui/hub/admin", async (p) => { await contract(p, "full"); await serveOld(["hub-client.js"])(p); });
    await signIn(a.page, "admin");
    await a.page.waitForSelector(".hub-steps", { timeout: 10000 }); await a.page.waitForTimeout(500);
    const oldClient = await a.page.evaluate(`({ entry: !!document.querySelector('[data-entry="group-permissions"]'), steps: document.querySelectorAll(".hub-steps > li").length })`);
    await a.page.screenshot({ path: shot(`${tag}-old-client-admin`), fullPage: true });
    check(`${tag}-old-client`, !oldClient.entry && oldClient.steps === 3 && await clean(a), { oldClient, errs: a.errs, foreign: a.foreign });
    await a.ctx.close();
    // 2. An older panel-hub.js against this server and the mark: the old landing, no error.
    const b = await open(c, "/ui/hub", async (p) => { await contract(p, "full"); await serveOld(["panel-hub.js"])(p); });
    await signIn(b.page, "bo");
    await b.page.waitForSelector(".hub-home", { timeout: 10000 }); await b.page.waitForTimeout(500);
    const oldPanel = await b.page.evaluate(`({ welcome: !!document.querySelector(".hub-welcome-page") })`);
    check(`${tag}-old-panel`, !oldPanel.welcome && await clean(b), { oldPanel, errs: b.errs, foreign: b.foreign });
    await b.ctx.close();
    // 3. Its own stylesheet doesn't arrive (an interrupted load): the welcome still works, plainer — both entries there, chat usable.
    const s = await open(c, "/ui/hub", async (p) => { await contract(p, "full"); await p.route((u: URL) => u.pathname === "/assets/hub-groups.css", (route: any) => route.fulfill({ status: 404, body: "" })); });
    await signIn(s.page, "bo");
    // Without it a phone keeps hub-chat.css's own landing (the chat list; the side pane hidden): the welcome is there but not drawn.
    await s.page.waitForSelector(".hub-welcome-card", { timeout: 10000, state: "attached" }); await s.page.waitForTimeout(300);
    const vis = await s.page.evaluate(`document.querySelectorAll(".hub-welcome-card").length === 2 && !!document.querySelector('.hub-welcome-card[data-entry="chat"] .btn')
      && (innerWidth >= 900 || !!document.querySelector(".hub-new"))`);
    await s.page.screenshot({ path: shot(`${tag}-no-groups-css-welcome`), fullPage: true });
    check(`${tag}-no-groups-css`, vis && s.errs.length === 0 && (await s.csp()).length === 0, { vis, errs: s.errs });
    await s.ctx.close();
  }
} catch (e) { fail.push(`exception: ${(e as Error).message}`); r.exception = String((e as Error).stack || e).slice(0, 1200); }
finally {
  await browser.close(); server.close(); await rig.close?.();
  writeFileSync(join(OUT, "hub-groups-s89.json"), JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r, null, 2));
  console.log(fail.length ? `FAIL ${fail.length}: ${fail.join(", ")}` : "ALL PASS");
  process.exit(fail.length ? 1 : 0);
}
