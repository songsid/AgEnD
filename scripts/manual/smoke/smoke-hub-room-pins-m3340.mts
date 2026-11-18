/**
 * M-3340 (the user: personal pins): a Hub room's pins are each person's own. A real browser on a real Hub (HTTPS + SQLite; a
 * synthetic directory; no agent, Fleet, native process or account). Per case (desk light en, desk dark zh-TW, phone light zh-TW,
 * phone dark en): Alex opens the room, opens a message's menu (right-click; a phone's long press) → Pin; the header's 📌 (a desk)
 * and ⋯ say 1; the list says only Alex sees it and shows the message; a row shows it in the room; then Bob opens the same room —
 * no 📌, no pins, and his menu offers Pin (not Unpin). Pictures: <case>-<step>.png.
 * BASELINE=1 (the base): expects the gap (no Pin in the menu).
 *   REPO=<checkout> OUT=<dir> PW_DIR=<dir with playwright-core> [CHROME=<path>] [BASELINE=1] npx tsx scripts/manual/smoke/smoke-hub-room-pins-m3340.mts
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const repo = process.env.REPO!, out = process.env.OUT!, pwDir = process.env.PW_DIR!, baseline = process.env.BASELINE === "1";
if (!repo || !out || !pwDir) throw Error("REPO/OUT/PW_DIR required");
mkdirSync(out, { recursive: true });
const { s3bRig } = await import(repo + "/tests/helpers/hub-s3b-rig.ts");
const { freeHubPort } = await import(repo + "/tests/helpers/hub-rig.ts");
const { provisionHubIdentity } = await import(repo + "/src/hub/tls.ts");
const { personKeyString } = await import(repo + "/src/hub/identity.ts");
const port = await freeHubPort(), origin = `https://127.0.0.1:${port}`;
const rig = await s3bRig({ webOrigin: origin, attachments: true });   // rooms that take files (attachments-v1)
const keys = mkdtempSync(join(out, "owned-keys-")); chmodSync(keys, 0o700);
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const server = createServer({ key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) },
  (req, res) => { if (!rig.http.handle(req, res)) { res.writeHead(404); res.end(); } });
await new Promise<void>((r, j) => { server.once("error", j); server.listen(port, "127.0.0.1", r); });
const pw = createRequire(pwDir + "/")("playwright-core");
const browser = await pw.chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });
const receipt: any = { source: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), baseline, cases: [], pageErrors: [], foreign: [] };
const check = (ok: unknown, msg: string) => { if (!ok) throw Error(msg); };
const shot = async (p: any, n: string) => { await p.evaluate(() => document.fonts.ready); await p.screenshot({ path: join(out, n + ".png"), fullPage: false }); };
const admin = await rig.signIn("admin");
const cases = [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "light", lang: "zh-TW" }, { device: "phone", theme: "dark", lang: "en" }];
const W: any = { en: { pin: "Pin", unpin: "Unpin", title: "Pinned messages", only: "Only you see your pins." }, "zh-TW": { pin: "釘選", unpin: "取消釘選", title: "釘選的訊息", only: "只有你看得到你的釘選。" } };
const PINNED = "The release checklist is in the shared doc, section 3.";
try {
  for (const [i, c] of cases.entries()) {
    const tag = `${c.device}-${c.theme}-${c.lang}`, row: any = { tag, steps: {} }; receipt.cases.push(row);
    const la = "alex" + i, lb = "bob" + i, alex = rig.addPerson(la, "Alex"), bob = rig.addPerson(lb, "Bob");
    await rig.signIn(la); const bobApi = await rig.signIn(lb);
    const room = (await rig.call(admin, "POST", "/hub/v1/rooms", { name: `Pins ${tag}`, people: [personKeyString(alex), personKeyString(bob)] })).json.room.id as string;
    for (const text of ["Morning, all.", PINNED, "Rehearsal at 3pm."]) await rig.call(admin, "POST", `/hub/v1/rooms/${room}/messages`, { text, mentions: [], idempotencyKey: randomUUID() });
    const open = async (login: string) => {
      const ctx = await browser.newContext({ viewport: c.device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 }, isMobile: c.device === "phone",
        hasTouch: c.device === "phone", locale: c.lang === "en" ? "en-US" : "zh-TW", colorScheme: c.theme, ignoreHTTPSErrors: true });
      await ctx.addInitScript({ content: `window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});` });
      await ctx.route("**/*", (route: any) => { const u = new URL(route.request().url()); if (u.origin !== origin) { receipt.foreign.push(u.origin); return route.abort(); } return route.continue(); });
      const p = await ctx.newPage(); p.setDefaultTimeout(15000);
      p.on("pageerror", (e: any) => receipt.pageErrors.push(`${tag}: ${String(e)}`));
      await p.goto(origin + "/ui/hub"); await p.fill("#hubLogin", login); await p.fill("#hubPassword", "pw-" + login);
      await p.locator(".hub-signin button[type=submit]").click(); await p.locator(".hub-session-row").first().waitFor({ state: "attached" });
      await p.goto(`${origin}/ui/hub?room=${room}`); await p.getByText(PINNED).first().waitFor(); await p.waitForTimeout(600);
      // Whose page this is, from the page's own session (on a phone nothing on screen says who is signed in).
      const login2 = await p.evaluate(async () => (await (await fetch("/hub/v1/session", { credentials: "same-origin" })).json()).login);
      check(login2 === login, `the page is ${login}'s (session says ${login2})`);
      return { ctx, p, login: login2 };
    };
    const menuOn = async (p: any) => {
      const body = p.locator(".msg .body").filter({ hasText: PINNED }).first();
      if (c.device === "desk") await body.click({ button: "right" });
      else await body.evaluate((el: HTMLElement) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 })); });
      await p.waitForTimeout(300);
      return p.evaluate(() => [...document.querySelectorAll(".msg-menu button")].map((b) => (b.textContent || "").trim()));
    };
    const a = await open(la);
    row.steps.alexLogin = a.login;
    try {
      const items = await menuOn(a.p);
      row.steps.menu = items; await shot(a.p, `${tag}-1-menu`);
      if (baseline) { check(!items.includes(W[c.lang].pin), `baseline: expected no Pin (${JSON.stringify(items)})`); row.status = "BASELINE_REPRODUCED"; continue; }
      check(items.includes(W[c.lang].pin), `the menu has Pin (${JSON.stringify(items)})`);
      await a.p.locator(".msg-menu button").filter({ hasText: W[c.lang].pin }).first().click(); await a.p.waitForTimeout(600);
      row.steps.btn = c.device === "desk" ? await a.p.locator(".hub-room-pins-btn").innerText().catch(() => "") : "(phone: in ⋯)";
      await shot(a.p, `${tag}-2-pinned`);
      if (c.device === "desk") check(row.steps.btn === "1", `📌 says 1 (${row.steps.btn})`);
      await a.p.locator(".hub-room-menu > button").click(); await a.p.waitForTimeout(300);
      const menu = await a.p.evaluate(() => [...document.querySelectorAll(".menu-list [role^=menuitem]")].map((b) => (b.textContent || "").trim()));
      row.steps.roomMenu = menu; await shot(a.p, `${tag}-3-room-menu`);
      check(menu.includes(`${W[c.lang].title} · 1`), `⋯ lists the pins (${JSON.stringify(menu)})`);
      await a.p.locator(".menu-list [role^=menuitem]").filter({ hasText: W[c.lang].title }).first().click(); await a.p.waitForTimeout(400);
      const list = await a.p.evaluate(() => ({ only: document.querySelector(".hub-room-pins-only")?.textContent, rows: [...document.querySelectorAll(".hub-room-pins-dlg .chat-pin-text")].map((x) => x.textContent) }));
      row.steps.list = list; await shot(a.p, `${tag}-4-list`);
      check(list.only === W[c.lang].only && list.rows.length === 1 && list.rows[0] === PINNED, `the list: only me, the message (${JSON.stringify(list)})`);
      await a.p.locator(".hub-room-pins-dlg .chat-pin-go").first().click(); await a.p.waitForTimeout(250);
      row.steps.flash = await a.p.evaluate((t: string) => [...document.querySelectorAll(".msg.flash")].some((m) => (m.textContent || "").includes(t)), PINNED);
      await shot(a.p, `${tag}-5-shown`);
      check(row.steps.flash, "the row shows the message in the room (flashed)");
    } catch (e: any) { row.status = "FAIL"; row.error = String(e?.stack || e).slice(0, 800); await shot(a.p, `${tag}-FAIL`).catch(() => {}); continue; }
    finally { await a.ctx.close(); }
    // Bob, in the same room: nothing of Alex's.
    const b = await open(lb);
    try {
      // Bob's own page (its session says so), his message menu, and the room's ⋯ — where Alex's says "Pinned messages · 1"
      // and his must not: the capture is of that menu, so it can't be taken for one of Alex's frames.
      const bobMenu = await menuOn(b.p);
      await b.p.keyboard.press("Escape"); await b.p.waitForTimeout(200);
      await b.p.locator(".hub-room-menu > button").click(); await b.p.waitForTimeout(300);
      const bobRoomMenu = await b.p.evaluate(() => [...document.querySelectorAll(".menu-list [role^=menuitem]")].map((x) => (x.textContent || "").trim()));
      const bobApiPins = (await rig.call(bobApi, "GET", `/hub/v1/rooms/${room}/pins`)).json.pins;
      row.steps.bob = { login: b.login, btn: await b.p.locator(".hub-room-pins-btn").count(), menu: bobMenu, roomMenu: bobRoomMenu, apiPins: bobApiPins };
      await shot(b.p, `${tag}-6-bob`);
      check(b.login === lb && row.steps.bob.btn === 0 && bobMenu.includes(W[c.lang].pin) && !bobMenu.includes(W[c.lang].unpin)
        && !bobRoomMenu.some((x: string) => x.startsWith(W[c.lang].title)) && Array.isArray(bobApiPins) && bobApiPins.length === 0,
        `Bob sees none of Alex's pins (${JSON.stringify(row.steps.bob)})`);
      row.status = "PASS";
    } catch (e: any) { row.status = "FAIL"; row.error = String(e?.stack || e).slice(0, 800); await shot(b.p, `${tag}-FAIL`).catch(() => {}); }
    finally { await b.ctx.close(); }
  }
} catch (e: any) { receipt.error = String(e?.stack || e).slice(0, 1500); }
finally {
  await browser.close(); await new Promise<void>(r => server.close(() => r())); await rig.close(); rmSync(keys, { recursive: true, force: true });
  receipt.status = !receipt.error && receipt.cases.length === cases.length && receipt.cases.every((x: any) => x.status === (baseline ? "BASELINE_REPRODUCED" : "PASS")) && !receipt.pageErrors.length ? "PASS" : "FAIL";
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ source: receipt.source, baseline, status: receipt.status, error: receipt.error, cases: receipt.cases.map((x: any) => ({ tag: x.tag, status: x.status, error: x.error, steps: x.steps })), pageErrors: receipt.pageErrors, foreign: receipt.foreign }));
}
process.exitCode = receipt.status === "PASS" ? 0 : 1;
