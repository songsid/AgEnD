// #2182 from defaults (fleet decision a78ebdc5): the org canvas's traffic lines routed around the cards and through the
// team boxes' doors (libavoid in a worker). Each case is a fresh profile with nothing seeded, signed in through the
// visible /signin, reaching Fleet → Org chart through visible navigation. Demo names only.
// The user's screenshot case: a sender outside every team box (General) delegating to two cards inside awp-ota and one
// in the box of instances in no team; plus a ×3 bundle between two teams and lines into a folded team.
// Per case, measured on the page (each line's points are the path's corners): every line is routed by the worker
// (data-routed), starts and ends on a card (or on a folded team's box — its end), never runs along a box border,
// never crosses a header band or a card, its arrowhead clears every border, and no two lines share a run (4 px apart
// or less along more than 8 px). And:
// - desk (light, loopback): #2135 kept — the delegations stay until their report_result (and go after it); a message
//   lingers while it fades (12 s), then goes; ×3 on a bundle; folding awp-ota ends its lines on the box. The policies:
//   /ui keeps the dashboard's (no WebAssembly; the page cannot compile any), the worker's script has its own.
// - phone (dark, zh-TW, a LAN origin in Chromium, reduced motion): the same lines routed on the phone's packing; no
//   horizontal overflow.
// - the public link (desk light, reduced motion): routed through the snapshot poll.
// - blocked: the worker's script refused (as a browser without module workers or WebAssembly would fail) — every line
//   is still drawn, on its lane, ending on its cards; nothing is routed; the only error is the refused request.
// - timing: 60 cards in eight teams, 20 lines — how long from the lines' first drawing to all routed.
// BEFORE=1 (run against a checkout without #2182): only the screenshot case's pictures, no checks.
//   PW_DIR=… REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf [PW_ENGINE=webkit] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2182-org-routing.mts
import { bootFixture, freshPage, mounted, openPublicLink, shotPath, type FreshPage } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2182-org-routing";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const BEFORE = process.env.BEFORE === "1";
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
const CANCEL = /^(EventSource|Fetch API) cannot load https?:\s*\/+[^\s/]+\/(ui\/(events|poll|traffic)|auth\/session)(\?\S*)? due to access control checks\.$/;
const fx = await bootFixture({ port: Number(process.env.HP ?? 48620), classic: false });
const fm = fx.fm;
const dir = fm.dataDir ?? fx.dir;

// ── The fleet: General outside every box; awp-ota and two more teams; three in no team ──
const SMALL = {
  teams: { "platform": ["infra-terraform", "ci-runner", "log-shipper", "secrets-rotator"], "awp-ota": ["ota-builder", "ota-signer", "ota-rollout", "ota-canary", "ota-metrics"],
    "data": ["etl-nightly", "warehouse-sync", "report-builder"] } as Record<string, string[]>,
  rest: ["docs-site-builder", "release-notes-drafter", "grok-scout"],
};
function useFleet(f: { teams: Record<string, string[]>; rest: string[] }) {
  const names = ["general", ...Object.values(f.teams).flat(), ...f.rest];
  fm.fleetConfig.instances = Object.fromEntries(names.map((name, i) => [name, { working_directory: dir, backend: ["claude-code", "codex", "kiro-cli"][i % 3], ...(name === "general" ? { general_topic: true } : {}) }]));
  fm.fleetConfig.teams = Object.fromEntries(Object.entries(f.teams).map(([t, members]) => [t, { members }]));
  fm.getInstanceStatus = () => "running";
}
useFleet(SMALL);

// ── Traffic, as the outbox publishes it (FleetManager.publishTraffic: the SSE and the snapshot) ──
let seq = 0;
const row = (from: string, to: string, requestKind: string, correlationId: string | null, state: string, id = `smoke-${from}-${to}-${requestKind}-${correlationId}`) => ({
  deliveryId: id, operationId: `op-${id}`, sourceKey: "k", sourceInstance: from, sourceDaemonBootId: "b", targetInstance: to, targetSession: null, targetDaemonBootId: null,
  kind: "fleet_inbound", correlationId, payload: { type: "fleet_inbound", content: "", meta: { request_kind: requestKind } }, state, attemptNo: 0, createdSeq: ++seq,
  managerBootId: null, responseDeliveredAt: null, nextAttemptAt: null, lastError: null, reconciliationPending: false });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function message(from: string, to: string, kind: string, corr: string | null, gap = 150, id?: string) {
  for (const s of ["queued", "delivering", "delivered"]) { fm.publishTraffic(row(from, to, kind, corr, s, id)); await wait(gap); }
  fm.publishTraffic(row(from, to, kind, corr, "delivered", id), "consumed");
}
/** The screenshot case: General → two in awp-ota and one in no team, as open delegations. */
const DELEGATIONS: Array<[string, string]> = [["general", "ota-builder"], ["general", "ota-canary"], ["general", "release-notes-drafter"]];
/** Each case its own correlation ids (a closed delegation's id is done for good). */
async function openDelegations(tag: string) { for (const [i, [a, z]] of DELEGATIONS.entries()) await message(a, z, "task", `cid-${tag}-${i}`, 60); }
async function closeDelegations(tag: string) { for (const [i, [a, z]] of DELEGATIONS.entries()) await message(z, a, "report", `cid-${tag}-${i}`, 40); }
/** The open delegations' lines only (a delegation's task message also fades for 12 s on its own line). */
const work = (m: M) => ({ ...m, lines: m.lines.filter((l) => l.cls.includes("ph-work")) });

// ── The page ──
async function openCanvas(p: FreshPage) {
  await mounted(p.page, 30000);
  const direct = p.page.locator('a[href^="/ui/fleet"]');
  let clicked = false;
  for (let i = 0; i < await direct.count() && !clicked; i++) if (await direct.nth(i).isVisible()) { await direct.nth(i).click(); clicked = true; }
  if (!clicked) {   // a phone: Fleet is a tab, or in the drawer
    await p.page.locator('nav.tabs a[href^="/ui/fleet"]').first().click();
  }
  await p.page.waitForURL(/\/ui\/fleet/, { timeout: 10000 });
  if (!/\/ui\/fleet\/org$/.test(new URL(p.page.url()).pathname)) await p.page.locator('.p-fleet a.seg-item[href="/ui/fleet/org"]').first().click();
  await p.page.waitForURL("**/ui/fleet/org", { timeout: 10000 });
  await p.page.waitForSelector(".oc-svg .oc-node", { timeout: 15000 });
  await p.page.waitForTimeout(500);
}
/** Each line as drawn: its key data, its points (the path's corners), whether routed; the cards, boxes and headers. */
const MEASURE = `(() => {
  const num = (s) => s.trim().split(/[ ,]+/).map(Number);
  const pts = (d) => { const out = []; const re = /([MLQ])([^MLQ]*)/g; let m; while ((m = re.exec(d))) { const v = num(m[2]); if (m[1] === "Q") out.push({ x: v[0], y: v[1] }); else out.push({ x: v[0], y: v[1] }); }
    const corners = [out[0]]; const qs = [...d.matchAll(/Q([^MLQ]*)/g)].map((q) => num(q[1])); for (const q of qs) corners.push({ x: q[0], y: q[1] }); corners.push(out[out.length - 1]); return corners; };
  const cards = [...document.querySelectorAll(".oc-node")].map((g) => { const m = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(g.getAttribute("transform")); const r = g.querySelector(".oc-card");
    return { name: g.dataset.name, x: +m[1], y: +m[2], w: +r.getAttribute("width"), h: +r.getAttribute("height") }; });
  const boxes = [...document.querySelectorAll(".oc-team")].map((g) => { const r = g.querySelector(".oc-box"), hd = g.querySelector(".oc-head"); const caret = document.querySelector('.oc-team-head[data-team="' + CSS.escape(g.dataset.team) + '"] .oc-caret');
    return { team: g.dataset.team, folded: !!caret && caret.textContent === "▸", x: +r.getAttribute("x"), y: +r.getAttribute("y"), w: +r.getAttribute("width"), h: +r.getAttribute("height"), headH: hd ? +hd.getAttribute("height") + 2 : 34 }; });
  const lines = [...document.querySelectorAll(".oc-fl")].map((g) => { const p = g.querySelector(".oc-flow"), b = g.querySelector(".oc-badge text");
    return { cls: p.getAttribute("class").replace("oc-flow ", ""), routed: g.dataset.routed === "1", pts: pts(p.getAttribute("d")), badge: b ? b.textContent : null }; });
  return { cards, boxes, lines, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
})()`;
type Pt = { x: number; y: number };
type M = { cards: any[]; boxes: any[]; lines: Array<{ cls: string; routed: boolean; pts: Pt[]; badge: string | null }>; overflow: boolean };
const measure = async (p: FreshPage) => p.page.evaluate(MEASURE) as Promise<M>;
async function until(p: FreshPage, test: (m: M) => boolean, ms = 10000) {
  const end = Date.now() + ms;
  let m = await measure(p);
  while (!test(m) && Date.now() < end) { await wait(200); m = await measure(p); }
  return { ok: test(m), m };
}
/** The line ends `name` → `name` (or a folded box "box:<team>"), from what its two ends sit on. */
const near = (a: number, b: number) => Math.abs(a - b) < 1.5;
const onRect = (p: Pt, r: any) => ((near(p.x, r.x) || near(p.x, r.x + r.w)) && p.y >= r.y - 1 && p.y <= r.y + r.h + 1) || ((near(p.y, r.y) || near(p.y, r.y + r.h)) && p.x >= r.x - 1 && p.x <= r.x + r.w + 1);
const endOn = (m: M, p: Pt) => m.cards.find((c) => onRect(p, c))?.name ?? (m.boxes.find((b) => b.folded && onRect(p, b)) ? `box:${m.boxes.find((b) => b.folded && onRect(p, b)).team}` : null);
const ends = (m: M) => m.lines.map((l) => [endOn(m, l.pts[0]), endOn(m, l.pts[l.pts.length - 1])]);
/** The issue's acceptance on what is drawn: a list of problems (none: all met). */
function problems(m: M) {
  const out: string[] = [];
  const segs = (p: Pt[]) => p.slice(1).map((q, i) => ({ a: p[i], b: q, h: Math.abs(p[i].y - q.y) < 0.01 }));
  const span = (s: any) => (s.h ? [Math.min(s.a.x, s.b.x), Math.max(s.a.x, s.b.x)] : [Math.min(s.a.y, s.b.y), Math.max(s.a.y, s.b.y)]);
  m.lines.forEach((l, i) => {
    const [a, z] = [endOn(m, l.pts[0]), endOn(m, l.pts[l.pts.length - 1])];
    if (!a || !z) out.push(`line ${i}: an end on no card (${a} → ${z})`);
    for (const s of segs(l.pts)) {
      if (Math.abs(s.a.x - s.b.x) > 0.01 && Math.abs(s.a.y - s.b.y) > 0.01) out.push(`line ${i}: not orthogonal`);
      const [lo, hi] = span(s), c = s.h ? s.a.y : s.a.x;
      for (const b of m.boxes) {
        const edges = s.h ? [b.y, b.y + b.h] : [b.x, b.x + b.w], [blo, bhi] = s.h ? [b.x, b.x + b.w] : [b.y, b.y + b.h];
        if (edges.some((v) => Math.abs(v - c) < 6) && Math.min(hi, bhi) - Math.max(lo, blo) > 12) out.push(`line ${i}: along ${b.team}'s border`);
        if (!b.folded && (s.h ? c > b.y + 0.5 && c < b.y + b.headH - 0.5 && hi > b.x && lo < b.x + b.w : c > b.x && c < b.x + b.w && hi > b.y + 0.5 && lo < b.y + b.headH - 0.5)) out.push(`line ${i}: through ${b.team}'s header`);
      }
      for (const k of m.cards) if (s.h ? c > k.y + 1 && c < k.y + k.h - 1 && hi > k.x + 1 && lo < k.x + k.w - 1 : c > k.x + 1 && c < k.x + k.w - 1 && hi > k.y + 1 && lo < k.y + k.h - 1) out.push(`line ${i}: through ${k.name}`);
    }
    const zp = l.pts[l.pts.length - 1], yp = l.pts[l.pts.length - 2];
    const t = Math.min(1, 14 / Math.hypot(zp.x - yp.x, zp.y - yp.y)), s0 = { x: zp.x + (yp.x - zp.x) * t, y: zp.y + (yp.y - zp.y) * t }, hz = Math.abs(zp.y - yp.y) < 0.01;
    const head = { x0: Math.min(s0.x, zp.x) - (hz ? 0 : 9), x1: Math.max(s0.x, zp.x) + (hz ? 0 : 9), y0: Math.min(s0.y, zp.y) - (hz ? 9 : 0), y1: Math.max(s0.y, zp.y) + (hz ? 9 : 0) };
    for (const b of m.boxes) {
      if (b.folded && (z ?? "").startsWith("box:")) continue;   // a line to a folded team ends on its box: its arrowhead is on it by design
      if (([b.x, b.x + b.w].some((x) => x > head.x0 && x < head.x1) && head.y1 > b.y && head.y0 < b.y + b.h) || ([b.y, b.y + b.h].some((v) => v > head.y0 && v < head.y1) && head.x1 > b.x && head.x0 < b.x + b.w)) out.push(`line ${i}: arrowhead on ${b.team}'s border`);
    }
  });
  for (let i = 0; i < m.lines.length; i++) for (let j = i + 1; j < m.lines.length; j++) for (const s1 of segs(m.lines[i].pts)) for (const s2 of segs(m.lines[j].pts)) {
    if (s1.h !== s2.h) continue;
    const c1 = s1.h ? s1.a.y : s1.a.x, c2 = s2.h ? s2.a.y : s2.a.x, [l1, h1] = span(s1), [l2, h2] = span(s2);
    if (Math.abs(c1 - c2) < 4 && Math.min(h1, h2) - Math.max(l1, l2) > 8) out.push(`lines ${i} and ${j}: share a run`);
  }
  return [...new Set(out)];
}
const results: Array<{ name: string; ok: boolean }> = [];
function record(name: string, c: Record<string, boolean>, extra: Record<string, unknown> = {}) {
  const failed = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  results.push({ name, ok: !failed.length });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${ENGINE}-${name}${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify(extra).slice(0, 1500)}` : ""}`);
}
const ownErrors = (p: FreshPage, navEnd: number, also: RegExp | null = null) => p.errors.filter((e, i) => { const t = e.replace(/ @ \S+$/, "");
  return !(ENGINE === "webkit" && (WEBKIT_OWN.has(t) || (i < navEnd && CANCEL.test(t)))) && !(also && also.test(t)); });
const allRouted = (n: number) => (m: M) => m.lines.length >= n && m.lines.every((l) => l.routed);
const ONLY = process.env.ONLY?.split(",");
const only = (n: string) => !ONLY || ONLY.includes(n);

// ── BEFORE: the screenshot case's pictures only ──
if (BEFORE) {
  for (const [name, open] of [["desk-light-en", () => freshPage(fx, { device: "desk", theme: "light", lang: "en" })], ["phone-dark-zh-TW", () => freshPage(fx, { device: "phone", theme: "dark", lang: "zh-TW" })]] as const) {
    const p = await open();
    await openCanvas(p);
    await openDelegations(`before-${name}`);
    await until(p, (m) => work(m).lines.length >= 3);
    await p.page.waitForTimeout(800);
    await p.page.screenshot({ path: shotPath(SMOKE, `before-${ENGINE}-${name}`, "1-screenshot-case") });
    await closeDelegations(`before-${name}`);
    await p.ctx.close();
  }
  console.log("BEFORE pictures taken");
  await fx.close();
  process.exit(0);
}

// ── desk ──
if (only("desk")) {
  const p = await freshPage(fx, { device: "desk", theme: "light", lang: "en" });
  const c: Record<string, boolean> = {};
  await openCanvas(p);
  const navEnd = p.errors.length;
  await openDelegations("desk");
  const a = await until(p, (m) => work(m).lines.length === 3 && allRouted(3)(m));
  c.screenshotCaseRouted = a.ok;
  c.screenshotCaseEnds = JSON.stringify(ends(work(a.m)).sort()) === JSON.stringify(DELEGATIONS.map(([x, y]) => [x, y]).sort());
  const pa = problems(a.m);
  c.screenshotCaseAcceptance = pa.length === 0;
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-desk-light-en`, "1-screenshot-case") });
  // ×3: three messages between the same two cards, kind and phase — one line.
  for (const k of [1, 2, 3]) fm.publishTraffic(row("ci-runner", "etl-nightly", "send", null, "delivering", `smoke-bundle-${k}`));
  const b = await until(p, (m) => m.lines.some((l) => l.badge === "×3") && m.lines.every((l) => l.routed));
  const pb = problems(b.m);
  c.bundleOneLineX3 = b.ok && b.m.lines.filter((l) => l.badge === "×3").length === 1;
  c.bundleAcceptance = pb.length === 0;
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-desk-light-en`, "2-bundle-x3") });
  for (const k of [1, 2, 3]) fm.publishTraffic(row("ci-runner", "etl-nightly", "send", null, "delivered", `smoke-bundle-${k}`), "consumed");
  // #2135: the delegations stay (in progress) long after their messages; a delivered message lingers while it fades.
  await wait(6000);
  const stay = await measure(p);
  c.workStays = stay.lines.filter((l) => l.cls.includes("ph-work")).length === 3;
  const fading = await until(p, (m) => m.lines.some((l) => l.cls.includes("ph-fading")), 3000);
  c.messageLingersFading = fading.ok;
  const faded = await until(p, (m) => !m.lines.some((l) => l.cls.includes("ph-fading")), 16000);
  c.messageGoesAfterFading = faded.ok;
  // Fold awp-ota: its lines end on its box (the box is their end), routed.
  await p.page.locator('.oc-team-head[data-team="awp-ota"] .oc-toggle').click();
  const f = await until(p, (m) => allRouted(2)(m) && ends(work(m)).filter(([, z]) => z === "box:awp-ota").length === 1);
  const pf = problems(f.m);
  c.foldedEndsOnBox = f.ok && pf.length === 0;
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-desk-light-en`, "3-folded") });
  await p.page.locator('.oc-team-head[data-team="awp-ota"] .oc-toggle').click();
  // The report_result closes each delegation: its return, then nothing — no line left over.
  await closeDelegations("desk");
  const done = await until(p, (m) => m.lines.length === 0, 18000);   // the reports' own lines fade for 12 s
  c.noLineLeft = done.ok;
  // The policies: the page's refuses WebAssembly (and the page cannot compile any); the worker's script has its own.
  const pol = await p.page.evaluate(`(async () => {
    const ui = (await fetch("/ui/fleet/org", { credentials: "same-origin" })).headers.get("content-security-policy") || "";
    const w = (await fetch("/ui/js/fleet-route-worker.js", { credentials: "same-origin" })).headers.get("content-security-policy") || "";
    let compiled = "no"; try { await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); compiled = "yes"; } catch (e) { compiled = "refused"; }
    return { ui, w, compiled };
  })()`) as { ui: string; w: string; compiled: string };
  c.pagePolicyUnchanged = /script-src 'self'/.test(pol.ui) && !/wasm-unsafe-eval|unsafe-eval/.test(pol.ui);
  c.pageCannotCompileWasm = pol.compiled === "refused";
  c.workerPolicy = pol.w === "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src blob:";
  const errs = ownErrors(p, navEnd, /WebAssembly|wasm|Refused to (compile|evaluate)/i);   // the page's own refused compile, asked above
  c.noErrors = errs.length === 0;
  record("desk-light-en", c, { pa, pb, pf, ends: ends(a.m), foldEnds: ends(f.m), left: (await measure(p)).lines.map((l) => l.cls), bundle: b.m.lines.map((l) => [l.cls, l.badge, l.routed, l.pts]), errs });
  await p.ctx.close();
}

// ── phone ──
if (only("phone")) {
  const p = await freshPage(fx, { device: "phone", theme: "dark", lang: "zh-TW" }, ENGINE === "webkit" ? { reducedMotion: true } : { origin: "lan", reducedMotion: true });
  const c: Record<string, boolean> = {};
  await openCanvas(p);
  const navEnd = p.errors.length;
  await openDelegations("phone");
  const a = await until(p, (m) => work(m).lines.length === 3 && allRouted(3)(m));
  const pa = problems(a.m);
  c.routed = a.ok;
  c.acceptance = pa.length === 0;
  c.noOverflow = !a.m.overflow;
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-phone-dark-zh-TW-reduced`, "1-screenshot-case") });
  await closeDelegations("phone");
  c.noErrors = ownErrors(p, navEnd).length === 0;
  record(ENGINE === "webkit" ? "phone-dark-zh-TW-reduced" : "phone-dark-zh-TW-lan-reduced", c, { pa, errors: p.errors });
  await p.ctx.close();
}

// ── the public link ──
if (only("public")) {
  const link = await openPublicLink(fx);
  const p = await link.publicPage({ device: "desk", theme: "light", lang: "en" }, { reducedMotion: true });
  const c: Record<string, boolean> = {};
  await openCanvas(p);
  const navEnd = p.errors.length;
  await openDelegations("public");
  const a = await until(p, (m) => work(m).lines.length === 3 && allRouted(3)(m), 15000);
  const pa = problems(a.m);
  c.routedThroughThePoll = a.ok;
  c.acceptance = pa.length === 0;
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-public-link-desk-light-en-reduced`, "1-screenshot-case") });
  await closeDelegations("public");
  c.noErrors = ownErrors(p, navEnd).length === 0;
  record("public-link-desk-light-en-reduced", c, { pa, errors: p.errors });
  await p.ctx.close();
  await link.close();
}

// ── blocked: no worker ──
if (only("blocked")) {
  const p = await freshPage(fx, { device: "desk", theme: "light", lang: "en" }, { beforeNavigate: (ctx) => ctx.route("**/ui/js/fleet-route-worker.js", (r: any) => r.abort()) });
  const c: Record<string, boolean> = {};
  await openCanvas(p);
  const navEnd = p.errors.length;
  await openDelegations("blocked");
  const a = await until(p, (m) => work(m).lines.length === 3, 8000);
  await p.page.waitForTimeout(5000);   // past the client's timeout: still nothing routed
  const m = await measure(p);
  c.allDrawnOnLanes = a.ok && work(m).lines.length === 3 && m.lines.every((l) => !l.routed);
  c.endsOnCards = ends(m).every(([x, y]) => !!x && !!y);
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-blocked-desk-light-en`, "1-lanes") });
  await closeDelegations("blocked");
  const errs = ownErrors(p, navEnd, /fleet-route-worker|net::ERR_FAILED|Failed to load resource|access control/i);
  c.onlyTheRefusedRequest = errs.length === 0;
  record("blocked-worker-desk-light-en", c, { errs, m: m.lines.map((l) => [l.cls, l.routed]) });
  await p.ctx.close();
}

// ── timing: 60 cards, 20 lines ──
if (only("timing")) {
  const teams: Record<string, string[]> = {};
  const sizes = [8, 6, 9, 4, 7, 5, 3, 6];
  sizes.forEach((n, i) => { teams[i === 1 ? "awp-ota" : `team-${i}`] = Array.from({ length: n }, (_, k) => `t${i}-agent-${k + 1}`); });
  const restN = 60 - 1 - sizes.reduce((x, y) => x + y, 0);
  useFleet({ teams, rest: Array.from({ length: restN }, (_, k) => `solo-${k + 1}`) });
  const names = ["general", ...Object.values(teams).flat(), ...Array.from({ length: restN }, (_, k) => `solo-${k + 1}`)];
  const p = await freshPage(fx, { device: "desk", theme: "light", lang: "en" });
  await openCanvas(p);
  let s = 5;
  const rnd = (n: number) => { s = (s * 1103515245 + 12345) % 2147483648; return s % n; };
  const pairs: Array<[string, string]> = [];
  while (pairs.length < 20) { const x = names[rnd(names.length)], y = names[rnd(names.length)]; if (x !== y && !pairs.some(([u, v]) => u === x && v === y)) pairs.push([x, y]); }
  const t0 = Date.now();
  pairs.forEach(([x, y], i) => fm.publishTraffic(row(x, y, "send", null, "delivering", `smoke-t-${i}`)));
  const drawn = await until(p, (m) => m.lines.length >= 20, 10000);
  const t1 = Date.now();
  const routed = await until(p, allRouted(20), 15000);
  const t2 = Date.now();
  const pr = problems(routed.m);
  await p.page.screenshot({ path: shotPath(SMOKE, `${ENGINE}-timing-60-cards`, "1-routed") });
  record("timing-60-cards-20-lines", { drawn: drawn.ok, routed: routed.ok, cards60: routed.m.cards.length === 60 }, { msToDraw: t1 - t0, msDrawnToRouted: t2 - t1, problems: pr.length });
  console.log(`timing ${ENGINE}: 60 cards, 20 lines — drawn ${t1 - t0} ms after publishing, routed ${t2 - t1} ms after that; acceptance problems: ${pr.length}${pr.length ? " " + JSON.stringify(pr).slice(0, 400) : ""}`);
  pairs.forEach(([x, y], i) => fm.publishTraffic(row(x, y, "send", null, "delivered", `smoke-t-${i}`), "consumed"));
  await p.ctx.close();
}

const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `FAIL ${bad.map((b) => b.name).join(", ")}` : `PASS (${ENGINE})`);
await fx.close();
process.exit(bad.length ? 1 : 0);
