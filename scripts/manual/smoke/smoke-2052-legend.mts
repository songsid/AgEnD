// #2052 from defaults (fleet decision a78ebdc5): the org canvas's key never covers a card. On the realistic fixture
// (its many teams; demo names only), a fresh profile with nothing seeded reaches Fleet → Org chart through the sidebar.
// - At the opening view the key is a **Key** toggle in the toolbar: nothing over the canvas, the bottom-left team in view
//   uncovered.
// - Opened, its rows are a strip between the toolbar and the canvas: below the toolbar, above the canvas, over no card.
// - Desk light (English) and phone dark (zh-TW, reduced motion, a LAN origin): no horizontal overflow, the toggle on
//   screen; kept per device (a reload keeps it open). No page error.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2052-legend.mts
//   (PW_ENGINE=webkit for WebKit: see smoke-emoji-tofu.mts's header for the in-Docker recipe)
import { bootFixture, freshPage, mounted, shotPath, type FreshPage } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2052-legend";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48490), classic: false });
const fm = fx.fm;
// Demo names only in what is shot: the fixture's real-fleet names go (its teams and many instances stay).
const REAL = /^(agend-|rd1-|awp-|doupo-)|^(web-claude|sol|fable|qa-1|a)$|-t\d{10,}|鬥破|己把鳩|研一/;
for (const name of Object.keys(fm.fleetConfig.instances)) if (REAL.test(name)) delete fm.fleetConfig.instances[name];
for (const t of Object.values(fm.fleetConfig.teams ?? {}) as Array<{ members: string[] }>) t.members = t.members.filter((m) => !REAL.test(m));
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const KNOWN_WEBKIT = /Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline'|Viewport argument key "interactive-widget" not recognized|cannot load .* due to access control checks/;

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
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, vw: window.innerWidth };
})()`;
const overlaps = (a: any, b: any) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

const results: Array<{ name: string; ok: boolean; [k: string]: unknown }> = [];
for (const [name, c, opts] of [["desk-light-en", { device: "desk", theme: "light", lang: "en" }, {}],
  ["phone-dark-zh-TW-lan-reduced", { device: "phone", theme: "dark", lang: "zh-TW" }, ENGINE === "webkit" ? { reducedMotion: true } : { origin: "lan", reducedMotion: true }]] as const) {
  const p = await freshPage(fx, c as any, opts as any);
  await openOrg(p);
  const m0 = await p.page.evaluate(MEASURE) as any;
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "1-opening") });
  const chk: Record<string, boolean> = {
    keyInToolbar: !!m0.key && m0.key.y + m0.key.h <= m0.svg.y + 0.5 && m0.key.x + m0.key.w <= m0.vw + 0.5,
    nothingOverCanvas: !m0.strip && !m0.inStage,
    noOverflow: !m0.overflow,
  };
  await p.page.locator(".oc-tools .oc-key").click();
  await p.page.waitForSelector(".oc-legend", { timeout: 5000 });
  await p.page.waitForTimeout(400);
  const m1 = await p.page.evaluate(MEASURE) as any;
  chk.stripBetweenToolbarAndCanvas = !!m1.strip && m1.strip.y >= m1.bar.y + m1.bar.h - 0.5 && m1.strip.y + m1.strip.h <= m1.svg.y + 0.5 && !m1.inStage;
  chk.stripCoversNoCard = m1.things.length > 0 && !m1.things.some((t: any) => overlaps(t, m1.strip));
  chk.openNoOverflow = !m1.overflow;
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-${name}`, "2-key-open") });
  await p.page.reload();
  await p.page.waitForSelector(".oc-svg .oc-node", { timeout: 10000 });
  chk.keptOpen = await p.page.waitForSelector(".oc-legend", { timeout: 5000 }).then(() => true, () => false);
  const errors = p.errors.filter((e) => !(ENGINE === "webkit" && KNOWN_WEBKIT.test(e)));
  chk.noErrors = errors.length === 0;
  const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
  results.push({ name, ok: !failed.length, failed });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${ENGINE}-${name}${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify({ m0: { key: m0.key, svg: m0.svg, overflow: m0.overflow }, m1: { strip: m1.strip, bar: m1.bar, svg: m1.svg } }).slice(0, 500)} ${JSON.stringify(errors).slice(0, 200)}` : ""}`);
  await p.ctx.close();
}
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `FAIL ${bad.map((b) => b.name).join(", ")}` : `PASS (${ENGINE})`);
await fx.close();
process.exit(bad.length ? 1 : 0);
