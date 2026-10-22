// #2412 on the realistic fixture: the usage card's head never loses the provider title to a long plan badge. Rows with
// the user's case (a Codex credential profile on "Self Serve Business Usage Based") and other long plans (Claude Max
// 20x, Team Premium 6.25x, Enterprise, Business) and long profile names, at the rail's narrowest page (1200 px, the
// rail is 320) and the phone dialog (390), light and dark, English and zh-TW. Per row it reports whether the title,
// the profile and the badge are clipped, and the badge's text; it fails (exit 1) when a title is clipped, when a
// profile that fits is clipped, or when a badge takes the row.
// Output: 2412/<case>-rail-<n>.png | -phone-<n>.png | -phone320-<n>.png (one per card, nothing around it) and result.json.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2412-usage-head.mts
import { writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath } from "../smoke-fixture/index.mts";
const REPO = () => process.env.REPO!;

const fx = await bootFixture({ port: Number(process.env.HP ?? 48560), instances: 12 });
const { setUsageFetcherForTests } = await import(REPO() + "/src/usage/usage-api.ts");
const soon = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const weekly = (used: number) => [{ type: "percent", label: "Weekly", labelI18n: { key: "usage.metric.weekly" }, used, resetsAt: soon(120), windowMs: 6048e5 }];
const row = (id: string, name: string, plan: string, profile?: string, used = 10) => ({ id, name, status: "ok", plan, metrics: weekly(used), ...(profile ? { profile } : {}) });
setUsageFetcherForTests(async () => ({ fetchedAt: new Date().toISOString(), providers: [
  row("codex:yanxianchen", "Codex (yanxianchen)", "Self Serve Business Usage Based", "yanxianchen"),
  row("claude", "Claude", "Max (20x)", undefined, 64),
  row("claude:research-team-long-profile-name", "Claude (research-team-long-profile-name)", "Team Premium (6.25x)", "research-team-long-profile-name", 12),
  row("codex:platform-infrastructure-oncall-rotation", "Codex (platform-infrastructure-oncall-rotation)", "Enterprise", "platform-infrastructure-oncall-rotation", 40),
  row("claude:研究團隊共用帳號", "Claude (研究團隊共用帳號)", "Business", "研究團隊共用帳號", 5),
  row("kiro", "Kiro", "Kiro Pro+ Power Monthly Subscription Plan", undefined, 70),
  // A long name with no kind to shorten to: the badge itself must give way (CSS), never the title.
  row("muse", "Meta Muse Code", "Usage Based Self Serve Custom Arrangement", undefined, 33),
] }));
fx.fm.getActiveUsageProviderIds = () => null;

const chat = `/ui/chat/${encodeURIComponent(fx.instances[4].name)}`;
const r: any = {};
let bad = 0;
for (const c of matrix()) {
  const tag = caseName(c);
  const kind = c.device === "desk" ? "rail" : "phone";
  const { ctx, page, csp } = await fx.page(c, { path: chat, storage: { agend_usage_rail: "1" } });
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
  if (kind === "rail") await page.setViewportSize({ width: 1200, height: 900 });   // the narrowest page the rail is shown on
  await page.waitForTimeout(1500);
  if (kind === "phone") { await page.click("button.hd-usage").catch(() => errs.push("no button.hd-usage")); await page.waitForTimeout(1200); }
  const scope = kind === "rail" ? ".u-rail" : "dialog[open]";
  const measure = () => page.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(scope)}); if (!s) return null; return [...s.querySelectorAll(".u-provider")].map((h) => {
    const head = h.querySelector(".u-head"), st = h.querySelector(".u-head strong"), pr = h.querySelector(".u-profile"), pl = h.querySelector(".u-head .u-plan");
    // Sub-pixel (#2415 review: 130 px of text in a 129.89 px box paints an ellipsis; scrollWidth rounds it away).
    const clipped = (el) => { if (!el) return null; const range = document.createRange();
      range.selectNodeContents(el.querySelector('[aria-hidden="true"]') || el);   // the badge's visible text, not its screen-reader copy
      const cs = getComputedStyle(el), inner = el.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      return range.getBoundingClientRect().width > inner + 0.01; };
    const w = (el) => el ? Math.round(el.getBoundingClientRect().width) : null;
    return { title: st && st.getAttribute("title"), name: st && st.textContent, profile: pr && pr.textContent, plan: pl && pl.textContent.trim(), planTitle: pl && pl.getAttribute("title"),
      nameClipped: clipped(st), profileClipped: clipped(pr), profileTip: pr && pr.getAttribute("title"), planClipped: clipped(pl), headW: w(head), nameW: w(st), planW: w(pl),
      // Prism on #2415: everything in the head stays inside it (↑↓ included), whatever the width.
      orderW: w(h.querySelector(".u-order")), gap: getComputedStyle(head).columnGap, nameMax: st && getComputedStyle(st).maxWidth,
      overflowPx: Math.max(0, ...[...head.children].map((el) => Math.round(el.getBoundingClientRect().right - head.getBoundingClientRect().right))) };
  }); })()`) as Promise<any[] | null>;
  const rows = await measure();
  r[`${tag}-rows`] = rows;
  // The narrowest phone too (320 px): there the name may end in an ellipsis as a last resort, but nothing leaves the head.
  if (kind === "phone") {
    await page.setViewportSize({ width: 320, height: 700 }); await page.waitForTimeout(500);
    const narrow = (await measure()) ?? [];
    r[`${tag}-rows320`] = narrow;
    for (const x of narrow) if (x.overflowPx > 0) { bad++; errs.push(`320 px: ${x.title} overflows its head by ${x.overflowPx}px`); }
    const cards320 = page.locator(`${scope} .u-provider`);
    for (let i = 0, n = await cards320.count(); i < n; i++) { await cards320.nth(i).scrollIntoViewIfNeeded(); await cards320.nth(i).screenshot({ path: shotPath("2412", c, `phone320-${i}`) }); }
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
  }
  for (const x of rows ?? []) {
    if (x.overflowPx > 0) { bad++; errs.push(`${x.title} overflows its head by ${x.overflowPx}px`); }
    if (x.nameClipped) { bad++; errs.push(`title clipped: ${x.title}`); }
    // A profile that fits shows whole: clipped only when it is longer than the row (then its tooltip says it).
    if (x.profileClipped && x.profile && x.profile.length < 24) { bad++; errs.push(`profile clipped though short: ${x.profile}`); }
    if (x.profileClipped && !x.profileTip) { bad++; errs.push(`profile clipped without a tooltip: ${x.profile}`); }
    if (x.planW && x.headW && x.planW > x.headW * 0.5) { bad++; errs.push(`badge takes the row: ${x.plan} ${x.planW}/${x.headW}`); }
  }
  if (!rows) { bad++; errs.push(`no ${scope}`); }
  // Each card on its own (every row, whatever the list's height), never the page around it: the header behind the
  // dialog would show the fixture's instance names.
  const cards = page.locator(`${scope} .u-provider`);
  for (let i = 0, n = await cards.count(); i < n; i++) {
    await cards.nth(i).scrollIntoViewIfNeeded();
    await cards.nth(i).screenshot({ path: shotPath("2412", c, `${kind}-${i}`) });
  }
  r[`${tag}-csp`] = await csp(); r[`${tag}-errs`] = errs;
  await ctx.close();
}
writeFileSync(shotPath("2412", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(r, null, 1));
console.log(JSON.stringify(r, null, 1).slice(0, 8000));
console.log(bad ? `FAIL: ${bad} problem(s)` : "PASS");
await fx.close(); process.exit(bad ? 1 : 0);
