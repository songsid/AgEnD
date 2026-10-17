// #1918 phase 3 on the realistic fixture: live traffic on the org canvas, over the matrix (desk 1366 / phone 390,
// light / dark, English / zh-TW). A stubbed traffic snapshot (near items, a far pair, a bundled broadcast to ten
// instances, a queued send) over the fixture's ~60 instances in 8 teams, then SSE "traffic" events: one delivered
// (fades), one queued. Light cases also zoom out to the far view, open the list, and toggle live (.oc-live).
// Copied from the 1918 phase-3 smoke (#2042 may still change its checks); screenshots and result.json under 1918d/.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-1918d.mts
import { writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath, seedAvatars, seedIdentityColors } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48510) });
const names = fx.instances.map(i => i.name);
const avatars = await seedAvatars(fx, 24);
const colors = seedIdentityColors(fx, names.slice(1, 13));
const r: any = { instances: fx.instances.length, avatars: Object.keys(avatars).length, colors: Object.keys(colors).length };

// Traffic items on the fixture's real names: the general hub, long Latin and CJK instances.
const hex = (n: number) => n.toString(16).padStart(16, "0");
const T = (n: number, from: string, to: string, state: string, kind: string, op?: string) => ({ id: hex(n), from, to, kind, state, at: new Date().toISOString(), ...(op ? { op } : {}) });
const [HUB, A, B, C, D, E, F] = [names[0], names[1], names[3], names[7], names[8], names[9], names[29]];
const BIG = names.slice(30, 40);
const items: any[] = [T(1, HUB, A, "delivering", "task"), T(2, HUB, B, "delivering", "task"), T(3, A, C, "queued", "send"),
  T(4, D, HUB, "delivering", "report"), T(5, E, F, "delivering", "query"), T(6, names[11], HUB, "queued", "report"),
  ...BIG.map((to, i) => T(100 + i, names[2], to, "delivering", "broadcast", hex(999)))];
fx.fm.trafficSnapshot = () => ({ now: new Date().toISOString(), items });

const MEASURE = `(() => ({ flows: [...document.querySelectorAll(".oc-flow")].map((e) => e.getAttribute("class").replace("oc-flow ", "")), badges: [...document.querySelectorAll(".oc-badge text")].map((t) => t.textContent),
  legend: !!document.querySelector(".oc-legend"), sending: [...document.querySelectorAll(".org-sending")].map((p) => p.textContent.replace(/\\s+/g, " ").trim()), k: document.querySelector(".oc-world")?.getAttribute("transform") }))()`;

for (const c of matrix()) {
  const tag = caseName(c);
  const { ctx, page, csp } = await fx.page(c);
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 200)));
  await page.goto(`${fx.base}/ui/fleet/org`); await page.waitForSelector(".oc-svg", { timeout: 8000 }).catch(() => errs.push("no canvas")); await page.waitForTimeout(1200);
  r[`${tag}-open`] = await page.evaluate(MEASURE);
  await page.screenshot({ path: shotPath("1918d", c, "traffic") });
  // Live: A→B-side delivered (fades), a new one queued.
  fx.fm.emitSseEvent("traffic", T(1, HUB, A, "delivered", "task")); fx.fm.emitSseEvent("traffic", T(7, names[4], names[5], "queued", "update"));
  await page.waitForTimeout(400);
  r[`${tag}-live`] = await page.evaluate(MEASURE);
  if (c.theme === "light") {
    await page.screenshot({ path: shotPath("1918d", c, "live") });
    await page.waitForTimeout(3600);
    r[`${tag}-faded`] = await page.evaluate(MEASURE);
    // Far: zoom out.
    await page.locator(".oc-zoom button").nth(2).click(); for (let i = 0; i < 2; i++) await page.locator(".oc-zoom button").nth(1).click();
    await page.waitForTimeout(300);
    r[`${tag}-far`] = await page.evaluate(MEASURE);
    await page.screenshot({ path: shotPath("1918d", c, "far") });
    const L = c.lang === "zh-TW" ? { list: "清單", canvas: "畫布" } : { list: "List", canvas: "Canvas" };
    await page.locator(`text="${L.list}"`).first().click().catch(() => errs.push(`no "${L.list}" toggle`)); await page.waitForTimeout(400);
    r[`${tag}-list`] = await page.evaluate(MEASURE);
    await page.screenshot({ path: shotPath("1918d", c, "list") });
    await page.locator(`text="${L.canvas}"`).first().click().catch(() => errs.push(`no "${L.canvas}" toggle`)); await page.waitForTimeout(300);
    await page.locator(".oc-live").click().catch(() => errs.push("no .oc-live")); await page.waitForTimeout(300);
    r[`${tag}-liveOff`] = await page.evaluate(MEASURE);
    await page.locator(".oc-live").click().catch(() => errs.push("no .oc-live")); await page.waitForTimeout(300);
  }
  r[`${tag}-csp`] = await csp(); r[`${tag}-errs`] = errs;
  await ctx.close();
}
writeFileSync(shotPath("1918d", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1).slice(0, 6000));
await fx.close(); process.exit(0);
