/**
 * M-3298: "@Person" in a Hub room, in two real browsers on a real Hub (HTTPS + SQLite; a synthetic directory; no agent, Fleet,
 * native process or account). Alex types "@Hub Admin …" in the room's web composer and sends it; the Hub Admin's own browser
 * then shows the room with the @ mark (the room list's "Mentioned you"). The request the page sent is recorded (its `mentions`).
 * BASELINE=1 (on the base, SMOKE_NAME=…-before): the same steps, expecting no mark (the bug).
 *   REPO=<checkout> OUT=<dir> PW_DIR=<dir with playwright-core> [CHROME=<path>] npx tsx scripts/manual/smoke/smoke-hub-room-person-mention-m3298.mts
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
const repo = process.env.REPO!, out = process.env.OUT!, pwDir = process.env.PW_DIR!, baseline = process.env.BASELINE === "1";
if (!repo || !out || !pwDir) throw Error("REPO/OUT/PW_DIR required");
mkdirSync(out, { recursive: true });
const { s3bRig } = await import(repo + "/tests/helpers/hub-s3b-rig.ts");
const { freeHubPort } = await import(repo + "/tests/helpers/hub-rig.ts");
const { provisionHubIdentity } = await import(repo + "/src/hub/tls.ts");
const { personKeyString } = await import(repo + "/src/hub/identity.ts");
const port = await freeHubPort(), origin = `https://127.0.0.1:${port}`;
const rig = await s3bRig({ webOrigin: origin });
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
const cases = [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }];
async function open(c: any, login: string) {
  const ctx = await browser.newContext({ viewport: c.device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 }, isMobile: c.device === "phone",
    hasTouch: c.device === "phone", locale: c.lang === "en" ? "en-US" : "zh-TW", colorScheme: c.theme, ignoreHTTPSErrors: true });
  await ctx.addInitScript({ content: `window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});` });
  await ctx.route("**/*", (route: any) => { const u = new URL(route.request().url()); if (u.origin !== origin) { receipt.foreign.push(u.origin); return route.abort(); } return route.continue(); });
  const p = await ctx.newPage(); p.setDefaultTimeout(15000);
  p.on("pageerror", (e: any) => receipt.pageErrors.push(`${login}: ${String(e)}`));
  await p.goto(origin + "/ui/hub"); await p.fill("#hubLogin", login); await p.fill("#hubPassword", "pw-" + login);
  await p.locator(".hub-signin button[type=submit]").click();
  try { await p.locator(".hub-session-row").first().waitFor({ state: "attached" }); } catch (e) { await shot(p, `signin-${login}-FAIL`); writeFileSync(join(out, `signin-${login}.html`), await p.content()); throw e; }
  return { ctx, p };
}
try {
  for (const [i, c] of cases.entries()) {
    const tag = `${c.device}-${c.theme}-${c.lang}`, row: any = { tag, checks: [] }; receipt.cases.push(row);
    const login = "alex" + i, alex = rig.addPerson(login, "Alex"); await rig.signIn(login);
    const room = (await rig.call(admin, "POST", "/hub/v1/rooms", { name: `Weekly ${tag}`, people: [personKeyString(alex)] })).json.room.id as string;
    const a = await open(c, login);
    try {
      let sent: any = null;
      a.p.on("request", (r: any) => { if (r.method() === "POST" && new URL(r.url()).pathname === `/hub/v1/rooms/${room}/messages`) sent = JSON.parse(r.postData() || "{}"); });
      await a.p.goto(`${origin}/ui/hub?room=${room}`); await a.p.locator("#msgIn").waitFor();
      // Typed as a person types it: "@", the menu, the name it offers, then the rest.
      await a.p.locator("#msgIn").click(); await a.p.keyboard.type("@Hub");
      await a.p.getByText("@Hub Admin", { exact: true }).first().waitFor(); row.checks.push("the @ menu offers the person"); await shot(a.p, `${tag}-1-menu`);
      await a.p.locator("#msgIn").fill(""); await a.p.keyboard.type("@Hub Admin please look at the numbers");
      await a.p.locator("#sendBtn").click();
      const end = Date.now() + 10000; while (!sent && Date.now() < end) await new Promise(r => setTimeout(r, 50));
      check(sent, "the page sent nothing"); row.sentMentions = sent.mentions;
      await a.p.getByText("@Hub Admin please look at the numbers", { exact: false }).first().waitFor(); await shot(a.p, `${tag}-2-sent`);
    } finally { await a.ctx.close(); }
    const b = await open(c, "admin");
    try {
      const item = b.p.locator(`li[data-room="${room}"]`).first();
      // (On a phone the room list is in the closed drawer: drawn, not shown — read from the page as drawn.)
      await item.waitFor({ state: c.device === "phone" ? "attached" : "visible" });
      const marked = (await item.locator(".hub-room-at").count()) > 0;
      row.adminMark = marked; await shot(b.p, `${tag}-3-admin-list`);
      if (baseline) { check(!marked, "baseline: expected no @ mark (the bug)"); row.status = "BASELINE_REPRODUCED"; }
      else { check(marked, "the admin's room list has no @ mark"); check(Array.isArray(row.sentMentions) && row.sentMentions.length === 1, "the page did not send the person"); row.status = "PASS"; }
    } finally { await b.ctx.close(); }
  }
} catch (e: any) { receipt.error = String(e?.stack || e); }
finally {
  await browser.close(); await new Promise<void>(r => server.close(() => r())); await rig.close(); rmSync(keys, { recursive: true, force: true });
  receipt.status = receipt.cases.length === cases.length && receipt.cases.every((x: any) => x.status === (baseline ? "BASELINE_REPRODUCED" : "PASS")) && !receipt.pageErrors.length ? "PASS" : "FAIL";
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ source: receipt.source, baseline, status: receipt.status, cases: receipt.cases, pageErrors: receipt.pageErrors, foreign: receipt.foreign, error: receipt.error }));
}
process.exitCode = receipt.status === "PASS" ? 0 : 1;
