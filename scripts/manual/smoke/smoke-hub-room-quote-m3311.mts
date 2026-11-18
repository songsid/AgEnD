/**
 * M-3311 (2): the Fleet chat's 「引用」 in a Hub room — a passage selected (a real browser selection) in a message → the pill →
 * the passage goes into the room's box as a Markdown quote; repeatable. Before that (the rig): M-3308: Ctrl+V in a Hub room's composer, in a real browser on a real Hub (HTTPS + SQLite; a synthetic directory; no agent,
 * Fleet, native process or account). A paste is what the browser hands the page: a ClipboardEvent whose clipboardData carries
 *   screenshot — a PNG with the name Chrome gives a screen capture ("image.png"), as Win+Shift+S / PrintScreen leave it;
 *   unnamed    — the same picture with no name (another browser's clipboard image);
 *   file       — a copied file (notes.txt);
 *   long       — 5,000 characters of text (the Fleet chat attaches it as a text file past 4,000).
 * Judged per case: the file chips under the box (names, all uploaded), then Send: the Hub's stored message has that many files,
 * and the picture is drawn in the thread. BASELINE=1 (the base): expects no pill (the gap). Steps: a screenshot dragged over the conversation (the drop card, mid-drag),
 * dropped (its chip, then Send: the Hub stores it); a markdown file dropped; 5,000 characters pasted (the chip and the notice).
 * Cases: desk light en, desk dark zh-TW, phone light zh-TW, phone dark en. Pictures: <case>-<step>.png.
 *   REPO=<checkout> OUT=<dir> PW_DIR=<dir with playwright-core> [CHROME=<path>] npx tsx scripts/manual/smoke/smoke-hub-room-quote-m3311.mts
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
const SEED = "Ship the beta on Friday, after the rehearsal passes on both hosts.";
const SEED2 = "The Hub's name should show on the sign-in page.";
try {
  for (const [i, c] of cases.entries()) {
    const tag = `${c.device}-${c.theme}-${c.lang}`, row: any = { tag, steps: {} }; receipt.cases.push(row);
    const login = "alex" + i, alex = rig.addPerson(login, "Alex"); await rig.signIn(login);
    const room = (await rig.call(admin, "POST", "/hub/v1/rooms", { name: `Quote ${tag}`, people: [personKeyString(alex)] })).json.room.id as string;
    for (const text of [SEED, SEED2]) await rig.call(admin, "POST", `/hub/v1/rooms/${room}/messages`, { text, mentions: [], idempotencyKey: randomUUID() });
    const ctx = await browser.newContext({ viewport: c.device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 }, isMobile: c.device === "phone",
      hasTouch: c.device === "phone", locale: c.lang === "en" ? "en-US" : "zh-TW", colorScheme: c.theme, ignoreHTTPSErrors: true });
    await ctx.addInitScript({ content: `window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});` });
    await ctx.route("**/*", (route: any) => { const u = new URL(route.request().url()); if (u.origin !== origin) { receipt.foreign.push(u.origin); return route.abort(); } return route.continue(); });
    const p = await ctx.newPage(); p.setDefaultTimeout(15000);
    p.on("pageerror", (e: any) => receipt.pageErrors.push(`${tag}: ${String(e)}`));
    try {
      await p.goto(origin + "/ui/hub"); await p.fill("#hubLogin", login); await p.fill("#hubPassword", "pw-" + login);
      await p.locator(".hub-signin button[type=submit]").click(); await p.locator(".hub-session-row").first().waitFor({ state: "attached" });
      await p.goto(`${origin}/ui/hub?room=${room}`); await p.locator("#msgIn").waitFor();
      await p.getByText(SEED2, { exact: false }).first().waitFor();
      // A real selection: a Range over a passage of the message's words (what a drag or a long press leaves).
      const select = (msg: string, word: string) => p.evaluate(({ msg, word }: any) => {
        const md = [...document.querySelectorAll(".hub-room-page .thread .msg .md")].find((e) => (e.textContent || "").includes(msg))!;
        const walker = document.createTreeWalker(md, NodeFilter.SHOW_TEXT); let n: any; while ((n = walker.nextNode())) if (n.data.includes(word)) break;
        const at = n.data.indexOf(word), r = document.createRange(); r.setStart(n, at); r.setEnd(n, at + word.length);
        const sel = document.getSelection()!; sel.removeAllRanges(); sel.addRange(r);
        return String(sel);
      }, { msg, word });
      const pill = p.locator(".quote-pop .quote-pick").first();
      const s1 = await select(SEED, "after the rehearsal passes"); row.steps.selected = s1;
      const shown = await pill.waitFor({ timeout: 3000 }).then(() => true, () => false);
      row.steps.pill = shown ? await pill.textContent() : null;
      await p.waitForTimeout(200); await shot(p, `${tag}-1-pill`);
      if (baseline) { check(!shown, "baseline: expected no pill"); row.status = "BASELINE_REPRODUCED"; continue; }
      check(shown, "the Quote pill on a selected passage");
      check(row.steps.pill.trim() === (c.device === "phone" ? (c.lang === "en" ? "Quote selection" : "引用選取的文字") : (c.lang === "en" ? "Quote" : "引用")), `the pill's words (${row.steps.pill})`);
      await pill.click(); await p.waitForTimeout(400);
      const v1 = await p.locator("#msgIn").inputValue(); row.steps.after1 = v1;
      check(v1 === "> after the rehearsal passes\n", `the quote in the box (${JSON.stringify(v1)})`);
      await p.locator("#msgIn").press("End"); await p.keyboard.type("Yes, both hosts.");
      await select(SEED2, "sign-in page"); await pill.waitFor({ timeout: 3000 }); await pill.click(); await p.waitForTimeout(400);
      const v2 = await p.locator("#msgIn").inputValue(); row.steps.after2 = v2;
      check(v2 === "> after the rehearsal passes\nYes, both hosts.\n\n> sign-in page\n", `repeatable: quote, answer, quote (${JSON.stringify(v2)})`);
      await shot(p, `${tag}-2-quoted`);
      await p.locator("#sendBtn").click(); await p.waitForTimeout(1200); await shot(p, `${tag}-3-sent`);
      const last = ((await rig.call(admin, "GET", `/hub/v1/rooms/${room}/messages`)).json.messages as any[]).filter((m: any) => m.author?.kind === "person").at(-1);
      check(last?.text === v2.trimEnd() || last?.text === v2, `sent as typed (${JSON.stringify(last?.text)})`);
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
