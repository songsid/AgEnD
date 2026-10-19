// #2193 from defaults (fleet decision a78ebdc5): with no effects configured the effects runtime is never loaded, and
// each thing that needs it wakes it once. A fresh profile per case, signed in through the visible /signin; 14 chats of
// 120 messages (seedChat). Each wake case starts asleep (proved) on its own page, then changes one thing on the host:
//   none       — nothing configured: a burst of chat switches, status frames, a minute's idle; the runtime's module
//                (/ui/js/app-effects.js) is never fetched, no effect layer is in the page; Chromium: a CPU profile at
//                4× of the whole case has 0 ms in effects code;
//   placement  — an agent places a Canvas Worker effect in the open chat: the runtime wakes and the chat shows it
//                (a playing frame, or — where this host cannot play — the row's reason, #2121);
//   ambient    — an agent sets falling petals on a chat: they show (.amb-layer), and the runtime still sleeps
//                (ambient is host-drawn, never the runtime's);
//   try        — an agent offers a Try card: the card shows, the runtime wakes, and the card leaves "checking";
//   slot       — the person picks a personal effect (fx.page, through /ui/prefs as Settings saves it): the runtime wakes.
// Also: single episode — after a wake, a burst of switches through chats with placements loads the module once.
// No page error (WebKit's own lines only).
//   PW_DIR=… REPO=… OUT=… [PW_ENGINE=webkit] npx --prefix <checkout> tsx scripts/manual/smoke/smoke-effects-dormant.mts
import { writeFileSync } from "node:fs";
import { addSnowEffect, bootFixture, freshPage, mounted, seedChat, type FreshPage } from "../smoke-fixture/index.mts";
import { SNOW_EFFECT } from "../smoke-fixture/seed.mts";

const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const N = Number(process.env.N ?? 120);
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
const CANCEL = /^(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/ui\/(events|poll|history)(\?\S*)? due to access control checks\.$/;
// Chromium's console line for the effect bootstrap page's CSP (a directive this Chromium does not know; as on main
// whenever an effect plays): matched exactly, and only for /effect-bootstrap.
const FRAME_CSP = /^Unrecognized Content-Security-Policy directive 'webrtc'\. @ http:\/\/127\.0\.0\.1:\d+\/effect-bootstrap$/;
// WebKit logs the same line with no location ("\n @ ?").
const FRAME_CSP_WEBKIT = "Unrecognized Content-Security-Policy directive 'webrtc'.\n @ ?";
const other = (errors: string[]) => errors.filter((e) => { const t = e.replace(/ @ \S+$/, ""); return !(FRAME_CSP.test(e) || ENGINE === "webkit" && (e === FRAME_CSP_WEBKIT || WEBKIT_OWN.has(t) || CANCEL.test(t))); });

const fx = await bootFixture({ port: Number(process.env.HP ?? 48640), classic: false });
const fm = fx.fm;
const CHATS = fx.instances.filter((i: any) => i.status === "running" && !i.general).map((i: any) => i.name).slice(0, 14);
for (const name of Object.keys(fm.fleetConfig.instances)) if (!CHATS.includes(name)) delete fm.fleetConfig.instances[name];
await seedChat(fx, CHATS, N);
const emitStatus = () => { try { fm.emitSseEvent("status", fm.getUiStatus()); } catch { /* the next frame */ } };

/** What the page has of the runtime: its module fetched, effect layers, effect frames. */
const runtimeState = (page: any) => page.evaluate(`({
  loaded: performance.getEntriesByType("resource").some((e) => /\\/ui\\/js\\/app-effects\\.js(\\?|$)/.test(e.name)),
  loads: performance.getEntriesByType("resource").filter((e) => /\\/ui\\/js\\/app-effects\\.js(\\?|$)/.test(e.name)).length,
  layers: document.querySelectorAll(".agend-effect-layer").length,
  frames: document.querySelectorAll("iframe.agend-effect-frame").length,
})`);
// A function predicate: a string one is compiled in the page, and the dashboard's CSP refuses eval.
const until = async (page: any, fn: (arg?: any) => boolean, ms: number, arg: any = null) => { try { await page.waitForFunction(fn, arg, { timeout: ms, polling: 200 }); return true; } catch { return false; } };
const RUNTIME = () => performance.getEntriesByType("resource").some((e) => /\/ui\/js\/app-effects\.js(\?|$)/.test(e.name));
const go = async (page: any, name: string) => { await page.evaluate(`document.querySelector('a[href="/ui/chat/${encodeURIComponent(name)}"]').click()`); await page.waitForTimeout(250); };

async function open(chat: string): Promise<FreshPage> {
  const p = await freshPage(fx, { device: "desk", theme: "light", lang: "en" } as any);
  await p.page.goto(`${p.base}/ui/chat/${encodeURIComponent(chat)}`);
  await mounted(p.page, 60000);
  await p.page.waitForFunction((n: number) => document.querySelectorAll(".p-chat .msg").length >= n, Math.min(N, 24), { timeout: 60000 });
  await p.page.waitForTimeout(800);
  return p;
}
const results: any = { engine: ENGINE, cases: {} };
let failed = false;
const verdict = (name: string, ok: boolean, detail: any) => { results.cases[name] = { ok, ...detail }; if (!ok) failed = true; console.log(`${ok ? "ok  " : "FAIL"} ${ENGINE} ${name}: ${JSON.stringify(detail).slice(0, 400)}`); };

// ── none: nothing configured ──
{
  const p = await open(CHATS[0]);
  const cdp = ENGINE === "chromium" ? await p.ctx.newCDPSession(p.page) : null;
  if (cdp) { await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 }); await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 500 }); await cdp.send("Profiler.start"); }
  for (let r = 0; r < 2; r++) for (const n of CHATS.slice(1)) await go(p.page, n);
  for (let i = 0; i < 10; i++) { emitStatus(); await p.page.waitForTimeout(300); }
  await p.page.mouse.move(400, 300); await p.page.mouse.move(600, 400);
  let effectsMs: number | null = null;
  if (cdp) {
    const { profile } = await cdp.send("Profiler.stop");
    const byId = new Map(profile.nodes.map((n: any) => [n.id, n])), parent = new Map<number, number>();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const FX = /^(effect-[\w-]+|app-effects|chat-effects|chat-effect-posters|owner-css|effects-waker)\.js$/;
    let us = 0;
    profile.samples.forEach((sid: number, i: number) => { let x: number | undefined = sid; while (x !== undefined) { const u = (byId.get(x) as any).callFrame.url; if (u && FX.test(u.split("/").pop())) { us += profile.timeDeltas[i] ?? 0; break; } x = parent.get(x); } });
    effectsMs = Math.round(us / 1000);
  }
  const st = await runtimeState(p.page);
  // owner-css and the waker are still on the page (owner CSS is not the runtime's; the waker is the watch): their whole
  // share is reported; the runtime's own files must be absent.
  verdict("none", !st.loaded && st.layers === 0 && st.frames === 0 && other(p.errors).length === 0, { ...st, effectsMsAt4x: effectsMs, switches: 2 * (CHATS.length - 1), errors: other(p.errors) });
  await p.ctx.close();
}

// ── ambient: host-drawn, the runtime stays asleep ──
{
  const p = await open(CHATS[1]);
  const before = await runtimeState(p.page);
  const r = fm.webAppearance.handleTool(CHATS[2], "set_web_ambient", { preset: "fall", glyphs: ["🌸", "❀", "✿"] });
  emitStatus();
  await go(p.page, CHATS[2]);
  const shown = await until(p.page, () => { const l = document.querySelector(".p-chat .amb-layer"); return !!l && l.children.length > 0; }, 15000);
  const after = await runtimeState(p.page);
  verdict("ambient", r?.kind === "loop" && !before.loaded && shown && !after.loaded && other(p.errors).length === 0, { set: r?.kind, before, shown, after, errors: other(p.errors) });
  await p.ctx.close();
}

// ── placement: a Canvas Worker effect placed in the open chat ──
const effect = addSnowEffect(fx, { kind: "agent", id: CHATS[3] });
{
  const p = await open(CHATS[3]);
  const before = await runtimeState(p.page);
  const t0 = Date.now();
  const applied = fm.effectTools.apply(CHATS[3], { id: effect });
  emitStatus();
  const woke = await until(p.page, RUNTIME, 15000); const wokeMs = Date.now() - t0;
  const frame = await until(p.page, () => document.querySelectorAll("iframe.agend-effect-frame").length > 0, 20000); const frameMs = Date.now() - t0;
  const notice = await p.page.evaluate(`[...document.querySelectorAll(".chat-fx-notice")].map((n) => n.textContent.replace(/\\s+/g, " ").trim()).join(" | ")`);
  const after = await runtimeState(p.page);
  // Single episode: through every chat with placements and back, quickly.
  for (const n of CHATS.slice(3, 9)) { if (n !== CHATS[3]) fm.effectTools.apply(n, { id: addSnowEffect(fx, { kind: "agent", id: n }) }); }
  emitStatus();
  for (let r = 0; r < 3; r++) for (const n of CHATS.slice(3, 9)) await go(p.page, n);
  const end = await runtimeState(p.page);
  verdict("placement", !!applied && !applied.error && !before.loaded && woke && (frame || notice.length > 0) && end.loads === 1 && other(p.errors).length === 0,
    { applied: JSON.stringify(applied).slice(0, 120), before, wokeMs, frame, frameMs, notice: notice.slice(0, 200), after, singleEpisode: end, errors: other(p.errors) });
  await p.ctx.close();
}

// ── try: an agent offers a Try card ──
{
  const p = await open(CHATS[10]);
  const before = await runtimeState(p.page);
  const tryEffect = addSnowEffect(fx, { kind: "agent", id: CHATS[10] });
  const offered = await fm.effectTools.preview(CHATS[10], { id: tryEffect });
  const tc = Date.now(); const card = await until(p.page, () => !!document.querySelector(".p-chat .effect-trial-offer"), 15000); const cardMs = Date.now() - tc;
  const woke = await until(p.page, RUNTIME, 15000);
  await p.page.waitForTimeout(1500);
  const text = await p.page.evaluate(`(document.querySelector(".p-chat .effect-trial-offer") || {}).textContent || ""`);
  verdict("try", offered?.status === "offered" && !before.loaded && card && woke && !/checking|確認中/i.test(text) && other(p.errors).length === 0, { offered: offered?.status ?? offered, before, card, cardMs, woke, text: text.slice(0, 160), errors: other(p.errors) });
  await p.ctx.close();
}

// ── slot: a personal effect chosen (as Settings saves it) ──
{
  const p = await open(CHATS[11]);
  const before = await runtimeState(p.page);
  // The snow effect as a personal page effect (the fixture's declares the chat region only), the person's own.
  const files = new Map<string, Uint8Array>([["effect.json", Buffer.from(JSON.stringify({ ...SNOW_EFFECT.manifest, name: "fixture-snow-page", regions: ["chat", "page"] }))], ["worker.js", Buffer.from(SNOW_EFFECT.worker)]]);
  const st = fm.effectLibrary.stage(files, { kind: "human", id: p.personKey }); const own = st.ok ? fm.effectLibrary.commit(st.stageId).ids?.[0] : null;
  const epoch = await p.page.evaluate(`(() => { try { return JSON.parse(document.documentElement.getAttribute("data-prefs") || "{}").ownerEpoch ?? null; } catch { return null; } })()`);
  const saved = await p.page.evaluate(`fetch("/ui/prefs", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ set: { "fx.page": ${JSON.stringify(own)} }, ownerEpoch: ${JSON.stringify(epoch)} }) }).then(async (r) => r.status === 200 ? 200 : r.status + " " + (await r.text()).slice(0, 160))`);
  emitStatus();
  const woke = await until(p.page, RUNTIME, 20000);
  const seen = await p.page.evaluate(`Promise.all([import("/assets/app-prefs.js").then((m) => m.ownerEffectsChosen()), import("/assets/app-store.js").then((m) => m.appStore.get().prefsRev), fetch("/ui/prefs", { credentials: "same-origin" }).then((r) => r.json()).then((b) => Object.keys(b.values || {}).join(","))])`);
  verdict("slot", saved === 200 && !before.loaded && woke && other(p.errors).length === 0, { saved, epoch: !!epoch, before, woke, pageSees: seen, errors: other(p.errors) });
  await p.ctx.close();
}

writeFileSync(`${process.env.OUT ?? "."}/smoke-effects-dormant-${ENGINE}.json`, JSON.stringify(results, null, 1));
console.log(`${failed ? "FAIL" : "PASS"} (${process.env.OUT ?? "."}/smoke-effects-dormant-${ENGINE}.json)`);
await fx.browser.close();
process.exit(failed ? 1 : 0);
