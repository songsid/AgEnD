// Hub rooms, track U2 (dev-claude2), in a real Chrome: New room, Room settings, the members panel, invitations (with an
// agent's 「在這些房間裡」) and Administration → Rooms, each mounted on its own page (the shell that mounts them is
// web-claude's), served from REPO's src/ui as the Hub serves them (/ui/js/<module>, /assets/<shared>), against the
// seam-1 fixture (tests/support/hub-rooms-fixture.ts) routed in the browser. Loopback only; no Hub, no account.
// Pictures (desk/phone × light/dark × en/zh-TW) and, with AFTER=1, judged facts per view.
//   PW_DIR=… CHROME=… REPO=<checkout> OUT=<dir> [AFTER=1] [MATRIX=…] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-hub-rooms-u2.mts
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";

const REPO = process.env.REPO!, OUT = join(process.env.OUT!, "hub-rooms-u2"), PW = process.env.PW_DIR!, AFTER = process.env.AFTER === "1";
mkdirSync(OUT, { recursive: true });
const { createHubRoomsFixture } = await import(REPO + "/tests/support/hub-rooms-fixture.ts");
const CASES = (process.env.MATRIX ?? "desk-light-en,desk-dark-zh-TW,phone-light-en,phone-dark-zh-TW").split(",").map((s) => {
  const [device, theme, ...lang] = s.split("-"); return { device: device as "desk" | "phone", theme: theme as "light" | "dark", lang: lang.join("-") as "en" | "zh-TW" };
});
const VIEWS = ["new", "settings", "members", "invitations", "admin"] as const;

const MOUNT = `
import { html, render, useState } from "/assets/app-html.js";
import { setLang } from "/assets/app-i18n.js";
import { ConfirmHost } from "/assets/ui-confirm.js";
import { createHubWebClient } from "/ui/js/hub-client.js";
const q = new URLSearchParams(location.search), view = q.get("view");
setLang(q.get("lang") || "en", { store: false });
const client = createHubWebClient(); await client.session();
let body;
if (view === "new") { const { NewRoomDialog } = await import("/ui/js/hub-room-new.js"); body = html\`<\${NewRoomDialog} client=\${client} />\`; }
if (view === "settings") { const { RoomSettings } = await import("/ui/js/hub-room-settings.js"); const detail = await client.room("room-weekly"); body = html\`<\${RoomSettings} client=\${client} roomId="room-weekly" detail=\${detail} />\`; }
if (view === "members") { const { RoomMembersPanel } = await import("/ui/js/hub-room-members.js"); const detail = await client.room("room-weekly"); body = html\`<div style="max-width:320px"><\${RoomMembersPanel} client=\${client} roomId="room-weekly" detail=\${detail} /></div>\`; }
if (view === "invitations") { const m = await import("/ui/js/hub-invitations.js"); body = html\`<div class="card" style="max-width:640px;display:flex;flex-direction:column;gap:12px"><\${m.InvitationsList} client=\${client} /><\${m.AgentRoomsSection} client=\${client} exposureId="exp-02" /></div>\`; }
if (view === "admin") { const { AdminRooms } = await import("/ui/js/hub-admin-rooms.js"); body = html\`<div class="card"><\${AdminRooms} client=\${client} /></div>\`; }
render(html\`<main style="padding:16px">\${body}<\${ConfirmHost} /></main>\`, document.getElementById("app"));
document.body.dataset.ready = "1";
`;
const PAGE = (theme: string, lang: string) => `<!doctype html><html lang="${lang}" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/assets/tokens.css"><link rel="stylesheet" href="/assets/app.css"><link rel="stylesheet" href="/assets/hub.css"></head><body style="background:var(--bg)"><div id="app"></div><script type="module" src="/mount.js"></script></body></html>`;

const types: Record<string, string> = { js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", svg: "image/svg+xml", woff2: "font/woff2" };
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (status: number, type: string, body: string | Buffer) => { res.writeHead(status, { "content-type": type }); res.end(body); };
  if (url.pathname === "/") return send(200, "text/html; charset=utf-8", PAGE(url.searchParams.get("theme") ?? "light", url.searchParams.get("lang") ?? "en"));
  if (url.pathname === "/mount.js") return send(200, types.js, MOUNT);
  const m = /^\/(ui\/js|assets)\/([A-Za-z0-9._-]+)$/.exec(url.pathname);
  if (!m) return send(404, "text/plain", "no");
  const file = normalize(join(REPO, "src/ui", m[1] === "assets" ? "shared" : "", m[2]!));
  if (!existsSync(file)) return send(404, "text/plain", "no");
  send(200, types[m[2]!.split(".").pop()!] ?? "application/octet-stream", readFileSync(file));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

const pw = createRequire(PW + "/")("playwright-core");
const browser = await pw.chromium.launch({ ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}), args: ["--no-sandbox"] });
const VIEW = { desk: { width: 1366, height: 900 }, phone: { width: 390, height: 844 } } as const;
const r: Record<string, unknown> = {}, fail: string[] = [];
try {
  for (const c of CASES) for (const view of VIEWS) {
    const tag = `${c.device}-${c.theme}-${c.lang}`, zh = c.lang === "zh-TW";
    const ctx = await browser.newContext({ viewport: VIEW[c.device], colorScheme: c.theme, deviceScaleFactor: 1, locale: c.lang });
    const fx = createHubRoomsFixture();
    const page = await ctx.newPage();
    await page.route("**/*", (route: any) => new URL(route.request().url()).origin === base ? route.fallback() : route.abort());
    await fx.route(page);
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(String(e)));
    await page.goto(`${base}/?view=${view}&lang=${c.lang}&theme=${c.theme}`);
    await page.waitForSelector("body[data-ready='1']", { timeout: 15000 });
    await page.waitForTimeout(500);
    if (view === "new") {
      await page.fill("#hubRoomName", zh ? "研一主管週會" : "Weekly leads meeting");
      await page.fill("#hubRoomPeople", "陳"); await page.waitForTimeout(400); await page.click(".hub-room-result");
      await page.fill("#hubRoomPeople", "研"); await page.waitForTimeout(400); await page.locator(".hub-room-result").first().click();
      await page.fill("#hubRoomAgents", "my-"); await page.waitForTimeout(400); await page.click(".hub-room-result");
      await page.fill("#hubRoomAgents", "spec"); await page.waitForTimeout(400); await page.click(".hub-room-result");
      await page.fill("#hubRoomAgents", "test"); await page.waitForTimeout(400);
    }
    if (view === "members") { await page.locator(".hub-member-open").first().click(); await page.waitForTimeout(200); }
    const facts = await page.evaluate(`(() => ({ text: document.body.innerText.replace(/\\s+/g, " ").slice(0, 600), scroll: document.documentElement.scrollWidth > innerWidth + 1 }))()`) as any;
    const file = join(OUT, `${tag}-${view}.png`);
    const target = view === "new" || view === "settings" ? page.locator("dialog .dlg-box").first() : view === "members" ? page.locator(".hub-room-members") : page.locator("main > div").first();
    await target.screenshot({ path: file }).catch(() => page.screenshot({ path: file, fullPage: true }));
    r[`${tag}-${view}`] = { ...facts, errors };
    if (AFTER) {
      const want: Record<string, string[]> = {
        new: zh ? ["新房間", "你 · 管理", "陳主任", "研一 · 2 人", "my-notes", "spec-writer · 邀請 · 等擁有者同意", "加入房間助理（Hub 提供）", "建立"] : ["New room", "You · Manager", "Create"],
        settings: zh ? ["房間設定", "基本", "成員可以 @所有 Agent", "成員與 Agent", "audit-helper（周小明）· 已邀請，等擁有者同意", "old-audit（林小華）· 邀請已過期", "重新邀請", "封存房間"] : ["Room settings", "Invite again", "Archive room"],
        members: zh ? ["成員 · 3（線上 2）", "Agent · 12（線上 7）", "… 其餘 4 個", "房間助理", "誰看得到", "在這裡 @ 它"] : ["Members · 3 (online 2)", "Agents · 12 (online 7)", "@ it here"],
        invitations: zh ? ["邀請", "被 @ 時，它會讀到房間最近的訊息。", "陳主任 邀請你的 Agent「my-notes」加入房間「產品規劃」", "同意", "不要", "在這些房間裡", "退出這個房間"] : ["Invitations", "When @-ed, it reads the room's recent messages.", "Agree", "Leave this room"],
        admin: zh ? ["誰可以開房間", "每個人都可以開一對一對話。", "所有房間", "這裡看不到任何房間的內容。", "研一主管週會", "已封存"] : ["Who can start rooms", "All rooms", "Archived"],
      };
      const missing = want[view]!.filter(w => !facts.text.toLowerCase().includes(w.toLowerCase()));   // headings may be drawn upper-case
      if (missing.length || errors.length || facts.scroll) fail.push(`${tag}-${view}: missing ${JSON.stringify(missing)} errors ${JSON.stringify(errors)} scroll ${facts.scroll}`);
    }
    await ctx.close();
  }
} catch (e) { fail.push(String((e as Error).stack ?? e).slice(0, 800)); }
finally { await browser.close(); server.close(); }
writeFileSync(join(OUT, "result.json"), JSON.stringify({ r, fail }, null, 2));
console.log(fail.length ? "FAIL\n" + fail.join("\n") : `PASS ${Object.keys(r).length} shots`);
process.exit(fail.length ? 1 : 0);
