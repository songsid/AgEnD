import { publicRoster } from "../smoke-fixture/public-roster.mts";
// M-3610 on the real app: Fleet › Tasks on a phone — every control of its toolbar a full tap target (≥44 px), on the home
// page and in a project; a desktop keeps its compact bar. Each case gets an empty board of its own (the fleet's scheduler
// on a database of its own) with one project and one card, then Fleet → its Tasks tab, through visible UI.
//   phone (zh-TW light, en dark): the Fleet tab pills, the search box, Instances, New project, a tile's ⋯; in the project:
//     Back, Stats, Instances, New main task, Board/List, its search (opened from its 🔍 on a phone, the 🔍 measured too) — each
//     ≥44 px high (an icon button ≥44 px wide too).
//   desk (en light): the same controls stay compact (under 44 px): the desktop is unchanged.
//   every case: no sideways scroll, no page errors. Pictures in $OUT/smoke-tasks-phone-tap-m3610/.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [HP=19761] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-tasks-phone-tap-m3610.mts
// ui-gate: {"name": "Fleet Tasks phone tap targets (local only)", "hp": 19761}
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-tasks-phone-tap-m3610";
const REPO = process.env.REPO!;
const fx = await bootFixture({ roster: publicRoster(6), port: 0, oldPort: Number(process.env.HP ?? 19761), instances: 6, classic: false });
const fm: any = fx.fm;
const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
const { boardToolAction } = await import(REPO + "/src/task-board-tool.ts");
const CASES = [
  { device: "phone", theme: "light", lang: "zh-TW" }, { device: "phone", theme: "dark", lang: "en" }, { device: "desk", theme: "light", lang: "en" },
] as const;
const HOME = [".p-fleet .seg .seg-item", ".p-fleet .tb-home .tb-search input", ".p-fleet .tb-head-actions .btn", ".p-fleet .tb-project-menu .icon-btn"];
const PROJECT = [".p-fleet .seg .seg-item", ".p-fleet .tb-head-back", ".p-fleet .tb-insights", ".p-fleet .tb-head-actions .btn", ".p-fleet .tb-seg-btn", ".p-fleet .tb-board-page .tb-search input"];
const r: any = { cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
/** Each visible control a selector names: { sel, text, w, h, icon }. */
const sizes = (page: any, sels: string[]) => page.evaluate((list: string[]) => list.flatMap((sel) => [...document.querySelectorAll(sel)].flatMap((e: any) => {
  const b = e.getBoundingClientRect();
  return b.width > 0 && b.height > 0 && b.right > 0 && b.left < innerWidth ? [{ sel, text: (e.textContent || e.placeholder || e.getAttribute("aria-label") || "").trim().slice(0, 30),
    w: Math.round(b.width), h: Math.round(b.height), icon: e.classList.contains("icon-btn") }] : [];
})), sels);

for (const c of CASES) {
  const tag = `${c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, `scheduler-${tag}.db`), () => {}, DEFAULT_SCHEDULER_CONFIG, (n: string) => !!fm.fleetConfig.instances[n]);
  fm.attachTaskBoard(fm.scheduler.db);
  const agent = Object.keys(fm.fleetConfig.instances)[0];
  boardToolAction(fm.scheduler.db, agent, { action: "create_project", name: "Website", description: "The public site" });
  boardToolAction(fm.scheduler.db, agent, { action: "create", title: "Fix the footer links", project: "Website" });
  const p = await freshPage(fx, c as any).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 200)}`]; return null; });
  if (!p) continue;
  const { page, base } = p;
  try {
    ok(res, "mounted", await mounted(page, 30000));
    // Fleet (from defaults it opens on the Org chart), then its Tasks tab.
    await page.goto(`${base}/ui/fleet/org`); await page.waitForTimeout(1500);
    const tab = page.locator('.seg a[href="/ui/fleet"]');
    for (let i = 0; i < await tab.count(); i++) if (await tab.nth(i).isVisible()) { await tab.nth(i).click(); break; }
    await page.waitForSelector(".tb-home", { timeout: 15000 }); await page.waitForTimeout(1200);
    const check = async (where: string, sels: string[]) => {
      const got = await sizes(page, sels);
      const missing = sels.filter((s) => !got.some((g: any) => g.sel === s));
      ok(res, `${where}: every control found`, missing.length === 0, missing);
      if (c.device === "phone") {
        const small = got.filter((g: any) => g.h < 44 || (g.icon && g.w < 44));
        ok(res, `${where}: all ≥44 px`, small.length === 0, small.length ? small : got.map((g: any) => `${g.text || g.sel} ${g.w}×${g.h}`));
      } else {
        const big = got.filter((g: any) => g.h >= 44);
        ok(res, `${where}: desktop compact (unchanged)`, big.length === 0, big.length ? big : got.map((g: any) => `${g.text || g.sel} ${g.w}×${g.h}`));
      }
    };
    await check("home", HOME);
    await page.screenshot({ path: shotPath(SMOKE, tag, "1-home") });
    await page.locator(".tb-home .tb-project-open").filter({ hasText: "Website" }).first().click();
    await page.waitForSelector(".tb-board-page", { timeout: 15000 }); await page.waitForTimeout(1200);
    // On a phone the project's search opens from its 🔍 (#4394's phone layout): the 🔍 is a control too, and the field is measured open.
    const findToggle = page.locator(".tb-board-page .tb-search-toggle");
    const phoneToggle = c.device === "phone" && await findToggle.isVisible();
    if (phoneToggle) { await findToggle.click(); await page.waitForSelector(".tb-board-page .tb-search input", { state: "visible", timeout: 5000 }); }
    await check("project", phoneToggle ? [...PROJECT, ".p-fleet .tb-board-page .tb-search-toggle"] : PROJECT);
    await page.screenshot({ path: shotPath(SMOKE, tag, "2-project") });
    ok(res, "noOverflow", !(await page.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`)));
    ok(res, "noPageErrors", p.errors.length === 0, p.errors);
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await page.screenshot({ path: shotPath(SMOKE, tag, "error") }).catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((v: any) => !v.failed);
writeFileSync(shotPath(SMOKE, "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify({ pass: r.pass, cases: Object.fromEntries(Object.entries(r.cases).map(([k, v]: any) => [k, v.failed ?? []])) }, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);
