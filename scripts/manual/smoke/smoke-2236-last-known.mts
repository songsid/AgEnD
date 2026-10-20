// #2236 follow-up on the realistic fixture: usage rows showing their last known numbers in Chromium — an expired
// Claude login (its session window reset since, its weekly still current), a rate-limited Codex row, and a live one.
// Measured in the rail (desk 1366) and the phone sheet (390), light and dark, English and zh-TW: the mark, the
// second line, whether anything is clipped, and that the reset window shows no number. Output: 2236-lk/<case>-*.png
// and result.json.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2236-last-known.mts
import { writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath } from "../smoke-fixture/index.mts";

const fx = await bootFixture({ port: Number(process.env.HP ?? 48537) });
const { setUsageFetcherForTests } = await import(process.env.REPO + "/src/usage/usage-api.ts");
const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
setUsageFetcherForTests(async () => ({ fetchedAt: new Date().toISOString(), providers: [
  { id: "claude", name: "Claude", status: "ok", plan: "Team Premium (6.25x)", stale: true, cachedAt: at(-1.5), staleCause: "expired",
    hint: "Access token expired — it refreshes the next time any Claude instance runs.", hintI18n: { key: "usage.error.claude_token_expired" },
    metrics: [{ type: "percent", label: "Session", labelI18n: { key: "usage.metric.session" }, resetsAt: at(-0.5), windowMs: 18e6, resetPassed: true },
      { type: "percent", label: "Weekly", labelI18n: { key: "usage.metric.weekly" }, used: 97, resetsAt: at(60), windowMs: 6048e5 }] },
  { id: "codex", name: "Codex", status: "ok", plan: "Pro 5x", stale: true, cachedAt: at(-0.1), staleCause: "transient", hint: "cached 6m ago — live query is rate limited",
    metrics: [{ type: "percent", label: "Weekly", labelI18n: { key: "usage.metric.weekly" }, used: 41, resetsAt: at(100), windowMs: 6048e5 }] },
  { id: "kiro", name: "Kiro", status: "ok", plan: "Pro", metrics: [{ type: "percent", label: "Monthly", used: 12, resetsAt: at(300) }] },
] }));
fx.fm.getActiveUsageProviderIds = () => null;
const chat = `/ui/chat/${encodeURIComponent(fx.instances[4].name)}`;
const r: any = {};
for (const c of matrix()) {
  const tag = caseName(c), kind = c.device === "desk" ? "rail" : "phone";
  const { ctx, page, csp } = await fx.page(c, { path: chat, storage: { agend_usage_rail: "1" } });
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
  await page.waitForTimeout(1500);
  if (kind === "phone") { await page.click("button.hd-usage").catch(() => errs.push("no button.hd-usage")); await page.waitForTimeout(1200); }
  const scope = kind === "rail" ? ".u-rail" : "dialog[open]";
  const box = await page.locator(scope).first().boundingBox().catch(() => null);
  r[tag] = { errs, rows: await page.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(scope)}); if (!s) return null; return [...s.querySelectorAll(".u-provider")].map((h) => {
    const mk = h.querySelector(".u-stale"), dt = h.querySelector(".u-stale-detail"), clipped = (el) => el ? el.scrollWidth > el.clientWidth + 1 : null;
    return { cls: h.className, mark: mk && mk.textContent, detail: dt && dt.textContent, markClipped: clipped(mk), detailClipped: clipped(dt),
      resetSince: [...h.querySelectorAll(".u-reset-since")].map((m) => ({ text: m.textContent, bar: !!m.querySelector(".u-meter") })),
      fill: (h.querySelector(".u-fill") && getComputedStyle(h.querySelector(".u-fill")).backgroundColor) };
  }); })()`) };
  if (box) await page.screenshot({ path: shotPath("2236-lk", c, kind), clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 640) } });
  else errs.push(`no ${scope} box`);
  r[tag].csp = await csp();
  await ctx.close();
}
writeFileSync(shotPath("2236-lk", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1).slice(0, 6000));
await fx.close(); process.exit(0);
