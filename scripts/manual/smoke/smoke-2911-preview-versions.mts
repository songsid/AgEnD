// #2911 (1), M-2216: the preview panel's ‹ v of n › step and its Changes view, on the realistic fixture with the real
// preview listener. An agent replies with three versions of one page (same <title>) and another page between them.
// - Seeded opt-in (desk light en, phone dark zh-TW): open v3 in the panel (it runs); ‹ shows v2 waiting for Preview;
//   Preview runs it; › then Changes shows v2 → v3; a step keeps Changes; v1 has no Changes; a v4 reply adds a version.
// - From defaults (decision a78ebdc5: nothing seeded, visible UI only): the panel offers Allow; the stepper and Changes
//   work before it (text only, nothing runs); Allow through the visible confirm runs the shown version. Desk loopback,
//   and phone on a LAN origin (where previews may be unavailable — the stepper and Changes must still work).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2911-preview-versions.mts
import { writeFileSync } from "node:fs";
import { bootFixture, shotPath } from "../smoke-fixture/index.mts";
import { freshPage } from "../smoke-fixture/from-defaults.mts";

const SMOKE = "smoke-2911-preview-versions";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48460), instances: 2 });
const fm = fx.fm;
const name = fx.instances.find((i: any) => !i.general)!.name;
const PAGE = (v: number, bg: string, extra = "") => `<title>Counter</title>\n<style>body{font:20px sans-serif;background:${bg};padding:16px}</style>\n<h1>Counter v${v}</h1>\n<p id=ok>rendered v${v}</p>${extra}\n<button>+1</button>`;
const say = (text: string) => fm.emitSseEvent("message", { instance: name, sender: name, role: "agent", text, ts: new Date().toISOString() });
say("v1:\n```html\n" + PAGE(1, "#fde") + "\n```");
say("Another page:\n```html\n<title>Other</title><p>other</p>\n```");
say("v2:\n```html\n" + PAGE(2, "#dfe") + "\n```");
say("v3:\n```html\n" + PAGE(3, "#def", "\n<p>new in v3</p>") + "\n```");

const want = {
  en: { at: (i: number, n: number) => `v${i}/${n}`, from: (v: number) => `Changes from v${v}`, idle: "Click Preview to run it here." },
  "zh-TW": { at: (i: number, n: number) => `v${i}/${n}`, from: (v: number) => `與第 ${v} 版相比的變更`, idle: "按「預覽」在這裡執行。" },
} as const;
let total = 3;                                                             // versions of "Counter" in the thread so far
const results: any = { browser: fx.browser.version(), cases: {} };

// A string, not a function: tsx would wrap a function's inner names in __name(), which the page does not have.
const PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  const f = q(".pv-panel iframe"), b = q(".pv-panel-bar"), br = b ? b.getBoundingClientRect() : null;
  return { at: q(".pv-ver-at")?.textContent ?? null, prevOff: q(".pv-ver-prev")?.disabled ?? null, nextOff: q(".pv-ver-next")?.disabled ?? null,
    frame: !!f, sandbox: f?.getAttribute("sandbox") ?? null, run: !!q(".pv-panel-run"), allow: !!q(".pv-panel-allow"), changes: !!q(".pv-changes"),
    diffHead: q(".pv-diff-head")?.textContent ?? null,
    del: [...document.querySelectorAll(".pv-diff .d-del")].map(e => e.textContent), add: [...document.querySelectorAll(".pv-diff .d-add")].map(e => e.textContent),
    note: q(".pv-panel .pv-note")?.textContent ?? "", overflowX: document.documentElement.scrollWidth - innerWidth,
    bar: br ? { w: Math.round(br.width), h: Math.round(br.height) } : null };
})()`;
const probe = (page: any) => page.evaluate(PROBE);
async function rendered(page: any) {
  for (const f of page.frames()) { if (f === page.mainFrame()) continue; try { const v = await f.evaluate("(document.getElementById('ok')||{}).textContent||''"); if (v) return v; } catch { /* navigating */ } }
  return "";
}
const waitRendered = async (page: any, want: string) => { for (let i = 0; i < 50; i++) { if ((await rendered(page)) === want) return true; await page.waitForTimeout(100); } return false; };
const openIn = async (page: any, nth: number) => { await page.waitForSelector(".html-card .pv-open"); await page.evaluate(`document.querySelectorAll(".html-card .pv-open")[${nth}].click()`); await page.waitForTimeout(600); };
const press = async (page: any, sel: string) => { await page.click(sel); await page.waitForTimeout(500); };

// From defaults: nothing seeded, visible UI only.
// Fresh cases run first (the seeded ones set host-wide prefs). Only the last one clicks Allow: that choice is host-wide.
for (const [c, opts, clickAllow] of [[{ device: "phone", theme: "dark", lang: "zh-TW" }, { origin: "lan" }, false], [{ device: "desk", theme: "light", lang: "en" }, {}, true]] as const) {
  const id = `fresh-${c.device}-${c.theme}-${c.lang}${(opts as any).origin ? "-lan" : ""}`;
  const fp = await freshPage(fx, c as any, { ...(opts as any), account: "operator", path: `/ui/chat/${encodeURIComponent(name)}` });
  const { page } = fp;
  const w = want[c.lang], r: any = {};
  await openIn(page, 2);                                                   // v2 (cards: v1, Other, v2, v3)
  r.opened = await probe(page);
  await page.screenshot({ path: shotPath(SMOKE, id, "1-panel-not-allowed") });
  await press(page, ".pv-ver-next");
  await press(page, ".pv-changes");
  r.changes = await probe(page);
  await page.screenshot({ path: shotPath(SMOKE, id, "2-changes-before-allow") });
  if (r.opened.allow && clickAllow) {
    await press(page, ".pv-ver-prev");
    await press(page, ".pv-panel-bar .seg-inline .btn");                  // back to Page: the Allow offer is the page view's note
    await page.click(".pv-panel-allow");
    await page.waitForSelector('[data-confirm="yes"]');
    await page.screenshot({ path: shotPath(SMOKE, id, "3-allow-confirm") });
    await page.click('[data-confirm="yes"]');
    await page.waitForTimeout(800);
    r.allowed = { ...(await probe(page)), shows: await rendered(page) };
    // Allow enables Preview; the panel's own Allow runs only the click that opened it — a step since then waits for Preview.
    if (!r.allowed.frame && r.allowed.run) { await press(page, ".pv-panel-run"); r.allowed.afterPreview = (await waitRendered(page, "rendered v2")) ? "rendered v2" : await rendered(page); }
    await page.screenshot({ path: shotPath(SMOKE, id, "4-allowed") });
  }
  // The preview frame's own two console lines, known since #1306 (design §1: Chromium does not parse CSP `webrtc`;
  // the [::1] dashboard origin in frame-ancestors). Recorded, not counted as page errors.
  const known = (e: string) => /\/frame$/.test(e) && /directive 'webrtc'|'frame-ancestors' does not support the source expression 'http:\/\/\[::1\]/.test(e);
  r.frameNotes = fp.errors.filter(known); r.errors = fp.errors.filter(e => !known(e));
  r.pass = r.opened.at === w.at(2, 3) && !r.opened.frame && r.changes.diffHead === w.from(2) && r.changes.add.length > 0 && !r.changes.frame
    && (!r.opened.allow || !clickAllow || r.allowed.shows === "rendered v2" || r.allowed.afterPreview === "rendered v2")
    && r.opened.overflowX <= 0 && !r.errors.length;
  results.cases[id] = r;
  await fp.ctx.close();
}
for (const c of [{ device: "desk", theme: "light", lang: "en" }, { device: "phone", theme: "dark", lang: "zh-TW" }] as const) {
  const id = `${c.device}-${c.theme}-${c.lang}`;
  const { ctx, page, csp } = await fx.page(c as any, { path: `/ui/chat/${encodeURIComponent(name)}`, prefs: { "preview.optIn": true } as any });
  const errors: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 160)));
  const w = want[c.lang], r: any = {}, n0 = total;
  await openIn(page, 3);                                                   // cards: v1, Other, v2, v3 (then any later version)
  r.v3 = { ...(await probe(page)), shows: (await waitRendered(page, "rendered v3")) ? "rendered v3" : await rendered(page) };
  await page.screenshot({ path: shotPath(SMOKE, id, "1-v3-running") });
  await press(page, ".pv-ver-prev");
  r.v2 = await probe(page);
  await page.screenshot({ path: shotPath(SMOKE, id, "2-v2-waiting") });
  await press(page, ".pv-panel-run");
  r.v2.afterPreview = (await waitRendered(page, "rendered v2")) ? "rendered v2" : await rendered(page);
  await press(page, ".pv-ver-next");
  await press(page, ".pv-changes");
  r.changes = await probe(page);
  await page.screenshot({ path: shotPath(SMOKE, id, "3-v3-changes") });
  await press(page, ".pv-ver-prev");
  r.changesKept = await probe(page);
  await press(page, ".pv-ver-prev");
  r.v1 = await probe(page);
  total++; say(`v${total}:\n\`\`\`html\n` + PAGE(total, "#ffd") + "\n```");
  await page.waitForTimeout(800);
  r.v4arrives = await probe(page);
  await page.screenshot({ path: shotPath(SMOKE, id, "4-v4-arrived") });
  r.csp = await csp(); r.errors = errors;
  r.pass = r.v3.at === w.at(3, n0) && r.v3.nextOff === (n0 === 3) && r.v3.frame && r.v3.sandbox === "allow-scripts" && r.v3.shows === "rendered v3"
    && r.v2.at === w.at(2, n0) && !r.v2.frame && r.v2.run && r.v2.afterPreview === "rendered v2"
    && r.changes.diffHead === w.from(2) && r.changes.del.length === 3 && r.changes.add.length === 4
    && r.changesKept.diffHead === w.from(1) && r.changesKept.at === w.at(2, n0)
    && r.v1.at === w.at(1, n0) && r.v1.prevOff === true && !r.v1.changes && r.v1.diffHead === null && r.v1.note === w.idle
    && r.v4arrives.at === w.at(1, n0 + 1)
    && r.v1.overflowX <= 0 && !r.errors.length && !r.csp.length;
  results.cases[id] = r;
  await ctx.close();
}

writeFileSync(shotPath(SMOKE, "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));
const ok = Object.values(results.cases).every((r: any) => r.pass);
console.log(ok ? "PASS" : "FAIL");
await fx.close();
process.exit(ok ? 0 : 1);
