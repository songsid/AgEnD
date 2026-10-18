// #1918 review from defaults (fleet decision a78ebdc5): the org canvas shows the work, and no line floats free. The user's
// shape: two General cards over a 3-column grid of instances in no team, a team, a paused instance. Each case is a fresh
// profile with nothing seeded, signed in through the visible /signin as its own synthetic account, reaching Fleet → Org
// chart through visible navigation.
// - desk (light, loopback): a delegate_task → report_result round trip over several seconds — the delegator → worker
//   line stays "in progress" long after the task message has gone, the report brings one return line back, then it
//   goes; a report between two cards in the grid's third column stays inside the box (the user's broken line);
//   folding the team (its header) ends its member's line at the box; the paused instance's line ends on its card;
//   a reload while a delegation is open draws it again (the snapshot).
// - phone (dark, zh-TW, a LAN origin, reduced motion): the in-progress line is drawn and does not move; the key says so
//   in zh-TW; no horizontal overflow.
// - the public link (phone light): no stream — the open delegation comes with the snapshot poll, and goes once its
//   report closed it.
// Every measure: each line starts and ends on a card or a folded team's box. No page error.
// What is not real: traffic rows are handed to FleetManager.publishTraffic (the path every outbox event takes: SSE and
// the snapshot) instead of coming from real instances; the outbox's admission → publishTraffic is unit-tested.
//   PW_DIR=~/.cache/agend-smoke/pw REPO=<checkout> OUT=<dir> FONTCONFIG_FILE=/etc/fonts/fonts.conf \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-1918-workflow-defaults.mts
import { bootFixture, freshPage, mounted, openPublicLink, shotPath, type FreshPage } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-1918-workflow-defaults";
const fx = await bootFixture({ port: Number(process.env.HP ?? 48450), classic: false });
const fm = fx.fm;

// The user's shape, demo names only: two Generals, nine in no team (3 columns), a team of four, one paused.
const GENERALS = ["general", "ops-general"];
const REST = ["observability-dashboards", "billing-reconciliation", "search-indexer", "customer-support-macros", "nightly-benchmarks",
  "docs-site-builder", "grok-scout", "codex-refactor-bot", "muse-writer"];
const TEAM = { name: "QA", members: ["release-notes-drafter", "opencode-sandbox", "agy-design-review", "kiro-steering-experiments"] };
const PAUSED = "nightly-benchmarks";
const dir = fm.dataDir ?? fx.dir;
fm.fleetConfig.instances = Object.fromEntries([...GENERALS, ...REST, ...TEAM.members].map((name, i) => [name, {
  working_directory: dir, backend: ["claude-code", "codex", "kiro-cli"][i % 3], ...(GENERALS.includes(name) ? { general_topic: true } : {}) }]));
fm.fleetConfig.teams = { [TEAM.name]: { members: TEAM.members } };
fm.getInstanceStatus = (n: string) => (n === PAUSED ? "paused" : "running");

// Traffic, as the outbox would publish it.
let seq = 0;
/** A message's row in `state`; its states share one delivery id (`id`, or one per from/to/kind/correlation). */
const row = (from: string, to: string, requestKind: string, correlationId: string | null, state: string, id = `smoke-d-${from}-${to}-${requestKind}-${correlationId}`) => ({
  deliveryId: id, operationId: `smoke-op-${id}`, sourceKey: "k", sourceInstance: from, sourceDaemonBootId: "b",
  targetInstance: to, targetSession: null, targetDaemonBootId: null, kind: "fleet_inbound", correlationId,
  payload: { type: "fleet_inbound", content: "", meta: { request_kind: requestKind } }, state, attemptNo: 0, createdSeq: seq,
  managerBootId: null, responseDeliveredAt: null, nextAttemptAt: null, lastError: null, reconciliationPending: false });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** One message through its states, `gap` ms apart (consumed is the outbox's mark after delivered). */
async function message(from: string, to: string, kind: string, corr: string | null, gap = 300) {
  const states = ["queued", "delivering", "delivered"];
  for (const s of states) { fm.publishTraffic(row(from, to, kind, corr, s)); await wait(gap); }
  fm.publishTraffic(row(from, to, kind, corr, "delivered"), "consumed");
}

// ── the page ──
async function openCanvas(p: FreshPage) {
  await mounted(p.page);
  const direct = p.page.locator('a[href="/ui/fleet/org"]');
  let clicked = false;
  for (let i = 0; i < await direct.count(); i++) if (await direct.nth(i).isVisible()) { await direct.nth(i).click(); clicked = true; break; }
  if (!clicked) {
    const fleet = p.page.locator('a[href^="/ui/fleet"]');
    for (let i = 0; i < await fleet.count(); i++) if (await fleet.nth(i).isVisible()) { await fleet.nth(i).click(); break; }
    await p.page.locator('.seg a[href="/ui/fleet/org"]').first().click();
  }
  await p.page.waitForURL("**/ui/fleet/org", { timeout: 10000 });
  await p.page.waitForSelector(".oc-svg .oc-node", { timeout: 10000 });
  await p.page.waitForTimeout(600);
}
/** Each line: its classes, what its two ends sit on (a card's name, "box:<team>", or null), and its y extent. */
const MEASURE = `(() => {
  const cards = [...document.querySelectorAll(".oc-node")].map((g) => { const m = /translate\\(([-\\d.]+) ([-\\d.]+)\\)/.exec(g.getAttribute("transform")); const r = g.querySelector(".oc-card");
    return { name: g.dataset.name, x: +m[1], y: +m[2], w: +r.getAttribute("width"), h: +r.getAttribute("height") }; });
  const boxes = [...document.querySelectorAll(".oc-team")].map((g) => { const r = g.querySelector(".oc-box"), caret = document.querySelector('.oc-team-head[data-team="' + CSS.escape(g.dataset.team) + '"] .oc-caret');
    return { team: g.dataset.team, folded: !caret || caret.textContent === "▸",
    x: +r.getAttribute("x"), y: +r.getAttribute("y"), w: +r.getAttribute("width"), h: +r.getAttribute("height") }; });
  const near = (a, b) => Math.abs(a - b) < 1.5;
  const on = (pt) => {
    for (const c of cards) if (((near(pt.x, c.x) || near(pt.x, c.x + c.w)) && pt.y >= c.y - 1 && pt.y <= c.y + c.h + 1) || ((near(pt.y, c.y) || near(pt.y, c.y + c.h)) && pt.x >= c.x - 1 && pt.x <= c.x + c.w + 1)) return c.name;
    for (const b of boxes) if (b.folded && near(pt.y, b.y) && pt.x >= b.x && pt.x <= b.x + b.w) return "box:" + b.team;
    return null;
  };
  return { lines: [...document.querySelectorAll(".oc-flow")].map((p) => { const len = p.getTotalLength(), a = p.getPointAtLength(0), z = p.getPointAtLength(len), bb = p.getBBox();
    return { cls: p.getAttribute("class").replace("oc-flow ", ""), from: on(a), to: on(z), minY: bb.y, maxY: bb.y + bb.height, anim: getComputedStyle(p).animationName }; }),
    boxes, legend: [...document.querySelectorAll(".oc-legend .oc-lg")].map((r) => r.textContent.trim()),
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
})()`;
const measure = async (p: FreshPage) => p.page.evaluate(MEASURE) as Promise<{ lines: Array<{ cls: string; from: string | null; to: string | null; minY: number; maxY: number; anim: string }>; boxes: any[]; legend: string[]; overflow: boolean }>;
const floating = (m: Awaited<ReturnType<typeof measure>>) => m.lines.filter((l) => !l.from || !l.to);
const has = (m: Awaited<ReturnType<typeof measure>>, cls: string, from: string, to: string) => m.lines.some((l) => l.cls === cls && l.from === from && l.to === to);
async function until(p: FreshPage, test: (m: Awaited<ReturnType<typeof measure>>) => boolean, ms = 8000) {
  const end = Date.now() + ms;
  let m = await measure(p);
  while (!test(m) && Date.now() < end) { await wait(250); m = await measure(p); }
  return { ok: test(m), m };
}

const results: Array<{ name: string; ok: boolean; [k: string]: unknown }> = [];
function record(name: string, checks: Record<string, boolean>, extra: Record<string, unknown> = {}) {
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  results.push({ name, ok: !failed.length, failed, ...extra });
  console.log(`${failed.length ? "FAIL" : "ok  "} ${name}${failed.length ? ` [${failed.join(", ")}] ${JSON.stringify(extra).slice(0, 900)}` : ""}`);
}
const ONLY = process.env.ONLY?.split(",");
const only = (n: string) => !ONLY || ONLY.includes(n);

// ── desk ──
if (only("desk")) {
  const p = await freshPage(fx, { device: "desk", theme: "light", lang: "en" });
  const c: Record<string, boolean> = {};
  const floats: unknown[] = [];
  const check = (m: Awaited<ReturnType<typeof measure>>) => { const f = floating(m); if (f.length) floats.push(f); return m; };
  await openCanvas(p);
  const shape = await p.page.evaluate(`(() => { const loose = document.querySelector(".oc-team.loose"); const xs = new Set([...document.querySelectorAll(".oc-node")].filter((g) => { const n = g.dataset.name; return ${JSON.stringify(REST)}.includes(n); }).map((g) => g.getAttribute("transform").split(" ")[0]));
    return { tops: ${JSON.stringify(GENERALS)}.every((n) => !!document.querySelector('.oc-node[data-name="' + n + '"]')), loose: !!loose, cols: xs.size, paused: !!document.querySelector('.oc-node.st-paused[data-name="${PAUSED}"]'), live: !!document.querySelector(".oc-live.on") }; })()`) as any;
  c.shape = shape.tops && shape.loose && shape.cols === 3 && shape.paused;
  c.liveOnByDefault = shape.live;
  // 1. delegate_task → (several seconds) → report_result.
  const WORKER = REST[2];
  await message("general", WORKER, "task", "cid-smoke-1");
  const open = await until(p, (m) => has(m, "h-task ph-work", "general", WORKER));
  c.workShown = open.ok; check(open.m);
  await wait(6000);
  const later = check(await measure(p));
  c.workStaysLongAfterTheMessage = has(later, "h-task ph-work", "general", WORKER) && !later.lines.some((l) => l.cls.includes("ph-live"));
  await p.page.screenshot({ path: shotPath(SMOKE, "desk", "1-in-progress") });
  await message(WORKER, "general", "report", "cid-smoke-1", 150);
  const back = await until(p, (m) => has(m, "h-report ph-return", WORKER, "general") && !has(m, "h-task ph-work", "general", WORKER), 4000);
  c.returnShown = back.ok; check(back.m);
  await p.page.screenshot({ path: shotPath(SMOKE, "desk", "2-report-back") });
  const gone = await until(p, (m) => !m.lines.some((l) => l.cls.includes("ph-work") || l.cls.includes("ph-return")), 6000);
  c.workGoneAfterReturn = gone.ok;
  // 2. the user's broken line: a report between two cards in the third column of the grid.
  const thirdCol = await p.page.evaluate(`(() => { const loose = document.querySelector(".oc-team.loose .oc-box"); const bx = +loose.getAttribute("x"), bw = +loose.getAttribute("width");
    const cells = [...document.querySelectorAll(".oc-node")].map((g) => ({ n: g.dataset.name, x: +/translate\\(([-\\d.]+) ([-\\d.]+)/.exec(g.getAttribute("transform"))[1], y: +/translate\\(([-\\d.]+) ([-\\d.]+)/.exec(g.getAttribute("transform"))[2] }))
      .filter((c) => ${JSON.stringify(REST)}.includes(c.n));
    const maxX = Math.max(...cells.map((c) => c.x));
    return { boxY: +loose.getAttribute("y"), col: cells.filter((c) => c.x === maxX).sort((a, b) => a.y - b.y).map((c) => c.n) }; })()`) as { boxY: number; col: string[] };
  const [upper, lower] = [thirdCol.col[0], thirdCol.col[thirdCol.col.length - 1]];
  fm.publishTraffic(row(upper, lower, "report", null, "delivering"));
  const inBox = await until(p, (m) => m.lines.some((l) => l.from === upper && l.to === lower));
  const line = inBox.m.lines.find((l) => l.from === upper && l.to === lower);
  c.thirdColumnLineStaysInTheBox = !!line && line.minY >= thirdCol.boxY - 0.5;
  await p.page.screenshot({ path: shotPath(SMOKE, "desk", "3-third-column") });
  fm.publishTraffic(row(upper, lower, "report", null, "delivered"), "consumed");
  // 3. fold the team through its header: its member's line ends at the box.
  await p.page.locator(`.oc-team-head[data-team="${TEAM.name}"] .oc-toggle`).click();
  await p.page.waitForTimeout(400);
  fm.publishTraffic(row("ops-general", TEAM.members[1], "send", null, "delivering"));
  const folded = await until(p, (m) => m.lines.some((l) => l.from === "ops-general" && l.to === `box:${TEAM.name}`));
  c.foldedEndsAtBox = folded.ok; check(folded.m);
  await p.page.screenshot({ path: shotPath(SMOKE, "desk", "4-folded") });
  fm.publishTraffic(row("ops-general", TEAM.members[1], "send", null, "delivered"), "consumed");
  // 4. the paused instance: its line ends on its card.
  fm.publishTraffic(row("general", PAUSED, "send", null, "queued"));
  const paused = await until(p, (m) => m.lines.some((l) => l.from === "general" && l.to === PAUSED));
  c.pausedEndsOnCard = paused.ok; check(paused.m);
  fm.publishTraffic(row("general", PAUSED, "send", null, "cancelled"));
  // 5. a reload while a delegation is open: drawn again from the snapshot.
  await message("ops-general", REST[7], "task", "cid-smoke-2");
  await until(p, (m) => has(m, "h-task ph-work", "ops-general", REST[7]));
  await p.page.reload();
  await p.page.waitForSelector(".oc-svg .oc-node", { timeout: 10000 });
  const reloaded = await until(p, (m) => has(m, "h-task ph-work", "ops-general", REST[7]));
  c.reloadDrawsOpenWork = reloaded.ok; check(reloaded.m);
  await p.page.screenshot({ path: shotPath(SMOKE, "desk", "5-after-reload") });
  // Team headers are drawn above the lines (a line leaving a box through its header ran over the count).
  c.headersAboveLines = await p.page.evaluate(`(() => { const w = [...document.querySelector(".oc-world").children].map((g) => g.getAttribute("class")); return w.indexOf("oc-heads") > w.indexOf("oc-flows"); })()`) as boolean;
  c.noFloatingLine = floats.length === 0;
  c.noErrors = p.errors.length === 0;
  record("desk-light-en", c, { errors: p.errors, floats, thirdCol, line });
  await p.ctx.close();
  await message(REST[7], "ops-general", "report", "cid-smoke-2", 50);           // close it for the next cases
}

// ── phone, LAN, reduced motion, zh-TW ──
if (only("phone")) {
  const p = await freshPage(fx, { device: "phone", theme: "dark", lang: "zh-TW" }, { origin: "lan", reducedMotion: true });
  const c: Record<string, boolean> = {};
  await openCanvas(p);
  await message("general", REST[4], "task", "cid-smoke-3");
  const open = await until(p, (m) => has(m, "h-task ph-work", "general", REST[4]));
  const work = open.m.lines.find((l) => l.cls === "h-task ph-work");
  c.workShown = open.ok;
  c.stillUnderReducedMotion = !!work && work.anim === "none";
  await p.page.locator(".oc-legend summary").click();
  const keyed = await measure(p);
  c.keyInZh = ["進行中（直到回報）", "完成（回報送回）", "尚未回報"].every((s) => keyed.legend.includes(s));
  c.noOverflow = !keyed.overflow;
  c.noFloatingLine = floating(keyed).length === 0;
  await p.page.screenshot({ path: shotPath(SMOKE, "phone", "1-in-progress-key") });
  c.noErrors = p.errors.length === 0;
  record("phone-dark-zh-TW-lan-reduced", c, { errors: p.errors, work, legend: keyed.legend });
  await p.ctx.close();
  await message(REST[4], "general", "report", "cid-smoke-3", 50);
}

// ── the public link (no stream: the snapshot poll) ──
if (only("public")) {
  const link = await openPublicLink(fx);
  const p = await link.publicPage({ device: "phone", theme: "light", lang: "en" }, { reducedMotion: true });
  const c: Record<string, boolean> = {};
  await openCanvas(p);
  await message("general", REST[0], "task", "cid-smoke-4", 100);
  const open = await until(p, (m) => has(m, "h-task ph-work", "general", REST[0]), 9000);
  c.workComesWithThePoll = open.ok;
  await p.page.screenshot({ path: shotPath(SMOKE, "public", "1-in-progress") });
  await message(REST[0], "general", "report", "cid-smoke-4", 100);
  const gone = await until(p, (m) => !m.lines.some((l) => l.cls.includes("ph-work")), 9000);
  c.workGoesOnceReported = gone.ok;
  c.noFloatingLine = floating(gone.m).length === 0;
  c.noErrors = p.errors.length === 0;
  record("public-link-phone-light-en", c, { errors: p.errors });
  await p.ctx.close();
  await link.close();
}

const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `FAIL ${bad.map((b) => b.name).join(", ")}` : "PASS");
await fx.close();
process.exit(bad.length ? 1 : 0);
