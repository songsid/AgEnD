// M-3245 (the user, iPhone, beta.7: 「設定頁左上的左箭頭和漢堡選單 icon 意義不明」): a phone's top-left button had three
// meanings in three looks — ☰ opened the agents' drawer, the drawer's own ← closed it (read as "back"), and a Settings
// section had ☰ with a "‹ Settings" bar under it. One rule now: ☰ opens the drawer on a page with nothing above it; ←
// goes back one level (an agent's pages → the agents; a Settings section → Settings); ✕ closes the drawer.
// The real app on the shared fixture (in-process FleetManager, scratch home, loopback only, fake agents). Headless.
// Cases: phone light en, phone dark zh-TW. Pictured per case: 1-drawer (✕), 2-section (←), 3-list (☰).
// Run it on the base too (SMOKE_NAME=…-before): it FAILs there.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [MATRIX=…] scripts/manual/smoke/run.sh smoke-phone-nav-icons-m3245.mts
import { bootFixture, caseName, freshPage, matrix, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = process.env.SMOKE_NAME ?? "smoke-phone-nav-icons-m3245";
const fx = await bootFixture({ port: Number(process.env.HP ?? 49190), instances: 4 });
const cases = matrix(process.env.MATRIX ?? "phone-light-en,phone-dark-zh-TW").filter((c) => c.device === "phone");
const results: Array<{ name: string; ok: boolean; failed: string[] }> = [];
try {
  for (const c of cases) {
    const failed: string[] = [];
    const need = (ok: unknown, what: string) => { if (!ok) failed.push(what); };
    const zh = c.lang === "zh-TW";
    const p = await freshPage(fx, c, { account: "operator", path: "/settings/preferences", beforeNavigate: async (ctx: any) => { await ctx.addInitScript({ content: "window.__name = (f) => f" }); } });
    const page = p.page;
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
    // The top-left control: what it is, which icon shows, where it goes, its name.
    const corner = () => page.evaluate(() => {
      const b = document.querySelector("#sbOpen") as HTMLElement | null, shown = (e: Element | null) => !!e && getComputedStyle(e).display !== "none";
      const bar = document.querySelector(".p-settings .s-back") as HTMLElement | null;
      return b ? { tag: b.tagName, menu: shown(b.querySelector(".ic-menu")), back: shown(b.querySelector(".ic-back")), href: b.getAttribute("href"), label: b.getAttribute("aria-label"),
        bar: !!bar && getComputedStyle(bar).display !== "none", path: location.pathname } : null;
    });
    const drawer = () => page.evaluate(() => {
      const x = document.querySelector("#sidebar .side-collapse") as HTMLElement | null, shown = (e: Element | null) => !!e && getComputedStyle(e).display !== "none";
      const r = x?.getBoundingClientRect();
      return x ? { close: shown(x.querySelector(".ic-close")), back: shown(x.querySelector(".ic-back")), label: x.getAttribute("aria-label"), w: Math.round(r!.width), h: Math.round(r!.height) } : null;
    });
    try {
      need(await mounted(page, 30000), "the app mounted");
      await page.waitForTimeout(1200);
      // 2-section: ← back to Settings, no "‹ Settings" bar
      const s = await corner();
      need(s && s.tag === "A" && s.back && !s.menu && s.href === "/settings" && s.label === (zh ? "回到設定" : "Back to Settings") && !s.bar,
        `section: the top-left is ← to Settings, no bar under the header (${JSON.stringify(s)})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "2-section") });
      // ← goes there; 3-list: ☰
      await page.locator("#sbOpen").tap(); await page.waitForTimeout(800);
      const l = await corner();
      need(l && l.path === "/settings" && l.tag === "BUTTON" && l.menu && !l.back, `← goes to the Settings list, whose top-left is ☰ (${JSON.stringify(l)})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "3-list") });
      // 1-drawer: ☰ opens it; its top-left is ✕
      await page.locator("#sbOpen").tap(); await page.waitForTimeout(600);
      const d = await drawer();
      need(d && d.close && !d.back && d.label === (zh ? "關閉側邊欄" : "Close the sidebar") && d.w >= 44 && d.h >= 44, `the drawer's top-left is ✕, a full tap target (${JSON.stringify(d)})`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "1-drawer") });
      await page.locator("#sidebar .side-collapse").tap(); await page.waitForTimeout(500);
      need(!(await page.evaluate(() => document.querySelector(".shell")!.classList.contains("sb-open"))), "✕ closes the drawer");
      need(errs.length === 0, `page errors: ${errs.join(" | ")}`);
    } catch (err) {
      failed.push(`threw: ${String(err).slice(0, 300)}`);
      await page.screenshot({ path: shotPath(SMOKE, caseName(c), "error") }).catch(() => {});
    }
    results.push({ name: caseName(c), ok: failed.length === 0, failed });
    await p.ctx.close();
  }
} finally {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.failed.length ? " — " + r.failed.join("; ") : ""}`);
  await fx.close();
}
process.exit(results.length === cases.length && results.every((r) => r.ok) ? 0 : 1);
