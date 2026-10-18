// #2053 from defaults (fleet decision a78ebdc5): how fast switching chats is — first visits and revisits — on a fleet-sized
// history (seedChat: 200 messages per chat, zh-TW and English, long Markdown, code, tables, photos), demo names only.
// A fresh profile with nothing seeded, signed in through the visible /signin, on desk (1366) and phone (390); Chromium
// runs with a 4× CPU slowdown (DevTools; WebKit has none, so it runs unthrottled). Per switch, from the click on the
// chat's sidebar row (a DOM click: the phone's drawer is not opened, so only the app's own work is timed):
//   first — the first message of the new thread is in the DOM      full — every message is (the thread drawn)
//   lt    — long-task ms started between the click and every message in the DOM (Chromium)
//   md / mdN — ms in renderMarkdown, and its calls (until 400 ms after `full`)
// First visits (history read); revisits among the last four chats shown (what the page keeps: THREAD_KEEP), ROUNDS
// rounds; and revisits of chats seen longer ago (let go: drawn anew); medians. A chat left at the bottom comes back at
// the bottom (#2088's end-of-scroll must hold); one left higher up keeps the memo's unchanged path (listed).
// Then the acceptance, no timing (the review's P2-2): the person's way — the sidebar's visible rows, a phone's drawer
// opened with ☰ — on desk light (English; a LAN origin in Chromium), phone dark (zh-TW, reduced motion) and the
// temporary public link (phone light, reduced motion; stubbed as the harness says). A chat read part-way up, another
// opened, the first shown again: the very same thread (kept), where the reader left it; the second, left at the bottom,
// shown again at the bottom. No page error (WebKit's own two lines only). RUN IT ALONE: nothing else may run beside it.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> [PW_ENGINE=webkit] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2053-switch.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, openPublicLink, seedChat, shotPath, type FreshPage } from "../smoke-fixture/index.mts";

const N = Number(process.env.N ?? 200), ROUNDS = Number(process.env.ROUNDS ?? 2);
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
// No page error. The only lines accepted are WebKit's own (#2127, as #2138's smoke), under WebKit only, matched
// exactly on the text before " @ <url>", and listed apart in the result.
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
// The smoke's own navigation (to the first chat) cancels the stream and a poll it opened: WebKit logs those as "cannot
// load … due to access control checks". Accepted only by position — inside that navigation's window [from, to) — and
// only for /ui/events and /ui/poll (as #2138's smoke); the same text anywhere else fails.
// (WebKit writes the URL as "http: /127.0.0.1:<port>/ui/…": a space after the scheme.)
const CANCEL = /^(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/ui\/(events|poll)(\?\S*)? due to access control checks\.$/;
const split = (errors: string[], nav: [number, number]) => {
  const accepted: string[] = [], other: string[] = [];
  errors.forEach((e, i) => {
    const text = e.replace(/ @ \S+$/, "");
    const own = ENGINE === "webkit" && (WEBKIT_OWN.has(text) || (i >= nav[0] && i < nav[1] && CANCEL.test(text)));
    (own ? accepted : other).push(e);
  });
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
  const marks = {}; let t0 = 0, tEnd = 0; let done = false;
  const frame = (k) => { if (marks[k] === undefined) { marks[k] = -1; requestAnimationFrame(() => { marks[k] = Math.round(performance.now() - t0); }); } };
  // Long tasks that started between the click and the thread drawn (entries arrive late: read 400 ms on).
  const finish = (extra) => { obs.disconnect(); if (!tEnd) tEnd = performance.now(); const lt = (window.__lt || []).filter(([s]) => s >= t0 && s < tEnd).reduce((n, [, d]) => n + d, 0);
    const sc = document.querySelector(".p-chat .scroller"); const dist = sc ? Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight) : null;
    resolve({ ...marks, lt: Math.round(lt), md: Math.round(window.__md), mdN: window.__mdN, dist, ...extra }); };
  const check = () => {
    const mine = [...document.querySelectorAll(".p-chat .msg.agent .sender")].some((e) => e.textContent === to);
    const msgs = mine ? document.querySelectorAll(".p-chat .msg").length : 0;
    if (msgs > 0) frame("first");
    if (msgs >= want && !done) { done = true; tEnd = performance.now(); frame("full"); setTimeout(() => finish({}), 400); }
  };
  const obs = new MutationObserver(check);
  obs.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => { if (!done) finish({ timeout: true, msgs: document.querySelectorAll(".p-chat .msg").length }); }, 30000);
  window.__md = 0; window.__mdN = 0;
  // Where the chat being left was (px from its bottom): a revisit restores it.
  const was = document.querySelector(".p-chat .scroller"); marks.leftAt = was ? Math.round(was.scrollHeight - was.scrollTop - was.clientHeight) : null;
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
  const navFrom = p.errors.length;
  await p.page.goto(`${p.base}/ui/chat/${CHATS[0]}`);
  await mounted(p.page, 30000);
  await p.page.waitForFunction((n: number) => document.querySelectorAll(".p-chat .msg").length >= n, N, { timeout: 60000 });
  await p.page.waitForTimeout(1000);
  const nav: [number, number] = [navFrom, p.errors.length];
  const first: any[] = [], revisit: any[] = [], older: any[] = [];
  // Where each chat was left (px from its bottom, at the click away). One left at the bottom (within the 48 px a reader
  // counts as at the bottom) must come back at the bottom (#2088). One left higher up comes back at its remembered
  // scrollTop, the memo's unchanged path: listed (leftOffBottom), not judged here.
  let current = CHATS[0];
  const left: Record<string, number> = {};
  const go = async (to: string) => { const r = await measure(p.page, to); left[current] = r.leftAt; current = to; return r; };
  const where = (to: string, r: any) => { const was = left[to]; return { to, was, ok: typeof was !== "number" || typeof r.dist !== "number" ? false : was <= 48 ? r.dist <= 2 : true, ...r }; };
  for (const to of CHATS.slice(1)) first.push({ to, ...(await go(to)) });                    // first visits: history read
  // Now shown: CHATS[5]; kept: CHATS[2..4]. Revisits among those four (each a kept one).
  for (let r = 0; r < ROUNDS; r++) for (const to of [CHATS[4], CHATS[3], CHATS[2], CHATS[5]]) revisit.push(where(to, await go(to)));
  // Seen longer ago (let go): CHATS[0], CHATS[1] — drawn anew, from the history already read.
  for (const to of [CHATS[0], CHATS[1]]) older.push(where(to, await go(to)));
  const all = [...first, ...revisit, ...older];
  results.cases[tag] = { summary: { first: summary(first), revisit: summary(revisit), older: summary(older) },
    backWhereLeft: [...revisit, ...older].every((x) => x.ok), leftOffBottom: Object.entries(left).filter(([, d]) => d > 48).map(([n, d]) => `${n}:${d}`),
    timeouts: all.filter((x) => x.timeout || x.missing).length,
    errors: split(p.errors, nav).other, webkitOwn: split(p.errors, nav).accepted, nav, allErrors: p.errors,
    rows: { first: first.map((r, i) => ({ to: CHATS[i + 1], ...r })), revisit, older } };
  await p.page.screenshot({ path: shotPath("smoke-2053-switch", `${ENGINE}-${tag}`, "chat") });
  await p.ctx.close();
}

async function clickVisible(page: any, selector: string, timeout = 10000): Promise<void> {
  const all = page.locator(selector), end = Date.now() + timeout;
  do {
    for (let i = 0; i < await all.count(); i++) if (await all.nth(i).isVisible()) { await all.nth(i).click(); return; }
    await page.waitForTimeout(100);
  } while (Date.now() < end);
  throw new Error(`nothing visible matches ${selector} on ${page.url()}`);
}
/** Open a chat as a person does: its visible row in the sidebar (a phone opens the drawer with ☰ first). */
async function visit(p: FreshPage, to: string) {
  if (p.page.viewportSize().width < 760 && !(await p.page.locator(".shell.sb-open").count())) await clickVisible(p.page, 'button[aria-controls="sidebar"]');
  await clickVisible(p.page, `a[href="/ui/chat/${to}"]`);
  await p.page.waitForURL(`**/ui/chat/${to}`, { timeout: 10000 });
  await p.page.waitForFunction(([name, n]: [string, number]) => [...document.querySelectorAll(".p-chat .msg.agent .sender")].some((e) => e.textContent === name)
    && document.querySelectorAll(".p-chat .msg").length >= n, [to, N] as [string, number], { timeout: 30000 });
  await p.page.waitForTimeout(600);
}
/** The open chat's scroller: its position, px from the bottom, and whether its thread is the one tagged `tag`. */
const where = (p: FreshPage, tag?: string) => p.page.evaluate((t: string | null) => {
  const sc = document.querySelector(".p-chat .scroller") as HTMLElement, th = document.querySelector(".p-chat .thread") as any;
  return { top: Math.round(sc.scrollTop), dist: Math.round(sc.scrollHeight - sc.scrollTop - sc.clientHeight), same: t ? th[t] === true : null };
}, tag ?? null);
const accept: any[] = [];
async function acceptCase(name: string, open: () => Promise<FreshPage>) {
  const p = await open();
  await mounted(p.page, 30000);
  const [A, B] = [CHATS[0], CHATS[1]];
  await visit(p, A);
  // Read part-way up: a wheel on a desk, the page scrolled by the reader's finger on a phone (no wheel there).
  if (p.page.viewportSize().width < 760) await p.page.evaluate(() => { document.querySelector(".p-chat .scroller")!.scrollBy(0, -1500); });
  else { await p.page.locator(".p-chat .scroller").hover(); await p.page.mouse.wheel(0, -1500); }
  // Where the reader stopped: once the scroll has come to rest (WebKit's wheel scrolls smoothly, and was read mid-way).
  for (let i = 0, last = -1; i < 40; i++) {
    const top = await p.page.evaluate(() => document.querySelector(".p-chat .scroller")!.scrollTop);
    if (top === last) break;
    last = top; await p.page.waitForTimeout(150);
  }
  await p.page.waitForTimeout(300);
  await p.page.evaluate(() => { (document.querySelector(".p-chat .thread") as any).__keptA = true; });
  const leftA = await where(p);
  await visit(p, B);
  const firstB = await where(p);
  await p.page.evaluate(() => { (document.querySelector(".p-chat .thread") as any).__keptB = true; });
  await visit(p, A);
  const backA = await where(p, "__keptA");
  await p.page.screenshot({ path: shotPath("smoke-2053-switch", `${ENGINE}-accept-${name}`, "back") });
  await visit(p, B);
  const backB = await where(p, "__keptB");
  const errors = p.errors.filter((e) => !(ENGINE === "webkit" && WEBKIT_OWN.has(e.replace(/ @ \S+$/, ""))));
  const chk = { readUp: leftA.dist > 200, keptA: backA.same === true, whereLeftA: Math.abs(backA.top - leftA.top) <= 2,
    bOpensAtBottom: firstB.dist <= 2, keptB: backB.same === true, bBackAtBottom: backB.dist <= 2, noErrors: errors.length === 0 };
  const failed = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
  accept.push({ name, ok: !failed.length, failed, leftA, backA, firstB, backB, errors });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${ENGINE}-accept-${name}${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify({ leftA, backA, firstB, backB, errors }).slice(0, 500)}` : ""}`);
  await p.ctx.close();
}
await acceptCase(ENGINE === "webkit" ? "desk-light-en" : "desk-light-en-lan",
  () => freshPage(fx, { device: "desk", theme: "light", lang: "en" }, ENGINE === "webkit" ? {} : { origin: "lan" }));
await acceptCase("phone-dark-zh-TW-reduced", () => freshPage(fx, { device: "phone", theme: "dark", lang: "zh-TW" }, { reducedMotion: true }));
const link = await openPublicLink(fx);
await acceptCase("public-link-phone-light-en-reduced", () => link.publicPage({ device: "phone", theme: "light", lang: "en" }, { reducedMotion: true }));
await link.close();
results.accept = accept;

writeFileSync(shotPath("smoke-2053-switch", `${ENGINE}-result`, "x").replace(/-x\.png$/, ".json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify(Object.fromEntries(Object.entries(results.cases).map(([k, v]: any) => [k, { ...v.summary, backWhereLeft: v.backWhereLeft, leftOffBottom: v.leftOffBottom, timeouts: v.timeouts, errors: v.errors, webkitOwn: v.webkitOwn.length }])), null, 1));
const failed = Object.values(results.cases).some((v: any) => v.errors.length || v.timeouts || !v.backWhereLeft) || accept.some((a) => !a.ok);
console.log(failed ? "FAIL" : `PASS (${ENGINE})`);
await fx.close(); process.exit(failed ? 1 : 0);
