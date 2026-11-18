/**
 * M-3311 (3): in a Hub room, as in the Fleet chat — the line under the box (Enter sends, Shift+Enter a new line; then the @agent
 * hint), the message menu's Copy link (its address opens that message), the header menu's Full width (a desk), and a long
 * paste's As text (its text back in the box). Real browser, real Hub. Before that (the rig): M-3308: Ctrl+V in a Hub room's composer, in a real browser on a real Hub (HTTPS + SQLite; a synthetic directory; no agent,
 * Fleet, native process or account). A paste is what the browser hands the page: a ClipboardEvent whose clipboardData carries
 *   screenshot — a PNG with the name Chrome gives a screen capture ("image.png"), as Win+Shift+S / PrintScreen leave it;
 *   unnamed    — the same picture with no name (another browser's clipboard image);
 *   file       — a copied file (notes.txt);
 *   long       — 5,000 characters of text (the Fleet chat attaches it as a text file past 4,000).
 * Judged per case: the file chips under the box (names, all uploaded), then Send: the Hub's stored message has that many files,
 * and the picture is drawn in the thread. BASELINE=1 (the base): expects none of the four (the gaps). Steps: a screenshot dragged over the conversation (the drop card, mid-drag),
 * dropped (its chip, then Send: the Hub stores it); a markdown file dropped; 5,000 characters pasted (the chip and the notice).
 * Cases: desk light en, desk dark zh-TW, phone light zh-TW, phone dark en. Pictures: <case>-<step>.png.
 *   REPO=<checkout> OUT=<dir> PW_DIR=<dir with playwright-core> [CHROME=<path>] npx tsx scripts/manual/smoke/smoke-hub-room-menu-m3311.mts
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
const ENTER = { en: { desk: "Enter to send · Shift+Enter for a new line", phone: "Return adds a line · tap Send to send" }, "zh-TW": { desk: "Enter 送出 · Shift+Enter 換行", phone: "Return 換行 · 按「送出」傳送" } } as any;
try {
  for (const [i, c] of cases.entries()) {
    const tag = `${c.device}-${c.theme}-${c.lang}`, row: any = { tag, steps: {} }; receipt.cases.push(row);
    const login = "alex" + i, alex = rig.addPerson(login, "Alex"); await rig.signIn(login);
    const room = (await rig.call(admin, "POST", "/hub/v1/rooms", { name: `Menu ${tag}`, people: [personKeyString(alex)] })).json.room.id as string;
    for (let n = 1; n <= 3; n++) await rig.call(admin, "POST", `/hub/v1/rooms/${room}/messages`, { text: n === 2 ? SEED : `Note ${n}`, mentions: [], idempotencyKey: randomUUID() });
    const ctx = await browser.newContext({ viewport: c.device === "phone" ? { width: 390, height: 844 } : { width: 1920, height: 1080 }, isMobile: c.device === "phone",
      hasTouch: c.device === "phone", locale: c.lang === "en" ? "en-US" : "zh-TW", colorScheme: c.theme, ignoreHTTPSErrors: true });
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    await ctx.addInitScript({ content: `window.__name=fn=>fn;localStorage.setItem('agend_lang',${JSON.stringify(c.lang)});localStorage.setItem('agend_theme',${JSON.stringify(c.theme)});` });
    await ctx.route("**/*", (route: any) => { const u = new URL(route.request().url()); if (u.origin !== origin) { receipt.foreign.push(u.origin); return route.abort(); } return route.continue(); });
    const p = await ctx.newPage(); p.setDefaultTimeout(15000);
    p.on("pageerror", (e: any) => receipt.pageErrors.push(`${tag}: ${String(e)}`));
    try {
      await p.goto(origin + "/ui/hub"); await p.fill("#hubLogin", login); await p.fill("#hubPassword", "pw-" + login);
      await p.locator(".hub-signin button[type=submit]").click(); await p.locator(".hub-session-row").first().waitFor({ state: "attached" });
      await p.goto(`${origin}/ui/hub?room=${room}`); await p.locator("#msgIn").waitFor(); await p.getByText(SEED).first().waitFor();
      // 1. The line under the box.
      // What shows: a phone hides the Fleet chat's keyboard hint (as the Fleet chat does); the room's own stays.
      const hints = await p.evaluate(() => [...document.querySelectorAll(".hub-room-page .composer-row .hint")].filter((h) => getComputedStyle(h).display !== "none" && (h as HTMLElement).offsetWidth > 0).map((h) => (h.textContent || "").trim()));
      row.steps.hints = hints; await shot(p, `${tag}-1-hints`);
      // 2. Copy link from the message menu (right-click; a phone's long press opens the same menu).
      const body = p.locator(".hub-room-page .msg", { hasText: SEED }).first().locator(".body");
      if (c.device === "desk") await body.click({ button: "right" });
      else await body.evaluate((el: HTMLElement) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 })); });
      await p.locator(".msg-menu").waitFor({ timeout: 4000 }).catch(() => {});
      const items = await p.evaluate(() => [...document.querySelectorAll(".msg-menu [data-item]")].map((b) => (b as HTMLElement).dataset.item));
      row.steps.menu = items; await shot(p, `${tag}-2-message-menu`);
      if (baseline) {
        check(!items.includes("copyLink") && hints.length === 1, `baseline: no Copy link, no Enter hint (${JSON.stringify({ items, hints })})`);
        row.status = "BASELINE_REPRODUCED"; continue;
      }
      if (c.device === "desk") check(hints[0] === ENTER[c.lang].desk && hints.length === 2, `the Enter hint, then the @agent one (${JSON.stringify(hints)})`);
      else check(hints.length === 1 && hints[0] !== ENTER[c.lang].phone, `a phone: the room's own hint only, as the Fleet chat hides its keyboard hint there (${JSON.stringify(hints)})`);
      check(items.includes("copyLink"), `Copy link in the menu (${JSON.stringify(items)})`);
      await p.locator('.msg-menu [data-item="copyLink"]').click(); await p.waitForTimeout(400);
      const link = await p.evaluate(() => navigator.clipboard.readText()); row.steps.link = link.replace(origin, "<origin>");
      check(new RegExp(`/ui/hub\\?room=${room}&m=[A-Za-z0-9-]+$`).test(link), `the copied address (${link})`);
      await p.goto(link); await p.getByText(SEED).first().waitFor();
      row.steps.opened = await p.evaluate(() => location.search);
      check(!/[?&]m=/.test(row.steps.opened), `the link opened the room at the message (the address then cleaned: ${row.steps.opened})`);
      // 3. Full width (a desk; a phone's menu has none).
      await p.locator(".hub-room-menu > button").click(); await p.waitForTimeout(300);
      const full = p.locator(".menu-list [role=menuitemcheckbox]");
      if (c.device === "desk") {
        const before = await p.evaluate(() => (document.querySelector(".hub-room-page .thread") as HTMLElement).getBoundingClientRect().width);
        check(await full.count() === 1, "Full width in the header menu");
        await full.click(); await p.waitForTimeout(400);
        const after = await p.evaluate(() => (document.querySelector(".hub-room-page .thread") as HTMLElement).getBoundingClientRect().width);
        row.steps.width = [Math.round(before), Math.round(after)];
        check(after > before + 40, `the conversation widens (${row.steps.width})`);
        await p.keyboard.press("Escape"); await p.waitForTimeout(200); await shot(p, `${tag}-3-full-width`);
        await p.reload(); await p.getByText(SEED).first().waitFor(); await p.waitForTimeout(400);
        row.steps.kept = await p.evaluate(() => document.querySelector(".hub-room-page")?.getAttribute("data-width"));
        check(row.steps.kept === "full", "kept on this device after a reload");
      } else { check(await full.count() === 0, "no Full width on a phone"); await p.keyboard.press("Escape"); }
      // 4. A long paste, then As text.
      await p.locator("#msgIn").fill("My answer");
      await p.evaluate(() => { const dt = new DataTransfer(); dt.setData("text/plain", "y".repeat(5000)); document.querySelector("#msgIn")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); });
      const asText = p.locator(".hub-pending-files .as-text"); await asText.waitFor({ timeout: 8000 });
      row.steps.asTextLabel = (await asText.textContent())?.trim(); await shot(p, `${tag}-4-as-text-chip`);
      check(row.steps.asTextLabel === (c.lang === "en" ? "As text" : "改為文字"), `the chip's As text (${row.steps.asTextLabel})`);
      await asText.click(); await p.waitForTimeout(400);
      const v = await p.locator("#msgIn").inputValue();
      check(v === `My answer\n${"y".repeat(5000)}` && !(await p.locator(".hub-pending-files .file-chip").count()), `the text back in the box, the chip gone (${v.length})`);
      await shot(p, `${tag}-5-as-text-back`);
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
