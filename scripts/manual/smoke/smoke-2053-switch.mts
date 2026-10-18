// #2053 from defaults (fleet decision a78ebdc5): how fast switching chats is — first visits and revisits — on a fleet-sized
// history (seedChat: 200 messages per chat, zh-TW and English, long Markdown, code, tables, photos), demo names only.
// A fresh profile with nothing seeded, signed in through the visible /signin, on desk (1366) and phone (390); Chromium
// runs with a 4× CPU slowdown (DevTools; WebKit has none, so it runs unthrottled). Per switch, from the click on the
// chat's sidebar row (a DOM click: the phone's drawer is not opened, so only the app's own work is timed):
//   first — the first message of the new thread is in the DOM      full — every message is (the thread drawn)
//   lt    — long-task ms between the click and `full` (Chromium)   md / mdN — ms in renderMarkdown, and its calls
// First visits (history read); revisits among the last four chats shown (what the page keeps: THREAD_KEEP), ROUNDS
// rounds; and revisits of chats seen longer ago (let go: drawn anew); medians. After every revisit the view is at the
// bottom (pinned), as before (#2088's end-of-scroll must hold). RUN IT ALONE: nothing else may run beside it.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> [PW_ENGINE=webkit] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2053-switch.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, seedChat, shotPath } from "../smoke-fixture/index.mts";

const N = Number(process.env.N ?? 200), ROUNDS = Number(process.env.ROUNDS ?? 2);
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
// No page error. The only lines accepted are WebKit's own (#2127, as #2138's smoke), under WebKit only, matched
// exactly on the text before " @ <url>", and listed apart in the result.
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
const split = (errors: string[]) => {
  const accepted: string[] = [], other: string[] = [];
  for (const e of errors) (ENGINE === "webkit" && WEBKIT_OWN.has(e.replace(/ @ \S+$/, "")) ? accepted : other).push(e);
  return { accepted, other };
};
const fx = await bootFixture({ port: Number(process.env.HP ?? 48560), classic: false });
const fm = fx.fm;
const CHATS = ["observability-dashboards", "billing-reconciliation", "search-indexer", "customer-support-macros", "nightly-benchmarks", "docs-site-builder"];
for (const name of Object.keys(fm.fleetConfig.instances)) if (!CHATS.includes(name)) delete fm.fleetConfig.instances[name];
const chatted = await seedChat(fx, CHATS, N);

const measure = (page: any, to: string) => page.evaluate(`new Promise((resolve) => {
  const to = ${JSON.stringify(to)}, want = ${N};
  const link = document.querySelector('a[href="/ui/chat/' + to + '"]');
  const marks = {}; let t0 = 0; let done = false;
  const frame = (k) => { if (marks[k] === undefined) { marks[k] = -1; requestAnimationFrame(() => { marks[k] = Math.round(performance.now() - t0); }); } };
  const finish = (extra) => { obs.disconnect(); const lt = (window.__lt || []).filter(([s]) => s >= t0).reduce((n, [, d]) => n + d, 0);
    const sc = document.querySelector(".p-chat .scroller"); const bottom = sc ? sc.scrollHeight - sc.scrollTop - sc.clientHeight <= 2 : null;
    resolve({ ...marks, lt: Math.round(lt), md: Math.round(window.__md), mdN: window.__mdN, bottom, ...extra }); };
  const check = () => {
    const mine = [...document.querySelectorAll(".p-chat .msg.agent .sender")].some((e) => e.textContent === to);
    const msgs = mine ? document.querySelectorAll(".p-chat .msg").length : 0;
    if (msgs > 0) frame("first");
    if (msgs >= want && !done) { done = true; frame("full"); setTimeout(() => finish({}), 400); }
  };
  const obs = new MutationObserver(check);
  obs.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => { if (!done) finish({ timeout: true, msgs: document.querySelectorAll(".p-chat .msg").length }); }, 30000);
  window.__md = 0; window.__mdN = 0;
  t0 = performance.now(); if (link) link.click(); else resolve({ missing: true }); check();
})`);
const med = (xs: number[]) => { const s = xs.filter((x) => typeof x === "number" && x >= 0).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : null; };
const summary = (rows: any[]) => Object.fromEntries(["first", "full", "lt", "md", "mdN"].map((m) => [m, med(rows.map((r) => r[m]))]));

const results: any = { engine: ENGINE, N, chatted, cases: {} };
for (const [tag, c] of [["desk", { device: "desk", theme: "light", lang: "en" }], ["phone", { device: "phone", theme: "light", lang: "en" }]] as const) {
  const p = await freshPage(fx, c as any);
  // Timing hooks before the app loads: long tasks and a wrap of renderMarkdown.
  await p.ctx.addInitScript({ content: `window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]); }).observe({ entryTypes: ["longtask"] }); } catch {}
    window.__md = 0; window.__mdN = 0;
    const wrap = () => { const R = window.AgendChatRender; if (!R || R.__w) return !!R; const f = R.renderMarkdown; R.renderMarkdown = function () { const s = performance.now(); try { return f.apply(this, arguments); } finally { window.__md += performance.now() - s; window.__mdN++; } }; R.__w = true; return true; };
    const iv = setInterval(() => { if (wrap()) clearInterval(iv); }, 5);` });
  if (ENGINE === "chromium") { const cdp = await p.ctx.newCDPSession(p.page); await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 }); }
  await p.page.goto(`${p.base}/ui/chat/${CHATS[0]}`);
  await mounted(p.page, 30000);
  await p.page.waitForFunction((n: number) => document.querySelectorAll(".p-chat .msg").length >= n, N, { timeout: 60000 });
  await p.page.waitForTimeout(1000);
  const first: any[] = [], revisit: any[] = [], older: any[] = [];
  for (const to of CHATS.slice(1)) first.push(await measure(p.page, to));                    // first visits: history read
  // Now shown: CHATS[5]; kept: CHATS[2..4]. Revisits among those four (each a kept one).
  for (let r = 0; r < ROUNDS; r++) for (const to of [CHATS[4], CHATS[3], CHATS[2], CHATS[5]]) revisit.push(await measure(p.page, to));
  // Seen longer ago (let go): CHATS[0], CHATS[1] — drawn anew, from the history already read.
  for (const to of [CHATS[0], CHATS[1]]) older.push(await measure(p.page, to));
  const all = [...first, ...revisit, ...older];
  results.cases[tag] = { summary: { first: summary(first), revisit: summary(revisit), older: summary(older) },
    bottomAfterRevisit: [...revisit, ...older].every((x) => x.bottom === true), timeouts: all.filter((x) => x.timeout || x.missing).length,
    errors: split(p.errors).other, webkitOwn: split(p.errors).accepted };
  await p.page.screenshot({ path: shotPath("smoke-2053-switch", `${ENGINE}-${tag}`, "chat") });
  await p.ctx.close();
}
writeFileSync(shotPath("smoke-2053-switch", `${ENGINE}-result`, "x").replace(/-x\.png$/, ".json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify(Object.fromEntries(Object.entries(results.cases).map(([k, v]: any) => [k, { ...v.summary, bottom: v.bottomAfterRevisit, timeouts: v.timeouts, errors: v.errors, webkitOwn: v.webkitOwn.length }])), null, 1));
const failed = Object.values(results.cases).some((v: any) => v.errors.length || v.timeouts || !v.bottomAfterRevisit);
console.log(failed ? "FAIL" : `PASS (${ENGINE})`);
await fx.close(); process.exit(failed ? 1 : 0);
