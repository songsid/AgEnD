// #2014 on the realistic fixture: the usage card's title in Chromium over the matrix. A credential profile's row shows
// the provider name, the profile on its own muted line, and a readable plan badge; the fixture's long plan names
// (Team Premium (6.25x) with CJK, a long profile name, Max 20x with CJK) at the rail (desk 1366) and the phone sheet
// (390), light and dark, English and zh-TW. Reports per provider: clipping of name, profile and plan.
// Output: 2014/<case>-rail.png | -phone.png and result.json.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2014.mts
import { writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath, seedUsage } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48520) });
await seedUsage(fx);
const chat = `/ui/chat/${encodeURIComponent(fx.instances[4].name)}`;
const r: any = {};

for (const c of matrix()) {
  const tag = caseName(c);
  const kind = c.device === "desk" ? "rail" : "phone";
  const { ctx, page, csp } = await fx.page(c, { path: chat, storage: { agend_usage_rail: "1" } });
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
  await page.waitForTimeout(1500);
  if (kind === "phone") { await page.click("button.hd-usage").catch(() => errs.push("no button.hd-usage")); await page.waitForTimeout(1200); }
  const scope = kind === "rail" ? ".u-rail" : "dialog[open]";
  const box = await page.locator(scope).first().boundingBox().catch(() => null);
  r[`${tag}-rows`] = await page.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(scope)}); if (!s) return null; return [...s.querySelectorAll(".u-provider")].map((h) => {
    const st = h.querySelector(".u-head strong"), pr = h.querySelector(".u-profile"), pl = h.querySelector(".u-head .u-plan");
    const clipped = (el) => el ? el.scrollWidth > el.clientWidth + 1 : null;
    return { name: st && st.textContent, profile: pr && pr.textContent, plan: pl && pl.textContent, nameClipped: clipped(st), profileClipped: clipped(pr), planClipped: clipped(pl), planW: pl && Math.round(pl.getBoundingClientRect().width) };
  }); })()`);
  if (box) await page.screenshot({ path: shotPath("2014", c, kind), clip: kind === "rail" ? { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 560) } : undefined });
  else errs.push(`no ${scope} box`);
  await page.screenshot({ path: shotPath("2014", c, `${kind}-page`) });
  r[`${tag}-csp`] = await csp(); r[`${tag}-errs`] = errs;
  await ctx.close();
}
writeFileSync(shotPath("2014", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1).slice(0, 6000));
await fx.close(); process.exit(0);
