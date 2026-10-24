// #2585 B from defaults (fleet decision a78ebdc5), through visible navigation: the Office scene is centred where it is
// smaller than the canvas (the user, 1791 × 1089: one 6-across room anchored 15 px from the left, ~930 px empty on the
// right). A demo fleet: one big team (大廳, 38 desks) and two on their own. Fleet → Org chart → Office, as it opens;
// then Fit, then the window narrowed (1366 × 900). Each time the scene's middle is the canvas's middle on an axis where
// the scene is smaller (it covers the canvas on the other). LABEL=before|after names the shots (run "before" on main).
// Cases: desk light en, desk dark zh-TW.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [LABEL=before] [PW_ENGINE=webkit] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2585-office-centre.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "2585-office-centre", LABEL = process.env.LABEL ?? "after";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const WEBKIT_OWN = /^(Viewport argument key "interactive-widget" not recognized and ignored\.|Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy\.|(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/[a-z-]+|auth\/sessions?|api\/[a-z/-]+)(\?\S*)? due to access control checks\.)/;
const pageErrors = (errors: string[]) => errors.filter((e) => !(ENGINE === "webkit" && WEBKIT_OWN.test(e)));
const fx = await bootFixture({ port: Number(process.env.HP ?? 48872), classic: false });
const fm = fx.fm, dir = fm.dataDir ?? fx.dir;
const TEAM = "大廳", MEMBERS = Array.from({ length: 38 }, (_, i) => `desk-${String(i + 1).padStart(2, "0")}`);
const names = ["general", ...MEMBERS, "release-notes-drafter", "nightly-benchmarks"];
fm.fleetConfig.instances = Object.fromEntries(names.map((name, i) => [name, { working_directory: dir, backend: ["claude-code", "codex", "kiro-cli"][i % 3], ...(name === "general" ? { general_topic: true } : {}) }]));
fm.fleetConfig.teams = { [TEAM]: { members: MEMBERS } };
fm.getInstanceStatus = () => "running";
const r: any = { engine: ENGINE, label: LABEL, cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
// The view (the overview's frame: data-k/x/y), the scene's size (its viewBox) and the canvas's.
const MEASURE = `(() => { const f = document.querySelector(".oo-mini-view"), cv = document.querySelector(".oo-canvas").getBoundingClientRect();
  const [, , w, h] = document.querySelector(".oo-mini").getAttribute("viewBox").split(" ").map(Number);
  const [k, x, y] = ["data-k", "data-x", "data-y"].map((a) => Number(f.getAttribute(a)));
  return { k, x, y, w, h, cw: cv.width, ch: cv.height, sw: w * k, sh: h * k,
    gapL: Math.round(x), gapR: Math.round(cv.width - x - w * k), gapT: Math.round(y), gapB: Math.round(cv.height - y - h * k) }; })()`;
const centred = (m: any) => (m.sw >= m.cw - 0.5 ? m.x <= 0.5 && m.x + m.sw >= m.cw - 0.5 : Math.abs(m.gapL - m.gapR) <= 1)
  && (m.sh >= m.ch - 0.5 ? m.y <= 0.5 && m.y + m.sh >= m.ch - 0.5 : Math.abs(m.gapT - m.gapB) <= 1);
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "desk", theme: "dark", lang: "zh-TW" }] as const) {
  const tag = `${c.device}-${c.theme}-${c.lang}`, res: any = (r.cases[tag] = {});
  const p = await freshPage(fx, c as any).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 200)}`]; return null; });
  if (!p) continue;
  const { page, base } = p;
  try {
    ok(res, "mounted", await mounted(page, 30000));
    await page.setViewportSize({ width: 1791, height: 1089 });
    await page.goto(`${base}/ui/fleet/org`);
    await page.locator(".oc-tools .seg-inline button", { hasText: c.lang === "en" ? "Office" : "辦公室" }).click();
    await page.waitForSelector(".oo-canvas", { timeout: 15000 }); await page.waitForTimeout(900);
    const open = await page.evaluate(MEASURE) as any;
    await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-1-open`) });
    await page.locator(".oo-zoom .oo-fit").click(); await page.waitForTimeout(500);
    const fit = await page.evaluate(MEASURE) as any;
    await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-2-fit`) });
    await page.setViewportSize({ width: 1366, height: 900 }); await page.waitForTimeout(700);
    const narrow = await page.evaluate(MEASURE) as any;
    await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-3-1366`) });
    res.measured = { open, fit, narrow };
    ok(res, "open:centred", centred(open), open);
    ok(res, "fit:centred", centred(fit), fit);
    ok(res, "resized:centred", centred(narrow), narrow);
    ok(res, "noOverflow", !(await page.evaluate(`document.documentElement.scrollWidth > document.documentElement.clientWidth`)));
    ok(res, "noPageErrors", pageErrors(p.errors).length === 0, pageErrors(p.errors));
  } catch (err) {
    res.failed = [...(res.failed ?? []), `threw: ${String(err).slice(0, 240)}`];
    await page.screenshot({ path: shotPath(SMOKE, tag, `${LABEL}-error`) }).catch(() => {});
  }
  await p.ctx.close();
}
r.pass = Object.values(r.cases).every((x: any) => !x.failed);
writeFileSync(shotPath(SMOKE, `result-${LABEL}`, "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
const brief = (m: any) => m && `k ${m.k.toFixed(3)} scene ${Math.round(m.sw)}×${Math.round(m.sh)} in ${m.cw}×${m.ch} gaps L${m.gapL} R${m.gapR} T${m.gapT} B${m.gapB}`;
console.log(JSON.stringify({ pass: r.pass, cases: Object.fromEntries(Object.entries(r.cases).map(([k, v]: any) => [k, { failed: v.failed ?? [], open: brief(v.measured?.open), fit: brief(v.measured?.fit), narrow: brief(v.measured?.narrow) }])) }, null, 1));
await fx.close(); process.exit(r.pass ? 0 : 1);
