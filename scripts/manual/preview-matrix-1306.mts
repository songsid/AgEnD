// #1306 §10.2: the recorded browser run, as a script. NOT part of the test suite (CI has no browser).
// Re-run it to fill in a browser/mode of docs/design/1306-browser-acceptance.md:
//
//   npm i --no-save --prefix /tmp/pw playwright-core
//   PW_DIR=/tmp/pw REPO=$PWD OUT=/tmp/run.json MODE=loopback|origin CHROME=/path/to/chrome npx tsx scripts/manual/preview-matrix-1306.mts
//
// It runs the real /ui and /frame from an in-process FleetManager in a scratch AGEND_HOME on fixed ports
// (47380/47381, or 47390/47391 for MODE=origin) — no fleet, no CLI, no tmux, and no instance is ever started.
// MODE=origin maps preview.test → 127.0.0.1 with Chromium's --host-resolver-rules.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(process.env.PW_DIR + "/");
const { chromium } = require("playwright-core");
const MODE = process.env.MODE === "origin" ? "origin" : "loopback";
const HP = MODE === "origin" ? 47390 : 47380, PP = HP + 1;
const dir = mkdtempSync(join(tmpdir(), `s1306-${MODE}-`));
process.env.AGEND_HOME = dir;
writeFileSync(join(dir, "fleet.yaml"), `health_port: ${HP}\ninstances:\n  w:\n    working_directory: ${dir}\n    backend: claude-code\nweb:\n  preview_port: ${PP}\n` + (MODE === "origin" ? `  preview_origin: http://preview.test:${PP}\n` : ""));
const { FleetManager } = await import(process.env.REPO + "/src/fleet-manager.ts");
const fm: any = new FleetManager(dir);
const q = () => {}; fm.logger = { info: q, warn: q, error: q, debug: q, trace: q, fatal: q, child: () => fm.logger };
fm.notifyFleetError = () => true;
fm.loadConfig(join(dir, "fleet.yaml"));
fm.lifecycle = { isPaused: () => false, hasWorkLease: () => false, daemons: new Map() };
fm.deliverToInstance = async () => true;
fm.initializeWebAuthTokens(); fm.startHealthServer(HP);
const t0 = Date.now(); while (!fm.previewListening && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 50));
// Every request either listener receives, so "nothing was sent" is checked where it would arrive.
const dashLog: string[] = [], prevLog: string[] = [];
fm.healthServer.prependListener("request", (req: any) => dashLog.push(`${req.method} ${req.url}`));
fm.previewListener.server.prependListener("request", (req: any) => prevLog.push(`${req.method} ${req.url}`));
const base = `http://127.0.0.1:${HP}`;
const EXE = process.env.CHROME ?? process.env.HOME + "/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox", "--host-resolver-rules=MAP preview.test 127.0.0.1"] });
const version = browser.version();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.addInitScript(() => document.addEventListener("securitypolicyviolation", (e: any) => console.error("CSP violation: " + e.violatedDirective + " " + e.blockedURI + " @" + location.origin)));
const page = await ctx.newPage();
const dialogs: string[] = [], violations: string[] = [], popups: string[] = [];
page.on("dialog", (d: any) => { dialogs.push(d.type() + ":" + d.message().slice(0, 40)); d.accept(); });
page.on("console", (m: any) => { if (/CSP violation/.test(m.text())) violations.push(m.text().slice(0, 160)); });
ctx.on("page", (p: any) => popups.push(p.url()));
// Every request the browser issues, from any frame: a blocked navigation is never issued.
const browserRequests: string[] = [];
ctx.on("request", (r: any) => browserRequests.push(r.url()));
await page.goto(`${base}/signin`); await page.waitForSelector("#code");
await page.fill("#code", fm.issueDashboardLogin().display); await page.click("#go"); await page.waitForURL(`${base}/ui`);
await page.click('.instance-item[data-n="w"]');
await page.click("#previewOptIn");                       // accepts the confirm (one explicit per-device opt-in)
const rows: Array<{ row: string; expected: string; result: string; pass: boolean | null; notes?: string }> = [];
const rec = (row: string, expected: string, result: string, pass: boolean | null, notes?: string) => rows.push({ row, expected, result, pass, ...(notes ? { notes } : {}) });
const OUT = process.env.OUT!;
const flush = () => writeFileSync(OUT, JSON.stringify({ mode: MODE, browser: `Chrome for Testing ${version}`, os: "Linux (WSL2)", dashboard: base, rows }, null, 1));
setInterval(flush, 1000).unref();

let seq = 0;
async function preview(html: string, pg: any = page, waitMs = 5000) {
  const page_ = pg;
  const had = Number(await page_.evaluate(`document.querySelectorAll(".html-card .pv-run").length`));
  fm.emitSseEvent("message", { instance: "w", sender: "w", role: "agent", text: "```html\n" + html + "\n```", ts: new Date().toISOString() });
  const n = ++seq;
  // (polled: waitForFunction(string) would eval in the page, which the dashboard's CSP refuses)
  for (let i = 0; i < 50 && Number(await page_.evaluate(`document.querySelectorAll(".html-card .pv-run").length`)) <= had; i++) await page_.waitForTimeout(100);
  await page_.evaluate(`[...document.querySelectorAll(".html-card .pv-run")].at(-1).click()`);
  for (let i = 0; i < waitMs / 100; i++) {
    const f = page_.frames().find((x: any) => x.url().endsWith("/frame") && x !== page_.mainFrame());
    if (f) { try { if (await f.evaluate("!!document.getElementById('ok')")) return f; } catch { /* navigating */ } }
    await page_.waitForTimeout(100);
  }
  throw new Error("no preview frame");
}
const sleep = (ms: number) => page.waitForTimeout(ms);
const frameNow = () => page.frames().find((x: any) => x !== page.mainFrame());

// The run's own page: one element to say it rendered.
const BASE_HTML = "<p id=ok>rendered</p>";
let f = await preview(BASE_HTML);
const ev = (expr: string) => f.evaluate(expr);
/** A JS string literal for an evaluated expression: JSON, with `<`, `>`, U+2028 and U+2029 escaped too. */
const lit = (v: unknown) => JSON.stringify(v).replace(/[<>\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const quiet = async (fn: () => Promise<unknown>) => { const before = dashLog.length; await fn(); await sleep(400); return dashLog.slice(before).filter(l => !/^GET \/ui\/(events|poll)/.test(l)); };

// ── G1: the account boundary ──
rec("document.cookie", "throws SecurityError or \"\"; never the session", String(await ev(`(() => { try { return "value:" + JSON.stringify(document.cookie); } catch (e) { return "throws " + e.name; } })()`)), null);
rows.at(-1)!.pass = /throws SecurityError|value:""/.test(rows.at(-1)!.result);
const parentDoc = await ev(`(() => { try { return "read " + typeof parent.document.body; } catch (e) { return "throws " + e.name; } })()`);
rec("parent.document", "throws", String(parentDoc), /throws/.test(String(parentDoc)));
const topHref = await ev(`(() => { try { return "read " + top.location.href; } catch (e) { return "throws " + e.name; } })()`);
rec("top.location.href (read)", "throws", String(topHref), /throws/.test(String(topHref)));
await ev(`(() => { try { top.location = "https://example.org/"; } catch (e) {} })()`); await sleep(600);
rec("top.location = … (write)", "blocked (dashboard stays)", page.url(), page.url() === `${base}/ui`);
let sent = await quiet(() => ev(`fetch(${lit(base + "/ui/send")}, { method: "POST", body: "{}" }).then(r => "status " + r.status, e => "rejected " + e.name)`).then((x: string) => rows.push({ row: "fetch(\"/ui/send\", POST) to the dashboard", expected: "blocked by CSP", result: x, pass: /rejected/.test(x) })));
rows.at(-1)!.notes = `dashboard received: ${lit(sent)}`; if (sent.length) rows.at(-1)!.pass = false;

// ── Best-effort network restrictions (recorded; none of these is a promise) ──
const prevOrigin = MODE === "origin" ? `http://preview.test:${PP}` : `http://127.0.0.1:${PP}`;
const pre = prevLog.length;
for (const [row, expr] of [
  ["fetch to the preview origin", `fetch(${lit(prevOrigin + "/frame?probe")}).then(r => "status " + r.status, e => "rejected " + e.name)`],
  ["navigator.sendBeacon to the dashboard", `(() => { try { return "returned " + navigator.sendBeacon(${lit(base + "/ui/send")}, "x"); } catch (e) { return "throws " + e.name; } })()`],
  ["new WebSocket to the dashboard", `new Promise(r => { try { const w = new WebSocket(${lit(base.replace("http", "ws") + "/ui/events")}); w.onerror = () => r("error event"); w.onopen = () => r("OPEN"); setTimeout(() => r("no open in 1.5s"), 1500); } catch (e) { r("throws " + e.name); } })`],
  ["new EventSource to the dashboard", `new Promise(r => { try { const s = new EventSource(${lit(base + "/ui/events")}); s.onerror = () => { s.close(); r("error event"); }; s.onopen = () => r("OPEN"); setTimeout(() => r("no open in 1.5s"), 1500); } catch (e) { r("throws " + e.name); } })`],
  ["<img src> to the dashboard", `new Promise(r => { const i = new Image(); i.onload = () => r("LOADED"); i.onerror = () => r("error event"); i.src = ${lit(base + "/health?img")}; setTimeout(() => r("no load in 1.5s"), 1500); })`],
  ["CSS url() to the dashboard", `new Promise(r => { const d = document.createElement("div"); d.style.backgroundImage = ${lit(`url(${base}/health?css)`)}; d.textContent = "x"; document.body.append(d); getComputedStyle(d).backgroundImage; setTimeout(() => r("styled; requests checked server-side"), 1200); })`],
  ["<link rel=prefetch> to the dashboard", `new Promise(r => { const l = document.createElement("link"); l.rel = "prefetch"; l.href = ${lit(base + "/health?prefetch")}; l.onload = () => r("LOADED"); l.onerror = () => r("error event"); document.head.append(l); setTimeout(() => r("no load in 1.5s"), 1500); })`],
  ["form submit to the dashboard", `new Promise(r => { const fm = document.createElement("form"); fm.method = "POST"; fm.action = ${lit(base + "/ui/send")}; document.body.append(fm); try { fm.submit(); r("submitted (sandbox decides)"); } catch (e) { r("throws " + e.name); } })`],
  ["window.open", `(() => { try { return "returned " + window.open("https://example.org/"); } catch (e) { return "throws " + e.name; } })()`],
  ["alert", `(() => { try { alert("x"); return "returned"; } catch (e) { return "throws " + e.name; } })()`],
] as Array<[string, string]>) {
  const got = await quiet(async () => { const r = await ev(expr).catch((e: Error) => "harness: " + e.message.split("\n")[0]); rows.push({ row, expected: "blocked / nothing sent", result: String(r), pass: null }); });
  const last = rows.at(-1)!;
  last.notes = `dashboard received: ${lit(got)}`;
  last.pass = got.length === 0 && !/OPEN|LOADED/.test(last.result);
}
await sleep(500);
rows.find(r => r.row === "fetch to the preview origin")!.notes += `; preview listener received: ${lit(prevLog.slice(pre))}`;
rows.find(r => r.row === "fetch to the preview origin")!.pass = !prevLog.slice(pre).some(l => l.includes("probe")) && rows.find(r => r.row === "fetch to the preview origin")!.pass!;
rows.find(r => r.row === "window.open")!.pass &&= popups.length === 0;
rows.find(r => r.row === "alert")!.pass &&= dialogs.filter(d => d.startsWith("alert")).length === 0;

// ── Self-navigation of the frame ──
async function nav(row: string, expr: string, expectStays = true, target = "") {
  f = await preview(BASE_HTML);
  const prevBefore = prevLog.length, reqBefore = browserRequests.length;
  await f.evaluate(expr).catch(() => {});
  await sleep(1200);
  const fr = frameNow();
  const url = fr ? fr.url() : "(frame gone)";
  const stillOk = fr ? await fr.evaluate("!!document.getElementById('ok')").catch(() => false) : false;
  const issued = browserRequests.slice(reqBefore).filter(u => !/\/ui\/(events|poll)/.test(u));
  const reached = target ? issued.filter(u => u.startsWith(target)) : [];
  const loaded = /^(https?:\/\/example\.org|data:|blob:)/.test(url) || (/\/other$/.test(url));
  // Blocked = the target is never requested and never becomes the frame's document. Chromium shows its error page
  // (chrome-error://chromewebdata) in the frame instead of keeping the shim — the content is gone either way.
  rows.push({ row, expected: expectStays ? "blocked: the target never loads" : "allowed by frame-src (path match): reaches only the preview listener",
    result: `frame at ${url}; original content ${stillOk ? "still there" : "gone"}`,
    pass: expectStays ? (!loaded && reached.length === 0 && prevLog.length === prevBefore) : /\/frame\?x$/.test(url),
    notes: `requests issued: ${lit(issued)}; preview listener received: ${lit(prevLog.slice(prevBefore))}` });
}
await nav("self-navigation: location = \"https://example.org/?x\"", `location = "https://example.org/?x"`, true, "https://example.org");
await nav("self-navigation: <meta http-equiv=refresh>", `(() => { const m = document.createElement("meta"); m.httpEquiv = "refresh"; m.content = "0;url=https://example.org/"; document.head.append(m); })()`, true, "https://example.org");
await nav("self-navigation: link click", `(() => { const a = document.createElement("a"); a.href = "https://example.org/"; document.body.append(a); a.click(); })()`, true, "https://example.org");
await nav("self-navigation: location = \"data:…\"", `location = "data:text/html,<p>x</p>"`);
await nav("self-navigation: location = \"blob:…\"", `location = URL.createObjectURL(new Blob(["<p>x</p>"], { type: "text/html" }))`);
await nav("self-navigation: location = \"javascript:…\"", `location = "javascript:document.body.innerHTML='replaced'"`);
await nav("self-navigation: location = \"/other\"", `location = "/other"`);
await nav("self-navigation: location = \"/frame?x\" (the known bypass)", `location = "/frame?x"`, false);

// ── WebRTC (documentation of why there is no probe gate) ──
f = await preview(BASE_HTML);
const rtc = await f.evaluate(`({ RTCPeerConnection: typeof RTCPeerConnection, webkitRTCPeerConnection: typeof webkitRTCPeerConnection, RTCDataChannel: typeof RTCDataChannel, nestedFrame: (() => { try { const i = document.createElement("iframe"); i.src = "about:blank"; document.body.append(i); return "created; contentWindow.RTCPeerConnection: " + typeof (i.contentWindow && i.contentWindow.RTCPeerConnection); } catch (e) { return "throws " + e.name; } })() })`);
rec("WebRTC entry points in the preview's realm", "removed by the shim (defence in depth only — not a block)", JSON.stringify(rtc), null,
  "A nested about:blank frame is same-origin with the preview and inherits its sandbox; whether it exposes a fresh RTCPeerConnection is recorded here. The design makes no no-network claim either way (§4.3); STUN/TURN to a loopback relay and the RFC 8828 mode 3/4 cases were not exercised in this run.");

// ── The watchdog: a frame that stops sending heartbeats is closed (when the parent stays responsive) ──
f = await preview(BASE_HTML);
await f.evaluate(`(() => { const id = setInterval(() => {}, 1e9); for (let i = 0; i <= id; i++) { clearInterval(i); clearTimeout(i); } })()`);
const wdStart = Date.now();
let closed = false;
while (Date.now() - wdStart < 14000) { if ((await page.evaluate(`document.querySelectorAll(".preview-frame").length`)) === 0) { closed = true; break; } await sleep(250); }
rec("watchdog: heartbeats stop", "frame closed after ~10 s (best effort)", closed ? `closed after ${Math.round((Date.now() - wdStart) / 100) / 10} s` : "still open after 14 s", closed);

// ── Busy loop and memory (§8: recorded, residual risk accepted) ──
async function responsiveness(label: string, html: string) {
  // Its own tab: a frozen renderer cannot be recovered from inside, and the rest of the run must not depend on it.
  const tab = await ctx.newPage();
  tab.on("dialog", (d: any) => d.accept());
  const withTimeout = <T,>(p: Promise<T>, ms: number, what: string): Promise<T | string> => Promise.race([p, new Promise<string>(r => setTimeout(() => r(`${what}: no answer in ${ms} ms`), ms))]);
  try {
    await tab.goto(`${base}/ui`); await tab.waitForSelector(".topbar");
    await tab.click('.instance-item[data-n="w"]');
    await tab.waitForTimeout(800);   // the chat's history has arrived
    const fr = await preview(BASE_HTML + html, tab);
    await tab.evaluate(`window.__ticks = []; window.__tick = setInterval(() => window.__ticks.push(performance.now()), 100)`);
    await fr.evaluate(`setTimeout(() => window.__go && window.__go(), 300)`).catch(() => {});
    await new Promise(r => setTimeout(r, 1800));
    const t = Date.now();
    const click = await withTimeout(tab.evaluate(`(() => { const b = [...document.querySelectorAll(".pv-stop")].find(x => !x.hidden); if (b) b.click(); return b ? "clicked" : "no running card"; })()`), 3000, "Stop");
    const clickNote = click === "clicked" ? `Stop clicked ${Date.now() - t} ms after asking` : String(click);
    const gaps = await withTimeout(tab.evaluate(`(() => { clearInterval(window.__tick); const t = window.__ticks; let g = 0; for (let i = 1; i < t.length; i++) g = Math.max(g, t[i] - t[i - 1]); return JSON.stringify({ ticks: t.length, maxGapMs: Math.round(g) }); })()`), 3000, "parent timer");
    const left = await withTimeout(tab.evaluate(`String(document.querySelectorAll(".preview-frame").length)`), 2000, "frames");
    rec(label, "recorded: does the parent's Stop and its timers respond within 1 s?", `${clickNote}; parent timer ${gaps}; frames left ${left}`, null);
  } catch (e) {
    rec(label, "recorded", "harness: " + (e as Error).message.split("\n")[0], null);
  }
  await withTimeout(tab.close({ runBeforeUnload: false }), 5000, "close").catch(() => {});
}
await responsiveness("busy loop in the preview", "<script>window.__go = () => { for (;;) {} };</script>");
// After a busy preview is stopped: does the next one render, and when? (Removing a frame does not stop its spinning
// process; previews of the same origin share it.)
{
  const t = Date.now();
  try {
    await preview(BASE_HTML, page, 60000);
    rec("a new preview after a busy one was stopped", "recorded", `rendered after ${Math.round((Date.now() - t) / 100) / 10} s`, null);
  } catch {
    // Does reloading the tab clear it?
    let after = "";
    try {
      await page.reload(); await page.waitForSelector(".topbar"); await page.click('.instance-item[data-n="w"]'); await page.waitForTimeout(800);
      const t2 = Date.now();
      await preview(BASE_HTML, page, 30000);
      after = `after reloading the tab, a preview rendered in ${Math.round((Date.now() - t2) / 100) / 10} s`;
    } catch { after = "a reload of the tab did not clear it within 30 s"; }
    rec("a new preview after a busy one was stopped", "recorded", `did not render within 60 s in the same tab (the stopped preview's renderer process keeps spinning); ${after}`, null);
  }
  await page.evaluate(`[...document.querySelectorAll(".pv-stop")].filter(x => !x.hidden).forEach(b => b.click())`).catch(() => {});
}
await responsiveness("memory growth in the preview", "<script>window.__go = () => { const keep = []; setInterval(() => { for (let i = 0; i < 40; i++) keep.push(new Array(1e6).fill(i)); }, 50); };</script>");

const g1 = rows.slice(0, 5);
flush();
console.log(JSON.stringify({ mode: MODE, browser: `Chrome for Testing ${version}`, os: "Linux (WSL2) " + process.platform, dashboard: base, preview: prevOrigin, g1Pass: g1.every(r => r.pass), rows, dialogs, popups, cspViolationsSeenOnDashboard: violations.filter(v => v.includes("@" + base)).length }, null, 1));
await browser.close(); fm.healthServer.close(); fm.previewListener?.close();
process.exit(0);
