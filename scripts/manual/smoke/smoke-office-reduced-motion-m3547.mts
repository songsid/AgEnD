import { publicRoster } from "../smoke-fixture/public-roster.mts";
// M-3547 on the real app, from defaults (fleet decision a78ebdc5): Fleet → Org chart → Office (the whole fleet's own
// office). With reduced motion on, drag, pat and feed are off (M-3293) — and now the Office says so without hovering:
//   reduced motion: the "Drag and pat" box is off and locked, with a visible note beside it (desk: the bar; phone: the
//                   ⋯ sheet); a person's card has no Pat or Feed and says why where they would be.
//   ordinary motion: no note anywhere, the box is on, and the card has Pat and Feed as before.
// Pictures per case in $OUT/smoke-office-reduced-motion-m3547/.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [HP=19747] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-office-reduced-motion-m3547.mts
// ui-gate: {"name": "Office reduced-motion hint (local only)", "hp": 19747}
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-office-reduced-motion-m3547";
const CASES = [
  { device: "desk", theme: "light", lang: "en", rm: true },
  { device: "desk", theme: "dark", lang: "zh-TW", rm: true },
  { device: "phone", theme: "dark", lang: "zh-TW", rm: true },
  { device: "phone", theme: "light", lang: "en", rm: true },
  { device: "desk", theme: "light", lang: "en", rm: false },
  { device: "phone", theme: "dark", lang: "zh-TW", rm: false },
] as const;
const WORDS = {
  en: { office: "Office", bar: "Off while reduced motion is on", card: "Drag, pat and feed are off: this device asks for reduced motion." },
  "zh-TW": { office: "辦公室", bar: "開啟「減少動態效果」時關閉", card: "拖曳、摸頭與餵點心已關閉：這台裝置開啟了「減少動態效果」。" },
} as const;

const fx = await bootFixture({ roster: publicRoster(6), port: 0, oldPort: Number(process.env.HP ?? 19747), instances: 6, classic: false });
const r: any = { cases: {} };
const ok = (c: any, k: string, v: boolean, detail?: unknown) => { c[k] = detail === undefined ? v : { pass: v, detail }; if (!v) c.failed = [...(c.failed ?? []), k]; };
const text = async (page: any, sel: string) => ((await page.locator(sel).count()) ? (await page.locator(sel).first().innerText()).trim() : null);

for (const c of CASES) {
  const tag = `${c.device}-${c.theme}-${c.lang}${c.rm ? "-reduced" : ""}`, w = WORDS[c.lang];
  const res: any = (r.cases[tag] = {});
  const p = await freshPage(fx, c as any).catch((err) => { res.failed = [`freshPage: ${String(err).slice(0, 200)}`]; return null; });
  if (!p) continue;
  const { page, base } = p;
  try {
    ok(res, "mounted", await mounted(page, 30000));
    await page.emulateMedia({ reducedMotion: c.rm ? "reduce" : "no-preference" });
    await page.goto(`${base}/ui/fleet/org`);
    await page.locator(".oc-tools .seg-inline button", { hasText: w.office }).click();
    await page.waitForSelector(".oo-canvas", { timeout: 15000 }); await page.waitForTimeout(2500);
    // The options: the bar on a desk, the ⋯ sheet on a phone.
    if (c.device === "phone") { await page.locator(".oo-more-btn").click(); await page.locator(".oo-sheet .oo-play input").waitFor(); }
    const box = page.locator(".oo-play input");
    if (c.rm) {
      ok(res, "box off and locked", !(await box.isChecked()) && (await box.isDisabled()));
      ok(res, "note says why", (await text(page, ".oo-play-still")) === w.bar, await text(page, ".oo-play-still"));
      // Beside the box: inside its label, on the box's row (a wrapping bar must not carry it under other options).
      const nb = await page.locator(".oo-play .oo-play-still").boundingBox(), ib = await box.boundingBox();
      const op = await page.locator(".oo-play > span:not(.oo-play-still)").evaluate((el: any) => Number(getComputedStyle(el).opacity));
      ok(res, "label disabled-looking", op < 0.6, op);
      ok(res, "note beside the box", !!nb && !!ib && nb.width > 0 && nb.x > ib.x && nb.y < ib.y + ib.height && nb.y + nb.height > ib.y, { nb, ib });
    } else {
      ok(res, "box on", await box.isChecked());
      ok(res, "no note", (await page.locator(".oo-play-still").count()) === 0);
    }
    await page.screenshot({ path: shotPath(SMOKE, tag, "1-options") });
    if (c.device === "phone") { await page.keyboard.press("Escape"); await page.waitForTimeout(300); }
    // A person's card: the accessible person target (a real tap on the canvas is M-3293's own smoke).
    const person = page.locator("button.oo-desk").first(); await person.focus(); await person.press("Enter");
    await page.locator(".oo-card").waitFor(); await page.waitForTimeout(400);
    if (c.rm) {
      ok(res, "card: no Pat/Feed", (await page.locator(".oo-card-pat, .oo-card-feed").count()) === 0);
      ok(res, "card: says why", (await text(page, ".oo-card .oo-card-play-off")) === w.card, await text(page, ".oo-card .oo-card-play-off"));
      const cb = await page.locator(".oo-card").boundingBox(), nb = await page.locator(".oo-card-play-off").boundingBox();
      // zh-TW: the quoted setting name stays on one line with the words before it (no line starts with 「).
      if (c.lang === "zh-TW") {
        const lines = await page.locator(".oo-card-play-off .oo-nowrap").evaluate((el: any) => el.getClientRects().length);
        ok(res, "card: quote kept whole", lines === 1, lines);
      }
      ok(res, "card: note inside the card", !!cb && !!nb && nb.x >= cb.x - 1 && nb.x + nb.width <= cb.x + cb.width + 1 && nb.y + nb.height <= cb.y + cb.height + 1, { cb, nb });
    } else {
      ok(res, "card: Pat and Feed", (await page.locator(".oo-card-pat").count()) === 1 && (await page.locator(".oo-card-feed").count()) === 1);
      ok(res, "card: no note", (await page.locator(".oo-card-play-off").count()) === 0);
    }
    await page.screenshot({ path: shotPath(SMOKE, tag, "2-card") });
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
