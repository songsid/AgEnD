// #1918 phase 2 on the realistic fixture: Fleet → Org chart as a canvas, over the matrix (desk 1366 / phone 390,
// light / dark, English / zh-TW). ~60 instances in 8 teams (long Latin and CJK team names), loose instances, a crashed
// and a stopped one, identity pictures and colours. Checks per case: the canvas opens, a folded team, a search, Enter
// (jump), a drag and a wheel zoom (desk), Fit, a card click opens its chat, the fold survives a reload, and the list.
// Light cases run the interaction steps; every case shoots the canvas as it opens. Measurements go to 1918c/result.json.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-1918c.mts
// (run it through run.sh, or one at a time under systemd-run with MemoryMax; see scripts/manual/smoke/run.sh)
import { writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath, seedAvatars, seedIdentityColors, TEAMS } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48500) });
const names = fx.instances.map(i => i.name);
const avatars = await seedAvatars(fx, 24);
const colors = seedIdentityColors(fx, names.slice(1, 13));
const r: any = { instances: fx.instances.length, teams: TEAMS.length, avatars: Object.keys(avatars).length, colors: Object.keys(colors).length };

const MEASURE = `(() => { const s = document.querySelector(".oc-svg"); if (!s) return { canvas: false, list: !!document.querySelector(".org-team") };
  const sr = s.getBoundingClientRect(); const cards = [...s.querySelectorAll(".oc-node")];
  const vis = cards.filter((c) => { const b = c.getBoundingClientRect(); return b.right > sr.left && b.left < sr.right && b.bottom > sr.top && b.top < sr.bottom; });
  const lead = s.querySelector(".oc-node.lead"); const lb = lead && lead.getBoundingClientRect();
  return { canvas: true, cards: cards.length, visible: vis.length, transform: s.querySelector(".oc-world").getAttribute("transform"),
    leadW: lb && Math.round(lb.width), teams: [...s.querySelectorAll(".oc-team")].map((g) => g.getAttribute("data-team") + (g.querySelector(".oc-caret") ? ":" + g.querySelector(".oc-caret").textContent : "")),
    found: document.querySelector(".oc-found")?.textContent ?? null, dims: s.querySelectorAll(".oc-node.dim").length, matches: s.querySelectorAll(".oc-node.match").length };
})()`;

for (const c of matrix()) {
  const tag = caseName(c);
  const L = c.lang === "zh-TW" ? { list: "清單", canvas: "畫布" } : { list: "List", canvas: "Canvas" };
  const { ctx, page, csp } = await fx.page(c);
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  await page.goto(`${fx.base}/ui/fleet/org`); await page.waitForSelector(".oc-svg", { timeout: 8000 }).catch(() => errs.push("no canvas")); await page.waitForTimeout(800);
  r[`${tag}-open`] = await page.evaluate(MEASURE);
  await page.screenshot({ path: shotPath("1918c", c, "open") });
  if (c.theme === "light") {
    // Fold the 4th team, search "data", Enter.
    await page.locator(".oc-toggle").nth(3).dispatchEvent("click"); await page.waitForTimeout(300);
    await page.fill(".oc-find input", "data"); await page.waitForTimeout(300);
    r[`${tag}-search`] = await page.evaluate(MEASURE);
    await page.screenshot({ path: shotPath("1918c", c, "search") });
    await page.press(".oc-find input", "Enter"); await page.waitForTimeout(400);
    r[`${tag}-enter`] = await page.evaluate(MEASURE);
    await page.screenshot({ path: shotPath("1918c", c, "enter") });
    await page.fill(".oc-find input", ""); await page.waitForTimeout(200);
    // Drag pan, then wheel zoom (desk only), then Fit and a card click that opens its chat.
    const sb = (await page.locator(".oc-svg").boundingBox())!;
    if (c.device === "desk") {
      await page.mouse.move(sb.x + 300, sb.y + 300); await page.mouse.down(); await page.mouse.move(sb.x + 200, sb.y + 220, { steps: 5 }); await page.mouse.up();
      r[`${tag}-afterDrag`] = await page.evaluate(`document.querySelector(".oc-world").getAttribute("transform") + " " + location.pathname`);
      await page.mouse.move(sb.x + 400, sb.y + 300); await page.mouse.wheel(0, -400); await page.waitForTimeout(200);
      r[`${tag}-afterWheel`] = await page.evaluate(`document.querySelector(".oc-world").getAttribute("transform")`);
    }
    await page.locator(".oc-zoom button").nth(2).click(); await page.waitForTimeout(200);
    r[`${tag}-afterFit`] = await page.evaluate(`document.querySelector(".oc-world").getAttribute("transform")`);
    await page.locator(`.oc-node[data-name="${names[1]}"]`).first().click().catch(() => errs.push("card click: node not clickable"));
    await page.waitForTimeout(500);
    r[`${tag}-click`] = await page.evaluate("location.pathname");
    await page.goto(`${fx.base}/ui/fleet/org`); await page.waitForSelector(".oc-svg").catch(() => errs.push("no canvas after reload")); await page.waitForTimeout(500);
    r[`${tag}-foldKept`] = await page.evaluate(MEASURE);
    await page.locator(`text="${L.list}"`).first().click().catch(() => errs.push(`no "${L.list}" toggle`)); await page.waitForTimeout(400);
    await page.screenshot({ path: shotPath("1918c", c, "list") });
    r[`${tag}-list`] = await page.evaluate(MEASURE);
    await page.locator(`text="${L.canvas}"`).first().click().catch(() => errs.push(`no "${L.canvas}" toggle`)); await page.waitForTimeout(300);
  }
  r[`${tag}-csp`] = await csp(); r[`${tag}-errs`] = errs;
  await ctx.close();
}
writeFileSync(shotPath("1918c", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1).slice(0, 6000));
await fx.close(); process.exit(0);
