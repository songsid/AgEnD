// #4463 captures: a skin pack drawn as real WebP pictures (a canvas's toDataURL("image/webp"), decodable, not a fake
// header), uploaded through the Office editor's own file picker, then drawn in the Office and on an Office share page.
// Synthetic pack and fixture agents only (Alpha … Echo): no real names. The share's tunnel is stubbed (the real share
// service and gateway on loopback, presented with a quick-tunnel Host, as smoke-2715 does): no cloudflared, no network.
// Copy it to scripts/manual/smoke/ and run, from the checkout:
//   REPO=<checkout> PW_DIR=<dir with playwright-core> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/capture.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
const REPO = process.env.REPO!, OUT = process.env.OUT!; mkdirSync(OUT, { recursive: true });
const { bootFixture, mounted } = await import(join(REPO, "scripts/manual/smoke-fixture/index.mts"));
const { createOfficeShareGateway } = await import(join(REPO, "src/office-share.ts"));
const NAMES = ["alpha", "beta", "gamma", "delta", "echo"];
const ROSTER = NAMES.map((n, i) => ({ name: `bot-${n}`, displayName: n[0].toUpperCase() + n.slice(1), backend: i % 2 ? "codex" : "claude-code", team: "Studio", status: "running" as const, general: i === 0 }));
const fx = await bootFixture({ port: 0, oldPort: 49163, roster: ROSTER, classic: false });
const fm = fx.fm;
const status = new Map<string, string>(ROSTER.map((r) => [r.name, "running"]));
status.set("bot-delta", "paused");
fm.getInstanceStatus = (n: string) => status.get(n) ?? "running";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const report: any = { cases: {} };

// ── The pack: a 5120×2880 background (the new side cap) and a character sheet, both encoded by Chromium as WebP ──
const draw = await fx.browser.newPage();
const drawn = await draw.evaluate(`(() => {
  const mk = (w, h) => { const cv = document.createElement("canvas"); cv.width = w; cv.height = h; return { cv, c: cv.getContext("2d") }; };
  const webp = (cv) => cv.toDataURL("image/webp", 0.9);
  const sheet = mk(2 * 32, 48);
  for (let f = 0; f < 2; f++) { const c = sheet.c, o = f * 32; c.fillStyle = "#2f8f5b"; c.fillRect(o + 8, 22 - f, 16, 24); c.fillStyle = "#f2c9a3"; c.fillRect(o + 9, 6 - f, 14, 15); c.fillStyle = "#3a2a1a"; c.fillRect(o + 9, 4 - f, 14, 5); }
  const W = 5120, H = 2880, bg = mk(W, H), g = bg.c;
  g.fillStyle = "#eef1f6"; g.fillRect(0, 0, W, H);
  g.strokeStyle = "#cdd3de"; g.lineWidth = 2; for (let x = 0; x <= W; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); } for (let y = 0; y <= H; y += 64) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  const room = (x, y, w, h, f, t) => { g.fillStyle = f; g.fillRect(x, y, w, h); g.strokeStyle = "#3d4a5e"; g.lineWidth = 12; g.strokeRect(x, y, w, h); g.fillStyle = "#1f2633"; g.font = "700 120px sans-serif"; g.fillText(t, x + 60, y + 160);
    for (let i = 0; i < 6; i++) { g.fillStyle = "#9a7650"; g.fillRect(x + 140 + i * 360, y + h - 520, 240, 120); } };
  room(160, 160, 2240, 1120, "#d6e6fa", "Work"); room(2720, 160, 2240, 1120, "#d9f0dc", "Lounge");
  room(160, 1600, 2240, 1120, "#fadcd6", "Help desk"); room(2720, 1600, 2240, 1120, "#e6def5", "Nap");
  g.fillStyle = "#c0392b"; g.font = "800 140px sans-serif"; g.textAlign = "center"; g.fillText("WebP 5120 × 2880", W / 2, H / 2 + 50);
  for (const [x, y] of [[0, 0], [W - 96, 0], [0, H - 96], [W - 96, H - 96]]) { g.fillStyle = "#f1c40f"; g.fillRect(x, y, 96, 96); }   // the four corners
  const ch = { idle: { src: "sheet.webp", frames: 2, w: 32, h: 48, fps: 2, dw: 160, dh: 240, ax: 16, ay: 46 } };
  const manifest = { format: 1, id: "synth-webp", canvas: [W, H], background: "bg.webp",
    areas: {
      desks: { rect: [160, 160, 2240, 1120], seats: [[600, 1150], [1000, 1150], [1400, 1150], [1800, 1150]] },
      lounge: { rect: [2720, 160, 2240, 1120], seats: [[3100, 1150], [3550, 1150], [4000, 1150], [4450, 1150]] },
      help: { rect: [160, 1600, 2240, 1120], seats: [[700, 2600], [1200, 2600]] },
      nap: { rect: [2720, 1600, 2240, 1120], seats: [[3300, 2600], [3900, 2600]] } },
    stateZones: { working: "desks", needs: "help", crashed: "help", paused: "nap", stopped: "nap", default: "lounge" },
    characters: { default: ch } };
  return { manifest, bg: webp(bg.cv), sheet: webp(sheet.cv) };
})()`) as { manifest: any; bg: string; sheet: string };
await draw.close();
const bytes = (url: string) => { if (!url.startsWith("data:image/webp;base64,")) throw new Error("the canvas did not encode WebP: " + url.slice(0, 40)); return Buffer.from(url.split(",")[1]!, "base64"); };
const bgWebp = bytes(drawn.bg), sheetWebp = bytes(drawn.sheet);
const isWebp = (b: Buffer) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
if (!isWebp(bgWebp) || !isWebp(sheetWebp)) throw new Error("not a RIFF/WEBP file");
report.pictures = { "bg.webp": { bytes: bgWebp.length, chunk: bgWebp.subarray(12, 16).toString("latin1") }, "sheet.webp": { bytes: sheetWebp.length, chunk: sheetWebp.subarray(12, 16).toString("latin1") } };
const id = drawn.manifest.id;

// An office to edit (the editor needs stored offices), on the built-in style until the pack is in.
const put = (skin?: string) => { const w = fm.officeStore.replace([{ id: "hq", name: "HQ", ...(skin ? { skin } : {}), members: ROSTER.map((r) => r.name) }]); if (w && w.ok === false) throw new Error("office refused " + JSON.stringify(w)); };
put();

// ── The share's tunnel, stubbed ──
const HOST = "abc-office.trycloudflare.com";
let gwOrigin = "";
const svc = fm.officeShares as any;
svc.deps.ensure = async () => ({ path: "/nonexistent/cloudflared" });
svc.deps.provider = () => ({});
svc.deps.ownerCurrent = () => true;
svc.deps.manager = {
  start: async (_p: unknown, ctx: { onCandidateHost?(h: string): void }) => { ctx.onCandidateHost?.(HOST); return { ok: true, handle: { pageUrl: `https://${HOST}/ready`, onUnexpectedExit: () => () => {} } }; },
  stop: async () => ({ confirmed: true }),
};
svc.deps.createGateway = (opts: any) => {
  const gw = createOfficeShareGateway({ ...opts, create: ((handler: any) => createServer((req, res) => { req.headers.host = HOST; handler(req, res); })) as typeof createServer });
  const listen = gw.listen;
  return { ...gw, server: gw.server, readinessMarker: gw.readinessMarker, setHost: gw.setHost, close: gw.close, listen: async () => { const u = await listen(); gwOrigin = u.origin; return u; } };
};

// Every pack picture a page loads: its status, Content-Type, and whether the browser decoded it.
const watch = (page: any) => {
  const seen: Array<{ path: string; status: number; type: string }> = [];
  page.on("response", (r: any) => { const p = new URL(r.url()).pathname; if (/\/office-skins\/[^/]+\/img\//.test(p)) seen.push({ path: p.replace(/[0-9a-f]{16,}/g, "<sha>"), status: r.status(), type: r.headers()["content-type"] ?? "" }); });
  return seen;
};
const decoded = (page: any) => page.evaluate(`Promise.all([...new Set(performance.getEntriesByType("resource").map(e => e.name).filter(u => u.includes("/img/")))].map(u => new Promise(ok => { const i = new Image(); i.onload = () => ok(i.naturalWidth + "x" + i.naturalHeight); i.onerror = () => ok("error"); i.src = u; })))`);
const tab = (lang: string) => (lang === "en" ? "Office" : "辦公室");
const openOffice = async (page: any, lang: string) => {
  if (!(await mounted(page, 30000))) throw new Error("the app did not mount");
  await page.goto(`${fx.base}/ui/fleet/org`);
  await page.locator(".oc-tools .seg-inline button", { hasText: tab(lang) }).click();
  await page.waitForSelector(".oo-canvas", { timeout: 15000 });
};

try {
  // ── 1. Upload through the editor's picker (desk, EN): manifest.json and the two .webp files, picked together ──
  {
    const c = { device: "desk", theme: "light", lang: "en" } as const;
    const { ctx, page } = await fx.page(c as any, { storage: { agend_org_office: "hq" } });
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(String(e)));
    await openOffice(page, c.lang);
    await page.locator(".oo-edit").click();
    await page.waitForSelector(".oe-upload-files", { state: "attached", timeout: 10000 });
    const up = page.waitForResponse((r: any) => new URL(r.url()).pathname === "/ui/office-skins" && r.request().method() === "POST", { timeout: 30000 });
    await page.setInputFiles(".oe-upload-files", [
      { name: "manifest.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(drawn.manifest, null, 2)) },
      { name: "bg.webp", mimeType: "image/webp", buffer: bgWebp },
      { name: "sheet.webp", mimeType: "image/webp", buffer: sheetWebp },
    ]);
    const res = await up;
    const body = await res.text();
    if (!res.ok()) { await page.screenshot({ path: join(OUT, "x-upload-failed.png") }); throw new Error(`upload ${res.status()} ${body.slice(0, 400)}`); }
    await page.waitForSelector(`.oe-pack[data-pack="${id}"]`, { timeout: 15000 }).catch(async (e: Error) => { await page.screenshot({ path: join(OUT, "x-not-listed.png") }); throw new Error(e.message + " / " + body.slice(0, 300)); });
    await sleep(600);
    await page.locator(".oe-packs").first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(OUT, "1-editor-uploaded-desk-en.png") });
    report.upload = { status: res.status(), errors };
    await ctx.close();
  }
  const kept = fm.officeSkins.get(id);
  if (!kept) throw new Error("the pack is not kept");
  report.kept = { files: Object.keys(kept.files) };
  put(id);
  const auto = fm.officeStore.setAutoSkin(id); if (auto && auto.ok === false) throw new Error("setAutoSkin " + JSON.stringify(auto));
  // The editor's lead in zh-TW, with the pack listed.
  {
    const { ctx, page } = await fx.page({ device: "desk", theme: "light", lang: "zh-TW" } as any, { storage: { agend_org_office: "hq" } });
    await openOffice(page, "zh-TW");
    await page.locator(".oo-edit").click();
    await page.waitForSelector(`.oe-pack[data-pack="${id}"]`, { timeout: 15000 });
    await page.locator(".oe-packs").first().scrollIntoViewIfNeeded(); await sleep(400);
    await page.screenshot({ path: join(OUT, "1-editor-uploaded-desk-zh-TW.png") });
    await ctx.close();
  }

  // ── 2. The Office, and 3. a share of it, on a desk and a 390×844 phone, EN and zh-TW ──
  const made = await svc.create({ office: "hq", owner: "smoke", theme: "light" });
  if (!made.ok) throw new Error("share refused " + JSON.stringify(made));
  const shareUrl = `${gwOrigin}${new URL(made.url).pathname}`;
  for (const device of ["desk", "phone"] as const) for (const lang of ["en", "zh-TW"] as const) {
    const c = { device, theme: "light" as const, lang }, key = `${device}-${lang}`;
    const { ctx, page, csp } = await fx.page(c as any, { storage: { agend_org_office: "hq" } });
    const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(String(e)));
    const pics = watch(page);
    await openOffice(page, lang);
    await sleep(4000);
    await page.screenshot({ path: join(OUT, `2-office-${key}.png`) });
    const office = { errors, csp: await csp(), viewport: page.viewportSize(), pictures: pics, decoded: await decoded(page), zoom: (await page.locator(".oo-zoom-pct").innerText().catch(() => "?")).trim() };
    await ctx.close();
    // The share page: a viewer with no sign-in, on the same device.
    const vp = device === "phone" ? { width: 390, height: 844 } : { width: 1366, height: 900 };
    const sctx = await fx.browser.newContext({ viewport: vp, deviceScaleFactor: 1, isMobile: device === "phone", hasTouch: device === "phone", colorScheme: "light", locale: lang === "zh-TW" ? "zh-TW" : "en-US" });
    const sp = await sctx.newPage();
    const serrors: string[] = []; sp.on("pageerror", (e: Error) => serrors.push(String(e)));
    sp.on("console", (m: any) => { if (m.type() === "error") serrors.push(m.text().slice(0, 200)); });
    const spics = watch(sp);
    await sp.goto(shareUrl);
    await sp.waitForSelector(".oo-canvas", { timeout: 15000 });
    await sleep(4000);
    await sp.screenshot({ path: join(OUT, `3-share-${key}.png`) });
    report.cases[key] = { office, share: { errors: serrors, viewport: sp.viewportSize(), pictures: spics, decoded: await decoded(sp) } };
    await sctx.close();
  }
} finally { await fx.close(); }
writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1));
process.exit(0);   // the share gateway keeps the loop alive
