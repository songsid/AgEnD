// Board 00ef2430 on the realistic fixture: how fast switching instances in web chat feels — click to first visible change,
// on a fleet-sized history: 200 messages per instance from seedChat (zh-TW and English, long Markdown, code blocks,
// tables, served photos), six of the fixture's long-named instances. Measures, per switch:
//   sel   — the sidebar row turns active          (click → the frame after the change)
//   head  — the chat header shows the new name
//   first — the first message of the new thread is in the DOM
//   full  — every message of the thread is in the DOM (history read and drawn)
//   lt    — long-task time (ms) between the click and `full`
//   md    — time spent in renderMarkdown, and its call count
// First visits (history fetched) and revisits (cached), 5 rounds each. Timing runs only in desk-light-en and
// phone-light-en (the rest shoot the chat once, for the look). RUN IT ALONE: nothing else may run beside it.
// Output: chat-switch/result.json (summary + every switch) and the chat screenshots.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> npx --prefix <checkout> tsx scripts/manual/smoke/smoke-chat-switch.mts
import { writeFileSync } from "node:fs";
import { bootFixture, matrix, caseName, shotPath, seedChat } from "../smoke-fixture/index.mts";

const N = Number(process.env.N ?? 200);
const fx = await bootFixture({ port: Number(process.env.HP ?? 48540) });
const names = fx.instances.map(i => i.name).slice(1, 7);
const chatted = await seedChat(fx, names, N);
const TIMED = new Set(["desk-light-en", "phone-light-en"]);
const results: any = { N, messages: chatted, cases: {} };

/** Click the row for `to` and time the first visible changes; resolves when the whole thread is drawn (or after 20 s). */
const measure = (page: any, to: string) => page.evaluate(`new Promise((resolve) => {
  const to = ${JSON.stringify(to)}, want = ${N};
  const link = document.querySelector('a.v-inst[href="/ui/chat/' + to + '"]');
  const marks = {}; let t0 = 0; let done = false;
  const frame = (k) => { if (marks[k] === undefined) { marks[k] = -1; requestAnimationFrame(() => { marks[k] = performance.now() - t0; }); } };
  const finish = (extra) => { obs.disconnect(); const lt = window.__lt.filter(([s]) => s >= t0).reduce((n, [, d]) => n + d, 0); resolve({ ...marks, lt: Math.round(lt), md: Math.round(window.__md), mdN: window.__mdN, ...extra }); };
  const check = () => {
    if (link && link.classList.contains("active")) frame("sel");
    const h = document.querySelector(".p-chat .panel-title h1"); if (h && h.textContent.includes(to)) frame("head");
    // The new thread's messages: an agent message's sender is its instance's name.
    const mine = [...document.querySelectorAll(".p-chat .msg.agent .sender")].filter((e) => e.textContent === to).length;
    const msgs = mine ? document.querySelectorAll(".p-chat .msg").length : 0;
    if (msgs > 0) frame("first");
    if (msgs >= want && !done) { done = true; frame("full"); setTimeout(() => finish({}), 300); }
  };
  const obs = new MutationObserver(check);
  obs.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  setTimeout(() => { if (!done) finish({ timeout: true, msgs: document.querySelectorAll(".p-chat .msg").length }); }, 20000);
  window.__md = 0; window.__mdN = 0;
  t0 = performance.now(); if (link) link.click(); else resolve({ missing: true }); check();
})`);

const med = (xs: number[]) => { const s = [...xs].filter(x => typeof x === "number" && x >= 0).sort((x, y) => x - y); return s.length ? Math.round(s[Math.floor(s.length / 2)]!) : null; };
const summary = (rows: any[]) => Object.fromEntries(["sel", "head", "first", "full", "lt", "md", "mdN"].map(m => [m, med(rows.map((x: any) => x[m]))]));

for (const c of matrix()) {
  const tag = caseName(c);
  const { ctx, page, csp } = await fx.page(c);
  const errs: string[] = []; page.on("pageerror", (e: any) => errs.push(String(e).slice(0, 160)));
  // The timing hooks go in before the chat page loads: a long-task observer and a wrap of renderMarkdown.
  await ctx.addInitScript({ content: `
    window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]); }).observe({ entryTypes: ["longtask"] }); } catch {}
    window.__md = 0; window.__mdN = 0;
    const wrap = () => { const R = window.AgendChatRender; if (!R || R.__w) return !!R; const f = R.renderMarkdown; R.renderMarkdown = function () { const s = performance.now(); try { return f.apply(this, arguments); } finally { window.__md += performance.now() - s; window.__mdN++; } }; R.__w = true; return true; };
    const iv = setInterval(() => { if (wrap()) clearInterval(iv); }, 5);
  ` });
  await page.goto(`${fx.base}/ui/chat/${encodeURIComponent(names[0])}`);
  await page.waitForFunction((n: number) => document.querySelectorAll(".p-chat .msg").length >= n, N, { timeout: 30000 }).catch(() => errs.push("first thread not drawn"));
  await page.waitForTimeout(800);
  const out: any = { csp: await csp(), errs };
  if (TIMED.has(tag)) {
    const first: any[] = [], revisit: any[] = [];
    // First visits: the other five (history fetched); revisits: the same five again (cached).
    for (const to of names.slice(1)) first.push(await measure(page, to));
    for (const to of names.slice(0, 5)) revisit.push(await measure(page, to));
    out.first = first; out.revisit = revisit;
    out.summary = { first: summary(first), revisit: summary(revisit) };
  }
  await page.screenshot({ path: shotPath("chat-switch", c, "chat") });
  results.cases[tag] = out;
  await ctx.close();
}
writeFileSync(shotPath("chat-switch", "result", "x").replace(/-x\.png$/, ".json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify(Object.fromEntries(Object.entries(results.cases).map(([k, v]: any) => [k, v.summary ?? "no timing"])), null, 1));
await fx.close(); process.exit(0);
