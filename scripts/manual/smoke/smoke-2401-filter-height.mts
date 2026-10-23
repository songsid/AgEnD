// #2401 from defaults (fleet decision a78ebdc5): the sidebar's filter panel keeps its height when a facet becomes active
// (and when it is cleared) — the "Clear" control never wraps to a row of its own and never pushes the search box down.
// A fresh profile through visible UI: sign in, (phone: open the drawer), then for the Status group and the CLI group:
// open it, check a chip, press Clear; check it again, fold the group (every group folded, a facet set), press Clear.
// Measured each time: the panel's height (.v-filter), the search box's top and the headers' box width
// (.nav-facet-groups — it never narrows when a facet is set). Folded with a facet set is measured against folded at rest.
// The "before" run's resting heights are the ones to match: the take-over adds no height at rest either.
// Desk light en, desk dark zh-TW, phone dark zh-TW, phone light en; desk at the narrowest sidebar (200) and at 360.
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
  { device: "phone", theme: "dark", lang: "zh-TW" }, { device: "phone", theme: "light", lang: "en" },
  { device: "desk", theme: "light", lang: "en", side: 200 }, { device: "desk", theme: "dark", lang: "zh-TW", side: 360 }] as const) {
  const side = "side" in c ? c.side : null;
  const tag = `${c.device}-${c.theme}-${c.lang}${side ? `-side${side}` : ""}`, res: any = (r.cases[tag] = {});
  // The sidebar's width is this device's (#1722, localStorage), set before the app reads it.
  const p = await freshPage(fx, c, side ? { beforeNavigate: async (ctx: any) => ctx.addInitScript(`try { localStorage.setItem("agend_sidebar_w", "${side}") } catch {}`) } : {})
    .catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 240)}`]; return null; });
  if (!p) continue;
  const page = p.page;
  const shot = async (step: string) => {
    const el = await page.$(".v-filter");
    if (el) await el.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-${step}`) });
  };
  const measure = async (step: string) => { await page.waitForTimeout(250); const m = await page.evaluate(MEASURE) as any; await shot(step); return m; };
  const heads = page.locator(".v-filter .nav-facet-head");
  const firstChip = page.locator(".v-filter .nav-facet-list input[type=checkbox]").first();
  const clear = async () => { const reset = page.locator(".v-filter .nav-facet-reset"); if (await reset.count()) await reset.first().click(); };
  try {
    ok(res, "mounted", await mounted(page) && p.errors.length === 0);
    if (c.device === "phone") await page.locator("#main button.only-narrow").click();
    await heads.first().waitFor({ timeout: 10000 });
    const m: any = { foldedRest: await measure("0-folded") };
    for (const [k, n] of [["status", 0], ["cli", 1]] as const) {
      await heads.nth(n).click();                                                    // open the group
      await firstChip.waitFor({ timeout: 5000 });
      m[`${k}Open`] = await measure(`${k}-1-open`);
      await firstChip.check();                                                       // a facet becomes active
      m[`${k}Active`] = await measure(`${k}-2-active`);
      await clear();                                                                 // Clear
      m[`${k}Cleared`] = await measure(`${k}-3-cleared`);
      await firstChip.check();
      await heads.nth(n).click();                                                    // fold it: every group folded, a facet set
      m[`${k}FoldedActive`] = await measure(`${k}-4-folded-active`);
      await clear();
      m[`${k}FoldedCleared`] = await measure(`${k}-5-folded-cleared`);
    }
    res.measured = m;
    for (const k of ["status", "cli"]) {
      for (const [what, o, a, z] of [["open", m[`${k}Open`], m[`${k}Active`], m[`${k}Cleared`]], ["folded", m.foldedRest, m[`${k}FoldedActive`], m[`${k}FoldedCleared`]]] as const) {
        const at = `${k}:${what}`;
        ok(res, `${at}:heightUnchangedWhenActive`, Math.abs(a.height - o.height) < 0.5, [o.height, a.height]);
        ok(res, `${at}:searchBoxNotPushed`, Math.abs(a.boxTop - o.boxTop) < 0.5, [o.boxTop, a.boxTop]);
        ok(res, `${at}:heightUnchangedWhenCleared`, Math.abs(z.height - o.height) < 0.5, [o.height, z.height]);
        ok(res, `${at}:headersBoxNotNarrowed`, a.groups === o.groups, [o.groups, a.groups]);
        ok(res, `${at}:clearShownWhenActive`, a.reset === "visible");
        ok(res, `${at}:clearUnseenWhenCleared`, z.reset !== "visible", z.reset);
        ok(res, `${at}:noOverflow`, !o.overflow && !a.overflow && !z.overflow);
      }
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
