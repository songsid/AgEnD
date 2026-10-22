// #2401 from defaults (fleet decision a78ebdc5): the sidebar's filter panel keeps its height when a facet becomes active
// (and when it is cleared) — the "Clear" control never wraps to a row of its own and never pushes the search box down.
// A fresh profile through visible UI: sign in, (phone: open the drawer), open the Status facet group, then check a status
// chip and press Clear; then the same with the CLI group (Status folded). Measured each time: the panel's height
// (.v-filter), the search box's top and the headers' box width (.nav-facet-groups — it never narrows when a facet is set).
// The "before" run's resting height is the one to match: the take-over adds no height at rest either.
// Desk light en, desk dark zh-TW, phone dark zh-TW, phone light en.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2401-filter-height.mts
//   LABEL=before|after names the shots (run once on main's code for the "before" pictures).
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "2401", LABEL = process.env.LABEL ?? "after";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48818), instances: 6 });
const r: any = { label: LABEL, cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
const MEASURE = `(() => { const f = document.querySelector(".v-filter"), box = document.querySelector(".v-filter-box");
  if (!f || !box) return null; const a = f.getBoundingClientRect(), b = box.getBoundingClientRect();
  const g = document.querySelector(".nav-facet-groups");
  return { height: Math.round(a.height * 10) / 10, boxTop: Math.round(b.top * 10) / 10, groups: g ? Math.round(g.getBoundingClientRect().width) : null,
    reset: (() => { const x = document.querySelector(".nav-facet-reset"); if (!x) return "none"; const cs = getComputedStyle(x); return cs.visibility + (x.offsetParent ? "" : ":gone"); })(),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }; })()`;
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" },
  { device: "phone", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "light", lang: "en" }] as const) {
  const tag = `${c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  const p = await freshPage(fx, c).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 240)}`]; return null; });
  if (!p) continue;
  const page = p.page;
  const shot = async (step: string) => {
    const el = await page.$(".v-filter");
    if (el) await el.screenshot({ path: shotPath(SMOKE, c as any, `${LABEL}-${step}`) });
  };
  try {
    ok(res, "mounted", await mounted(page) && p.errors.length === 0);
    if (c.device === "phone") await page.locator("#main button.only-narrow").click();
    await page.locator(".v-filter .nav-facet-head").first().waitFor({ timeout: 10000 });
    await page.locator(".v-filter .nav-facet-head").first().click();                // open the Status group
    await page.locator(".v-filter .nav-facet-list input[type=checkbox]").first().waitFor({ timeout: 5000 });
    await page.waitForTimeout(200);
    const open = await page.evaluate(MEASURE) as any;
    await shot("1-group-open");
    await page.locator(".v-filter .nav-facet-list input[type=checkbox]").first().check();   // a facet becomes active
    await page.waitForTimeout(250);
    const active = await page.evaluate(MEASURE) as any;
    await shot("2-facet-active");
    const reset = page.locator(".v-filter .nav-facet-reset");
    if (await reset.count()) await reset.first().click();                            // Clear
    await page.waitForTimeout(250);
    const cleared = await page.evaluate(MEASURE) as any;
    await shot("3-cleared");
    // The CLI group: fold Status, open CLI, check its first chip, Clear.
    const heads = page.locator(".v-filter .nav-facet-head");
    await heads.nth(0).click(); await heads.nth(1).click();
    await page.locator(".v-filter .nav-facet-list input[type=checkbox]").first().waitFor({ timeout: 5000 });
    await page.waitForTimeout(200);
    const cliOpen = await page.evaluate(MEASURE) as any;
    await shot("4-cli-open");
    await page.locator(".v-filter .nav-facet-list input[type=checkbox]").first().check();
    await page.waitForTimeout(250);
    const cliActive = await page.evaluate(MEASURE) as any;
    await shot("5-cli-active");
    if (await reset.count()) await reset.first().click();
    await page.waitForTimeout(250);
    const cliCleared = await page.evaluate(MEASURE) as any;
    res.measured = { open, active, cleared, cliOpen, cliActive, cliCleared };
    for (const [k, [o, a, z]] of Object.entries({ status: [open, active, cleared], cli: [cliOpen, cliActive, cliCleared] })) {
      ok(res, `${k}:heightUnchangedWhenActive`, Math.abs(a.height - o.height) < 0.5, [o.height, a.height]);
      ok(res, `${k}:searchBoxNotPushed`, Math.abs(a.boxTop - o.boxTop) < 0.5, [o.boxTop, a.boxTop]);
      ok(res, `${k}:heightUnchangedWhenCleared`, Math.abs(z.height - o.height) < 0.5, [o.height, z.height]);
      ok(res, `${k}:headersBoxNotNarrowed`, a.groups === o.groups, [o.groups, a.groups]);
      ok(res, `${k}:clearShownWhenActive`, a.reset === "visible");
      ok(res, `${k}:clearUnseenWhenCleared`, z.reset !== "visible", z.reset);
      ok(res, `${k}:noOverflow`, !o.overflow && !a.overflow);
    }
    ok(res, "noPageErrors", p.errors.length === 0);
    res.errors = p.errors;
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await shot("error").catch(() => {});
  }
  await p.ctx.close();
  // The filter is a synced pref, written host-wide (#1665): unset it, so the next case starts from defaults too.
  for (const who of [p.personKey, "operator"]) fx.fm.webPrefs.write(who, new Map([["nav.filter", null]]));
}
r.pass = Object.values(r.cases).every((c: any) => !c.failed);
writeFileSync(shotPath(SMOKE, `result-${LABEL}`, "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify({ pass: r.pass, cases: Object.fromEntries(Object.entries(r.cases).map(([k, v]: any) => [k, { failed: v.failed ?? [], measured: v.measured }])) }, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);
