// M-3455 (the user, 2026-11-20: dragging the split view's divider is laggy): a measurement, not a gate. The real app on the
// shared fixture (in-process FleetManager, scratch home, loopback only; agents are IPC stubs — no CLI, vendor or account),
// headless Chromium at 1600×1000 with 4× CPU throttling (CDP). Two agents with 200 synthetic messages each (prose, lists,
// code blocks, a table) side by side; the divider is dragged 120 px right and back, one pointer move per frame (the
// browser's own cadence). Reported: per-frame intervals during the drag (rAF), and the trace's main-thread time by kind
// (script, style, layout, paint/composite) inside the drag window. Also checks that both histories keep their scroll
// position and that the drafts survive.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [HP=<port>] [THROTTLE=4] npx tsx scripts/manual/perf/split-resize-m3455.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture } from "../smoke-fixture/index.mts";

const REPO = process.env.REPO!, OUT = process.env.OUT!, THROTTLE = Number(process.env.THROTTLE ?? 4), LABEL = process.env.LABEL ?? "run";
mkdirSync(OUT, { recursive: true });
const fx = await bootFixture({ port: Number(process.env.HP ?? 49790), instances: 3, classic: false });
const fm = fx.fm as any;
const [, A, B] = fx.instances.map((i: any) => i.name);
const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);
const bodies = [
  "Checked the build logs:\n- no errors\n- two warnings, both known\n- the cache was warm",
  "Here is the change:\n\n```ts\nexport function clamp(value: number, min: number, max: number) {\n  return Math.min(max, Math.max(min, value));\n}\n```\n\nIt keeps the ratio inside the pane limits.",
  "部署完成，staging 已更新。接下來會跑煙霧測試，結果出來再回報。",
  "| step | time | result |\n|---|---|---|\n| build | 42 s | ok |\n| test | 3 m 10 s | ok |\n| deploy | 18 s | ok |",
  "A longer paragraph so the line wrapping changes as the pane width changes: the divider moves, every line in this message has to be broken again at the new width, and taller rows push the rest of the history down.",
];
for (const name of [A, B]) for (let n = 1; n <= 200; n++) {
  const user = n % 4 === 0;
  fm.webChatHistory.record({ instance: name, sender: user ? "Ops" : name, role: user ? "user" : "agent", text: `#${n} ${bodies[n % bodies.length]}`, ts: new Date(T0 + n * 60_000).toISOString() });
}
const result: any = { label: LABEL, throttle: THROTTLE };
try {
  fm.webPrefs.write("operator", new Map([["theme", "light"], ["lang", "en"]]));
  const ctx = await fx.browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: "en" });
  await ctx.addInitScript(() => { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); localStorage.setItem("agend_usage_rail", "0"); });
  const page = await ctx.newPage(); page.setDefaultTimeout(20000);
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  fm.initializeWebSessions();
  const { tokenEpoch } = await import(REPO + "/src/web-session.ts");
  const code = fm.webLoginCodes.issue({ tier: "admin", epoch: tokenEpoch(fm.webToken) }).display;
  await page.goto(fx.base + "/signin"); await page.locator("#code").waitFor();
  await page.locator("#code").evaluate((input: HTMLInputElement, value: string) => { input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); input.form!.requestSubmit(); }, code);
  await page.waitForURL(fx.base + "/ui");
  await page.evaluate(async (name: string) => { const nav = await import("/assets/app-nav.js"); nav.navigate(`/ui/chat/${encodeURIComponent(name)}`); }, A);
  await page.locator("#msgIn").waitFor();
  await page.evaluate(async (name: string) => { const { appStore } = await import("/assets/app-store.js"); await appStore.get().chatWorkspace?.open(name); }, B);
  await page.locator(".ws-pane-head").nth(1).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[data-pane] .msg, [data-pane] [data-key]').length > 300, null, { timeout: 30000 }).catch(() => {});
  await page.locator("#pane-a-msgIn").fill("draft A"); await page.locator("#pane-b-msgIn").fill("draft B");
  await page.waitForTimeout(1500);
  const rows = await page.evaluate(() => [...document.querySelectorAll("[data-pane]")].map(p => p.querySelectorAll("*").length));
  result.domNodesPerPane = rows;
  // Scroll each history somewhere in the middle; the drag must not move what the reader sees.
  const scrollers = () => page.evaluate(() => [...document.querySelectorAll("[data-pane]")].map(p => {
    const s = [...p.querySelectorAll("*")].find(el => el.scrollHeight > el.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) as HTMLElement | undefined;
    if (!s) return null; const top = s.getBoundingClientRect().top; const first = [...s.querySelectorAll("[data-key], .msg")].find(el => el.getBoundingClientRect().bottom > top) as HTMLElement | undefined;
    return { scrollTop: Math.round(s.scrollTop), first: first?.textContent?.slice(0, 24) ?? null, firstTop: first ? Math.round(first.getBoundingClientRect().top - top) : null };
  }));
  await page.evaluate(() => { for (const p of document.querySelectorAll("[data-pane]")) { const s = [...p.querySelectorAll("*")].find(el => el.scrollHeight > el.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) as HTMLElement | undefined; if (s) s.scrollTop = Math.round(s.scrollHeight / 2); } });
  await page.waitForTimeout(800);
  result.before = await scrollers();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  const sash = await page.locator(".ws-sash").boundingBox(); if (!sash) throw Error("no sash");
  const x0 = sash.x + sash.width / 2, y0 = sash.y + sash.height / 2;
  await page.mouse.move(x0, y0);
  const events: any[] = [];
  cdp.on("Tracing.dataCollected", (d: any) => events.push(...d.value));
  const done = new Promise(r => cdp.once("Tracing.tracingComplete", r));
  await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing", transferMode: "ReportEvents" });
  // A string: tsx would wrap a named in-page function in its __name helper, which the page doesn't have.
  await page.evaluate(`(() => { window.__frames = []; let last = performance.now(); function tick(t) { window.__frames.push(t - last); last = t; if (window.__frames.length < 2000 && !window.__stop) requestAnimationFrame(tick); } requestAnimationFrame(tick); performance.mark("drag-start"); })()`);
  await page.mouse.down();
  const STEPS = 60; const path: number[] = [];
  for (let i = 1; i <= STEPS; i++) path.push(x0 + 120 * Math.sin(Math.PI * i / STEPS));          // right and back
  for (let i = 1; i <= STEPS; i++) path.push(x0 - 120 * Math.sin(Math.PI * i / STEPS));          // left and back
  for (const x of path) { await page.mouse.move(x, y0); await page.evaluate(() => new Promise(requestAnimationFrame)); }
  await page.mouse.up();
  await page.evaluate(() => { performance.mark("drag-end"); (window as any).__stop = true; });
  await page.waitForTimeout(300);
  await cdp.send("Tracing.end"); await done;
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  const frames: number[] = (await page.evaluate(() => (window as any).__frames)).slice(1);
  const sorted = [...frames].sort((a, b) => a - b), q = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] * 10) / 10;
  result.frames = { n: frames.length, mean: Math.round(frames.reduce((a, b) => a + b, 0) / frames.length * 10) / 10, p50: q(.5), p90: q(.9), p99: q(.99), max: Math.round(Math.max(...frames)), over33: frames.filter(f => f > 33.4).length, over50: frames.filter(f => f > 50).length };
  // Main-thread time by kind inside the drag window (top-level renderer-main events only).
  const mark = (n: string) => events.find(e => e.name === n && e.ph?.match(/[RIn]/))?.ts;
  const t0 = mark("drag-start"), t1 = mark("drag-end");
  const main = events.find(e => e.name === "drag-start");                                   // the page's own renderer thread
  const kinds: Record<string, string> = { FunctionCall: "script", EvaluateScript: "script", EventDispatch: "script", TimerFire: "script", FireAnimationFrame: "script", "v8.execute": "script", RunMicrotasks: "script",
    UpdateLayoutTree: "style", RecalculateStyles: "style", Layout: "layout", PrePaint: "paint", Paint: "paint", PaintImage: "paint", UpdateLayer: "paint", UpdateLayerTree: "paint", Layerize: "paint", Commit: "paint", CompositeLayers: "paint" };
  const self: Record<string, number> = {}, byName: Record<string, number> = {};
  const evs = events.filter(e => e.ph === "X" && e.pid === main?.pid && e.tid === main?.tid && e.ts >= t0 && e.ts <= t1 && kinds[e.name]).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  // Self time of the kind: subtract nested known events (a Layout inside a FunctionCall is layout, not script).
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i]; let child = 0; const end = e.ts + e.dur;
    for (let j = i + 1; j < evs.length && evs[j].ts < end; j++) { const c = evs[j]; if (c.ts + c.dur <= end) { child += c.dur; const cend = c.ts + c.dur; while (j + 1 < evs.length && evs[j + 1].ts < cend) j++; } }
    self[kinds[e.name]] = (self[kinds[e.name]] ?? 0) + Math.max(0, e.dur - child); byName[e.name] = (byName[e.name] ?? 0) + e.dur;
  }
  const ms = (v: number) => Math.round(v / 100) / 10;
  result.window_ms = ms(t1 - t0); result.mainThreadSelf_ms = Object.fromEntries(Object.entries(self).map(([k, v]) => [k, ms(v)]));
  result.layoutCount = evs.filter(e => e.name === "Layout").length; result.forcedLayouts = events.filter(e => e.name === "Layout" && e.ts >= t0 && e.ts <= t1 && e.args?.beginData?.stackTrace).length;
  result.styleCount = evs.filter(e => e.name === "UpdateLayoutTree").length;
  await page.waitForTimeout(500);
  result.after = await scrollers();
  result.drafts = [await page.locator("#pane-a-msgIn").inputValue(), await page.locator("#pane-b-msgIn").inputValue()];
  result.ratio = await page.evaluate(async () => { const { navStore } = await import("/assets/app-nav.js"); return navStore.get().workspace?.ratio; });
  result.errors = errors;
  writeFileSync(join(OUT, `trace-${LABEL}.json`), JSON.stringify({ traceEvents: events }));
} catch (e) { result.error = String(e).slice(0, 600); }
finally { writeFileSync(join(OUT, `result-${LABEL}.json`), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2)); await fx.close(); process.exit(0); }
