// #2329 from defaults (fleet decision a78ebdc5): the org canvas's arrowheads on a busy 13-instance team (the user's
// agend-dev screenshot's shape). Each case is a fresh profile with nothing seeded, signed in through the visible
// /signin, reaching Fleet → Org chart through visible navigation. Demo names only.
// The traffic: General delegating to four members (the slow dashed work lines), messages both ways between cards side
// by side in one row, two members messaging General (heads side by side on its card), a member of another team
// messaging into agend-dev, all at once.
// Per case, measured on the page from each line's path and its marker (so the same measure reads main's markers and
// the fix's): every arrowhead's length, its tip's distance to the card it points at, and whether it overlaps a card or
// another head. Checks (not with BEFORE=1):
// - every line routed by the worker; every head at most 3.5 stroke widths long (≤ 12 px);
// - every tip 2–8 px short of its card, never on or under a card; no head on any card; no two heads overlapping;
// - a line with no head: its last straight run too short for one (the rule), and it keeps its source dot;
// - Live off: no line; Live on again: the open delegations back, new messages drawn; no horizontal overflow; no console error.
// Cases: desk light, desk dark, phone light, phone dark (reduced motion on the phone: a still picture).
// Pictures: the whole view (Live on), a close-up of the agend-dev box (Live on), the whole view with Live off.
//   PW_DIR=… REPO=<checkout> OUT=<dir> PW_DPR=2 FONTCONFIG_FILE=/etc/fonts/fonts.conf [BEFORE=1] [PW_ENGINE=webkit] \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-2329-org-arrows.mts
import { bootFixture, freshPage, mounted, shotPath, type FreshPage } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-2329-org-arrows";
const ENGINE = process.env.PW_ENGINE === "webkit" ? "webkit" : "chromium";
const BEFORE = process.env.BEFORE === "1";
const TAG = BEFORE ? "before" : "after";
const WEBKIT_OWN = new Set(["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.",
  'Viewport argument key "interactive-widget" not recognized and ignored.']);
const fx = await bootFixture({ port: Number(process.env.HP ?? 48640), classic: false });
const fm = fx.fm;
const dir = fm.dataDir ?? fx.dir;

// ── The fleet: General outside every box; agend-dev with 13 members; a small ops team; two in no team ──
const DEV = ["dev-web", "dev-web-codex", "reviewer-a", "reviewer-b", "coordinator", "dev-1", "dev-2", "dev-3", "dev-4", "docs-writer", "release-bot", "tester", "auditor"];
const FLEET = { teams: { "agend-dev": DEV, "ops": ["ops-deploy", "ops-monitor", "ops-backup"] } as Record<string, string[]>, rest: ["scout", "notes-drafter"] };
const names = ["general", ...Object.values(FLEET.teams).flat(), ...FLEET.rest];
fm.fleetConfig.instances = Object.fromEntries(names.map((name, i) => [name, { working_directory: dir, backend: ["claude-code", "codex", "kiro-cli"][i % 3], ...(name === "general" ? { general_topic: true } : {}) }]));
fm.fleetConfig.teams = Object.fromEntries(Object.entries(FLEET.teams).map(([t, members]) => [t, { members }]));
fm.getInstanceStatus = () => "running";

// ── Traffic, as the outbox publishes it (FleetManager.publishTraffic: the SSE and the snapshot) ──
let seq = 0;
const row = (from: string, to: string, requestKind: string, correlationId: string | null, state: string, id: string) => ({
  deliveryId: id, operationId: `op-${id}`, sourceKey: "k", sourceInstance: from, sourceDaemonBootId: "b", targetInstance: to, targetSession: null, targetDaemonBootId: null,
  kind: "fleet_inbound", correlationId, payload: { type: "fleet_inbound", content: "", meta: { request_kind: requestKind } }, state, attemptNo: 0, createdSeq: ++seq,
  managerBootId: null, responseDeliveredAt: null, nextAttemptAt: null, lastError: null, reconciliationPending: false });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Open delegations from General (task delivered, no report yet: the work lines). */
const WORK: Array<[string, string]> = [["general", "dev-1"], ["general", "dev-2"], ["general", "reviewer-a"], ["general", "coordinator"]];
/** Messages being delivered (the live lines): neighbours both ways, two into General, one from another team. */
const LIVE: Array<[string, string, string]> = [["dev-1", "reviewer-a", "send"], ["reviewer-a", "dev-1", "report"], ["dev-web", "dev-web-codex", "send"],
  ["dev-web-codex", "dev-web", "send"], ["dev-web", "general", "send"], ["dev-web-codex", "general", "report"], ["coordinator", "dev-4", "task"],
  ["dev-3", "dev-4", "send"], ["tester", "auditor", "send"], ["ops-deploy", "dev-2", "send"], ["release-bot", "docs-writer", "send"]];
async function seedTraffic(tag: string) {
  for (const [i, [a, z]] of WORK.entries()) for (const s of ["queued", "delivering", "delivered"]) { fm.publishTraffic(row(a, z, "task", `cid-${tag}-${i}`, s, `w-${tag}-${i}`)); await wait(30); }
  for (const [i, [a, z]] of WORK.entries()) fm.publishTraffic(row(a, z, "task", `cid-${tag}-${i}`, "delivered", `w-${tag}-${i}`), "consumed");
  // Let the delegations' own task messages fade out (12 s): only the work lines and the live messages stay.
  await wait(13500);
  for (const [i, [a, z, k]] of LIVE.entries()) fm.publishTraffic(row(a, z, k, null, "delivering", `l-${tag}-${i}`));
}
/** The case's messages delivered and its delegations reported (the next case starts from the same traffic, no ×N). */
async function clearTraffic(tag: string) {
  for (const t of [tag, `${tag}-again`]) for (const [i, [a, z, k]] of LIVE.entries()) fm.publishTraffic(row(a, z, k, null, "delivered", `l-${t}-${i}`), "consumed");
  for (const [i, [a, z]] of WORK.entries()) for (const st of ["delivering", "delivered"]) { fm.publishTraffic(row(z, a, "report", `cid-${tag}-${i}`, st, `r-${tag}-${i}`)); await wait(30); }
  for (const [i, [a, z]] of WORK.entries()) fm.publishTraffic(row(z, a, "report", `cid-${tag}-${i}`, "delivered", `r-${tag}-${i}`), "consumed");
}

// ── The page ──
async function openCanvas(p: FreshPage) {
  await mounted(p.page, 30000);
  const direct = p.page.locator('a[href^="/ui/fleet"]');
  let clicked = false;
  for (let i = 0; i < await direct.count() && !clicked; i++) if (await direct.nth(i).isVisible()) { await direct.nth(i).click(); clicked = true; }
  if (!clicked) await p.page.locator('nav.tabs a[href^="/ui/fleet"]').first().click();
  await p.page.waitForURL(/\/ui\/fleet/, { timeout: 10000 });
  if (!/\/ui\/fleet\/org$/.test(new URL(p.page.url()).pathname)) await p.page.locator('.p-fleet a.seg-item[href="/ui/fleet/org"]').first().click();
  await p.page.waitForURL("**/ui/fleet/org", { timeout: 10000 });
  await p.page.waitForSelector(".oc-svg .oc-node", { timeout: 15000 });
  await p.page.waitForTimeout(500);
}
/**
 * Each line's arrowhead as drawn, from its path's end and its marker (viewBox, refX, size in stroke widths, the head's
 * own outline): the tip, the base, the half width, in the canvas's coordinates (the cards' too); the last straight run.
 */
const MEASURE = `(() => {
  const cards = [...document.querySelectorAll(".oc-node")].map((g) => { const m = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(g.getAttribute("transform")); const r = g.querySelector(".oc-card");
    return { name: g.dataset.name, x: +m[1], y: +m[2], w: +r.getAttribute("width"), h: +r.getAttribute("height") }; });
  const lines = [...document.querySelectorAll(".oc-fl")].map((g) => {
    const p = g.querySelector(".oc-flow"), sw = parseFloat(getComputedStyle(p).strokeWidth), len = p.getTotalLength();
    const end = p.getPointAtLength(len), back = p.getPointAtLength(Math.max(0, len - 0.5)), start = p.getPointAtLength(0);
    const ux = (end.x - back.x) / (Math.hypot(end.x - back.x, end.y - back.y) || 1), uy = (end.y - back.y) / (Math.hypot(end.x - back.x, end.y - back.y) || 1);
    // The last straight run: walk back from the end while the direction holds.
    let run = 0; for (let s = len - 1; s >= 0; s -= 1) { const q = p.getPointAtLength(s); const dx = end.x - q.x, dy = end.y - q.y; if (Math.abs(dx * uy - dy * ux) > 0.3) break; run = len - s; }
    const ref = (a) => { const v = (p.getAttribute(a) || "").match(/#([^)]+)/); return v ? document.getElementById(v[1]) : null; };
    const mk = ref("marker-end"), src = ref("marker-start");
    let head = null;
    if (mk) {
      const vb = mk.getAttribute("viewBox").split(/[ ,]+/).map(Number), units = mk.getAttribute("markerUnits") || "strokeWidth";
      const k = (+mk.getAttribute("markerWidth")) * (units === "strokeWidth" ? sw : 1) / vb[2];
      const shape = mk.firstElementChild, bb = shape.getBBox(), refX = +mk.getAttribute("refX"), refY = +mk.getAttribute("refY");
      const tipAhead = (bb.x + bb.width - refX) * k, tailBack = (refX - bb.x) * k;
      head = { len: bb.width * k, half: Math.max(refY - bb.y, bb.y + bb.height - refY) * k,
        tip: { x: end.x + ux * tipAhead, y: end.y + uy * tipAhead }, base: { x: end.x - ux * tailBack, y: end.y - uy * tailBack } };
    }
    let dot = null;
    if (src) { const vb = src.getAttribute("viewBox").split(/[ ,]+/).map(Number), bb = src.firstElementChild.getBBox(); dot = bb.width * (+src.getAttribute("markerWidth")) * sw / vb[2]; }
    return { cls: p.getAttribute("class").replace("oc-flow ", ""), routed: g.dataset.routed === "1", sw, end: { x: end.x, y: end.y }, start: { x: start.x, y: start.y }, run, head, dot };
  });
  return { cards, lines, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
})()`;
type Pt = { x: number; y: number };
type Head = { len: number; half: number; tip: Pt; base: Pt };
type Line = { cls: string; routed: boolean; sw: number; end: Pt; start: Pt; run: number; head: Head | null; dot: number | null };
type M = { cards: Array<{ name: string; x: number; y: number; w: number; h: number }>; lines: Line[]; overflow: boolean };
const measure = async (p: FreshPage) => p.page.evaluate(MEASURE) as Promise<M>;
async function until(p: FreshPage, test: (m: M) => boolean, ms = 12000) {
  const end = Date.now() + ms;
  let m = await measure(p);
  while (!test(m) && Date.now() < end) { await wait(200); m = await measure(p); }
  return { ok: test(m), m };
}
/** Distance from point `p` to rectangle `r` (0 on or inside it), and whether it is inside. */
const dist = (p: Pt, r: any) => Math.hypot(Math.max(r.x - p.x, 0, p.x - r.x - r.w), Math.max(r.y - p.y, 0, p.y - r.y - r.h));
const inside = (p: Pt, r: any) => p.x > r.x + 0.5 && p.x < r.x + r.w - 0.5 && p.y > r.y + 0.5 && p.y < r.y + r.h - 0.5;
/** A head's box: from its base to its tip, its half width either side. */
const headBox = (h: Head) => ({ x0: Math.min(h.base.x, h.tip.x) - (h.base.x === h.tip.x ? h.half : 0), x1: Math.max(h.base.x, h.tip.x) + (h.base.x === h.tip.x ? h.half : 0),
  y0: Math.min(h.base.y, h.tip.y) - (h.base.y === h.tip.y ? h.half : 0), y1: Math.max(h.base.y, h.tip.y) + (h.base.y === h.tip.y ? h.half : 0) });
const overlap = (a: any, b: any, m = 0) => a.x0 < b.x1 - m && b.x0 < a.x1 - m && a.y0 < b.y1 - m && b.y0 < a.y1 - m;
/** The heads' numbers and their problems (none: all met). */
function heads(m: M) {
  const out: string[] = [], tipGaps: number[] = [], lens: number[] = [];
  let headless = 0;
  m.lines.forEach((l, i) => {
    if (!l.head) {
      headless++;
      // Drawn, the last run is the route's less the tip's gap: one this long held a head (fleet-traffic.js headFits).
      if (l.run >= 2.8 * l.sw + 1 + 0.5) out.push(`line ${i} (${l.cls}): no head on a ${l.run.toFixed(1)} px run`);
      if (!l.dot) out.push(`line ${i}: no head and no source dot`);
      return;
    }
    const h = l.head, near = m.cards.reduce((b, c) => (dist(h.tip, c) < dist(h.tip, b) ? c : b), m.cards[0]);
    const gap = inside(h.tip, near) ? -Math.min(h.tip.x - near.x, near.x + near.w - h.tip.x, h.tip.y - near.y, near.y + near.h - h.tip.y) : dist(h.tip, near);
    tipGaps.push(+gap.toFixed(1)); lens.push(+h.len.toFixed(1));
    if (h.len > 12 || h.len > 3.5 * l.sw + 0.01) out.push(`line ${i} (${l.cls}): head ${h.len.toFixed(1)} px long at stroke ${l.sw}`);
    if (gap < 2 || gap > 8) out.push(`line ${i} (${l.cls}): tip ${gap.toFixed(1)} px from ${near.name}`);
    const box = headBox(h);
    for (const c of m.cards) if (overlap(box, { x0: c.x, x1: c.x + c.w, y0: c.y, y1: c.y + c.h })) out.push(`line ${i} (${l.cls}): head on ${c.name}`);
  });
  const boxes = m.lines.map((l) => (l.head ? headBox(l.head) : null));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (boxes[i] && boxes[j] && overlap(boxes[i], boxes[j], 0.5)) out.push(`heads of lines ${i} and ${j} overlap`);
  return { out: [...new Set(out)], tipGaps, lens, headless, dots: m.lines.map((l) => (l.dot == null ? null : +l.dot.toFixed(1))) };
}
const results: Array<{ name: string; ok: boolean }> = [];
function record(name: string, c: Record<string, boolean>, extra: Record<string, unknown> = {}) {
  const failed = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  results.push({ name, ok: !failed.length });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${ENGINE}-${name}${failed.length ? ` [${failed.join(", ")}]` : ""} ${JSON.stringify(extra).slice(0, 2500)}`);
}
const ownErrors = (p: FreshPage, navEnd: number) => p.errors.filter((e) => !(ENGINE === "webkit" && WEBKIT_OWN.has(e.replace(/ @ \S+$/, ""))) && p.errors.indexOf(e) >= navEnd);
const N = WORK.length + LIVE.length;
/** The close-up: the agend-dev box's on-screen rectangle (with a margin), clipped to the viewport. */
async function boxClip(p: FreshPage) {
  return p.page.evaluate(`(() => { const r = document.querySelector('.oc-team[data-team="agend-dev"] .oc-box').getBoundingClientRect(), s = document.querySelector(".oc-svg").getBoundingClientRect();
    const x = Math.max(s.left, r.left - 24), y = Math.max(s.top, r.top - 140), x1 = Math.min(s.right, r.right + 24), y1 = Math.min(s.bottom, r.bottom + 24);
    return { x, y, width: x1 - x, height: y1 - y }; })()`) as Promise<{ x: number; y: number; width: number; height: number }>;
}
const ONLY = process.env.ONLY?.split(",");
const CASES = [{ device: "desk", theme: "light" }, { device: "desk", theme: "dark" }, { device: "phone", theme: "light" }, { device: "phone", theme: "dark" }] as const;

for (const k of CASES) {
  const name = `${k.device}-${k.theme}-en`;
  if (ONLY && !ONLY.includes(name)) continue;
  const p = await freshPage(fx, { device: k.device, theme: k.theme, lang: "en" }, k.device === "phone" ? { reducedMotion: true } : {});
  const c: Record<string, boolean> = {};
  await openCanvas(p);
  const navEnd = p.errors.length;
  await seedTraffic(name);
  const a = await until(p, (m) => m.lines.length === N && m.lines.every((l) => l.routed), 15000);
  await p.page.waitForTimeout(600);
  const m = await measure(p);
  const h = heads(m);
  c.allDrawn = m.lines.length === N;
  c.allRouted = a.ok;
  c.heads = h.out.length === 0;
  c.noOverflow = !m.overflow;
  await p.page.screenshot({ path: shotPath(SMOKE, `${TAG}-${ENGINE}-${name}`, "1-live-on") });
  await p.page.screenshot({ path: shotPath(SMOKE, `${TAG}-${ENGINE}-${name}`, "2-live-on-agend-dev"), clip: await boxClip(p) });
  // Live off: the lines go; on again: they come back.
  await p.page.locator(".oc-live").click();
  const off = await until(p, (x) => x.lines.length === 0, 5000);
  c.liveOffNoLines = off.ok;
  await p.page.screenshot({ path: shotPath(SMOKE, `${TAG}-${ENGINE}-${name}`, "3-live-off") });
  await p.page.locator(".oc-live").click();
  // On again: the open delegations come back from the snapshot (its in-flight messages are the outbox's pending rows,
  // which this fixture's published rows are not), and new messages draw as they come.
  const back = await until(p, (x) => x.lines.filter((l) => l.cls.includes("ph-work")).length === WORK.length, 8000);
  for (const [i, [x, y, kind]] of LIVE.entries()) fm.publishTraffic(row(x, y, kind, null, "delivering", `l-${name}-again-${i}`));
  const on = await until(p, (x) => x.lines.length === N, 8000);
  c.liveOnAgain = back.ok && on.ok;
  const again = on.m.lines.length;
  await clearTraffic(name);
  c.noErrors = ownErrors(p, navEnd).length === 0;
  record(name, BEFORE ? {} : c, { failed: Object.entries(c).filter(([, v]) => !v).map(([x]) => x), problems: h.out, headLens: h.lens, tipGaps: h.tipGaps, headless: h.headless, dots: h.dots,
    strokes: [...new Set(m.lines.map((l) => l.sw))], linesAgain: again, errors: ownErrors(p, navEnd) });
  await p.ctx.close();
}

const bad = results.filter((r) => !r.ok);
console.log(BEFORE ? "BEFORE pictures and numbers taken" : bad.length ? `FAIL ${bad.map((b) => b.name).join(", ")}` : `PASS (${ENGINE})`);
await fx.close();
process.exit(bad.length ? 1 : 0);
