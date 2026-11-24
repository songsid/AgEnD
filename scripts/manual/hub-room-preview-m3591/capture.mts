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
.bar{flex:1;background:#3b82f6;border-radius:6px 6px 0 0;color:#fff;font-size:12px;text-align:center;padding-top:4px}.a{height:55%}.b{height:72%}.c{height:90%}</style>
<h1>Q3 report / 第三季報告</h1><p>Sales by month (made-up numbers). 每月銷售（虛構數字）。</p>
<div class="bars"><div class="bar a">Jul</div><div class="bar b">Aug</div><div class="bar c">Sep</div></div>`;
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
        return q.fulfill({ status: answer?.status ?? 200, contentType: "application/json", body: JSON.stringify(answer?.body ?? {}) });
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
        await shot("3-panel");
        const reply = p.locator(".hub-room-page .pv-fb-reply").first();
        if (await reply.isVisible().catch(() => false)) {
          await reply.click(); await p.waitForTimeout(200);
          const box = await p.locator(".hub-room-page #msgIn").inputValue();
          check(`${tag}: Reply about this page puts its line in the room's box`, /Q3 report/.test(box), box);
          if (device === "desk") await shot("4-reply-line");
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
