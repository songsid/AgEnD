// #3226 E: an answer's HTML page in a Hub room's side panel, in a real browser on a REAL Hub web listener (createHubHttp's
// handle() behind node:https on 127.0.0.1, the agreed S5 fakes from tests/helpers/hub-s3b-rig.ts, a fake directory, the
// member driven in-process through S3's own receive()) and the Hub's REAL preview listener (createHubPreviewHandler: the
// static /frame shim on its own port, same certificate). No fleet runs.
// - the answer's ```html card: Open in panel → the room's panel where the info rail was; this browser has not allowed
//   previews → the panel's Allow asks in the Hub's words (this Hub, this browser) → the page runs in the frame at the
//   preview origin (sandbox allow-scripts, no same-origin); its bar has Point at it and Reply about this page, no Share;
//   Point at it → a click in the page puts its line in the room's composer; Reply about this page adds its line once;
//   the info button brings the rail back (desk); on a phone the panel is a sheet over the room.
// - not offered: a Hub without hub.web.preview_port → the panel says so in the Hub's words, nothing runs.
// - the stale-tab skew: the old shell (every long-lived /assets file from OLD_REF) with this branch's lazy Hub modules.
// - Hub-only: the page asks the Hub for nothing but /hub/v1/*, /assets/*, its own /ui/js modules and its pages; no CSP
//   violation on the page.
// LABEL=base (a checkout before E): the answer card and its Preview only (the before shots).
// Desk light/en and phone dark/zh-TW; screenshots under OUT/hub-preview-e.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> [LABEL=base|branch] [OLD_REF=songsid/release/2.3.5-alpha] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-hub-preview-e.mts
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

const REPO = process.env.REPO!, OUT = process.env.OUT!, PW = process.env.PW_DIR!, LABEL = process.env.LABEL ?? "branch";
const OLD_REF = process.env.OLD_REF ?? "songsid/release/2.3.5-alpha";
const BASE = LABEL === "base";
const { s3bRig } = await import(REPO + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(REPO + "/src/hub/tls.ts");
const preview = BASE ? null : await import(REPO + "/src/hub/preview.ts");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const r: Record<string, unknown> = { label: LABEL, oldRef: OLD_REF };
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };
const shot = (name: string) => { const d = join(OUT, "hub-preview-e"); mkdirSync(d, { recursive: true }); return join(d, `${LABEL}-${name}.png`); };
const old = (path: string): string | null => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD_REF}:src/ui/${path}`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { return null; } };
const free = () => 48000 + Math.floor(Math.random() * 900);

mkdirSync(OUT, { recursive: true });
const keys = mkdtempSync(join(OUT, "hub-preview-e-keys-")); chmodSync(keys, 0o700);
const servers: Server[] = [], rigs: any[] = [];
const listen = async (port: number, handler: (req: any, res: any) => void) => {
  const s = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) }, handler);
  await new Promise<void>((resolve) => s.listen(port, "127.0.0.1", resolve)); servers.push(s); return s;
};
await provisionHubIdentity({ home: keys, memberOrigin: "https://127.0.0.1:9" });

/** One Hub: its web listener, and (offered) its preview listener at its own port. */
async function hub(offered: boolean) {
  let port = free(), pport = free();
  while (pport === port) pport = free();
  const origin = `https://127.0.0.1:${port}`, boot = randomUUID().replace(/-/g, "");
  const settings = offered && preview ? { host: "127.0.0.1", port: pport, origin: `https://127.0.0.1:${pport}` } : null;
  const view = preview ? preview.hubPreviewView(origin, settings, boot) : undefined;
  const rig = await s3bRig({ webOrigin: origin, ...(view ? { preview: view } : {}) }); rigs.push(rig);
  await listen(port, (req, res) => { if (!rig.http.handle(req, res)) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found"); } });
  if (settings) await listen(pport, preview.createHubPreviewHandler(settings, origin, boot, () => true));
  // The world: olivia's fleet publishes two agents; alex may ask both.
  const olivia = rig.addPerson("olivia", "Olivia Chen"); rig.addPerson("alex", "Alex Lin");
  const fleetId = randomUUID(), link = rig.link(fleetId, olivia);
  const sales = randomUUID(), design = randomUUID();
  const exposure = (id: string, name: string) => ({ id, fleetId, owner: olivia, displayName: name, revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
  await rig.http.receive(rig.frame("exposure.snapshot", { revision: 1, exposures: [exposure(sales, "Sales numbers"), exposure(design, "Design guide")] }, link) as never, link);
  for (const login of ["olivia", "alex"]) await rig.signIn(login);
  const o0 = await rig.signIn("olivia");
  for (const id of [sales, design]) await rig.call(o0, "POST", "/hub/v1/grants", { exposureId: id, exposureRevision: 1, login: "alex", days: 7 });
  async function answer(question: string, text: string) {
    const sentQ = () => rig.sent.map((x: any) => x.frame).find((f: any) => f.type === "question" && f.payload.text === question);
    for (let i = 0; i < 80 && !sentQ(); i++) await new Promise((res) => setTimeout(res, 50));
    const q = sentQ() as any;
    const messageId = q?.payload?.identity?.messageId, answerId = randomUUID();
    const lease = await rig.http.receive(rig.frame("authorize.request", { messageId, operationId: randomUUID(), exposureRevision: 1, phase: "release-answer", answer: { answerId, contentDigest: sha(text) } }, link) as never, link) as any;
    await rig.http.receive(rig.frame("answer", { messageId, answerId, text, contentDigest: sha(text), releaseLease: lease.payload.lease }, link) as never, link);
    return !!q;
  }
  return { rig, origin, previewOrigin: settings?.origin ?? null, answer };
}

const pw = createRequire(PW + "/")("playwright-core");
const browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });
const CASES = [{ device: "desk", lang: "en", theme: "light", viewport: { width: 1366, height: 860 } }, { device: "phone", lang: "zh-TW", theme: "dark", viewport: { width: 390, height: 844 } }] as const;
const ALLOWED = /^\/(hub\/v1\/|assets\/|ui\/js\/(panel-hub|hub-client|hub-strings|hub-chat-store|hub-chat-strings|hub-quota|hub-owner-strings|hub-button-actions|hub-preview)\.js|ui\/hub|favicon)/;
const until = async (page: any, js: string, ms = 15000) => { for (let i = 0; i < ms / 250; i++) { if (await page.evaluate(js)) return true; await page.waitForTimeout(250); } return false; };

async function open(h: Awaited<ReturnType<typeof hub>>, c: (typeof CASES)[number], route?: (page: any) => Promise<void>) {
  const ctx = await browser.newContext({ viewport: c.viewport, colorScheme: c.theme, locale: c.lang === "zh-TW" ? "zh-TW" : "en-US", ignoreHTTPSErrors: true,
    isMobile: c.device === "phone", hasTouch: c.device === "phone", deviceScaleFactor: 2 });
  await ctx.addInitScript({ content: `if (window === window.top) { try { localStorage.setItem("agend_lang", ${JSON.stringify(c.lang)}); localStorage.setItem("agend_tour_done", "1"); } catch {}
    window.__csp = []; document.addEventListener("securitypolicyviolation", e => window.__csp.push(e.violatedDirective + " " + (e.blockedURI || ""))); }` });
  const page = await ctx.newPage();
  const errs: string[] = [], foreign: string[] = [];
  page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  page.on("request", (q: any) => { const u = new URL(q.url()); if (u.origin === h.origin && !ALLOWED.test(u.pathname)) foreign.push(u.pathname); else if (u.origin !== h.origin && u.origin !== h.previewOrigin && !u.protocol.startsWith("data")) foreign.push(q.url()); });
  if (route) await route(page);
  await page.goto(h.origin + "/ui/hub"); await page.waitForTimeout(1200);
  return { ctx, page, errs, foreign, csp: () => page.evaluate("window.__csp || []") as Promise<string[]> };
}
async function room(h: Awaited<ReturnType<typeof hub>>, a: Awaited<ReturnType<typeof open>>, c: (typeof CASES)[number], agent: string, again = "") {
  await a.page.waitForSelector("#hubLogin", { timeout: 10000 });
  await a.page.fill("#hubLogin", "alex"); await a.page.fill("#hubPassword", "pw-alex");
  await a.page.click(".hub-signin button[type=submit]");
  await a.page.waitForSelector(".hub-home", { timeout: 10000 });
  await a.page.click(c.device === "desk" ? ".sidebar .hub-new" : ".hub-home .hub-new");
  await a.page.waitForSelector(".hub-pick-row", { timeout: 10000 });
  await a.page.evaluate(`[...document.querySelectorAll(".hub-pick-row")].find((x) => x.querySelector(".t").textContent === ${JSON.stringify(agent)}).querySelector("button").click()`);
  await a.page.waitForSelector(".hub-chat-main", { timeout: 10000 });
  const en = c.lang === "en";
  const question = (en ? "Make the Q3 report a page I can look at." : "把第三季營收整理成一頁報告。") + again;
  await a.page.fill("#msgIn", question); await a.page.click("#sendBtn");
  const bar = (m: string, v: number, top: number) => `<div class="b"><i style="height:${top}%"></i><span>${m}</span><b>${v}</b></div>`;
  const PAGE = `<!doctype html><meta charset="utf-8"><title>${en ? "Q3 report" : "第三季營收報告"}</title>
<style>body{font:15px system-ui,sans-serif;margin:0;padding:18px;color:#172033;background:#fff}h1{font-size:20px;margin:0 0 12px}
.k{display:flex;gap:8px;margin-bottom:14px}.k div{flex:1;background:#f1f4f9;border-radius:8px;padding:8px 10px}.k small{display:block;color:#5b6475}.k strong{font-size:18px}
.c{display:flex;align-items:flex-end;gap:12px;height:150px;border-bottom:1px solid #d6dbe4}.b{flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%;align-items:center}
.b i{display:block;width:100%;background:#4c63d2;border-radius:4px 4px 0 0}.b span{font-size:12px;color:#5b6475;margin-top:4px}.b b{font-size:12px}p{color:#5b6475;font-size:13px}</style>
<h1 id="title">${en ? "Q3 revenue" : "第三季營收"}</h1>
<div class="k"><div><small>${en ? "Revenue" : "營收"}</small><strong>42.8 M</strong></div><div><small>${en ? "Growth" : "成長"}</small><strong>+12%</strong></div><div><small>${en ? "Margin" : "毛利"}</small><strong>38%</strong></div></div>
<div class="c">${bar(en ? "Jul" : "7 月", 13.1, 62)}${bar(en ? "Aug" : "8 月", 14.0, 74)}${bar(en ? "Sep" : "9 月", 15.7, 92)}</div>
<p id="src">${en ? "Source: finance export (sample)" : "資料來源：財務系統匯出（範例）"}</p>`;
  const text = (en ? "Here is the page." : "做好了，可以直接預覽。") + "\n\n```html\n" + PAGE + "\n```";
  const sent = await h.answer(question, text);
  const card = await until(a.page, `!!document.querySelector(".msg.agent .html-card, .msg.agent .pv-run")`, 30000);
  return { sent, card };
}

try {
  const h = await hub(true);
  for (const c of CASES) {
    const tag = `${c.device}-${c.theme}-${c.lang}`, en = c.lang === "en";
    const a = await open(h, c);
    const { sent, card } = await room(h, a, c, c.device === "desk" ? "Sales numbers" : "Design guide");
    await a.page.waitForTimeout(400);
    await a.page.screenshot({ path: shot(`${tag}-1-answer-card`) });
    if (BASE) {
      // Before E: the card's Preview, wherever it leads.
      const run = await a.page.$(".msg.agent .pv-run");
      const shown = !!run && await run.isVisible();
      if (shown) { await run.click(); await a.page.waitForTimeout(800); }
      r[`${tag}-before-preview-shown`] = shown;
      await a.page.screenshot({ path: shot(`${tag}-2-preview-click`) });
      const before = await a.page.evaluate(`({ open: !!document.querySelector(".msg.agent .pv-open"), note: document.querySelector(".msg.agent .pv-note")?.textContent || "", panel: !!document.querySelector(".pv-panel") })`);
      check(tag, sent && card, { sent, card, before }); r[`${tag}-before`] = before;
      await a.ctx.close();
      continue;
    }
    // Open in panel → this browser has not allowed previews: the panel's Allow, in the Hub's words.
    await a.page.click(".msg.agent .pv-open");
    await a.page.waitForSelector(".pv-panel .pv-panel-allow", { timeout: 10000 });
    const placed = await a.page.evaluate(`({ inRoom: !!document.querySelector(".hub-chat > .pv-panel"), rail: !!document.querySelector(".hub-chat > .u-rail"), share: document.querySelectorAll(".pv-fb-share, .pv-fb-shared").length })`);
    await a.page.click(".pv-panel .pv-panel-allow");
    await a.page.waitForSelector("dialog [data-confirm=yes]", { timeout: 10000 });
    const ask = await a.page.evaluate(`document.querySelector("dialog")?.innerText || ""`);
    await a.page.screenshot({ path: shot(`${tag}-2-allow-in-hub-words`) });
    await a.page.click("dialog [data-confirm=yes]");
    // The page runs in the frame at the Hub's preview origin.
    const frame = a.page.frameLocator(".pv-panel .pv-holder iframe");
    await frame.locator("#title").waitFor({ timeout: 15000 });
    await a.page.waitForTimeout(500);
    const run = await a.page.evaluate(`(() => { const f = document.querySelector(".pv-panel .pv-holder iframe"), p = document.querySelector(".pv-panel").getBoundingClientRect();
      return { src: f?.getAttribute("src"), sandbox: f?.getAttribute("sandbox"), right: Math.round(innerWidth - p.right), width: Math.round(p.width), rail: !!document.querySelector(".hub-chat > .u-rail"),
        bar: [...document.querySelectorAll(".pv-panel button")].map((b) => b.className.split(" ").find((x) => x.startsWith("pv-fb"))).filter(Boolean), stored: localStorage.getItem("agend_html_preview") }; })()`);
    run.title = await frame.locator("#title").textContent();
    await a.page.screenshot({ path: shot(`${tag}-3-page-in-panel`) });
    // Point at it: a click in the page puts its line in the composer (on a phone the sheet closes so the composer shows).
    await a.page.click(".pv-panel .pv-fb-pick");
    await a.page.waitForTimeout(300);
    await frame.locator("#src").click();
    const picked = await until(a.page, `(document.querySelector("#msgIn")?.value || "").includes("#src")`, 8000);
    const afterPick = await a.page.evaluate(`document.querySelector("#msgIn").value`);
    await a.page.screenshot({ path: shot(`${tag}-4-point-at-it`) });
    // Reply about this page: its line once (the panel again on a phone).
    if (!(await a.page.$(".pv-panel"))) { await a.page.click(".msg.agent .pv-open"); await a.page.waitForSelector(".pv-panel .pv-fb-reply", { timeout: 10000 }); }
    await a.page.click(".pv-panel .pv-fb-reply");
    if (!(await a.page.$(".pv-panel"))) { await a.page.click(".msg.agent .pv-open"); await a.page.waitForSelector(".pv-panel .pv-fb-reply", { timeout: 10000 }); }
    await a.page.click(".pv-panel .pv-fb-reply");
    await a.page.waitForTimeout(300);
    const draft = await a.page.evaluate(`document.querySelector("#msgIn").value`);
    const aboutLines = draft.split("\n").filter((l: string) => /Q3 report|第三季營收報告/.test(l)).length;
    await a.page.screenshot({ path: shot(`${tag}-5-reply-about`) });
    let railBack = true;
    if (c.device === "desk") {
      if (!(await a.page.$(".pv-panel"))) await a.page.click(".msg.agent .pv-open");
      await a.page.waitForSelector(".pv-panel", { timeout: 10000 });
      await a.page.click(".hub-chat-head button[aria-pressed]");
      railBack = await until(a.page, `!!document.querySelector(".hub-chat > .u-rail") && !document.querySelector(".pv-panel")`, 5000);
      await a.page.screenshot({ path: shot(`${tag}-6-info-brings-rail-back`) });
    }
    const csp = await a.csp();
    check(tag, sent && card && placed.inRoom && !placed.rail && placed.share === 0
      && /this Hub in this browser only|只對這個瀏覽器裡的這個 Hub 有效/.test(ask) && !/every device|每一台/.test(ask)
      && run.src === `${h.previewOrigin}/frame` && run.sandbox === "allow-scripts" && run.right <= 2 && !run.rail && run.stored === "on"
      && run.bar.includes("pv-fb-pick") && run.bar.includes("pv-fb-reply") && !run.bar.includes("pv-fb-share") && /Q3|第三季/.test(run.title || "")
      && picked && aboutLines === 1 && railBack && a.errs.length === 0 && a.foreign.length === 0 && csp.length === 0,
      { sent, card, placed, ask: ask.slice(0, 160), run, picked, afterPick, draft, aboutLines, railBack, errs: a.errs, foreign: a.foreign, csp });
    await a.ctx.close();
  }

  if (!BASE) {
    // Not offered: a Hub without hub.web.preview_port.
    const off = await hub(false);
    for (const c of CASES) {
      const tag = `${c.device}-${c.theme}-${c.lang}`;
      const a = await open(off, c);
      const { card } = await room(off, a, c, "Sales numbers");
      await a.page.click(".msg.agent .pv-open");
      await a.page.waitForSelector(".pv-panel", { timeout: 10000 });
      await a.page.waitForTimeout(400);
      const said = await a.page.evaluate(`document.querySelector(".pv-panel")?.innerText || ""`);
      const frames = await a.page.evaluate(`document.querySelectorAll("iframe").length`);
      await a.page.screenshot({ path: shot(`${tag}-7-not-offered`) });
      check(`${tag}-not-offered`, card && /Previews are not offered on this Hub|這個 Hub 不提供預覽/.test(said) && frames === 0 && a.errs.length === 0 && (await a.csp()).length === 0,
        { card, said: said.slice(0, 200), frames, errs: a.errs });
      await a.ctx.close();
    }

    // ── the stale-tab skew: the old shell with this branch's lazy Hub modules ──
    const oldShell = async (page: any) => {
      await page.route("**/assets/**", (route: any) => {
        const file = new URL(route.request().url()).pathname.replace(/^\/assets\//, "");
        const body = old(`shared/${file}`);
        return body === null ? route.continue() : route.fulfill({ status: 200, contentType: file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body });
      });
    };
    const c = CASES[0];
    const s = await open(h, c, oldShell);
    const { card } = await room(h, s, c, "Design guide", " (again)");
    await s.page.click(".msg.agent .pv-open");
    const ok = await s.page.waitForSelector(".pv-panel", { timeout: 10000 }).then(() => true, () => false);
    await s.page.screenshot({ path: shot("skew-old-shell-new-lazy") });
    check("skew-old-shell-new-lazy", card && ok && s.errs.length === 0, { card, ok, errs: s.errs });
    await s.ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  mkdirSync(join(OUT, "hub-preview-e"), { recursive: true });
  writeFileSync(join(OUT, "hub-preview-e", `result-${LABEL}.json`), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await browser.close();
  for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
  for (const g of rigs) await g.close();
  rmSync(keys, { recursive: true, force: true });
  process.exit(fail.length ? 1 : 0);
}
