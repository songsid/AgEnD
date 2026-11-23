// M-3556 before/after capture (prototype only): the Fleet office from defaults, desk + phone, en + zh-TW.
import { publicRoster } from "../smoke-fixture/public-roster.mts";
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, shotPath } from "../smoke-fixture/index.mts";
const SMOKE = process.env.SMOKE_NAME ?? "m3556";
const CASES = [
  { device: "desk", theme: "light", lang: "zh-TW" }, { device: "desk", theme: "dark", lang: "en" },
  { device: "phone", theme: "light", lang: "zh-TW" }, { device: "phone", theme: "dark", lang: "en" },
] as const;
const fx = await bootFixture({ roster: publicRoster(8), port: 0, oldPort: 19756, instances: 8, classic: false });
const r: any = {};
for (const c of CASES) {
  const tag = `${c.device}-${c.theme}-${c.lang}${process.env.RM ? "-reduced" : ""}`;
  const p = await freshPage(fx, c as any); const { page, base } = p;
  try {
    await mounted(page, 30000);
    if (process.env.RM) await page.emulateMedia({ reducedMotion: "reduce" });
    // Two stored offices, as a fleet that uses them has (the office picker, carousel and edit buttons all show).
    await page.evaluate(async () => {
      const g = await fetch("/ui/offices").then((x) => x.json());
      if ((g.offices || []).length) return;
      await fetch("/ui/offices", { method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ rev: g.rev ?? 0, offices: [{ id: "front", name: "Front desk", skin: "cozy", members: [] }, { id: "lab", name: "Lab", skin: "studio", members: [] }] }) });
    });
    await page.goto(`${base}/ui/fleet/org`);
    await page.locator(".oc-tools .seg-inline button", { hasText: c.lang === "en" ? "Office" : "辦公室" }).click();
    await page.waitForSelector(".oo-canvas", { timeout: 15000 }); await page.waitForTimeout(2500);
    await page.screenshot({ path: shotPath(SMOKE, tag, "1-office") });
    const bar = await page.locator(".oo-bar").first().boundingBox().catch(() => null);
    r[tag] = { bar };
    const opener = c.device === "phone" ? ".oo-more-btn" : ".oo-display-btn, .oo-bar .oo-options";
    if (await page.locator(opener).count()) {
      await page.locator(opener).first().click(); await page.waitForTimeout(500);
      await page.screenshot({ path: shotPath(SMOKE, tag, "2-options") });
    }
  } catch (e) { r[tag] = { err: String(e).slice(0, 300) }; await page.screenshot({ path: shotPath(SMOKE, tag, "error") }).catch(() => {}); }
  await p.ctx.close();
}
writeFileSync(shotPath(SMOKE, "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r)); await fx.close(); process.exit(0);
