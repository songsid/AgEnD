// #2236 follow-up on the realistic fixture: the default login's usage row beside profiles ("Claude (default)") in
// Chromium. It used to read "Claude (d…" in the ~300 px ◔ dialog; it should read "Claude" with "default" (zh-TW: 預設)
// on its own line, as a profile row does. Rows as a host with a default login and two profiles reports them. Measured
// in the rail (desk 1366, 320 px), the ◔ dialog (a 1100 px window, below the rail's width) and the phone sheet (390),
// light and dark, English and zh-TW: each row's title, its second line, and whether either is clipped.
// Output: 2236/<case>-rail.png | -dialog.png | -phone.png and result.json. Run it on a checkout without the change for
// the before (REPO=<that checkout>).
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2236-default-row.mts
import { writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48536) });
const { setUsageFetcherForTests } = await import(process.env.REPO + "/src/usage/usage-api.ts");
const soon = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const metrics = (session: number, weekly: number) => [
  { type: "percent", label: "Session", labelI18n: { key: "usage.metric.session" }, used: session, resetsAt: soon(2), windowMs: 18e6 },
  { type: "percent", label: "Weekly", labelI18n: { key: "usage.metric.weekly" }, used: weekly, resetsAt: soon(90), windowMs: 6048e5 }];
setUsageFetcherForTests(async () => ({ fetchedAt: new Date().toISOString(), providers: [
  { id: "claude", name: "Claude (default)", defaultLogin: true, status: "ok", plan: "Team Premium (6.25x)", metrics: metrics(100, 97) },
  { id: "claude:atlas", name: "Claude (atlas)", profile: "atlas", status: "ok", plan: "Max (20x)", metrics: metrics(41, 22) },
  { id: "claude:research", name: "Claude (research)", profile: "research", status: "ok", plan: "Max (20x)", metrics: metrics(8, 63) },
] }));
fx.fm.getActiveUsageProviderIds = () => null;
const chat = `/ui/chat/${encodeURIComponent(fx.instances[4].name)}`;
const r: any = {};
const rows = (scope: string) => `(() => { const s = document.querySelector(${JSON.stringify(scope)}); if (!s) return null; return [...s.querySelectorAll(".u-provider")].map((h) => {
  const st = h.querySelector(".u-head strong"), pr = h.querySelector(".u-profile"), pl = h.querySelector(".u-head .u-plan");
  const clipped = (el) => el ? el.scrollWidth > el.clientWidth + 1 : null;
  return { name: st && st.textContent, profile: pr && pr.textContent, plan: pl && pl.textContent, nameClipped: clipped(st), profileClipped: clipped(pr), width: Math.round(h.getBoundingClientRect().width) };
}); })()`;

for (const c of matrix()) {
  const tag = caseName(c);
  const kinds = c.device === "desk" ? ["rail", "dialog"] : ["phone"];
  for (const kind of kinds) {
    const { ctx, page, csp } = await fx.page(c, { path: chat, storage: { agend_usage_rail: kind === "rail" ? "1" : "0" } });
    const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
    if (kind === "dialog") await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(1500);
    if (kind !== "rail") { await page.click("button.hd-usage").catch(() => errs.push("no button.hd-usage")); await page.waitForTimeout(1200); }
    const scope = kind === "rail" ? ".u-rail" : "dialog[open]";
    const box = await page.locator(scope).first().boundingBox().catch(() => null);
    r[`${tag}-${kind}`] = { width: box && Math.round(box.width), rows: await page.evaluate(rows(scope)), errs };
    if (box) await page.screenshot({ path: shotPath("2236", c, kind), clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 520) } });
    else errs.push(`no ${scope} box`);
    r[`${tag}-${kind}`].csp = await csp();
    await ctx.close();
  }
}
writeFileSync(shotPath("2236", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1).slice(0, 8000));
await fx.close(); process.exit(0);
