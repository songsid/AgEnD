// #2184 from defaults (fleet decision a78ebdc5): no text moves after a chat switch. A fresh profile with nothing seeded
// signs in through the visible /signin; 14 chats of 200 messages each (seedChat: zh-TW and English, long Markdown, code,
// tables, served photos; demo names only), two of them themed (a full theme with a mono font and a background picture;
// a system font). Per switch — a click on the chat's sidebar row — every animation frame for 1.5 s records the box of
// every message on screen, keyed by element: one seen in two consecutive frames that moved (x, y, width or height, by
// more than EPS = 0.01 px) is a shift. Switches: first visits (cold), a revisit of a kept chat, and a revisit of one let
// go (evicted: 13 others shown since, more than the 12 a wide screen keeps; 6 on a phone). Cases: desk light (English;
// a LAN origin in Chromium) and phone dark (zh-TW, reduced motion). Judged: no shift on any switch, and no page error.
// PW_SCROLLBARS=1 (Chromium): classic scrollbars that take width, as on Windows. MEM=1 (Chromium): instead, the memory
// with every chat shown once (12 kept on a wide screen, 6 on a phone), CPU throttled 4×: JS heap after a GC, DOM nodes
// (all, kept threads included: DevTools' counters) and documents — printed, not judged.
//   PW_DIR=… REPO=… OUT=… [PW_SCROLLBARS=1] [MEM=1] [PW_ENGINE=webkit] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-switch-jitter.mts
//   (WebKit: the in-Docker recipe in smoke-emoji-tofu.mts's header)
import { writeFileSync } from "node:fs";
import { bootFixture, freshPage, mounted, seedChat, type FreshPage } from "../smoke-fixture/index.mts";

const N = Number(process.env.N ?? 200), EPS = Number(process.env.EPS ?? 0.01), WINDOW_MS = Number(process.env.WINDOW_MS ?? 1500);
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const MEM = process.env.MEM === "1" && ENGINE === "chromium";
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
// The smoke's own navigation (to the first chat) cancels the stream and a poll it opened: WebKit logs those. Accepted
// only by position, inside that navigation's window, and only for /ui/events and /ui/poll (as #2053's smoke).
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

const fx = await bootFixture({ port: Number(process.env.HP ?? 48590), classic: false });
const fm = fx.fm;
const CHATS = fx.instances.filter((i: any) => i.status === "running" && !i.general).map((i: any) => i.name).slice(0, 14);
for (const name of Object.keys(fm.fleetConfig.instances)) if (!CHATS.includes(name)) delete fm.fleetConfig.instances[name];
await seedChat(fx, CHATS, N);
const BG = fm.themeStore.addAsset(CHATS[3], "background", await fx.picture({ w: 800, h: 500, hue: 230, label: "", mime: "image/jpeg", seed: 3 }));
fx.seedTheme(CHATS[3], { v: 1, accent: "#8b5cf6", colors: { dark: { bg: "#101018" }, light: { bg: "#f6f2ff" } }, bubble: { radius: 6, border: "accent" },
  font: "mono", background: { image: BG.id, fit: "cover", opacity: 0.3 } });
fx.seedTheme(CHATS[5], { v: 1, accent: "#0ea5e9", font: "system" });

/** Click `to`'s sidebar row; then every frame for WINDOW_MS: each on-screen message's box, and what moved. */
const probe = (page: any, to: string) => page.evaluate(`new Promise((resolve) => {
  const to = ${JSON.stringify(to)}, EPS = ${EPS};
  const ids = new WeakMap(); let next = 0; const id = (n) => { if (!ids.has(n)) ids.set(n, ++next); return ids.get(n); };
  const els = new Map();
  const what = (k) => { const m = els.get(k); return m ? { cls: m.className, imgs: [...m.querySelectorAll("img")].map((i) => [i.complete, i.getAttribute("width"), i.getAttribute("height")]), text: (m.textContent || "").slice(0, 50) } : null; };
  const t0 = performance.now(); let prev = null; const shifts = []; let frames = 0, firstMine = null;
  const ls = []; let po = null;
  try { po = new PerformanceObserver((l) => { for (const e of l.getEntries()) ls.push([Math.round(e.startTime - t0), +e.value.toFixed(4)]); }); po.observe({ type: "layout-shift" }); } catch {}
  const sample = () => {
    const t = Math.round(performance.now() - t0); frames++;
    const sc = document.querySelector(".p-chat .scroller");
    const mine = !!sc && [...document.querySelectorAll(".p-chat .msg.agent .sender")].some((e) => e.textContent === to);
    if (mine && firstMine === null) firstMine = t;
    const cur = new Map();
    if (mine) { const v = sc.getBoundingClientRect();
      for (const m of sc.querySelectorAll(".msg")) { const r = m.getBoundingClientRect(); if (r.bottom < v.top || r.top > v.bottom) continue;
        cur.set(id(m), [r.x, r.y, r.width, r.height]); els.set(id(m), m); } }
    if (prev && prev.mine && mine) { const moved = [];
      for (const [k, b] of cur) { const a = prev.boxes.get(k); if (!a) continue; const d = b.map((x, i) => +(x - a[i]).toFixed(3)); if (d.some((x) => Math.abs(x) > EPS)) moved.push([k, ...d]); }
      if (moved.length) shifts.push({ t, moved: moved.length, first: moved.slice(0, 3), grew: moved.filter((m) => Math.abs(m[4]) > EPS).slice(0, 2).map((m) => [m[4], what(m[0])]),
        top: Math.round(sc.scrollTop), prevTop: prev.top, sh: sc.scrollHeight, prevSh: prev.sh, cw: sc.clientWidth, prevCw: prev.cw }); }
    prev = { mine, top: sc ? Math.round(sc.scrollTop) : null, sh: sc ? sc.scrollHeight : null, cw: sc ? sc.clientWidth : null, boxes: cur };
    if (t < ${WINDOW_MS}) requestAnimationFrame(sample);
    else { po && po.disconnect(); const cs = sc && sc.querySelector(".msg") ? getComputedStyle(sc.querySelector(".msg")) : null;
      resolve({ to, shifts, frames, firstMine, ls, font: cs ? cs.fontFamily.slice(0, 40) : null, onScreen: cur.size }); }
  };
  const link = document.querySelector('a[href="/ui/chat/' + encodeURIComponent(to) + '"]') || document.querySelector('a[href="/ui/chat/' + to + '"]');
  if (!link) return resolve({ to, missing: true });
  link.click(); requestAnimationFrame(sample);
})`);

const out: any = { engine: ENGINE, scrollbars: process.env.PW_SCROLLBARS === "1", eps: EPS, chats: CHATS.length, n: N, cases: {} };
let failed = false;
const CASES = [["desk-light-en", { device: "desk", theme: "light", lang: "en" }, { origin: ENGINE === "chromium" ? "lan" : undefined }],
  ["phone-dark-zh", { device: "phone", theme: "dark", lang: "zh-TW" }, { reducedMotion: true }]] as const;
for (const [tag, c, o] of CASES) {
  if (process.env.ONLY && !tag.startsWith(process.env.ONLY)) continue;
  const p: FreshPage = await freshPage(fx, c as any, o as any);
  const cdp = ENGINE === "chromium" ? await p.ctx.newCDPSession(p.page) : null;
  if (cdp && MEM) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  const navFrom = p.errors.length;
  await p.page.goto(`${p.base}/ui/chat/${encodeURIComponent(CHATS[0])}`);
  await mounted(p.page, 30000);
  await p.page.waitForFunction((n: number) => document.querySelectorAll(".p-chat .msg").length >= n, N, { timeout: 60000 });
  await p.page.waitForTimeout(1500);
  const nav: [number, number] = [navFrom, p.errors.length];
  // The phone's sidebar is a drawer: its rows are in the DOM; a DOM click switches as a tap on a visible row would.
  if (MEM) {
    const memory = async (label: string) => {
      await cdp!.send("HeapProfiler.collectGarbage");
      const heap = await cdp!.send("Runtime.getHeapUsage"), dom = await cdp!.send("Memory.getDOMCounters");
      const row = { label, heapMB: +(heap.usedSize / 1048576).toFixed(1), nodes: dom.nodes, documents: dom.documents, listeners: dom.jsEventListeners };
      console.log(`${tag} ${JSON.stringify(row)}`); return row;
    };
    const rows = [await memory("one chat")];
    for (const to of CHATS.slice(1)) { await probe(p.page, to); await p.page.waitForFunction((n: number) => document.querySelectorAll(".p-chat .msg").length >= n, N, { timeout: 60000 }); await p.page.waitForTimeout(300); }
    rows.push(await memory(`${CHATS.length} chats shown`));
    out.cases[tag] = { memory: rows };
    await p.ctx.close();
    continue;
  }
  const rows: any[] = [];
  const go = async (to: string, kind: string) => {
    const r = await probe(p.page, to);
    await p.page.waitForFunction((n: number) => document.querySelectorAll(".p-chat .msg").length >= n, N, { timeout: 60000 }).catch(() => {});
    await p.page.waitForTimeout(500);
    rows.push({ kind, ...r });
    const bad = r.missing || r.firstMine === null || r.shifts.length > 0;
    if (bad) failed = true;
    console.log(`${bad ? "FAIL" : "ok  "} ${ENGINE}-${tag} ${kind} ${to}: ${r.missing ? "no sidebar row" : `${r.shifts.length} frames with a shift (of ${r.frames}), ${r.onScreen} on screen, font ${r.font}`}${r.shifts?.length ? " " + JSON.stringify(r.shifts.slice(0, 2)).slice(0, 600) : ""}`);
  };
  const keep = c.device === "phone" ? 6 : 12;
  for (const to of CHATS.slice(1)) await go(to, "cold");
  await go(CHATS[CHATS.length - 2], "kept");
  await go(CHATS[0], CHATS.length - 1 > keep ? "evicted" : "kept");
  const s = split(p.errors, nav);
  if (s.other.length) { failed = true; console.log(`FAIL ${ENGINE}-${tag}: page errors ${JSON.stringify(s.other).slice(0, 400)}`); }
  out.cases[tag] = { rows, errors: s.other, webkitOwn: s.accepted };
  await p.ctx.close();
}
const file = `${process.env.OUT ?? "."}/smoke-switch-jitter-${ENGINE}${out.scrollbars ? "-sb" : ""}${MEM ? "-mem" : ""}.json`;
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(MEM ? `memory written: ${file}` : `${failed ? "FAIL" : "PASS"} (${file})`);
await fx.browser.close();
process.exit(failed ? 1 : 0);
