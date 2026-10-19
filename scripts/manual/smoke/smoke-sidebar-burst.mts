// #2188 from defaults (fleet decision a78ebdc5): clicking down the sidebar as fast as you like — the last click wins,
// nothing is left loading. A fresh profile with nothing seeded signs in through the visible /signin; 16 chats of 200
// messages each (seedChat: zh-TW and English, long Markdown, code, tables, served photos; demo names only).
// A burst: BURST rows clicked one after another, 80–150 ms apart (a fixed seeded sequence), then nothing. From the last
// click, every frame records the URL's chat, the highlighted row (aria-current), the header's name, the thread's own
// chat and its drawn message count, and whether a skeleton is on screen. Judged per burst:
//   - final: 3 s after the last click, the URL, highlight, header and thread all name the last click's chat, its
//     messages are drawn (≥ the history read, or all of a kept one), and no skeleton is on screen;
//   - instant: the highlight and the header name the last chat in the first frame after its click (ms reported);
//   - shown: ms from the last click to its thread on screen with its messages (reported, the before/after number).
// Bursts: cold (chats never opened), mixed (kept and cold), and one that passes through cold chats between two used ones
// (every other chat, more than a wide screen keeps; the used ones must still be kept: the same list, no history read). Then #2184's check, unchanged:
// no message on screen moves after the last click (EPS 0.01 px).
// Chromium with a 4× CPU slowdown (PW_THROTTLE=1 = none) and classic scrollbars; WebKit without (it has none).
//   PW_DIR=… REPO=… OUT=… [PW_ENGINE=webkit] [PW_THROTTLE=4] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-sidebar-burst.mts
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, seedChat, type FreshPage } from "../smoke-fixture/index.mts";

const N = Number(process.env.N ?? 200), BURST = Number(process.env.BURST ?? 6), EPS = 0.01;
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const THROTTLE = ENGINE === "chromium" ? Number(process.env.PW_THROTTLE ?? 4) : 1;
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
const CANCEL = /^(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/ui\/(events|poll)(\?\S*)? due to access control checks\.$/;
// A request the page aborted (a superseded history read) is the browser's own line in WebKit, never an error here.
const ABORTED = /^(Fetch API cannot load .*\/ui\/history\?.* due to access control checks\.|.*AbortError.*)$/;
const split = (errors: string[], nav: [number, number]) => {
  const accepted: string[] = [], other: string[] = [];
  errors.forEach((e, i) => {
    const text = e.replace(/ @ \S+$/, "");
    const own = ENGINE === "webkit" && (WEBKIT_OWN.has(text) || (i >= nav[0] && i < nav[1] && CANCEL.test(text)) || ABORTED.test(text));
    (own ? accepted : other).push(e);
  });
  return { accepted, other };
};

const fx = await bootFixture({ port: Number(process.env.HP ?? 48610), classic: false });
const fm = fx.fm;
const CHATS = fx.instances.filter((i: any) => i.status === "running" && !i.general).map((i: any) => i.name).slice(0, 16);
for (const name of Object.keys(fm.fleetConfig.instances)) if (!CHATS.includes(name)) delete fm.fleetConfig.instances[name];
await seedChat(fx, CHATS, N);
// AMBIENT=1: every chat has falling petals (an agent's set_web_ambient) — the host-drawn ambient path, no Canvas Worker.
const AMBIENT = process.env.AMBIENT === "1";
if (AMBIENT) for (const n of CHATS) { const r = fm.webAppearance.handleTool(n, "set_web_ambient", { preset: "fall", glyphs: ["🌸", "❀", "✿"] }); if (r?.kind !== "loop") throw new Error(`ambient not set for ${n}: ${JSON.stringify(r)}`); }
// History reads, counted per chat (the page's /ui/history requests reaching the server).
const reads: Record<string, number> = {};

// A fixed "random" spacing: 80–150 ms.
let seed = 7; const gap = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return 80 + (seed % 71); };

/** Click `seq` in turn with the given gaps; from the last click, sample every frame until settled (or 6 s). */
const burst = (page: any, seq: string[], gaps: number[]) => page.evaluate(`new Promise((resolve) => {
  const seq = ${JSON.stringify(seq)}, gaps = ${JSON.stringify(gaps)}, last = seq[seq.length - 1], EPS = ${EPS};
  const row = (n) => document.querySelector('.sidebar a.inst[href="/ui/chat/' + encodeURIComponent(n) + '"]') || document.querySelector('a[href="/ui/chat/' + encodeURIComponent(n) + '"]');
  const ids = new WeakMap(); let next = 0; const id = (n) => { if (!ids.has(n)) ids.set(n, ++next); return ids.get(n); };
  const frames = []; let t0 = 0, prevBoxes = null, firstHL = null, firstHeader = null, shown = null, shifts = 0;
  const view = () => {
    const url = decodeURIComponent((location.pathname.match(/^\\/ui\\/chat\\/(.+)$/) || [])[1] || "");
    const hl = document.querySelector('.sidebar a.inst[aria-current="page"], a.inst[aria-current="page"]');
    const hlName = hl ? decodeURIComponent((hl.getAttribute("href") || "").replace("/ui/chat/", "")) : null;
    const header = (document.querySelector(".p-chat .panel-title h1") || {}).textContent || "";
    const sc = document.querySelector(".p-chat .scroller");
    const senders = [...document.querySelectorAll(".p-chat .msg.agent .sender")].map((e) => e.textContent);
    const thread = senders.length ? senders[senders.length - 1] : null;
    const msgs = document.querySelectorAll(".p-chat .msg").length;
    const skel = !!document.querySelector(".p-chat .skeleton, .p-chat .sk-line, .p-chat [aria-busy='true']");
    return { url, hl: hlName, header, thread, msgs, skel, sc };
  };
  const sample = () => {
    const t = Math.round(performance.now() - t0), v = view();
    if (firstHL === null && v.hl === last) firstHL = t;
    if (firstHeader === null && v.header.includes(last)) firstHeader = t;
    if (shown === null && v.thread === last && v.msgs >= ${Math.min(N, 24)}) shown = t;
    const boxes = new Map();
    if (v.sc && v.thread === last) { const r0 = v.sc.getBoundingClientRect();
      // The newest dozen only (what a pinned view shows): the probe must not be the page's main cost.
      const all = v.sc.querySelectorAll(".msg");
      for (let i = Math.max(0, all.length - 12); i < all.length; i++) { const m = all[i], r = m.getBoundingClientRect(); if (r.bottom < r0.top || r.top > r0.bottom) continue; boxes.set(id(m), [r.x, r.y, r.width, r.height]); } }
    if (prevBoxes) { for (const [k, b] of boxes) { const a = prevBoxes.get(k); if (a && b.some((x, i) => Math.abs(x - a[i]) > EPS)) { shifts++; break; } } }
    prevBoxes = boxes;
    frames.push([t, v.url === last ? 1 : 0, v.hl === last ? 1 : 0, v.thread === last ? 1 : 0, v.msgs, v.skel ? 1 : 0]);
    if (t < 3000 || (t < 6000 && shown === null)) requestAnimationFrame(sample);
    else { const f = view(); resolve({ last, firstHL, firstHeader, shown, shifts, final: { url: f.url, hl: f.hl, header: f.header.slice(0, 80), thread: f.thread, msgs: f.msgs, skel: f.skel }, frames: frames.length }); }
  };
  let i = 0;
  const click = () => {
    const a = row(seq[i]);
    if (a) a.click();
    if (i === seq.length - 1) { t0 = performance.now(); requestAnimationFrame(sample); return; }
    setTimeout(click, gaps[i]); i++;
  };
  click();
})`);

const out: any = { engine: ENGINE, throttle: THROTTLE, ambient: AMBIENT, historyDelay: Number(process.env.HISTORY_DELAY ?? 0), chats: CHATS.length, n: N, cases: {} };
let failed = false;
const CASES = [["desk-light-en", { device: "desk", theme: "light", lang: "en" }, { origin: ENGINE === "chromium" ? "lan" : undefined }],
  ["phone-dark-zh", { device: "phone", theme: "dark", lang: "zh-TW" }, { reducedMotion: true }]] as const;
for (const [tag, c, o] of CASES) {
  if (process.env.ONLY && !tag.startsWith(process.env.ONLY)) continue;
  for (const k of Object.keys(reads)) delete reads[k];
  const p: FreshPage = await freshPage(fx, c as any, o as any);
  await p.page.route("**/ui/history?*", (route: any) => { const n = new URL(route.request().url()).searchParams.get("instance") ?? ""; reads[n] = (reads[n] ?? 0) + 1;
    // HISTORY_DELAY=<ms>: the history answers that late (a tunnel, a slow host).
    const d = Number(process.env.HISTORY_DELAY ?? 0); return d > 0 ? new Promise((r) => setTimeout(r, d)).then(() => route.continue()) : route.continue(); });
  if (ENGINE === "chromium" && THROTTLE > 1) { const cdp = await p.ctx.newCDPSession(p.page); await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE }); }
  const navFrom = p.errors.length;
  await p.page.goto(`${p.base}/ui/chat/${encodeURIComponent(CHATS[0])}`);
  await mounted(p.page, 60000);
  await p.page.waitForFunction((n: number) => document.querySelectorAll(".p-chat .msg").length >= n, N, { timeout: 90000 });
  await p.page.waitForTimeout(1000);
  const nav: [number, number] = [navFrom, p.errors.length];
  // CASE_PROFILE=1 (Chromium): a CPU profile over every burst of the case; the effects code's share is printed.
  const caseProf = process.env.CASE_PROFILE === "1" && ENGINE === "chromium" ? await p.ctx.newCDPSession(p.page) : null;
  if (caseProf) { await caseProf.send("Profiler.enable"); await caseProf.send("Profiler.setSamplingInterval", { interval: 500 }); await caseProf.send("Profiler.start"); }
  let clicks = 0;
  // The phone's sidebar is a drawer: open it once (☰) so its rows are the visible ones a person taps.
  if (c.device === "phone") {
    const b = p.page.locator('button[aria-controls="sidebar"]');
    for (let i = 0; i < await b.count(); i++) if (await b.nth(i).isVisible()) { await b.nth(i).click(); break; }
    await p.page.waitForTimeout(400);
  }
  const rows: any[] = [];
  const run = async (kind: string, seq: string[]) => {
    const gaps = seq.slice(1).map(() => gap()); clicks += seq.length;
    const before = { ...reads };
    const r = await burst(p.page, seq, gaps);
    const f = r.final;
    const ok = f.url === r.last && f.hl === r.last && f.header.includes(r.last) && f.thread === r.last && f.msgs >= Math.min(N, 24) && !f.skel && r.shown !== null && r.shifts === 0;
    const readsDuring = Object.fromEntries(Object.entries(reads).filter(([k, v]) => v !== (before[k] ?? 0)).map(([k, v]) => [k, v - (before[k] ?? 0)]));
    rows.push({ kind, seq, gaps, ok, ...r, readsDuring });
    if (!ok) failed = true;
    console.log(`${ok ? "ok  " : "FAIL"} ${ENGINE}${THROTTLE > 1 ? `-${THROTTLE}x` : ""}-${tag} ${kind}: last=${r.last.slice(0, 24)} highlight ${r.firstHL}ms header ${r.firstHeader}ms shown ${r.shown}ms shifts ${r.shifts}; final ${JSON.stringify({ ...f, header: undefined })}`);
    await p.page.waitForTimeout(800);
  };
  // cold: six chats never opened, the last one the target.
  await run("cold", CHATS.slice(1, 1 + BURST));
  // mixed: back through some just opened (kept) and new ones.
  await run("mixed", [CHATS[3], CHATS[8], CHATS[2], CHATS[9], CHATS[5]]);
  // used vs passed through: open A and B properly, then burst through cold chats, end on A; then B must still be kept.
  const A = CHATS[2], B = CHATS[3];
  // A and B are used (each stayed on for seconds): their thread elements are marked.
  const mark = (n: string) => p.page.evaluate(`(() => { const t = document.querySelector(".p-chat .thread"); if (!t) return false; t.__used = ${JSON.stringify(n)}; return true; })()`);
  await run("settle-A", [A]); const markA = await mark(A);
  await run("settle-B", [B]); const markB = await mark(B);
  const marked = () => p.page.evaluate(`(document.querySelector(".p-chat .thread") || {}).__used || null`);
  const PROFILE_AT = process.env.PROFILE === "1" ? "pass-through" : process.env.PROFILE ?? "";
  const prof = PROFILE_AT && ENGINE === "chromium" ? await p.ctx.newCDPSession(p.page) : null;
  if (prof && PROFILE_AT === "pass-through") { await prof.send("Profiler.enable"); await prof.send("Profiler.setSamplingInterval", { interval: 500 }); await prof.send("Profiler.start"); }
  // Through every other chat (more than the 12 a wide screen keeps), ending on A.
  await run("pass-through", [...CHATS.filter((n) => n !== A && n !== B), A]);
  if (prof && PROFILE_AT === "used-kept-B") { await prof.send("Profiler.enable"); await prof.send("Profiler.setSamplingInterval", { interval: 500 }); await prof.send("Profiler.start"); }
  if (prof && PROFILE_AT === "pass-through") {
    const { profile } = await prof.send("Profiler.stop");
    const self = new Map<string, number>(); const byId = new Map(profile.nodes.map((n: any) => [n.id, n]));
    const parent = new Map<number, number>(); for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const incl = new Map<string, number>();
    profile.samples.forEach((sid: number, i: number) => { const files = new Set<string>(); let x: number | undefined = sid;
      while (x !== undefined) { const u = (byId.get(x) as any).callFrame.url; if (u) files.add(u.split("/").pop()); x = parent.get(x); }
      for (const f of files) incl.set(f, (incl.get(f) ?? 0) + (profile.timeDeltas[i] ?? 0)); });
    console.log("PROFILE inclusive by file:\n" + [...incl].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${(v / 1000).toFixed(0)}ms ${k}`).join("\n"));
    const dt = profile.timeDeltas; const counts = new Map<number, number>();
    profile.samples.forEach((id: number, i: number) => counts.set(id, (counts.get(id) ?? 0) + (dt[i] ?? 0)));
    for (const [nid, us] of counts) { const n: any = byId.get(nid); const cf = n.callFrame; const key = `${cf.functionName || "(anon)"} ${cf.url.split("/").pop()}:${cf.lineNumber + 1}`; self.set(key, (self.get(key) ?? 0) + us); }
    const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${(v / 1000).toFixed(0)}ms ${k}`);
    console.log("PROFILE top self:\n" + top.join("\n"));
    writeFileSync(`${process.env.OUT ?? "."}/burst-profile.cpuprofile`, JSON.stringify(profile));
  }
  const aKept = await marked();
  const readsBefore = reads[B] ?? 0;
  await run("used-kept-B", [B]);
  if (prof && PROFILE_AT === "used-kept-B") { const { profile } = await prof.send("Profiler.stop"); writeFileSync(`${process.env.OUT ?? "."}/burst-profile.cpuprofile`, JSON.stringify(profile)); }
  const bKept = await marked();
  // Passing through five chats did not evict the two in use: each comes back as the same thread, with no read.
  const keptUsed = { markA, markB, aKept: aKept === A, bKept: bKept === B, bHistoryReadAgain: (reads[B] ?? 0) - readsBefore };
  const keptOk = keptUsed.aKept && keptUsed.bKept && keptUsed.bHistoryReadAgain === 0;
  if (!keptOk) failed = true;
  console.log(`${keptOk ? "ok  " : "FAIL"} ${ENGINE}${THROTTLE > 1 ? `-${THROTTLE}x` : ""}-${tag} used chats kept through the pass: ${JSON.stringify(keptUsed)}`);
  let effects: any = null;
  if (caseProf) {
    const { profile } = await caseProf.send("Profiler.stop");
    writeFileSync(`${process.env.OUT ?? "."}/case-${tag}${AMBIENT ? "-ambient" : ""}.cpuprofile`, JSON.stringify(profile));
    const byId = new Map(profile.nodes.map((n: any) => [n.id, n])), parent = new Map<number, number>();
    for (const n of profile.nodes) for (const ch of n.children ?? []) parent.set(ch, n.id);
    const EFFECTS = /^(effect-[\w-]+|app-effects|chat-effects|chat-ambient|owner-css|fx-[\w-]+)\.js$/;
    let fx = 0, busy = 0;
    profile.samples.forEach((sid: number, i: number) => {
      const dt = profile.timeDeltas[i] ?? 0; let x: number | undefined = sid, inFx = false, idle = false;
      const top = (byId.get(sid) as any).callFrame.functionName; if (top === "(idle)") idle = true;
      while (x !== undefined) { const u = (byId.get(x) as any).callFrame.url; if (u && EFFECTS.test(u.split("/").pop()!)) { inFx = true; break; } x = parent.get(x); }
      if (!idle) busy += dt; if (inFx) fx += dt;
    });
    effects = { clicks, effectsMs: Math.round(fx / 1000), busyMs: Math.round(busy / 1000), effectsPerClickMs: +(fx / 1000 / clicks).toFixed(1) };
    console.log(`effects ${ENGINE}-${tag}${AMBIENT ? "-ambient" : ""}: ${JSON.stringify(effects)}`);
  }
  const s = split(p.errors, nav);
  if (s.other.length) { failed = true; console.log(`FAIL ${ENGINE}-${tag}: page errors ${JSON.stringify(s.other).slice(0, 400)}`); }
  out.cases[tag] = { rows, keptUsed, effects, errors: s.other, accepted: s.accepted };
  await p.ctx.close();
}
const file = `${process.env.OUT ?? "."}/smoke-sidebar-burst-${ENGINE}${THROTTLE > 1 ? `-${THROTTLE}x` : ""}${AMBIENT ? "-ambient" : ""}.json`;
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`${failed ? "FAIL" : "PASS"} (${file})`);
await fx.browser.close();
process.exit(failed ? 1 : 0);
