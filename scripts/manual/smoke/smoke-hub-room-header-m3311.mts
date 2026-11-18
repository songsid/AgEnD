/**
 * M-3311 (4): a Hub room's header on a phone is one row, as the Fleet chat's — back, the room (its name, then one line of
 * counts, not cut), members and ⋯; the name is not on the top edge; text size and Notify are in ⋯; the purpose is in the
 * members sheet. A desk's header is unchanged (its text size and Notify buttons, the purpose). Real browser, real Hub. Before that (the rig): M-3308: Ctrl+V in a Hub room's composer, in a real browser on a real Hub (HTTPS + SQLite; a synthetic directory; no agent,
 * Fleet, native process or account). A paste is what the browser hands the page: a ClipboardEvent whose clipboardData carries
 *   screenshot — a PNG with the name Chrome gives a screen capture ("image.png"), as Win+Shift+S / PrintScreen leave it;
 *   unnamed    — the same picture with no name (another browser's clipboard image);
 *   file       — a copied file (notes.txt);
 *   long       — 5,000 characters of text (the Fleet chat attaches it as a text file past 4,000).
 * Judged per case: the file chips under the box (names, all uploaded), then Send: the Hub's stored message has that many files,
 * and the picture is drawn in the thread. BASELINE=1 (the base): expects the phone header's three rows (the gap). Steps: a screenshot dragged over the conversation (the drop card, mid-drag),
 * dropped (its chip, then Send: the Hub stores it); a markdown file dropped; 5,000 characters pasted (the chip and the notice).
 * Cases: desk light en, desk dark zh-TW, phone light zh-TW, phone dark en. Pictures: <case>-<step>.png.
 *   REPO=<checkout> OUT=<dir> PW_DIR=<dir with playwright-core> [CHROME=<path>] npx tsx scripts/manual/smoke/smoke-hub-room-header-m3311.mts
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
const NAME = "每週主管會議 Weekly";
try {
  for (const [i, c] of cases.entries()) {
    const tag = `${c.device}-${c.theme}-${c.lang}`, row: any = { tag, steps: {} }; receipt.cases.push(row);
    const login = "alex" + i, alex = rig.addPerson(login, "Alex"); await rig.signIn(login);
    const room = (await rig.call(admin, "POST", "/hub/v1/rooms", { name: `${NAME} ${i}`, people: [personKeyString(alex)] })).json.room.id as string;
    row.steps.purposeSet = (await rig.call(admin, "PATCH", `/hub/v1/rooms/${room}`, { purpose: "Decide the release plan every Monday." })).status;
    await rig.call(admin, "POST", `/hub/v1/rooms/${room}/messages`, { text: "Agenda is up.", mentions: [], idempotencyKey: randomUUID() });
    const ctx = await browser.newContext({ viewport: c.device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 }, isMobile: c.device === "phone",
      hasTouch: c.device === "phone", locale: c.lang === "en" ? "en-US" : "zh-TW", colorScheme: c.theme, ignoreHTTPSErrors: true });
    await ctx.addInitScript({ content: `window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});` });
    await ctx.route("**/*", (route: any) => { const u = new URL(route.request().url()); if (u.origin !== origin) { receipt.foreign.push(u.origin); return route.abort(); } return route.continue(); });
    const p = await ctx.newPage(); p.setDefaultTimeout(15000);
    p.on("pageerror", (e: any) => receipt.pageErrors.push(`${tag}: ${String(e)}`));
    try {
      await p.goto(origin + "/ui/hub"); await p.fill("#hubLogin", login); await p.fill("#hubPassword", "pw-" + login);
      await p.locator(".hub-signin button[type=submit]").click(); await p.locator(".hub-session-row").first().waitFor({ state: "attached" });
      await p.goto(`${origin}/ui/hub?room=${room}`); await p.locator("#msgIn").waitFor(); await p.getByText("Agenda is up.").first().waitFor(); await p.waitForTimeout(500);
      const m = await p.evaluate(() => {
        const head = document.querySelector(".hub-room-page .hub-chat-head") as HTMLElement, r = head.getBoundingClientRect();
        const vis = (sel: string) => { const e = head.querySelector(sel) as HTMLElement | null; return !!e && getComputedStyle(e).display !== "none" && e.offsetWidth > 0; };
        const title = head.querySelector(".hub-chat-title strong") as HTMLElement, tr = title.getBoundingClientRect(), s = head.querySelector(".hub-chat-title .s") as HTMLElement;
        const back = head.querySelector(".hub-back") as HTMLElement, br = back && back.offsetWidth ? back.getBoundingClientRect() : null;
        return { height: Math.round(r.height), titleTop: Math.round(tr.top - r.top), oneRow: br ? tr.bottom > br.top && tr.top < br.bottom : true,
          countsCut: s ? s.scrollWidth > s.clientWidth + 1 : null, counts: s?.textContent, purpose: vis(".hub-room-purpose-trigger"), tools: vis(".hub-head-tools") };
      });
      row.steps.header = m; await shot(p, `${tag}-1-header`);
      if (c.device === "phone") {
        if (baseline) { check(m.height > 70 || m.titleTop < 4 || m.countsCut, `baseline: expected the three-row header (${JSON.stringify(m)})`); row.status = "BASELINE_REPRODUCED"; continue; }
        check(m.height <= 64, `one row (header ${m.height} px)`);
        check(m.oneRow, "the name beside back, not above it");
        check(m.titleTop >= 4, `the name not on the top edge (${m.titleTop} px)`);
        check(m.countsCut === false, `the counts not cut (${m.counts})`);
        check(!m.purpose && !m.tools, "the purpose and text size / Notify are not in the phone header");
        await p.locator(".hub-room-menu > button").click(); await p.waitForTimeout(300);
        const items = await p.evaluate(() => [...document.querySelectorAll(".menu-list [role^=menuitem]")].map((b) => (b.textContent || "").trim()));
        row.steps.menu = items; await shot(p, `${tag}-2-menu`);
        check(items.some((x) => /Text size|字級/.test(x)), `text size in ⋯ (${JSON.stringify(items)})`);
        await p.keyboard.press("Escape");
        await p.locator(".hub-room-rail-toggle").click(); await p.waitForTimeout(500);
        row.steps.purposeInSheet = await p.evaluate(() => !!document.querySelector("dialog .hub-room-purpose-panel, .hub-rail-sheet .hub-room-purpose-panel"));
        await shot(p, `${tag}-3-members-purpose`);
        check(row.steps.purposeInSheet, "the purpose is in the members sheet");
      } else {
        if (baseline) { row.status = "BASELINE_REPRODUCED"; continue; }
        check(m.tools && m.purpose, `a desk keeps its header (text size, Notify, the purpose): ${JSON.stringify(m)}`);
      }
      row.status = "PASS";
    } catch (e: any) { row.status = "FAIL"; row.error = String(e?.stack || e).slice(0, 800); await shot(p, `${tag}-FAIL`).catch(() => {}); }
    finally { await ctx.close(); }
  }
} finally {
  await browser.close(); await new Promise<void>(r => server.close(() => r())); await rig.close(); rmSync(keys, { recursive: true, force: true });
  receipt.status = receipt.cases.length === cases.length && receipt.cases.every((x: any) => x.status === (baseline ? "BASELINE_REPRODUCED" : "PASS")) && !receipt.pageErrors.length ? "PASS" : "FAIL";
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ source: receipt.source, baseline, status: receipt.status, cases: receipt.cases.map((x: any) => ({ tag: x.tag, status: x.status, error: x.error, steps: x.steps })), pageErrors: receipt.pageErrors, foreign: receipt.foreign }));
}
process.exitCode = receipt.status === "PASS" ? 0 : 1;
