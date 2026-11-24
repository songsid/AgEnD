/**
 * M-3591 real-app captures: an agent's HTML page in a Hub group room.
 * The real Hub listener (tests/helpers/hub-s3b-rig.ts) serves the workspace shell and its modules over HTTPS on loopback, its
 * shell saying where the Hub's previews run (hubPreviewView); the Hub's own preview listener (src/hub/preview.ts
 * createHubPreviewHandler) serves /frame on the next port. Every /hub/v1/* call is answered by the rooms fixture
 * (tests/support/hub-rooms-fixture.ts), its weekly group room ending with an agent's answer that carries a ```html page and
 * the same page as an attached .html file — no fleet, CLI or account.
 * "before" serves BASE_REF's hub-room-thread.js and hub-room-composer.js (route.fulfill; nothing on disk changes); "after" is
 * this checkout. This browser has allowed previews for this Hub and read the banner (the card's own Allow is in the unit test).
 * Writes PNGs and receipt.json (sourceHead, baseRef, every check, every PNG's sha256) to OUT.
 *   PW_DIR=<playwright-core root> OUT=<dir> [BASE_REF=origin/release/2.3.5-alpha] npx tsx scripts/manual/hub-room-preview-m3591/capture.mts
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:https";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { s3bRig } from "../../../tests/helpers/hub-s3b-rig.js";
import { createHubRoomsFixture } from "../../../tests/support/hub-rooms-fixture.js";
import { provisionHubIdentity } from "../../../src/hub/tls.js";
import { createHubPreviewHandler, hubPreviewView } from "../../../src/hub/preview.js";

const out = resolve(process.env.OUT ?? ".artifacts/hub-room-preview-m3591"), base = process.env.BASE_REF ?? "origin/release/2.3.5-alpha";
mkdirSync(out, { recursive: true });
const git = (...a: string[]) => execFileSync("git", ["-c", "gc.auto=0", ...a], { encoding: "utf8", maxBuffer: 16 << 20 });
const OLD: Record<string, string> = Object.fromEntries(["hub-room-thread.js", "hub-room-composer.js"].map((f) => [f, git("show", `${base}:src/ui/${f}`)]));
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const receipt: any = { sourceHead: git("rev-parse", "HEAD").trim(), baseRef: git("rev-parse", base).trim(), dirty: git("status", "--porcelain", "--", "src").trim().split("\n").filter(Boolean), checks: [], pictures: [] };
const check = (name: string, ok: unknown, detail?: unknown) => { receipt.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)}`}`); };

const PAGE = `<!doctype html><meta charset="utf-8"><title>Q3 report</title>
<style>body{font:15px system-ui,sans-serif;margin:0;padding:20px;background:#f6f8fb;color:#172033}h1{margin:0 0 4px;font-size:20px}p{margin:0 0 14px;color:#4a5568}
.bars{display:flex;gap:12px;align-items:flex-end;height:150px;padding:12px;background:#fff;border-radius:12px;box-shadow:0 1px 3px #0002}
.bar{flex:1;background:#3b82f6;border-radius:6px 6px 0 0;color:#fff;font-size:12px;text-align:center;padding-top:4px}.a{height:55%}.b{height:72%}.c{height:90%}
@media (prefers-color-scheme:dark){body{background:#1b1f27;color:#e6e9ef}p{color:#a9b1c1}.bars{background:#262c37;box-shadow:none}}</style>
<h1>Q3 report / 第三季報告</h1><p>Sales by month (made-up numbers). 每月銷售（虛構數字）。</p>
<div class="bars"><div class="bar a">Jul</div><div class="bar b">Aug</div><div class="bar c">Sep</div></div>`;
// The rooms fixture's roster, as obviously made-up sample names in these captures (the fixture itself is unchanged).
const NAMES: Record<string, Record<string, string>> = {
  en: { "王經理": "Sam Sample", "陳主任": "Alex Sample", "吳小安": "Casey Sample", "林小華": "Jordan Sample", "周小明": "Riley Sample" },
  "zh-TW": { "王經理": "範例主管", "陳主任": "範例同事", "吳小安": "範例組員", "林小華": "範例夥伴", "周小明": "範例訪客" },
};
const sampleNames = (text: string, lang: string) => Object.entries(NAMES[lang]!).reduce((t, [from, to]) => t.split(from).join(to), text);
const FILE_ID = "aaaaaaaa-0000-4000-8000-0000000000f1", FILE_URL = `/hub/v1/rooms/room-weekly/files/${FILE_ID}`;

const port = 49800 + Math.floor(Math.random() * 90), origin = `https://127.0.0.1:${port}`, previewOrigin = `https://127.0.0.1:${port + 1}`;
const settings = { host: "127.0.0.1", port: port + 1, origin: previewOrigin }, bootId = randomBytes(16).toString("hex");
const rig = await s3bRig({ webOrigin: origin, preview: hubPreviewView(origin, settings, bootId) });
const keys = mkdtempSync(join(out, ".keys-"));
await provisionHubIdentity({ home: keys, memberOrigin: origin });
const tls = { key: readFileSync(join(keys, "hub/keys/tls-key.pem")), cert: readFileSync(join(keys, "hub/keys/tls-cert.pem")) };
const web = createServer(tls, (req, res) => { if (!rig.http.handle(req, res)) { res.writeHead(404); res.end(); } });
const frame = createHubPreviewHandler(settings, origin, bootId, () => true);
const preview = createServer(tls, (req, res) => frame(req, res));
await new Promise<void>((yes) => web.listen(port, "127.0.0.1", yes));
await new Promise<void>((yes) => preview.listen(port + 1, "127.0.0.1", yes));

const pw = createRequire(resolve(process.env.PW_DIR!, "package.json"))("playwright-core");
const browser = await pw.chromium.launch({ args: ["--no-sandbox", "--no-proxy-server"] });
try {
  for (const [device, lang, theme] of [["desk", "en", "light"], ["desk", "zh-TW", "dark"], ["phone", "en", "light"], ["phone", "zh-TW", "dark"]] as const) {
    for (const when of ["before", "after"] as const) {
      const tag = `${device}-${lang}-${theme}-${when}`, errors: string[] = [];
      const fx = createHubRoomsFixture(), room = fx.rooms.find((x: any) => x.id === "room-weekly") as any;
      const agent = room.members.find((m: any) => m.kind === "agent" && m.presence === "idle");
      room.messages.push({ id: "msg-9001", roomId: room.id, at: room.messages.at(-1).at + 60_000, author: { kind: "agent", id: agent.id, name: agent.name, owner: agent.owner },
        text: lang === "en" ? `Here is the Q3 page.\n\n\`\`\`html\n${PAGE}\n\`\`\`` : `第三季的頁面在這裡。\n\n\`\`\`html\n${PAGE}\n\`\`\``, mentions: [], stage: "answered",
        files: [{ id: FILE_ID, name: "q3-report.html", size: Buffer.byteLength(PAGE), mime: "text/html", url: FILE_URL }] });
      const context = await browser.newContext({ viewport: device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 860 }, locale: lang === "en" ? "en-US" : "zh-TW", colorScheme: theme,
        ignoreHTTPSErrors: true, hasTouch: device === "phone", isMobile: device === "phone", reducedMotion: "reduce" });
      await context.addInitScript({ content: "globalThis.__name = (fn) => fn;" });
      await context.addInitScript(({ lang, theme }) => {
        if (window !== window.top) return;
        localStorage.setItem("agend_lang", lang); localStorage.setItem("agend_theme", theme); localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1");
        localStorage.setItem("agend_html_preview", "on"); sessionStorage.setItem("agend_html_preview_banner_ack", "1");
      }, { lang, theme });
      await context.route("**/hub/v1/**", async (q: any) => {
        const req = q.request(), u = new URL(req.url()), path = u.pathname + u.search;
        if (u.pathname.endsWith("/events")) return q.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: "retry: 600000\n\n" });
        if (u.pathname === FILE_URL) return q.fulfill({ status: 200, headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="q3-report.html"' }, body: PAGE });
        const raw = req.postData(), answer = fx.handle({ method: req.method(), path, headers: req.headers(), body: raw ? JSON.parse(raw) : undefined });
        return q.fulfill({ status: answer?.status ?? 200, contentType: "application/json", body: sampleNames(JSON.stringify(answer?.body ?? {}), lang) });
      });
      if (when === "before") await context.route("**/ui/js/*.js", (route: any) => {
        const name = new URL(route.request().url()).pathname.split("/").pop()!;
        return OLD[name] ? route.fulfill({ contentType: "text/javascript", body: OLD[name] }) : route.continue();
      });
      const p = await context.newPage(); p.on("pageerror", (e: Error) => errors.push(e.message));
      const shot = async (name: string) => { const path = `m3591-${tag}-${name}.png`; await p.waitForTimeout(300); await p.screenshot({ path: join(out, path) }); receipt.pictures.push({ path, sha256: sha(readFileSync(join(out, path))) }); };
      await p.goto(`${origin}/ui/hub?room=room-weekly`);
      const card = p.locator(".hub-room-page .msg .html-card").first();
      await card.waitFor({ timeout: 15000 }).catch(async (e: Error) => { await p.screenshot({ path: join(out, `debug-${tag}.png`) }); console.log(errors); throw e; });
      await card.scrollIntoViewIfNeeded(); await p.waitForTimeout(300);
      await shot("1-card");
      const notes = await p.locator(".hub-room-page .msg .html-card .pv-note").allTextContents();
      const run = p.locator(".hub-room-page .msg .html-card .pv-run").first();
      if (when === "before") {
        check(`${tag}: the card says previews are not available here (the bug)`, notes.some((n: string) => /not available here|無法使用|不提供/.test(n)) || !(await run.isEnabled().catch(() => false)), notes);
      } else {
        check(`${tag}: the card offers Preview`, await run.isEnabled(), notes);
        check(`${tag}: no "not available" note`, !notes.some((n: string) => /not available here/.test(n)), notes);
        await run.click();
        const inline = p.locator(".hub-room-page .msg .html-card iframe").first();
        await inline.waitFor({ timeout: 15000 });
        const child = await (await inline.elementHandle()).contentFrame();
        await child.locator("h1").waitFor({ state: "attached", timeout: 15000 }).catch(() => {});
        check(`${tag}: the page runs in the card (sandbox allow-scripts, from the Hub's preview listener)`, (await inline.getAttribute("sandbox")) === "allow-scripts" && (await inline.getAttribute("src")) === `${previewOrigin}/frame`
          && /Q3 report/.test(await child.locator("h1").innerText().catch(() => "")), { sandbox: await inline.getAttribute("sandbox"), src: await inline.getAttribute("src") });
        await inline.scrollIntoViewIfNeeded(); await shot("2-running");
        await p.locator(".hub-room-page .msg .html-card .pv-open").first().click();
        await p.locator(".hub-room-page > .pv-panel").waitFor({ timeout: 15000 });
        await p.locator(".hub-room-page > .pv-panel iframe").first().waitFor({ timeout: 15000 }).catch(() => {});
        check(`${tag}: Open in panel opens the room's side panel`, await p.locator(".hub-room-page > .pv-panel").isVisible());
        if (device === "desk") check(`${tag}: the panel takes the members rail's place`, (await p.locator(".hub-room-page > .u-rail").count()) === 0);
        // The panel's own chrome (header, toolbar, the width select) is the app's surface in either theme; only the agent's
        // page inside the frame has its own colours.
        const look = await p.evaluate(() => {
          const bg = (sel: string) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).backgroundColor : null; };
          return { body: bg("body"), panel: bg(".hub-room-page > .pv-panel"), width: bg(".hub-room-page > .pv-panel .pv-width") };
        });
        check(`${tag}: the panel and its width select have the page's own background (${look.body})`, look.panel === look.body && (look.width === null || look.width === look.body), look);
        await shot("3-panel");
        if (device === "desk") {
          // Narrower than 560 px the panel's toolbar shows icons only (with their titles); dragged wider, each says its name.
          await p.locator(".hub-room-page > .pv-divider").focus(); await p.keyboard.press("Home"); await p.waitForTimeout(300);
          const reply = p.locator(".hub-room-page > .pv-panel .pv-fb-reply");
          await reply.hover();
          const label = (await reply.locator(".lbl").boundingBox())?.width ?? 0;
          check(`${tag}: a wider panel names Reply about this page beside its icon`, label > 20 && /Reply about this page|回覆這個頁面/.test(await reply.innerText()), { label, text: await reply.innerText() });
          receipt.replyControl = { ...(receipt.replyControl || {}), [lang]: { name: await reply.innerText(), title: await reply.getAttribute("title") } };
          await shot("3b-panel-wide-reply");
          await reply.click(); await p.waitForTimeout(200);
          const box = await p.locator(".hub-room-page #msgIn").inputValue();
          check(`${tag}: Reply about this page puts its line in the room's box`, /Q3 report/.test(box), box);
          await shot("4-reply-line");
        } else {
          // A phone's toolbar keeps Preview, views and full screen; the rest, Reply about this page among them, is in ⋯.
          await p.locator(".hub-room-page > .pv-panel .pv-toolbar-more").click();
          const reply = p.locator(".pv-toolbar-dialog .pv-fb-reply");
          await reply.waitFor({ timeout: 5000 });
          check(`${tag}: ⋯ names Reply about this page`, /Reply about this page|回覆這個頁面/.test(await reply.innerText()), await reply.innerText());
          await shot("3b-more-reply");
          await reply.click(); await p.waitForTimeout(400);
          const box = await p.locator(".hub-room-page #msgIn").inputValue();
          check(`${tag}: on a phone Reply closes the page and puts its line in the room's box`, /Q3 report/.test(box) && !(await p.locator(".hub-room-page > .pv-panel").count()), box);
          await shot("4-reply-line");
        }
      }
      check(`${tag}: no page errors`, errors.length === 0, errors);
      await context.close();
    }
  }
} finally {
  await browser.close();
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2));
  web.close(); preview.close(); rmSync(keys, { recursive: true, force: true });
}
const failed = receipt.checks.filter((c: any) => !c.ok);
console.log(`${receipt.checks.length - failed.length}/${receipt.checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
