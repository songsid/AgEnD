// #1629 r4-4 smoke, on the realistic fixture: declarative widgets. An agent's chat header strip and Details card at their
// item caps (labels at 24 graphemes, zh-TW and English, a list and a sparkline), live values that move on a data
// update, the chat of another instance with no strip, the person's sidebar widget (Settings → Appearance → example →
// Save, a bad edit refused with its reason), ?safe=1, CSP, no [style] inside widgets, no page errors. Full matrix:
// desktop 1366 / phone 390, light / dark, English / zh-TW.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> MATRIX=full npx --prefix <checkout> tsx scripts/manual/smoke/smoke-widgets.mts
import { join, dirname } from "node:path";
import { writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath, labelOf, seedAvatars, seedWidgets } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-widgets";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48410) });
const enc = encodeURIComponent;

const WITH = "rd1-platform-backend-sr4-server-t1547091841202130997"; // the agent with a chat header strip and a Details card
const OTHER = "研一官網-t1544335726169165914";                       // another instance, no widgets: the strip must not follow

await seedAvatars(fx, 30);
const seeded = { widgets: await seedWidgets(fx, WITH) };
const results: Record<string, any> = { seeded, browser: fx.browser.version(), cases: {} };

// What the page shows for one widget: its size, chip, values, styles inside, bar and sparkline geometry, overflow.
const probe = (page: any, sel: string) => page.evaluate(`(() => { const c = document.querySelector(${JSON.stringify(sel)}); if (!c) return null;
  const rect = (e) => e ? (({ width, height, left, right, top, bottom }) => ({ w: Math.round(width), h: Math.round(height), l: Math.round(left), r: Math.round(right), t: Math.round(top), b: Math.round(bottom) }))(e.getBoundingClientRect()) : null;
  return { rect: rect(c), chip: c.querySelector(".aw-chip")?.textContent, values: [...c.querySelectorAll(".aw-value, .aw-badge, li")].map((e) => e.textContent),
    styleInside: c.querySelectorAll("[style]").length + (c.hasAttribute("style") ? 1 : 0), bold: c.querySelectorAll("b").length, focusable: c.querySelectorAll("a, button, input, [tabindex]").length,
    bar: c.querySelector("progress") ? { value: c.querySelector("progress").value, max: c.querySelector("progress").max, w: Math.round(c.querySelector("progress").getBoundingClientRect().width) } : null,
    spark: c.querySelector("polyline") ? Math.round(c.querySelector(".aw-spark").getBoundingClientRect().width) : null,
    overflowX: c.scrollWidth > c.clientWidth + 1,
    hscroll: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth, csp: window.__csp }; })()`);

for (const c of matrix()) {
  const { ctx, page, csp } = await fx.page(c, { path: `/ui/chat/${enc(WITH)}` });
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
  page.on("console", (m: any) => { if (/Content Security Policy|Refused/.test(m.text())) errs.push("console: " + m.text().slice(0, 200)); });
  const r: any = {};
  await page.waitForTimeout(1500);
  r.chatHeader = await probe(page, ".p-chat .aw-chat_header");
  r.headerRect = await page.evaluate(`(() => { const h = document.querySelector(".p-chat .panel-header, .p-chat header"); const b = h && h.getBoundingClientRect(); return b ? { t: Math.round(b.top), b: Math.round(b.bottom) } : null; })()`);
  await page.screenshot({ path: shotPath(SMOKE, c, "chat") });
  // Live values: the agent's data moves, the page follows its themes_rev.
  fx.fm.webAppearance.handleTool(WITH, "set_web_widget", { slot: "chat_header", data: { done: 15, build: "#4822 running" } });
  await page.waitForTimeout(2500);
  r.chatHeaderLive = await probe(page, ".p-chat .aw-chat_header");
  await page.screenshot({ path: shotPath(SMOKE, c, "chat-live") });
  // Another instance's chat, reached in-app: no strip follows over.
  r.chatOther = await page.evaluate(`(async () => { history.pushState({}, "", "/ui/chat/${enc(OTHER)}"); dispatchEvent(new PopStateEvent("popstate")); await new Promise((r) => setTimeout(r, 1200)); return !!document.querySelector(".aw-chat_header"); })()`);
  // The Details card of the agent.
  await page.goto(`${fx.base}/ui/fleet/agent/${enc(WITH)}`); await page.waitForTimeout(1800);
  r.details = await probe(page, ".p-details .aw-details");
  await page.screenshot({ path: shotPath(SMOKE, c, "details"), fullPage: true });
  // The person's sidebar widget, from Settings → Appearance.
  await page.goto(`${fx.base}/settings/appearance`); await page.waitForTimeout(1500);
  // The example button must exist in every language: a missing control fails the case instead of skipping it.
  const ex = page.locator(".s-widget button", { hasText: labelOf(c, { en: "Start from an example", zh: "從範例開始" }) }).first();
  await ex.waitFor({ timeout: 5000 }); await ex.click(); await page.waitForTimeout(300);
  r.preview = await probe(page, ".s-widget-preview .aw");
  await page.locator(".s-widget").first().scrollIntoViewIfNeeded(); await page.waitForTimeout(200);
  await page.screenshot({ path: shotPath(SMOKE, c, "settings-widget") });
  await page.screenshot({ path: shotPath(SMOKE, c, "settings"), fullPage: true });
  const save = page.locator('.s-widget .btn-primary').first(); if (await save.isEnabled()) { await save.click(); await page.waitForTimeout(1200); } else r.saveDisabled = true;
  r.prefs = await page.evaluate(`fetch("/ui/prefs").then((x) => x.json()).then((p) => p.values["widget.sidebar"] ? p.values["widget.sidebar"].spec.title : null)`);
  // A bad edit says why and saves nothing.
  await page.fill(".s-widget-text", JSON.stringify({ spec: { v: 1, title: "x", items: [{ type: "stat", label: "c", bind: "cost_usd" }] }, data: {} }));
  await page.waitForTimeout(300);
  r.badEdit = await page.evaluate(`({ err: document.querySelector(".s-widget .err")?.textContent, disabled: document.querySelector(".s-widget .btn-primary")?.disabled })`);
  await page.goto(`${fx.base}/ui`); await page.waitForTimeout(1500);
  if (c.device === "phone") { const m = page.locator("#sbOpen").first(); if (await m.isVisible()) { await m.click(); await page.waitForTimeout(800); } }
  r.sidebar = await probe(page, ".side-widget .aw-sidebar");
  await page.screenshot({ path: shotPath(SMOKE, c, "sidebar") });
  // ?safe=1 renders no widget at all.
  await page.goto(`${fx.base}/ui/chat/${enc(WITH)}?safe=1`); await page.waitForTimeout(1500);
  r.safe = await page.evaluate(`document.querySelectorAll(".aw").length`);
  r.csp = await csp(); r.errs = errs;
  results.cases[caseName(c)] = r;
  await ctx.close();
}
writeFileSync(join(dirname(shotPath(SMOKE, "result", "x")), "results.json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify(Object.fromEntries(Object.entries(results.cases).map(([k, v]: [string, any]) => [k, { header: !!v.chatHeader, live: v.chatHeaderLive?.values, other: v.chatOther, details: !!v.details, prefs: v.prefs, badEdit: v.badEdit?.err, safe: v.safe, errs: v.errs.length, csp: v.csp.length }]))));
await fx.close(); process.exit(0);
