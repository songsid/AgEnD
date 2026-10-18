// #2052 from defaults (fleet decision a78ebdc5): the org canvas's key never covers a card. On the realistic fixture
// (its many teams; demo names only), a fresh profile with nothing seeded reaches Fleet → Org chart through the sidebar.
// - At the opening view the key is a **Key** toggle in the toolbar: nothing over the canvas, the bottom-left team in view
//   uncovered.
// - Opened, its rows are a strip between the toolbar and the canvas: below the toolbar, above the canvas, over no card.
// - Desk light (English) and phone dark (zh-TW, reduced motion, a LAN origin — Chromium; WebKit has no host-resolver
//   rule, so its phone case is on 127.0.0.1): no horizontal overflow, every toolbar control on screen; kept per device
//   (a reload keeps it open).
// - The temporary public link (desk light, reduced motion): the real PublicWebLink, gateway and routes
//   (openPublicLink); a fresh profile signs in through the link's own visible /signin and reaches Org the same way.
//   Stubbed, as the harness says: the tunnel and cloudflared, the owner check, the General notice, and the transport
//   (Playwright carries https://<demo>.trycloudflare.com to the gateway's local port).
// - No page error. The only lines accepted are WebKit's own, as #2138's smoke does (#2127), under WebKit only, matched
//   exactly and printed apart: its internal sheet for each <select> ("Refused to apply a stylesheet…": it renders the
//   same) and the viewport meta's interactive-widget key it doesn't know. Nothing else, no URL pattern, no cancel.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2052-legend.mts
//   (PW_ENGINE=webkit for WebKit: see smoke-emoji-tofu.mts's header for the in-Docker recipe)
import { bootFixture, freshPage, mounted, openPublicLink, shotPath, type FreshPage } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2052-legend";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48490), classic: false });
const fm = fx.fm;
// Demo names only in what is shot: the fixture's real-fleet names go (its teams and many instances stay).
const REAL = /^(agend-|rd1-|awp-|doupo-)|^(web-claude|sol|fable|qa-1|a)$|-t\d{10,}|鬥破|己把鳩|研一/;
for (const name of Object.keys(fm.fleetConfig.instances)) if (REAL.test(name)) delete fm.fleetConfig.instances[name];
for (const t of Object.values(fm.fleetConfig.teams ?? {}) as Array<{ members: string[] }>) t.members = t.members.filter((m) => !REAL.test(m));
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
// The two engine lines, whole (the text before " @ <url>"), never a pattern a page's own error could share.
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
const accepted: string[] = [];
const pageErrors = (errors: string[]) => errors.filter((e) => {
  const text = e.replace(/ @ \S+$/, "");
  if (ENGINE === "webkit" && WEBKIT_OWN.has(text)) { accepted.push(e); return false; }
  return true;
});

async function openOrg(p: FreshPage) {
  await mounted(p.page);
  const end = Date.now() + 10000;
  for (let clicked = false; !clicked && Date.now() < end;) {
    for (const sel of ['a[href="/ui/fleet/org"]', 'a[href^="/ui/fleet"]']) {
      const l = p.page.locator(sel);
      for (let i = 0; i < await l.count() && !clicked; i++) if (await l.nth(i).isVisible()) { await l.nth(i).click(); clicked = true; }
      if (clicked) break;
    }
    if (!clicked) await p.page.waitForTimeout(150);
  }
  if (!/\/ui\/fleet\/org$/.test(p.page.url())) await p.page.locator('.seg a[href="/ui/fleet/org"]').first().click();
  await p.page.waitForURL("**/ui/fleet/org", { timeout: 10000 });
  await p.page.waitForSelector(".oc-svg .oc-node", { timeout: 10000 });
  await p.page.waitForTimeout(700);
}
/** Where the key, the toolbar, the canvas and every card and team box are on screen. */
const MEASURE = `(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
  const svg = document.querySelector(".oc-svg"), sb = svg.getBoundingClientRect();
  const visible = (b) => b.w > 0 && b.h > 0 && b.x < sb.right && b.x + b.w > sb.left && b.y < sb.bottom && b.y + b.h > sb.top;
  return { key: r(document.querySelector(".oc-tools .oc-key")), bar: r(document.querySelector(".oc-bar")), strip: r(document.querySelector(".oc-legend")),
    inStage: !!document.querySelector(".oc-stage .oc-legend, .oc-svg .oc-legend"), svg: r(svg),
    things: [...document.querySelectorAll(".oc-node, .oc-box")].map(r).filter(visible),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, vw: window.innerWidth,
    // Every toolbar control wholly on screen (the phone's row once cut the last one off).
    toolsClipped: [...document.querySelectorAll(".oc-tools > *")].filter((el) => { const b = el.getBoundingClientRect(); return b.width > 0 && (b.left < -0.5 || b.right > window.innerWidth + 0.5); }).map((el) => el.className || el.tagName),
    toolsOverflow: (() => { const t = document.querySelector(".oc-tools"); return t ? t.scrollWidth > t.clientWidth + 1 : false; })() };
})()`;
const overlaps = (a: any, b: any) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

const results: Array<{ name: string; ok: boolean; [k: string]: unknown }> = [];
async function runCase(name: string, open: () => Promise<FreshPage>) {
  const p = await open();
  await openOrg(p);
  const m0 = await p.page.evaluate(MEASURE) as any;
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "1-opening") });
  const chk: Record<string, boolean> = {
    keyInToolbar: !!m0.key && m0.key.y + m0.key.h <= m0.svg.y + 0.5 && m0.key.x + m0.key.w <= m0.vw + 0.5,
    nothingOverCanvas: !m0.strip && !m0.inStage,
    noOverflow: !m0.overflow,
    toolbarWhole: m0.toolsClipped.length === 0 && !m0.toolsOverflow,
  };
  await p.page.locator(".oc-tools .oc-key").click();
  await p.page.waitForSelector(".oc-legend", { timeout: 5000 });
  await p.page.waitForTimeout(400);
  const m1 = await p.page.evaluate(MEASURE) as any;
  chk.stripBetweenToolbarAndCanvas = !!m1.strip && m1.strip.y >= m1.bar.y + m1.bar.h - 0.5 && m1.strip.y + m1.strip.h <= m1.svg.y + 0.5 && !m1.inStage;
  chk.stripCoversNoCard = m1.things.length > 0 && !m1.things.some((t: any) => overlaps(t, m1.strip));
  chk.openNoOverflow = !m1.overflow && m1.toolsClipped.length === 0 && !m1.toolsOverflow;
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "2-key-open") });
  await p.page.reload();
  await p.page.waitForSelector(".oc-svg .oc-node", { timeout: 10000 });
  chk.keptOpen = await p.page.waitForSelector(".oc-legend", { timeout: 5000 }).then(() => true, () => false);
  const errors = pageErrors(p.errors);
  chk.noErrors = errors.length === 0;
  const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
  results.push({ name, ok: !failed.length, failed, errors });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${ENGINE}-${name}${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify({ m0: { key: m0.key, svg: m0.svg, overflow: m0.overflow, clipped: m0.toolsClipped }, m1: { strip: m1.strip, bar: m1.bar, svg: m1.svg } }).slice(0, 500)} ${JSON.stringify(errors).slice(0, 400)}` : ""}`);
  await p.ctx.close();
}
await runCase("desk-light-en", () => freshPage(fx, { device: "desk", theme: "light", lang: "en" }));
await runCase(ENGINE === "webkit" ? "phone-dark-zh-TW-reduced" : "phone-dark-zh-TW-lan-reduced",
  () => freshPage(fx, { device: "phone", theme: "dark", lang: "zh-TW" }, ENGINE === "webkit" ? { reducedMotion: true } : { origin: "lan", reducedMotion: true }));
const link = await openPublicLink(fx);
await runCase("public-link-desk-light-en-reduced", () => link.publicPage({ device: "desk", theme: "light", lang: "en" }, { reducedMotion: true }));
await link.close();
if (accepted.length) console.log(`WebKit's own lines, accepted (${accepted.length}):\n  ${[...new Set(accepted.map((e) => e.replace(/ @ \S+$/, "")))].join("\n  ")}`);
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `FAIL ${bad.map((b) => b.name).join(", ")}` : `PASS (${ENGINE})`);
await fx.close();
process.exit(bad.length ? 1 : 0);
