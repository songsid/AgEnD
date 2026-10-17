// #1936 on the realistic fixture: the open instance pinned on top of the sidebar while a filter is on, over the matrix
// (desk 1366 / phone 390, light / dark, English / zh-TW). Colour sources: a person's pick on the name and an agent's own
// colour on its ring (seedIdentityColors, names 1..12), one instance with its colour shown nowhere (show: []), and
// automatic colours for the rest. Two filters: one that matches nothing but the pinned instance, one that matches
// a few CJK names ("平台"). Measures the pinned group's offset and rows; shoots the sidebar.
// Not covered (named in the original header, never in its code): the Color dialog from ⋯ and Settings → Web appearance.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-1936.mts
import { writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath, seedAvatars, seedIdentityColors } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48530) });
const names = fx.instances.map(i => i.name);
await seedAvatars(fx, 12);
seedIdentityColors(fx, names.slice(1, 13));
// The one whose colour is shown nowhere: a colour set, every placement off.
fx.fm.themeStore.setTheme(names[13], { v: 1, identity: { color: "preset:amber", show: [] } }, "agent");
const OPEN = names[4];                       // the pinned instance: a long Latin name, with a picture
const r: any = { open: OPEN, hidden: names[13] };

const MEASURE = `(() => { const l = document.querySelector("#instanceList"); if (!l) return null; const pin = l.querySelector(".v-pinned");
  const rows = [...l.querySelectorAll("a.inst")].map((a) => ({ name: a.querySelector(".inst-name").textContent, pinned: !!a.closest(".v-pinned"), current: a.getAttribute("aria-current") }));
  return { pinnedHead: pin && pin.querySelector(".v-group-head .grow").textContent, pinTopOffset: pin ? Math.round(pin.getBoundingClientRect().top - l.getBoundingClientRect().top) : null, rows, count: document.querySelector(".v-filter .note")?.textContent };
})()`;

for (const c of matrix()) {
  const tag = caseName(c);
  const { ctx, page, csp } = await fx.page(c);
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
  await page.goto(`${fx.base}/ui/chat/${encodeURIComponent(OPEN)}`); await page.waitForTimeout(1500);
  if (c.device === "phone") { await page.evaluate(`import("/assets/app-shell.js").then((m) => m.openDrawer())`).catch(() => errs.push("no openDrawer")); await page.waitForTimeout(800); }
  for (const facets of ["nomatch", "match"] as const) {
    await page.fill("#filterInput", facets === "nomatch" ? "zzzz-none" : "平台"); await page.waitForTimeout(500);
    r[`${tag}-${facets}`] = await page.evaluate(MEASURE);
    const vp = c.device === "desk" ? { width: 1366, height: 900 } : { width: 390, height: 844 };
    const sb = await page.locator("#sidebar").first().boundingBox();
    if (sb) { const x = Math.max(0, sb.x), w = Math.min(sb.width, vp.width - x), y = Math.max(0, sb.y);
      await page.screenshot({ path: shotPath("1936", c, facets), clip: { x, y, width: Math.max(1, w), height: Math.min(520, vp.height - y) } }).catch((e: any) => errs.push("shot: " + String(e).slice(0, 80))); }
    else errs.push("no #sidebar box");
  }
  r[`${tag}-csp`] = await csp(); r[`${tag}-errs`] = errs;
  await ctx.close();
}
writeFileSync(shotPath("1936", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r).slice(0, 6000));
await fx.close(); process.exit(0);
