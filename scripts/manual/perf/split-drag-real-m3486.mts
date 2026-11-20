// M-3486 (the user, 2026-11-20, on beta.16: the split view's divider drag still doesn't feel smooth after #4277): the same
// measurement as split-resize-m3455.mts, on chats shaped like real ones. Each of two agents has 200 messages mixing long
// Markdown (headings, lists, links), long code blocks (folded), tables, served images (several sizes), .html file cards and
// ```html blocks (one preview frame running — previews opted in on this device), reactions, reply quotes, status lines;
// the live activity block (/ui/steps: a turn of tool steps, the last one running). Desktop widths 1366 and 1920, no CPU
// throttle and 4×. Reported as in m3455: frame intervals during the drag, and main-thread time by kind; plus the trace's
// top script functions, ResizeObserver deliveries, image decodes and frame (iframe) layout work, to name what dominates.
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> [HP=<port>] [THROTTLE=4] [WIDTH=1366] [LABEL=…]
//   npx tsx scripts/manual/perf/split-drag-real-m3486.mts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture } from "../smoke-fixture/index.mts";

const REPO = process.env.REPO!, OUT = process.env.OUT!, THROTTLE = Number(process.env.THROTTLE ?? 4), WIDTH = Number(process.env.WIDTH ?? 1366), LABEL = process.env.LABEL ?? "run";
const HEIGHT = WIDTH >= 1920 ? 1080 : 768;
mkdirSync(OUT, { recursive: true });
// A plain placeholder roster (no teams): the evidence picture carries no realistic team, channel or agent names.
const fx = await bootFixture({ port: Number(process.env.HP ?? 49792), classic: false, roster: [
  { name: "general", backend: "claude-code", general: true, displayName: "General" },
  { name: "agent-a", backend: "claude-code", displayName: "Agent A" },
  { name: "agent-b", backend: "codex", displayName: "Agent B" }] });
const fm = fx.fm as any;
const [, A, B] = fx.instances.map((i: any) => i.name);
const { publicAttachment } = await import(REPO + "/src/web-upload.ts");
const tmp = join(fx.dir, "pics"); mkdirSync(tmp, { recursive: true });
const picture = async (key: string, name: string, instance: string) => {
  const path = join(tmp, `${instance}-${name}`); writeFileSync(path, await fx.picture(key as any));
  return publicAttachment(fm.webFiles.registerServed({ path, instance, name, mime: name.endsWith(".jpg") ? "image/jpeg" : "image/png", kind: "photo" }));
};
const htmlFile = (instance: string, n: number) => {
  const path = join(tmp, `${instance}-report-${n}.html`);
  writeFileSync(path, `<!doctype html><html><body style="font:14px sans-serif;margin:12px"><h2>Report ${n}</h2>${"<p>A paragraph of the generated report, wrapping to the frame's width.</p>".repeat(6)}<table border=1>${"<tr><td>cell</td><td>value</td><td>note</td></tr>".repeat(8)}</table></body></html>`);
  return publicAttachment(fm.webFiles.registerServed({ path, instance, name: `report-${n}.html`, mime: "text/html", kind: "document" }));
};
const code = (n: number) => "```ts\n" + Array.from({ length: 70 }, (_, i) => `export function step${n}_${i}(input: Record<string, number>): number { return Object.values(input).reduce((a, b) => a + b * ${i}, 0); }`).join("\n") + "\n```";
const md = (n: number) => `## Release notes ${n}\n\nThe build passed on every platform. ${"Each change below was checked against the previous release, and the numbers were measured twice so a slow run doesn't skew them. ".repeat(3)}\n\n- **Fleet:** agents resume after an update; the [changelog](https://example.com/changelog) lists each fix.\n- **Web:** the split view keeps both drafts; long lines wrap at the pane's width.\n- **Hub:** rooms keep their members across a restart.\n\n1. Pull the latest build.\n2. Restart the fleet.\n3. Check the Log for warnings.\n\n> A quoted note from the reviewer: the numbers look right, ship it.`;
const table = (n: number) => `Results for run ${n}:\n\n| step | time | result | note |\n|---|---|---|---|\n` + Array.from({ length: 9 }, (_, i) => `| step ${i + 1} | ${i * 7 + 3} s | ok | a longer note that wraps in a narrow pane |`).join("\n");
const htmlBlock = (n: number) => "Here is the chart page:\n\n```html\n<!doctype html><html><body><h1>Chart " + n + "</h1>" + "<div style=\"height:20px;background:#4a8;margin:4px 0;width:" + (30 + n % 60) + "%\"></div>".repeat(6) + "</body></html>\n```";
const T0 = Date.UTC(2026, 10, 20, 9, 0, 0);
for (const name of [A, B]) {
  const pics = [await picture("bannerWide", "wide.jpg", name), await picture("portrait", "portrait.jpg", name), await picture("avatarTransparent", "small.png", name), await picture("bannerTall", "tall.png", name)];
  let last: any = null;
  for (let n = 1; n <= 200; n++) {
    const ts = new Date(T0 + n * 60_000).toISOString(), k = n % 10;
    let m: any;
    if (k === 0) m = { role: "user", sender: "Ops", text: `#${n} Can you check this one again?`, ...(last ? { replyTo: { boot: last.boot, id: last.id, sender: last.sender, text: last.text.slice(0, 80) } } : {}) };
    else if (k === 1) m = { role: "agent", text: `#${n} ` + md(n) };
    else if (k === 2) m = { role: "agent", text: `#${n} The change:\n\n` + code(n) + "\n\nIt keeps the totals stable." };
    else if (k === 3) m = { role: "agent", text: `#${n} ` + table(n) };
    else if (k === 4) m = { role: "agent", text: `#${n} The screenshots:`, attachments: [pics[n % 4], pics[(n + 1) % 4]] };
    else if (k === 5) m = { role: "agent", text: `#${n} The generated report:`, attachments: [htmlFile(name, n)] };
    else if (k === 6) m = { role: "agent", text: `#${n} ` + htmlBlock(n) };
    else if (k === 7) m = { role: "status", text: `#${n} Restarted after the update; the session resumed.` };
    else if (k === 8) m = { role: "user", sender: "Ops", text: `#${n} 部署完成了嗎？順便看一下 staging 的紀錄。` };
    else m = { role: "agent", text: `#${n} ` + md(n).slice(0, 400) + "\n\n" + code(n).split("\n").slice(0, 12).join("\n") + "\n```" };
    const rec = fm.webChatHistory.record({ instance: name, sender: m.sender ?? name, ts, messageId: `rig${n}`, ...m });
    if (m.role === "agent") { last = rec; if (n % 3 === 0) { fm.webChatHistory.addReaction(name, `rig${n}`, "👍"); fm.webChatHistory.addReaction(name, `rig${n}`, "🎉"); } }
  }
}
// The live activity block: a turn of tool steps, the last running (what /ui/steps answers for a busy agent).
const now = Date.now();
const steps = Array.from({ length: 14 }, (_, i) => ({ id: `s${i}`, turn: "t-live", ts: now - (14 - i) * 4000, kind: "tool", tool: ["Read", "Grep", "Edit", "Bash"][i % 4],
  cat: ["read", "search", "edit", "run"][i % 4], subject: `src/module-${i}.ts`, status: i === 13 ? "running" : "done" }));
const result: any = { label: LABEL, throttle: THROTTLE, width: WIDTH };
try {
  fm.webPrefs.write("operator", new Map([["theme", "light"], ["lang", "en"]]));
  const ctx = await fx.browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, locale: "en" });
  await ctx.route("**/ui/steps*", (route: any) => route.fulfill({ json: { enabled: true, supported: true, backend: "claude-code", steps, events: [], key: "rig", after: null, before: null } }));
  await ctx.addInitScript(() => { localStorage.setItem("agend_tour_done", "1"); localStorage.setItem("agend_firstrun_dismissed", "1"); localStorage.setItem("agend_usage_rail", "0"); localStorage.setItem("agend_html_preview", "on"); sessionStorage.setItem("agend_html_preview_banner_ack", "1"); });
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
  // One preview running (the first ```html card in pane b), as a reader who clicked Preview leaves it.
  result.preview = await page.locator('[data-pane="b"] button', { hasText: /^Preview$/ }).first().click({ timeout: 4000 }).then(() => page.waitForSelector("iframe.preview-frame", { timeout: 8000 })).then(() => "running", (e: Error) => "none: " + e.message.slice(0, 80));
  result.content = await page.evaluate(() => ({ imgs: document.querySelectorAll("[data-pane] img").length, frames: document.querySelectorAll("[data-pane] iframe").length,
    codeBlocks: document.querySelectorAll("[data-pane] pre").length, tables: document.querySelectorAll("[data-pane] table").length, reactions: document.querySelectorAll("[data-pane] .reaction").length,
    quotes: document.querySelectorAll("[data-pane] .reply-quote, [data-pane] .msg-quote, [data-pane] blockquote").length, activity: document.querySelectorAll("[data-pane] .steps, [data-pane] .act, [data-pane] [class*=activity], [data-pane] [class*=step]").length }));
  await page.screenshot({ path: join(OUT, `shot-${LABEL}.png`) });
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
  await cdp.send("Tracing.start", { categories: process.env.STACKS ? "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,disabled-by-default-devtools.timeline.invalidationTracking,blink.user_timing" : "devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing", transferMode: "ReportEvents" });
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
