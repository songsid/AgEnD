// M-2988 (Lumen's Hub user-story board): the Hub-side words, in a real browser on a REAL Hub web listener (the s3b rig
// behind node:https, as smoke-hub-owner-admin-c.mts: scratch DB, fake directory; no fleet runs). Run it with REPO at the
// change for "after" and at its base for "before": the pages are REPO's, so the pictures are of that code.
//   #6  the owner's agent page: the danger card and its confirmation (「暫停提問」 → 「停止分享」);
//   #12 the administrator approves a pairing whose owner the Hub refuses; #16 revokes a Fleet that has a label. The admin
//       overview is routed to hold one labelled Fleet and one owner-confirmed pairing, and the approve answer to `denied`;
//       Revoke is cancelled, so nothing is written;
//   #17 the asker's room: the note above the composer.
// Judged (after only, AFTER=1): the words are the new ones, and no page error / CSP report / foreign request.
//   PW_DIR=… REPO=<checkout> OUT=<dir> [AFTER=1] [MATRIX=…] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-hub-story-fixes-2988.mts
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:https";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const REPO = process.env.REPO!, OUT = join(process.env.OUT!, "hub-story-fixes-2988"), PW = process.env.PW_DIR!, AFTER = process.env.AFTER === "1";
mkdirSync(OUT, { recursive: true });
const { s3bRig } = await import(REPO + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(REPO + "/src/hub/tls.ts");
const r: Record<string, unknown> = {};
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };
const shot = (name: string) => join(OUT, `${name}.png`);

const port = 49100 + Math.floor(Math.random() * 90), origin = `https://127.0.0.1:${port}`;
const rig = await s3bRig({ webOrigin: origin });
const http = rig.http;
const keys = mkdtempSync(join(OUT, "keys-")); chmodSync(keys, 0o700);
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!http.handle(req, res)) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found"); } });
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

const olivia = rig.addPerson("olivia", "Olivia Chen"); rig.addPerson("alex", "Alex Lin"); rig.addPerson("carol", "Carol Wu");
const fleetId = randomUUID(), link = rig.link(fleetId, olivia), sales = randomUUID();
await http.receive(rig.frame("exposure.snapshot", { revision: 1, exposures: [{ id: sales, fleetId, owner: olivia, displayName: "Sales numbers", revision: 1,
  state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) }] }, link) as never, link);

const pw = createRequire(PW + "/")("playwright-core");
const browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });
const VIEW = { desk: { width: 1366, height: 860 }, phone: { width: 390, height: 844 } } as const;
const CASES = (process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW").split(",").map((s) => {
  const [device, theme, ...lang] = s.split("-"); return { device: device as "desk" | "phone", theme: theme as "light" | "dark", lang: lang.join("-") as "en" | "zh-TW" };
});
const { HUB_UI_MODULES } = await import(REPO + "/src/hub/http/compose.ts");
const ALLOWED = new RegExp(`^/(hub/v1/|assets/|ui/js/(${(HUB_UI_MODULES as readonly string[]).map((f) => f.replace(/\.js$/, "").replace(/[-]/g, "\\-")).join("|")})\\.js|ui/hub|favicon)`);
async function open(c: (typeof CASES)[number], path: string, route?: (page: any) => Promise<void>) {
  const ctx = await browser.newContext({ viewport: VIEW[c.device], colorScheme: c.theme, locale: c.lang === "zh-TW" ? "zh-TW" : "en-US", ignoreHTTPSErrors: true,
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
const until = async (page: any, js: string, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { if (await page.evaluate(js)) return true; await page.waitForTimeout(100); } return false; };
const dialogText = (page: any) => page.evaluate(`(document.querySelector("[role=alertdialog], dialog[open]")?.textContent || "").replace(/\\s+/g, " ").trim()`);
const clean = async (x: { errs: string[]; foreign: string[]; csp: () => Promise<string[]> }) => x.errs.length === 0 && x.foreign.length === 0 && (await x.csp()).length === 0;

try {
  for (const l of ["olivia", "alex", "carol"]) await rig.signIn(l);
  const o0 = await rig.signIn("olivia");
  const g = (await rig.call(o0, "POST", "/hub/v1/grants", { exposureId: sales, exposureRevision: 1, login: "alex", days: 7 })).json.grant;
  const a0 = await rig.signIn("alex");
  const room = (await rig.call(a0, "POST", "/hub/v1/rooms", { exposureId: sales, grantId: g.id })).json.room.id;
  await rig.call(a0, "POST", `/hub/v1/rooms/${room}/messages`, { idempotencyKey: randomUUID(), text: "What were Q3 sales?" });
  const ad0 = await rig.signIn("admin");
  const offer = await rig.call(ad0, "POST", "/hub/v1/admin/pairings", { login: "carol" });
  rig.pairing.pair({ code: offer.json.code });

  for (const c of CASES) {
    const tag = `${c.device}-${c.theme}-${c.lang}`, en = c.lang === "en";
    // #6 the owner's agent page: the danger card, then its confirmation (cancelled).
    const o = await open(c, `/ui/hub/exposures?agent=${sales}`);
    await signIn(o.page, "olivia");
    await o.page.waitForSelector(".hub-danger", { timeout: 10000 });
    await o.page.locator(".hub-danger").scrollIntoViewIfNeeded();
    const card = await o.page.evaluate(`document.querySelector(".hub-danger").textContent.replace(/\\s+/g, " ").trim()`);
    await o.page.locator(".hub-danger").screenshot({ path: shot(`${tag}-06a-stop-sharing-card`) });
    await o.page.click(".hub-danger button");
    await until(o.page, `!!document.querySelector("[role=alertdialog], dialog[open]")`);
    const ask6 = await dialogText(o.page);
    await o.page.screenshot({ path: shot(`${tag}-06b-stop-sharing-confirm`) });
    await o.page.keyboard.press("Escape"); await o.page.waitForTimeout(300);
    if (AFTER) check(`${tag}-6`, (en ? /^Stop sharing/.test(card) && /shared again from its fleet.*everyone has to be allowed/.test(ask6) : /^停止分享/.test(card) && /回到它的 Fleet 重新分享.*每個人都要重新允許/.test(ask6))
      && !/Pause|暫停|Stop all asking|停止所有提問/.test(card + ask6) && await clean(o), { card, ask6, errs: o.errs, foreign: o.foreign });
    await o.ctx.close();

    // #12 / #16 the administrator: a pairing the Hub refuses because of its owner; a labelled Fleet's revoke.
    const routes = async (page: any) => {
      await page.route((u: URL) => /\/hub\/v1\/admin\/pairings\/[^/]+\/approve$/.test(u.pathname), (route: any) =>
        route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ code: "denied" }) }));
      await page.route((u: URL) => u.pathname === "/hub/v1/admin/overview", async (route: any) => {
        const res = await route.fetch(); const body = await res.json();
        // A labelled active Fleet (S1's label) and a manual pairing its owner has confirmed, waiting for the administrator.
        body.fleets = [{ id: fleetId, status: "active", label: "build-box", owner: { name: "Olivia Chen", login: "olivia" } }];
        body.pairings = [{ id: randomUUID(), owner: { name: "Carol Wu", login: "carol" }, ownerConfirmed: true, adminApproved: false, fingerprint: "f".repeat(64), expiresAt: Date.now() + 600_000 }];
        return route.fulfill({ response: res, json: body });
      });
    };
    const d = await open(c, "/ui/hub/admin", routes);
    await signIn(d.page, "admin");
    await d.page.waitForSelector("[data-fleet]", { timeout: 10000 });
    await d.page.evaluate(`document.querySelector("details.hub-admin-manual") && (document.querySelector("details.hub-admin-manual").open = true)`);
    const approve = d.page.locator(".hub-rows .hub-row button.btn-primary").first();
    let refused = "";
    if (await approve.count()) {
      await approve.scrollIntoViewIfNeeded(); await approve.click();
      await until(d.page, `!!document.querySelector("[role=alertdialog], dialog[open]")`);
      await d.page.evaluate(`document.querySelector("[role=alertdialog] [data-confirm=yes], dialog[open] [data-confirm=yes]").click()`);
      await until(d.page, `/Carol/.test([...document.querySelectorAll(".hub-admin [role=alert], .hub-admin .err, .hub-admin .note")].map(x => x.textContent).join(" ")) || /not allowed|沒有權限/.test(document.body.innerText)`);
      refused = await d.page.evaluate(`(document.body.innerText.split("\\n").find(l => /Carol .*(Fleet)|not allowed|沒有權限/.test(l)) || "").trim()`);
      const at = d.page.locator(".hub-admin [role=alert], .hub-admin .err").first();
      if (await at.count()) await at.scrollIntoViewIfNeeded();
      await d.page.screenshot({ path: shot(`${tag}-12-approve-refused`) });
    }
    await d.page.locator("[data-fleet] .menu button").first().scrollIntoViewIfNeeded();
    await d.page.locator("[data-fleet] .menu button").first().click();
    await until(d.page, `!!document.querySelector("[role=menuitem]")`);
    await d.page.evaluate(`document.querySelector("[role=menuitem]").click()`);
    await until(d.page, `!!document.querySelector("[role=alertdialog], dialog[open]")`);
    const ask16 = await dialogText(d.page);
    await d.page.screenshot({ path: shot(`${tag}-16-revoke-confirm`) });
    await d.page.keyboard.press("Escape"); await d.page.waitForTimeout(300);
    if (AFTER) check(`${tag}-12-16`, (en ? /Carol Wu can't connect a Fleet right now/.test(refused) && /Revoke Olivia Chen's fleet “build-box”\?/.test(ask16)
      : /Carol Wu 目前不能連接 Fleet/.test(refused) && /要撤銷 Olivia Chen 的 Fleet「build-box」嗎/.test(ask16)) && d.errs.length === 0 && (await d.csp()).length === 0,
      { refused, ask16, errs: d.errs, foreign: d.foreign });
    await d.ctx.close();

    // #17 the asker's room: the note above the composer.
    const a = await open(c, "/ui/hub");
    await signIn(a.page, "alex");
    await a.page.waitForSelector(".hub-home", { timeout: 10000 });
    await a.page.click(c.device === "desk" ? ".sidebar .side-new" : ".hub-home .side-new");
    await a.page.waitForSelector(".hub-pick-row", { timeout: 10000 });
    await a.page.evaluate(`[...document.querySelectorAll(".hub-pick-row")].find((x) => x.querySelector(".t").textContent === "Sales numbers").querySelector("button").click()`);
    await a.page.waitForSelector(".hub-identity", { state: "attached", timeout: 10000 });   // phone hides composer hints (as before)
    const note = await a.page.evaluate(`document.querySelector(".hub-identity").textContent.trim()`);
    await a.page.screenshot({ path: shot(`${tag}-17-ask-note`) });
    if (AFTER) check(`${tag}-17`, (en ? /the owner sees that you asked/.test(note) : /對方會看到是你問的/.test(note)) && await clean(a), { note, errs: a.errs, foreign: a.foreign });
    await a.ctx.close();
    r[`${tag}-words`] = { card, ask6, refused, ask16, note };
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  writeFileSync(join(OUT, "result.json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : AFTER ? "ALL PASS" : "captured (before: not judged)");
  await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await rig.close();
  rmSync(keys, { recursive: true, force: true });
  process.exit(fail.length ? 1 : 0);
}
