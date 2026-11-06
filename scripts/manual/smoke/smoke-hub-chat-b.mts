// #3226 B: the Hub as a chat app, in a real browser on a REAL Hub web listener (createHubHttp's handle() behind
// node:https on 127.0.0.1, as smoke-hub-s3b.mts: the agreed S5 fakes from tests/helpers/hub-s3b-rig.ts, a fake directory,
// the member driven in-process through S3's own receive()). No fleet runs.
// - Hub-only boot: the page asks the Hub for nothing but /hub/v1/*, /assets/*, its own /ui/js modules and its pages.
// - the chats: signed in, the list (sidebar on a wide screen, the page on a phone) and "pick a chat"; New chat lists what
//   is granted (who it answers for, until when); Ask opens the room: the shared-conversation notice before anyone types;
//   a question shows at once with its stage mark; the member answers (Markdown: a list, a table, code) and one paced poll
//   brings it, drawn by the fleet chat's own thread; the room's waiting mark in the list; the right-hand panel (the usage
//   rail's frame: the agent, your access, who sees it, what is not here) closes and stays closed on reload; on a phone the
//   panel is a sheet; the session's menu holds My shared agents and Administration; a revoked grant closes the room.
// - the stale-tab skew (rule 3): the old shell (every long-lived /assets file from OLD_REF) with this branch's lazy Hub
//   modules: the Hub page still signs in and shows the chats.
// Desk light/en and phone dark/zh-TW; screenshots under OUT/hub-chat-b.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> [OLD_REF=songsid/release/2.3.5-alpha] FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-hub-chat-b.mts
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

const REPO = process.env.REPO!, OUT = process.env.OUT!, PW = process.env.PW_DIR!;
const BUTTONS_F = process.env.BUTTONS_F === "1";
const { messageContentDigest } = await import(REPO + "/src/hub/identity.ts");
const { prepareHubAnswerButtons, buttonsDigest } = await import(REPO + "/src/hub/buttons-model.ts");
const OLD_REF = process.env.OLD_REF ?? "songsid/release/2.3.5-alpha";
const { s3bRig } = await import(REPO + "/tests/helpers/hub-s3b-rig.ts");
const { provisionHubIdentity } = await import(REPO + "/src/hub/tls.ts");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const r: Record<string, unknown> = { oldRef: OLD_REF };
const fail: string[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { r[name] = ok ? "PASS" : { FAIL: detail ?? true }; if (!ok) fail.push(name); };
const shot = (name: string) => { const d = join(OUT, "hub-chat-b"); mkdirSync(d, { recursive: true }); return join(d, `${name}.png`); };
const old = (path: string): string | null => { try { return execFileSync("git", ["-C", REPO, "show", `${OLD_REF}:src/ui/${path}`], { encoding: "utf8", maxBuffer: 16 << 20 }); } catch { return null; } };

const port = 48900 + Math.floor(Math.random() * 90), origin = `https://127.0.0.1:${port}`;
const rig = await s3bRig({ webOrigin: origin });
const http = rig.http;
mkdirSync(OUT, { recursive: true });
const keys = mkdtempSync(join(OUT, "hub-chat-b-keys-")); chmodSync(keys, 0o700);
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!http.handle(req, res)) { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found"); } });
await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

// The world: olivia's fleet publishes two agents; alex is granted both; admin administers.
const olivia = rig.addPerson("olivia", "Olivia Chen"), alex = rig.addPerson("alex", "Alex Lin");
const fleetId = randomUUID(), link = rig.link(fleetId, olivia);
if (BUTTONS_F) (link.features as Set<string>).add("buttons-v1");
const sales = randomUUID(), design = randomUUID();
const exposure = (id: string, name: string) => ({ id, fleetId, owner: olivia, displayName: name, revision: 1, state: "published", dataViewId: "agent", allowedTools: [], policyDigest: "b".repeat(64) });
await http.receive(rig.frame("exposure.snapshot", { revision: 1, exposures: [exposure(sales, "Sales numbers"), exposure(design, "Design guide")] }, link) as never, link);
void alex;

const pw = createRequire(PW + "/")("playwright-core");
const browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });
const CASES = [{ device: "desk", lang: "en", theme: "light", viewport: { width: 1366, height: 860 } }, { device: "phone", lang: "zh-TW", theme: "dark", viewport: { width: 390, height: 844 } }] as const;
const ALLOWED = /^\/(hub\/v1\/|assets\/|ui\/js\/(panel-hub|hub-client|hub-strings|hub-chat-store|hub-chat-strings|hub-quota|hub-button-actions)\.js|ui\/hub|favicon)/;

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
  await page.goto(origin + path); await page.waitForTimeout(1200);
  return { ctx, page, errs, foreign, csp: () => page.evaluate("window.__csp || []") as Promise<string[]> };
}
async function signIn(page: any, login: string, password = `pw-${login}`) {
  await page.waitForSelector("#hubLogin", { timeout: 10000 });
  await page.fill("#hubLogin", login); await page.fill("#hubPassword", password);
  await page.click(".hub-signin button[type=submit]");
}
const until = async (page: any, js: string, ms = 15000) => { for (let i = 0; i < ms / 250; i++) { if (await page.evaluate(js)) return true; await page.waitForTimeout(250); } return false; };
async function answer(question: string, text: string, buttons?: any) {
  const sentQ = () => rig.sent.map((x: any) => x.frame).find((f: any) => f.type === "question" && f.payload.text === question);
  for (let i = 0; i < 80 && !sentQ(); i++) await new Promise((res) => setTimeout(res, 50));
  const q = sentQ() as any;
  const messageId = q?.payload?.identity?.messageId, answerId = randomUUID();
  const digest = messageContentDigest("answer", text, { buttonsDigest: buttonsDigest(buttons) });
  const lease = await http.receive(rig.frame("authorize.request", { messageId, operationId: randomUUID(), exposureRevision: 1, phase: "release-answer", answer: { answerId, contentDigest: digest } }, link) as never, link) as any;
  await http.receive(rig.frame("answer", { messageId, answerId, text, ...(buttons ? { buttons } : {}), contentDigest: digest, releaseLease: lease.payload.lease }, link) as never, link);
  return !!q;
}

try {
  for (const login of ["olivia", "alex"]) await rig.signIn(login);
  const o0 = await rig.signIn("olivia");
  const grants: Record<string, any> = {};
  for (const id of [sales, design]) grants[id] = (await rig.call(o0, "POST", "/hub/v1/grants", { exposureId: id, exposureRevision: 1, login: "alex", days: 7 })).json.grant;

  for (const c of CASES) {
    const tag = `${c.device}-${c.theme}-${c.lang}`, en = c.lang === "en";
    const agent = c.device === "desk" ? "Sales numbers" : "Design guide";   // each case opens a room of its own (its first question)
    const a = await open(c, "/ui/hub");
    await signIn(a.page, "alex");
    await a.page.waitForSelector(".hub-home", { timeout: 10000 });
    await a.page.screenshot({ path: shot(`${tag}-1-home`) });
    // New chat: what is granted, who it answers for.
    await a.page.click(c.device === "desk" ? ".sidebar .hub-new" : ".hub-home .hub-new");
    await a.page.waitForSelector(".hub-pick-row", { timeout: 10000 });
    const picks = await a.page.evaluate(`[...document.querySelectorAll(".hub-pick-row .t")].map((x) => x.textContent)`);
    await a.page.screenshot({ path: shot(`${tag}-2-new-chat`) });
    await a.page.evaluate(`[...document.querySelectorAll(".hub-pick-row")].find((x) => x.querySelector(".t").textContent === ${JSON.stringify(agent)}).querySelector("button").click()`);
    await a.page.waitForSelector(".hub-chat-main", { timeout: 10000 });
    const emptyOk = await until(a.page, `!!document.querySelector(".hub-room-empty")`);
    const notice = await a.page.evaluate(`document.querySelector(".hub-room-empty")?.textContent || ""`);
    await a.page.screenshot({ path: shot(`${tag}-3-room-empty`) });
    // Ask: it shows at once with its stage.
    const question = en ? "Summarise Q3 sales by region, please." : "請依地區整理第三季營收。";
    await a.page.fill("#msgIn", question); await a.page.click("#sendBtn");
    const shownAtOnce = await until(a.page, `!!document.querySelector(".msg.user .tick")`, 5000);
    const tick = await a.page.evaluate(`document.querySelector(".msg.user .tick")?.getAttribute("aria-label") || ""`);
    await a.page.screenshot({ path: shot(`${tag}-4-asked`) });
    const md = en ? "Q3 by region:\n\n| Region | Sales |\n| --- | --- |\n| North | 18.2 M |\n| South | 23.8 M |\n\n- **South** grew 12%\n- North held flat\n\n```sql\nSELECT region, SUM(amount) FROM sales GROUP BY region;\n```"
      : "第三季各地區：\n\n| 地區 | 營收 |\n| --- | --- |\n| 北區 | 1,820 萬 |\n| 南區 | 2,380 萬 |\n\n- **南區**成長 12%\n- 北區持平\n\n```sql\nSELECT region, SUM(amount) FROM sales GROUP BY region;\n```";
    const choice = BUTTONS_F ? prepareHubAnswerButtons([{ label: en ? "Details" : "查看細節", value: "details" }, { label: en ? "Summary" : "保留摘要", value: "summary" }]) : undefined;
    const sent = await answer(question, md, choice);
    const answered = await until(a.page, `!!document.querySelector(".msg.agent .body table")`, 30000);
    const marks = await a.page.evaluate(`({ tick: document.querySelector(".msg.user .tick")?.getAttribute("aria-label"), code: !!document.querySelector(".msg.agent pre code"), sender: document.querySelector(".msg.agent .sender")?.textContent })`);
    await a.page.screenshot({ path: shot(`${tag}-5-answered`) });
    if (BUTTONS_F) {
      const nextQuestion = async (after: number) => {
        for (let i = 0; i < 200; i++) {
          const found = rig.sent.slice(after).find((v: any) => v.frame.type === "question");
          if (found) return (found.frame as any).payload;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error("No ordinary question after Hub choice");
      };
      await a.page.locator(".rb-btn").first().scrollIntoViewIfNeeded();
      await a.page.screenshot({ path: shot(`${tag}-f-before-button`) });
      const beforeClick = rig.sent.length;
      await a.page.locator(".rb-row:not(.poll) .rb-btn").first().click();
      const clicked = await nextQuestion(beforeClick);
      check(`${tag}-f-button-question`, clicked.text === `[button] ${en ? "Details" : "查看細節"} (value: details)`);
      const poll = prepareHubAnswerButtons([{ label: en ? "Option A" : "方案 A", value: "a" }, { label: en ? "Option B" : "方案 B", value: "b" }],
        { seconds: 120, multi: false, reveal: "close", showVoters: true, question: en ? "Which option?" : "選擇哪個方案？" });
      await answer(clicked.text, en ? "Which option?" : "選擇哪個方案？", poll);
      await a.page.locator(".rb-row.poll .rb-btn").first().waitFor({ timeout: 30000 });
      await a.page.locator(".rb-row.poll .rb-btn").first().scrollIntoViewIfNeeded();
      await a.page.screenshot({ path: shot(`${tag}-f-before-vote`) });
      const beforeVote = rig.sent.length;
      await a.page.locator(".rb-row.poll .rb-btn").first().click();
      const results = await nextQuestion(beforeVote);
      check(`${tag}-f-poll-question`, results.text.startsWith("[poll results]") && results.text.includes("(value: a) — 1"));
      const finalText = en ? "Poll result received." : "已收到投票結果。";
      await answer(results.text, finalText);
      const visible = await until(a.page, `document.querySelector(".hub-thread")?.textContent.includes(${JSON.stringify(finalText)}) || [...document.querySelectorAll(".msg.agent .body")].some(x => x.textContent.includes(${JSON.stringify(finalText)}))`, 30000);
      const control = await a.page.locator(".rb-row.poll").evaluate((x: Element) => ({ disabled: [...x.querySelectorAll("button")].every(b => b.disabled), text: x.textContent }));
      check(`${tag}-f-closed`, visible && control.disabled && control.text.includes("100%"), control);
      await a.page.locator(".rb-row.poll").scrollIntoViewIfNeeded();
      await a.page.screenshot({ path: shot(`${tag}-f-after-vote`) });
    }
    // The room fills the page beside the sidebar, its composer at the bottom; the list no longer says "waiting".
    const layout = await a.page.evaluate(`(() => { const m = document.querySelector(".hub-chat").getBoundingClientRect(), c = document.querySelector(".composer").getBoundingClientRect();
      return { right: Math.round(innerWidth - m.right), composerGap: Math.round(innerHeight - c.bottom) }; })()`);
    await a.page.evaluate(`import("/ui/js/panel-hub.js").then((m) => m.refreshRooms())`); await a.page.waitForTimeout(400);
    layout.stillWaiting = await a.page.evaluate(`!!document.querySelector(".sidebar .hub-room-row.active .pulse, .sidebar .hub-room-row .pulse")`);
    // The right-hand panel (desk: the rail, open; phone: the sheet behind ⓘ).
    let rail: any;
    if (c.device === "desk") {
      rail = await a.page.evaluate(`({ title: document.querySelector(".hub-chat .u-rail h2")?.textContent, cards: document.querySelectorAll(".hub-chat .u-rail .u-provider").length })`);
      await a.page.click(".hub-chat .u-rail .u-rail-head button");
      await a.page.waitForTimeout(300);
      await a.page.screenshot({ path: shot(`${tag}-6-rail-closed`) });
      await a.page.reload(); await a.page.waitForSelector(".hub-chat-main", { timeout: 10000 }); await a.page.waitForTimeout(800);
      rail.closedAfterReload = await a.page.evaluate(`!document.querySelector(".hub-chat .u-rail")`);
      await a.page.click(".hub-chat-head button[aria-pressed]"); await a.page.waitForTimeout(300);
      rail.reopened = await a.page.evaluate(`!!document.querySelector(".hub-chat .u-rail")`);
    } else {
      await a.page.click(".hub-chat-head button[aria-label]:last-of-type"); await a.page.waitForTimeout(500);
      rail = await a.page.evaluate(`({ sheet: !!document.querySelector("dialog .hub-rail-sheet"), cards: document.querySelectorAll("dialog .hub-rail-sheet .u-provider").length })`);
      await a.page.screenshot({ path: shot(`${tag}-6-info-sheet`) });
      await a.page.keyboard.press("Escape"); await a.page.waitForTimeout(300);
    }
    // The list: this room (and the session's menu).
    if (c.device === "phone") { await a.page.evaluate(`import("/assets/app-shell.js").then((m) => m.openDrawer())`); await a.page.waitForTimeout(500); }
    const list = await a.page.evaluate(`[...document.querySelectorAll(".sidebar .hub-room-row .t")].map((x) => x.textContent)`);
    await a.page.click(".sidebar .hub-session button"); await a.page.waitForTimeout(300);
    // Shown, not just present: each item is inside the viewport and the topmost element at its centre.
    const menu = await a.page.evaluate(`[...document.querySelectorAll(".sidebar [role=menuitem]")].filter((x) => { const b = x.getBoundingClientRect();
      return b.height > 0 && b.top >= 0 && b.bottom <= innerHeight && document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest("[role=menuitem]") === x; }).map((x) => x.textContent.trim())`);
    await a.page.screenshot({ path: shot(`${tag}-7-list-and-menu`) });
    await a.page.keyboard.press("Escape");
    check(`${tag}-chat`, picks.includes("Sales numbers") && picks.includes("Design guide") && emptyOk && /one conversation|同一段對話/.test(notice) && shownAtOnce && tick.length > 0
      && sent && answered && marks.code && marks.sender === agent && list.includes(agent) && menu.length === 3
      && layout.right <= 2 && layout.composerGap < 140 && !layout.stillWaiting
      && (c.device === "desk" ? rail.title && rail.cards >= 3 && rail.closedAfterReload && rail.reopened : rail.sheet && rail.cards >= 3)
      && a.errs.length === 0 && a.foreign.length === 0 && (await a.csp()).length === 0,
      { picks, emptyOk, notice: notice.slice(0, 80), shownAtOnce, tick, sent, answered, marks, rail, list, menu, layout, errs: a.errs, foreign: a.foreign, csp: await a.csp() });
    await a.ctx.close();
  }

  // A revoked grant closes the room (the next poll says so, and no composer is left).
  {
    const c = CASES[0];
    const a = await open(c, "/ui/hub");
    await signIn(a.page, "alex");
    await a.page.waitForSelector(".sidebar .hub-room-row", { timeout: 10000 });
    await a.page.evaluate(`[...document.querySelectorAll(".sidebar .hub-room-row")].find((x) => x.querySelector(".t").textContent === "Sales numbers").click()`);
    await a.page.waitForSelector(".hub-chat-main", { timeout: 10000 });
    const g = grants[sales];
    await rig.call(o0, "DELETE", `/hub/v1/grants/${g.id}?revision=${g.revision}`);
    await a.page.reload();
    const closed = await until(a.page, `!!document.querySelector(".hub-banner.danger") && !document.querySelector("#msgIn")`, 30000);
    const named = await a.page.evaluate(`document.querySelector(".hub-chat-title strong")?.textContent || ""`);
    await a.page.screenshot({ path: shot("desk-light-en-8-closed") });
    check("closed-room", closed && named === "Sales numbers" && a.errs.length === 0, { closed, named, errs: a.errs });
    await a.ctx.close();
  }

  // ── the stale-tab skew: the old shell with this branch's lazy Hub modules ──
  const oldShell = async (page: any) => {
    await page.route("**/assets/**", (route: any) => {
      const file = new URL(route.request().url()).pathname.replace(/^\/assets\//, "");
      if (file === "hub.css" || file === "hub-chat.css") return route.continue();
      const body = old(`shared/${file}`);
      return body === null ? route.continue() : route.fulfill({ status: 200, contentType: file.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", body });
    });
  };
  {
    const s = await open(CASES[0], "/ui/hub", oldShell);
    await signIn(s.page, "alex");
    const ok = await s.page.waitForSelector(".hub-home, .hub-chat-main", { timeout: 10000 }).then(() => true, () => false);
    await s.page.screenshot({ path: shot("skew-old-shell-new-lazy") });
    check("skew-old-shell-new-lazy", ok && s.errs.length === 0, { ok, errs: s.errs, foreignRequests: s.foreign.slice(0, 12) });
    await s.ctx.close();
  }
} catch (e) {
  fail.push("error"); r.error = String((e as Error).stack ?? e).slice(0, 1500);
} finally {
  mkdirSync(join(OUT, "hub-chat-b"), { recursive: true });
  writeFileSync(join(OUT, "hub-chat-b", "result.json"), JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r, null, 1));
  console.log(fail.length ? `FAIL: ${fail.join(", ")}` : "ALL PASS");
  await browser.close(); await new Promise<void>((resolve) => server.close(() => resolve())); await rig.close();
  rmSync(keys, { recursive: true, force: true });
  process.exit(fail.length ? 1 : 0);
}
