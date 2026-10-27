// #2715/#2716 from defaults (fleet decision a78ebdc5): the whole-fleet office's style kept for everyone, and a share
// link's look. A fresh fleet (no web-offices.json; one uploaded skin pack, the clinic fixture), fresh profiles with
// nothing seeded, signed in through the visible /signin, everything done through the visible UI. The share's tunnel is
// stubbed (no network): the real share gateway on loopback, presented with the tunnel's Host, as smoke-2636 does.
// 1. An admin opens the Office and picks the pack for Whole fleet: saved on the host. A second fresh profile (a read-only
//    session) shows it without picking anything.
// 2. Share… → Whole fleet (the default while it is shown), Look Dark (the default on a dark dashboard): the share page,
//    opened by a light-mode viewer, is served dark (data-theme on <html>, so the first frame is dark), opens on the
//    whole-fleet office in the host's style, and its pack pictures load. Then Look Light on the dark dashboard, opened by
//    a dark-mode viewer: light.
// 3. Blocked: the admin's saves exhausted (the offices' real limiter, filled for that person): a pick says "Too many
//    changes", and the picker goes back to the host's style; the host is unchanged.
// 4. The read-only person picks their own style: kept in their browser (a reload keeps it), and no PUT /ui/office-style
//    leaves the page (its network log).
// Pictures: 1-admin-picked, 1b-second-profile, 2-share-dark, 2b-share-light, 3-blocked, 4-own-pick.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2715-office-look.mts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, shotPath, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2715-office-look";
const REPO = process.env.REPO!;
const HOST = "abc-office.trycloudflare.com";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48620), classic: false, instances: 6 });
const fm = fx.fm;
const { tokenEpoch } = await import(REPO + "/src/web-session.ts");
const { fleetCookieName } = await import(REPO + "/src/web-cookie-names.ts");
const { createOfficeShareGateway } = await import(REPO + "/src/office-share.ts");

const results: Array<Record<string, unknown>> = [];
let failed = 0;
function record(name: string, c: Record<string, boolean>, extra: Record<string, unknown> = {}) {
  const bad = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length) failed++;
  results.push({ name, ok: !bad.length, checks: c, ...extra });
  console.log(`${bad.length ? "FAIL" : "ok  "} ${name}${bad.length ? ` [${bad.join(", ")}]` : ""} ${JSON.stringify(extra).slice(0, 1200)}`);
}

// ── The host: a fresh fleet, one uploaded pack ──
const FIX = join(REPO, "tests", "fixtures", "office-skin-clinic");
const manifest = JSON.parse(readFileSync(join(FIX, "manifest.json"), "utf8"));
const PACK = manifest.id as string;
const files = { "office_bg.png": readFileSync(join(FIX, "office_bg.png")).toString("base64"), "fox_idle.png": readFileSync(join(FIX, "fox_idle.png")).toString("base64") };
const added = fm.officeSkins.add({ manifest, files, name: "Clinic" }, "smoke");
if (!added.ok) throw new Error(`pack refused: ${JSON.stringify(added).slice(0, 200)}`);
const officesFile = join(fm.dataDir ?? fx.dir, "web-offices.json");

// ── The share's tunnel, stubbed: the real service and gateway, a fixed quick-tunnel host, no cloudflared ──
let gwOrigin = "";
const svc = fm.officeShares as any;
svc.deps.ensure = async () => ({ path: "/nonexistent/cloudflared" });
svc.deps.provider = () => ({});
svc.deps.ownerCurrent = () => true;
svc.deps.manager = {
  start: async (_p: unknown, ctx: { onCandidateHost?(h: string): void }) => {
    ctx.onCandidateHost?.(HOST);
    return { ok: true, handle: { pageUrl: `https://${HOST}/ready`, onUnexpectedExit: () => () => {} } };
  },
  stop: async () => ({ confirmed: true }),
};
svc.deps.createGateway = (opts: any) => {
  const gw = createOfficeShareGateway({ ...opts,
    create: ((handler: any) => createServer((req, res) => { req.headers.host = HOST; handler(req, res); })) as typeof createServer });
  const listen = gw.listen;
  return { ...gw, server: gw.server, readinessMarker: gw.readinessMarker, setHost: gw.setHost, close: gw.close,
    listen: async () => { const u = await listen(); gwOrigin = u.origin; return u; } };
};
const localShare = (url: string) => { const u = new URL(url); return `${gwOrigin}${u.pathname}`; };

// ── Visible navigation ──
async function openOffice(page: any, base: string) {
  if (!(await mounted(page, 30000))) throw new Error("the app did not mount");
  const direct = page.locator('a[href^="/ui/fleet"]');
  let clicked = false;
  for (let i = 0; i < await direct.count() && !clicked; i++) if (await direct.nth(i).isVisible()) { await direct.nth(i).click(); clicked = true; }
  if (!clicked) await page.locator('nav.tabs a[href^="/ui/fleet"]').first().click();
  await page.waitForURL(/\/ui\/fleet/, { timeout: 10000 });
  if (!/\/ui\/fleet\/org$/.test(new URL(page.url()).pathname)) await page.locator('.p-fleet a.seg-item[href="/ui/fleet/org"]').first().click();
  await page.waitForURL(`${base}/ui/fleet/org`, { timeout: 10000 });
  await page.locator(".oc-tools .seg-inline button", { hasText: "Office" }).click();
  await page.waitForSelector(".oo-canvas", { timeout: 15000 });
  await page.waitForTimeout(800);
}
const picker = (page: any) => page.locator(".oo-bar select[title]");
const styleOf = (page: any) => picker(page).inputValue() as Promise<string>;
const csp = (page: any) => page.evaluate("window.__smokeCsp || []") as Promise<string[]>;
const watchCsp = (ctx: any) => ctx.addInitScript({ content: `window.__smokeCsp = []; document.addEventListener("securitypolicyviolation", e => window.__smokeCsp.push(e.violatedDirective + " " + (e.blockedURI || "")));` });
/** Requests a page sends to /ui/office-style (its network log). */
const styleWrites = (page: any) => { const seen: string[] = []; page.on("request", (r: any) => { if (new URL(r.url()).pathname === "/ui/office-style") seen.push(`${r.method()} ${new URL(r.url()).pathname}`); }); return seen; };
/** The sRGB luminance of a CSS colour, 0 (black) to 1. */
const lum = (rgb: string) => { const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number); return (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255; };

const C: MatrixCase = { device: "desk", theme: "dark", lang: "en" };

// ── 1. The admin picks; a second fresh profile shows it ──
const fileBefore = existsSync(officesFile);
const admin = await freshPage(fx, C, { beforeNavigate: watchCsp });
const adminWrites = styleWrites(admin.page);
await openOffice(admin.page, admin.base);
const firstStyle = await styleOf(admin.page);
const title = await picker(admin.page).getAttribute("title");
const saved = admin.page.waitForResponse((r: any) => new URL(r.url()).pathname === "/ui/office-style", { timeout: 10000 });
await picker(admin.page).selectOption(PACK);
const savedStatus = (await saved).status();
await admin.page.waitForTimeout(2500);
await admin.page.screenshot({ path: shotPath(SMOKE, C, "1-admin-picked") });
record("1 admin picks for everyone", {
  "no web-offices.json before": !fileBefore,
  "opens on the default (cozy)": firstStyle === "cozy",
  "the picker says it is for everyone": title === "The whole fleet's style, for everyone: every device and share link",
  "PUT answered 200": savedStatus === 200,
  "kept on the host": fm.officeStore.autoSkin() === PACK,
  "written to web-offices.json": existsSync(officesFile) && JSON.parse(readFileSync(officesFile, "utf8")).autoSkin === PACK,
  "the picker shows the pack": (await styleOf(admin.page)) === PACK,
  "no page error": admin.errors.length === 0,
  "no CSP violation": (await csp(admin.page)).length === 0,
}, { firstStyle, savedStatus, writes: adminWrites, errors: admin.errors });

// A read-only session: a fresh context, its session cookie as the browser would hold it, nothing else.
fm.initializeWebSessions();
const roSid = fm.webSessions.create({ tier: "read", surface: "local", label: "smoke read", tokenEpoch: tokenEpoch(fm.webToken) }).sessionId;
const roCtx = await fx.browser.newContext({ viewport: { width: 1366, height: 900 }, colorScheme: "light", locale: "en-US" });
await watchCsp(roCtx);
await roCtx.addCookies([{ name: fleetCookieName("agend_session", fm.webToken), value: roSid, url: fx.base, httpOnly: true, sameSite: "Strict" }]);
const ro = await roCtx.newPage();
const roErrors: string[] = [];
ro.on("pageerror", (e: any) => roErrors.push(String(e).slice(0, 200)));
const roWrites = styleWrites(ro);
await ro.goto(`${fx.base}/ui`);
await openOffice(ro, fx.base);
await ro.waitForTimeout(2000);
await ro.screenshot({ path: shotPath(SMOKE, C, "1b-second-profile") });
const roStorage = await ro.evaluate("localStorage.getItem('agend_org_office_skin')");
record("1b a second fresh profile shows it", {
  "shows the pack, never picked here": (await styleOf(ro)) === PACK,
  "nothing of its own in storage": roStorage === null,
  "the picker says it is this browser's": (await picker(ro).getAttribute("title")) === "The whole fleet's style in this browser",
  "no style write": roWrites.length === 0,
  "no page error": roErrors.length === 0,
}, { roStorage });

// ── 2. Share… → Whole fleet, Look Dark; then Look Light ──
async function makeShare(look: string | null) {
  await admin.page.locator(".oo-share").click();
  await admin.page.waitForSelector(".os-form", { timeout: 5000 });
  const office = await admin.page.locator(".os-form select").nth(0).inputValue();
  const lookSel = admin.page.locator(".os-form select.os-look");
  const lookDefault = await lookSel.inputValue();
  if (look) await lookSel.selectOption(look);
  await admin.page.locator(".dlg-actions button", { hasText: "Create link" }).click();
  await admin.page.waitForSelector(".os-url", { timeout: 15000 });
  const url = await admin.page.locator(".os-url").inputValue();
  return { office, lookDefault, url };
}
async function viewShare(url: string, scheme: "light" | "dark", shot: string) {
  const ctx = await fx.browser.newContext({ viewport: { width: 1366, height: 900 }, colorScheme: scheme, locale: "en-US" });
  const page = await ctx.newPage();
  const errors: string[] = [], pictures: number[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 200)));
  page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  page.on("response", (r: any) => { if (/\/office-skins\/[^/]+\/img\//.test(new URL(r.url()).pathname)) pictures.push(r.status()); });
  const doc = await page.goto(localShare(url), { waitUntil: "commit" });
  const html = await doc.text();
  await page.waitForLoadState("domcontentloaded");
  const firstBg = await page.evaluate("getComputedStyle(document.body).backgroundColor") as string;
  const attr = await page.evaluate("document.documentElement.getAttribute('data-theme')");
  await page.waitForSelector(".oo-canvas", { timeout: 15000 });
  await page.waitForTimeout(3000);
  const opened = await page.locator("select.oo-office").inputValue();
  const style = await page.locator(".oo-bar select[title]").inputValue().catch(() => "");
  await page.screenshot({ path: shotPath(SMOKE, C, shot) });
  await ctx.close();
  return { html, firstBg, attr, opened, style, pictures, errors };
}
const dark = await makeShare(null);
await admin.page.screenshot({ path: shotPath(SMOKE, C, "2-dialog-made") });
await admin.page.locator(".dlg-actions button", { hasText: "Close" }).click();
const dv = await viewShare(dark.url, "light", "2-share-dark");
record("2 a share of Whole fleet, Look Dark, opened in a light-mode browser", {
  "the dialog's office default is Whole fleet": dark.office === "auto",
  "the dialog's look default is the dashboard's dark": dark.lookDefault === "dark",
  "served with data-theme=dark on <html>": dv.html.includes('<html lang="en" data-theme="dark">'),
  "dark from the first frame": dv.attr === "dark" && lum(dv.firstBg) < 0.25,
  "opens on the whole-fleet office": dv.opened === "auto",
  "in the host's style": dv.style === PACK,
  "its pack pictures load": dv.pictures.length > 0 && dv.pictures.every(s => s === 200),
  "no page error": dv.errors.length === 0,
}, { office: dark.office, lookDefault: dark.lookDefault, firstBg: dv.firstBg, opened: dv.opened, style: dv.style, pictures: dv.pictures.length, errors: dv.errors });
const light = await makeShare("light");
await admin.page.locator(".dlg-actions button", { hasText: "Close" }).click();
const lv = await viewShare(light.url, "dark", "2b-share-light");
record("2b Look Light from a dark dashboard, opened in a dark-mode browser", {
  "served with data-theme=light": lv.html.includes('<html lang="en" data-theme="light">'),
  "light from the first frame": lv.attr === "light" && lum(lv.firstBg) > 0.75,
  "opens on the whole-fleet office in the host's style": lv.opened === "auto" && lv.style === PACK,
  "no page error": lv.errors.length === 0,
}, { firstBg: lv.firstBg });

// ── 3. Blocked: the admin's saves exhausted (the offices' real limiter, for this person) ──
for (let i = 0; i < 25; i++) fm.officeWrites.record(admin.personKey);
const refused = admin.page.waitForResponse((r: any) => new URL(r.url()).pathname === "/ui/office-style", { timeout: 10000 });
await picker(admin.page).selectOption("pixel");
const refusedStatus = (await refused).status();
await admin.page.waitForSelector(".oo-style-err", { timeout: 5000 });
await admin.page.waitForTimeout(500);
const note = (await admin.page.locator(".oo-style-err").textContent())?.trim();
await admin.page.screenshot({ path: shotPath(SMOKE, C, "3-blocked") });
record("3 a refused save says so and goes back", {
  "PUT answered 429": refusedStatus === 429,
  "the note says why": note === "Too many changes. Try again in a minute.",
  "the picker is back on the host's style": (await styleOf(admin.page)) === PACK,
  "the host is unchanged": fm.officeStore.autoSkin() === PACK,
}, { refusedStatus, note });

// ── 4. The read-only person's own pick: kept in their browser, never sent ──
await picker(ro).selectOption("studio");
await ro.waitForTimeout(1500);
await ro.reload();
await openOffice(ro, fx.base);
await ro.waitForTimeout(1500);
await ro.screenshot({ path: shotPath(SMOKE, C, "4-own-pick") });
record("4 a non-admin's own pick stays theirs", {
  "kept after a reload": (await styleOf(ro)) === "studio",
  "in their storage": (await ro.evaluate("localStorage.getItem('agend_org_office_skin')")) === "studio",
  "no PUT /ui/office-style in its network log": roWrites.length === 0,
  "the host is unchanged": fm.officeStore.autoSkin() === PACK,
  "no page error": roErrors.length === 0,
  "no CSP violation": (await csp(ro)).length === 0,
}, { network: roWrites });

await roCtx.close();
await admin.ctx.close();
writeFileSync(shotPath(SMOKE, "result", "json").replace(/\.png$/, ".json"), JSON.stringify({ results, failed }, null, 1));
await fx.close();
console.log(failed ? `${failed} FAILED` : "all ok");
process.exit(failed ? 1 : 0);
