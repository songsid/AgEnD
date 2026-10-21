// #2347 §6 settings search on a fresh profile — desk light (en), desk dark (zh-TW), phone light (en). Checks: "/"
// focuses the box; "token" lists results grouped by section (marks and config keys shown) without a page error or a
// sideways page scroll; Enter lands on the first one's section with the field focused and flashed.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-2347-search.mts
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48854), instances: 2 });
fx.fm.getInstanceStatus = () => "running";
const results: Array<{ name: string; failed: string[] }> = [];
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "light", lang: "en" }] as const) {
  const name = `${c.device}-${c.theme}-${c.lang}`, failed: string[] = [];
  const ok = (k: string, v: boolean) => { if (!v) failed.push(k); };
  const p = await freshPage(fx, c);
  const errors: string[] = [];
  p.page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  await mounted(p.page, 30000);
  await p.page.goto(new URL("/settings/agents", p.page.url()).href);
  await p.page.locator("#settingsSearch").waitFor({ timeout: 15000 });
  await p.page.locator(".p-settings .panel-body").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await p.page.keyboard.press("/");
  ok("slashFocuses", await p.page.evaluate(`document.activeElement && document.activeElement.id === "settingsSearch"`) === true);
  await p.page.keyboard.type("token");
  await p.page.locator(".s-find-results").waitFor({ timeout: 5000 });
  const geo = `(() => { const n = document.querySelector(".s-nav"), m = document.querySelector(".main"), side = document.querySelector(".sidebar");
    const nr = n.getBoundingClientRect(), sr = side && getComputedStyle(side).display !== "none" ? side.getBoundingClientRect() : null;
    const clipped = [...document.querySelectorAll(".s-find-head, .s-find-label, .s-find-key")].some((e) => { const r = e.getBoundingClientRect(); return r.left < nr.left - 1 || r.right > nr.right + 1; });
    return { navScroll: n.scrollLeft, mainScroll: m.scrollLeft, navLeftOk: !sr || sr.right <= nr.left + 1 || innerWidth < 900, clipped }; })()`;
  const r = await p.page.evaluate(`(() => ({ heads: [...document.querySelectorAll(".s-find-head")].length, items: [...document.querySelectorAll(".s-find-item")].length,
    marks: document.querySelectorAll(".s-find-item mark").length, keys: document.querySelectorAll(".s-find-key").length,
    overflowX: document.documentElement.scrollWidth > innerWidth, geo: ${geo} }))()`) as any;
  const wide = await p.page.evaluate(`(() => { const n = document.querySelector(".s-nav"), nr = n.getBoundingClientRect(), m = document.querySelector(".main");
    const out = []; for (const e of n.querySelectorAll("*")) { const r = e.getBoundingClientRect(); if (r.right > nr.right + 1 || r.left < nr.left - 1) out.push(e.tagName + "." + (e.className || "") + " " + Math.round(r.left) + "-" + Math.round(r.right)); }
    const mw = []; for (const e of m.querySelectorAll("*")) { const r = e.getBoundingClientRect(); if (r.right > innerWidth + 1) mw.push(e.tagName + "." + String(e.className || "").slice(0, 40) + " " + Math.round(r.right)); }
    const cs = getComputedStyle(n), g = document.querySelector(".s-nav-groups"), gs = getComputedStyle(g);
    return { dir: [cs.display, cs.flexDirection, cs.flexWrap, gs.display, gs.flexDirection], nav: [Math.round(nr.left), Math.round(nr.right), n.scrollWidth, n.clientWidth], out: out.slice(0, 6), mainW: [m.scrollWidth, m.clientWidth], mw: mw.slice(0, 6) }; })()`);
  ok("navNotScrolledSideways", r.geo.navScroll === 0 && r.geo.mainScroll === 0);
  // Nothing in the nav column lies outside it (on a phone the groups' own row scrolls; it is the only one allowed to).
  ok("navFitsItsBox", wide.out.every((x: string) => c.device === "phone" && /s-nav-group|seg-item|SPAN\.|svg|circle|path|A\./.test(x)));
  ok("resultsNotClipped", !r.geo.clipped && r.geo.navLeftOk);
  ok("grouped", r.heads >= 2 && r.items >= 3);
  ok("marked", r.marks >= 1 && r.keys >= 1);
  ok("noSideScroll", !r.overflowX);
  await p.page.screenshot({ path: shotPath("2347s", c as any, "1-results") });
  await p.page.keyboard.press("Enter");
  await p.page.waitForTimeout(900);
  const landed = await p.page.evaluate(`(() => ({ path: location.pathname, focused: document.activeElement && document.activeElement.id, flash: !!document.querySelector(".s-flash") }))()`) as any;
  ok("landed", landed.path === "/settings/access" && landed.focused === "publicTunnelToken");
  const after = await p.page.evaluate(geo) as any;
  ok("pageNotOffset", after.mainScroll === 0 && (c.device === "phone" || after.navScroll === 0));
  ok("flashed", landed.flash);
  await p.page.screenshot({ path: shotPath("2347s", c as any, "2-landed") });
  ok("noPageErrors", errors.length === 0);
  results.push({ name, failed });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${name}${failed.length ? " " + failed.join(", ") : ""} ${JSON.stringify({ r, landed })}${errors.length ? " errors=" + JSON.stringify(errors) : ""}`);
  await p.ctx.close();
}
console.log(results.some((r) => r.failed.length) ? "FAIL" : "PASS");
await fx.close();
process.exit(results.some((r) => r.failed.length) ? 1 : 0);
