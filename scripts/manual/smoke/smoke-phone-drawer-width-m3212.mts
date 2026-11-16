// M-3212 (the user, 11-16): the phone's drawer width is a choice — 自訂 → 顯示 → 手機側欄: 滿版 (the default, M-3211) or 窄版
// (the drawer before M-3211: 300 px, the page beside it). This browser's own. On a phone 自訂 opens from an icon beside the
// drawer's filter, left of [+]; its 顯示 holds 詳細/精簡 and 手機側欄 (a phone's only). The drawer's agents follow 文字大小.
// A real browser on the shared fixture (in-process FleetManager, scratch home, loopback only, fake agents with faces),
// a phone (390×844, touch, an iPhone's safe area), light/dark; and a desk. Pictured per phone case: 1-full (the icon),
// 2-menu (自訂 open), 3-narrow-detailed, 4-narrow-compact. Run it on the base too (SMOKE_NAME=…-before): it FAILs there.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] [PW_ENGINE=webkit] scripts/manual/smoke/run.sh smoke-phone-drawer-width-m3212.mts
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";
import { clearDensity, density, faces, withFaces } from "../smoke-fixture/faces.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-phone-drawer-width-m3212";
const webkit = process.env.PW_ENGINE === "webkit";
const fx = await bootFixture({ port: Number(process.env.HP ?? 49000), instances: 8 });
const names = fx.instances.map((i: any) => i.name);
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
const isOpen = (page: any) => page.evaluate(() => document.querySelector(".shell")!.classList.contains("sb-open"));
const openDrawer = async (page: any) => { if (!(await isOpen(page))) { await page.locator("#sbOpen").tap(); await page.waitForTimeout(600); } };
const READ = () => {
  const sb = document.querySelector("#sidebar") as HTMLElement;
  const shown = (e: Element | null) => !!e && (e as HTMLElement).getBoundingClientRect().width > 0;
  const box = (e: Element | null) => { if (!e || !shown(e)) return null; const r = (e as HTMLElement).getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
  const rows = [...sb.querySelectorAll(".v-inst")].filter(shown) as HTMLElement[];
  const name = rows[0]?.querySelector(".inst-name");
  return { w: Math.round(sb.getBoundingClientRect().width), vw: innerWidth, narrow: sb.classList.contains("drawer-narrow"),
    icon: box(sb.querySelector(".v-filter .nav-sort-phone > .nav-sort-btn")), filter: box(sb.querySelector(".v-filter-box")), plus: box(sb.querySelector(".side-new")),
    chip: shown(sb.querySelector(".inst-head .nav-sort-btn")), favEdit: shown(sb.querySelector(".fav-edit")),
    scrim: getComputedStyle(document.querySelector(".scrim") as HTMLElement).display !== "none",
    rowMin: rows.length ? Math.min(...rows.map((e) => Math.round(e.getBoundingClientRect().height))) : 0,
    av: rows.map((e) => box(e.querySelector(".av"))?.w ?? null), name: name ? parseFloat(getComputedStyle(name).fontSize) : 0,
    menu: box(sb.querySelector(".nav-sort-phone .nav-sort-menu")),
    legends: [...sb.querySelectorAll(".nav-sort-phone .nav-sort-menu legend")].filter(shown).map((l) => (l.textContent || "").trim()),
    wide: document.documentElement.scrollWidth > document.documentElement.clientWidth };
};

try {
  for (const c of matrix(process.env.MATRIX ?? "phone-light-en,phone-dark-zh-TW")) {
    if (c.device !== "phone") continue;
    const failed: string[] = [];
    const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
    const zh = c.lang === "zh-TW";
    const p = await freshPage(fx, c, { account: "operator", path: "/ui/fleet/org", beforeNavigate: async (ctx: any, page: any) => {
      await ctx.addInitScript({ content: "window.__name = (f) => f" });
      await withFaces(ctx, names);
      if (!webkit) { const s = await ctx.newCDPSession(page); await s.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } }); }
    } });
    const page = p.page;
    const errs: string[] = []; page.on("pageerror", (e: any) => { const m = String(e); if (!(webkit && /ResizeObserver loop/.test(m))) errs.push(m.slice(0, 200)); });
    try {
      need(await mounted(page, 30000), "the app mounted");
      await faces(page, names); await page.waitForTimeout(800);
      await openDrawer(page);
      // 滿版 by default: the 自訂 icon beside the filter, left of [+]; the list header (its chip, 編輯最愛) stays hidden.
      const full = await page.evaluate(READ);
      need(!full.narrow && full.w === full.vw && !full.wide, `滿版 by default (${full.w} of ${full.vw})`);
      need(full.icon && full.filter && full.plus && full.icon.l >= full.filter.r - 1 && full.icon.r <= full.plus.l + 1 && Math.abs((full.icon.t + full.icon.b) / 2 - (full.filter.t + full.filter.b) / 2) <= 6
        && full.icon.w >= 44 && full.icon.h >= 44 && !full.chip && !full.favEdit, `自訂 is an icon between the filter and [+], a full tap target; no list header (${JSON.stringify({ icon: full.icon, filter: full.filter, plus: full.plus, chip: full.chip, favEdit: full.favEdit })})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "1-full") });
      await page.locator("#sidebar .nav-sort-phone > .nav-sort-btn").tap(); await page.waitForTimeout(400);
      const menu = await page.evaluate(READ);
      const want = zh ? ["顯示", "手機側欄"] : ["Display", "Phone sidebar"];
      need(menu.menu && want.every((w) => menu.legends.includes(w)) && menu.menu.r <= menu.vw + 1, `自訂 opens with 顯示 and 手機側欄 (${JSON.stringify(menu.legends)})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "2-menu") });
      // 窄版: the drawer before M-3211 — 300 px with the page beside it, rows of 48 px, the avatars at the list's own size.
      await page.locator(`#sidebar .nav-sort-phone input[name="nav-sort-drawer"][value="narrow"]`).check(); await page.waitForTimeout(400);
      await page.locator("#sidebar .nav-sort-phone > .nav-sort-btn").tap(); await page.waitForTimeout(300);   // the menu closes
      await openDrawer(page);
      const nd = await page.evaluate(READ);
      need(nd.narrow && nd.w === 300 && nd.scrim && nd.rowMin >= 47.5 && nd.av.every((w: number | null) => w === 28), `窄版: 300 px beside the page, 48 px rows, 28 px avatars (${JSON.stringify({ w: nd.w, scrim: nd.scrim, rowMin: nd.rowMin, av: nd.av })})`);
      need(nd.icon && nd.icon.r <= (nd.plus?.l ?? 0) + 1, `窄版 keeps 自訂 beside the filter (${JSON.stringify({ icon: nd.icon, plus: nd.plus })})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "3-narrow-detailed") });
      await density(page, "compact"); await page.waitForTimeout(500);
      const nc = await page.evaluate(READ);
      need(nc.narrow && nc.w === 300 && nc.av.every((w: number | null) => w === null), `窄版 compact: the dot alone (${JSON.stringify(nc.av)})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "4-narrow-compact") });
      await density(page, "detailed");
      // This browser keeps it: a reload opens on 窄版.
      await page.reload(); await mounted(page, 30000); await faces(page, names); await page.waitForTimeout(600); await openDrawer(page);
      const kept = await page.evaluate(READ);
      need(kept.narrow && kept.w === 300, `a reload keeps 窄版 (${kept.w})`);
      // Back to 滿版; 文字大小 L makes the names bigger (17 → 19.55 px).
      await page.evaluate(() => { localStorage.removeItem("agend_phone_drawer"); localStorage.setItem("agend_text_size", "l"); });
      await page.reload(); await mounted(page, 30000); await faces(page, names); await page.waitForTimeout(600); await openDrawer(page);
      const big = await page.evaluate(READ);
      need(!big.narrow && Math.abs(big.name - 17 * 1.15) < 0.2, `滿版 again; 文字大小 L scales the names (${big.name} px)`);
      await page.evaluate(() => localStorage.removeItem("agend_text_size"));
      need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
    } catch (err) {
      failed.push(`threw: ${String(err).slice(0, 300)}`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "error") }).catch(() => {});
    }
    results.push({ name: caseName(c), ok: failed.length === 0, failed });
    await p.ctx.close();
    clearDensity(fx);
  }
  // A desk: 自訂's chip as before, no phone icon, and no 手機側欄 in its menu.
  const c = { device: "desk", theme: "light", lang: "en" } as any;
  const p = await freshPage(fx, c, { account: "operator", path: "/ui/fleet/org", beforeNavigate: async (ctx: any) => { await ctx.addInitScript({ content: "window.__name = (f) => f" }); } });
  const failed: string[] = [];
  await mounted(p.page, 30000); await p.page.waitForTimeout(800);
  await p.page.locator("#sidebar .inst-head .nav-sort-btn").click(); await p.page.waitForTimeout(300);
  const d = await p.page.evaluate(() => {
    const shown = (e: Element | null) => !!e && (e as HTMLElement).getBoundingClientRect().width > 0;
    return { icon: shown(document.querySelector(".nav-sort-phone > .nav-sort-btn")), legends: [...document.querySelectorAll(".nav-sort-menu legend")].filter(shown).map((l) => (l.textContent || "").trim()) };
  });
  if (d.icon || d.legends.includes("Phone sidebar") || !d.legends.includes("Display")) failed.push(`desk: the chip's menu as before, no phone icon or 手機側欄 (${JSON.stringify(d)})`);
  await p.page.screenshot({ path: shotPath(SMOKE, "desk-light-en", "menu") });
  results.push({ name: "desk-light-en", ok: failed.length === 0, failed });
  await p.ctx.close();
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
