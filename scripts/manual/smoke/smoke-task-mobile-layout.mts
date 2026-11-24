// ui-gate: {"name": "Task board: the phone's Tasks page laid out for the width", "hp": 48650}
// The Tasks page on a phone ("plan A", the owner's pick), drawn in real Chromium, desk as the control.
// A phone (390px, touch) shows:
//  1. a project's head in three lines: [← Projects] … [Agent] [+ Main task]; the name with Insights at its right; the
//     description; then the progress line with its bar across the width (the "N in No project" banner under it);
//  2. one toolbar row: [Board | List] … [Filter] [Display] [🔍]; the search field opens from the 🔍 and stays open while it
//     holds words (the 🔍 says so); Esc on an empty field closes it;
//  3. the five statuses as ONE row of pills that scrolls sideways; the picked one is brought into view; a status with no cards
//     is dimmed and can still be picked;
//  4. no frame around the cards: the column's own box (.tb-col) is not drawn, the cards run the full width;
//  5. Home: the title with Agent and "New project" in its row, the search under it;
//  6. every control above measures at least the --tap size (44px) both ways as it is DRAWN into the page (hit box), and a
//     control's visible shape is not drawn bigger (the head's buttons keep their 36px, the pills their 32px);
//  6b. a control's painted shape is the desk's: each corner of a pill is a half circle and a field's corner is --r-sm — the horizontal and
//     the vertical radius, worked out from getComputedStyle with the border taken off (the painted edge is the padding box), are equal
//     (a 44px box with a 22px radius and a 6px transparent border leaves an oval 22 x 16: pointed); Filter / Display / 🔍 when on
//     draw their ring at the painted height (34px), not on the 44px box: the accent-coloured pixels of a screenshot of the control
//     start inside the transparent border, not at its edge; the keyboard focus ring hugs the painted edge.
//  7. nothing scrolls the page sideways; no two controls' 44px boxes share any area (rectangles measured), and a tap at five points of
//     each box (the centre and the four edge middles, 2px in) reaches that control itself (document.elementFromPoint): nothing covers it,
//     no clip cuts it, so the box a number says is the box a finger gets.
// The desk (1366px, mouse) is the control: its head keeps the buttons at the right, the search field is open, there is no 🔍 and
// no pill row, and each status is a framed column. Cards: not changed (no check here; the tile's own smokes cover them).
// The shots are the "before" when run on the base commit with SHOTS_ONLY=1 (same seed; the checks name new things).
//   PW_DIR=<dir with playwright-core> REPO=<checkout> OUT=<dir> MATRIX=desk-light-en,phone-dark-zh-TW HP=48650 \
//   npx tsx scripts/manual/smoke/smoke-task-mobile-layout.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, labelOf, matrix, shotPath, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-task-mobile-layout";
const REPO = process.env.REPO!;
const roster = [{ name: "master", backend: "claude-code" as const, status: "running" as const, general: true }, { name: "nightly", backend: "claude-code" as const, status: "running" as const }];
const fx = await bootFixture({ port: 0, oldPort: Number(process.env.HP ?? 48650), roster, classic: false });
const fm = fx.fm;
const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");
const ANN = { kind: "person", name: "operator" } as const;
const agent = (name: string) => ({ kind: "instance", name }) as const;

/**
 * "Game": open x2, one in progress with sub tasks, one in review for the person — Blocked and Done stay empty (the dimmed pills);
 * "Shop" beside it; and six cards agents opened in no project (the banner and Home's list).
 */
function seed(c: MatrixCase) {
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, `scheduler-${caseName(c)}.db`), () => {}, DEFAULT_SCHEDULER_CONFIG, (n: string) => !!fm.fleetConfig.instances[n]);
  (fm as any).attachTaskBoard(fm.scheduler.db);
  const board = fm.scheduler.db.board;
  const L = (en: string, zh: string) => labelOf(c, { en, zh });
  const game = board.createProject(ANN, { name: L("Game", "遊戲"), description: L("The game's work: seasons, rewards and the leaderboard", "遊戲相關工作：賽季、獎勵與排行榜"), leadInstance: "master" });
  board.createProject(ANN, { name: L("Shop", "商店"), description: L("Storefront and payments", "商店與付款") });
  const main = (title: string, extra: Record<string, unknown> = {}) => board.createCards(ANN, { project: game.id, cards: [{ title, ...extra }] }).cards[0]!.code as string;
  main(L("Serve the weekly leaderboard", "提供每週排行榜"), { assignee: "master" });
  main(L("Pick the badges", "挑選徽章"));
  const season = main(L("Season payout and the notice that goes with it, in every language the game ships", "賽季結算獎勵與推播通知，所有遊戲支援的語言都要有"), { assignee: "nightly", priority: "high" });
  board.moveCard(ANN, season, "claimed");
  const subs = ["Count the points", "Write the notice", "Translate it", "Send a test"].map((t, i) => board.createCards(ANN, { cards: [{ parent: season, title: L(t, ["計算積分", "撰寫通知", "翻譯通知", "發送測試"][i]!), assignee: "nightly" }] }).cards[0]!.code as string);
  for (const s of subs.slice(0, 2)) { board.moveCard(agent("nightly"), s, "claimed"); board.moveCard(agent("nightly"), s, "done", { result: "ok" }); }
  const review = main(L("Check the leaderboard numbers", "核對排行榜數字"), { assignee: "master" });
  board.moveCard(agent("master"), review, "claimed");
  board.moveCard(agent("master"), review, "review", { result: "src/leaderboard.ts" });
  const loose: Array<[string, string, string]> = [
    ["Daily report for the owner", "給擁有者的每日報告", "nightly"], ["Check the nightly backup", "檢查夜間備份", "nightly"], ["Fix checkout copy", "修正結帳頁文案", "master"],
    ["Rotate the API keys", "輪替 API 金鑰", "nightly"], ["Weekly digest of open cards", "每週未完成卡片摘要", "nightly"],
    ["A very long title that an automated run wrote because nobody said where the card belongs", "自動化流程寫的很長標題，因為沒有人說這張卡該放哪個專案，所以只好放在這裡", "nightly"],
  ];
  for (const [en, zh, who] of loose) board.createCards(agent(who), { cards: [{ title: L(en, zh), assignee: who, project: null }] });
  return { game: game.id };
}

const results: any = { smoke: SMOKE, cases: {} };
let failed = 0;
const shotsOnly = !!process.env.SHOTS_ONLY;
const TAP = 44;   // --tap, the style guide's touch minimum (§7)
const SLACK = 0.5;  // rounding only: two controls' 44px boxes share no area (the upstream review: "not overlapping")
const OVERFLOW = `(() => document.documentElement.scrollWidth <= window.innerWidth + 1)()`;
type Box = { x: number; y: number; w: number; h: number };
const r1 = (n: number) => Math.round(n * 10) / 10;
/** A control's hit box (what a finger gets), rounded to a tenth of a pixel. */
async function box(loc: any): Promise<Box | null> {
  const b = await loc.boundingBox();
  return b ? { x: r1(b.x), y: r1(b.y), w: r1(b.width), h: r1(b.height) } : null;
}
const tappable = (b: Box | null) => !!b && b.w >= TAP - 0.5 && b.h >= TAP - 0.5;
const sameRow = (a: Box | null, b: Box | null, tol = 3) => !!a && !!b && Math.abs((a.y + a.h / 2) - (b.y + b.h / 2)) <= tol;
const bottomOf = (b: Box) => b.y + b.h;
/**
 * Where a finger lands: for each control, the centre and the four edge middles of its box (2px in) must hit the control itself
 * (or something inside it) — `document.elementFromPoint`. A box that is covered by a neighbour, or cut by a clipping parent (a
 * scroller), fails here even when its measured size is 44px. Every control is scrolled into view first, inside its scroller too.
 */
const reachScript = `(m) => Object.fromEntries(Object.entries(m).map(([k, s]) => {
  const els = [...document.querySelectorAll(s)];
  if (!els.length) return [k, null];
  return [k, els.map((el) => {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    const r = el.getBoundingClientRect();
    const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.top + r.height / 2], [r.right - 2, r.top + r.height / 2], [r.left + r.width / 2, r.top + 2], [r.left + r.width / 2, r.bottom - 2]];
    return pts.every((p) => { const t = document.elementFromPoint(p[0], p[1]); return !!t && el.contains(t); });
  }).every(Boolean)];
}))`;

/**
 * A shot of the 44px boxes: each control's box outlined over the page (alternating colours, so neighbours read apart). Set through the
 * style object (the CSP forbids a style attribute, not a script's), taken, then removed.
 */
const outlineScript = `(sels) => { const colors = ["#ff3d81", "#00b3ff", "#ffb300", "#7cff4d"]; let n = 0;
  for (const sel of sels) for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.right < 0 || r.left > window.innerWidth) continue;
    const d = document.createElement("div"); const c = colors[n++ % colors.length];
    d.setAttribute("data-tap-box", "");
    for (const [k, v] of Object.entries({ position: "fixed", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px", border: "2px solid " + c, background: c + "26", "pointer-events": "none", "z-index": "99999", "box-sizing": "border-box" })) d.style.setProperty(k, v);
    document.body.appendChild(d);
  } }`;

/**
 * The corners as they are drawn. getComputedStyle gives the radii as written (999px, "16px 22px"); the used radii are those scaled down
 * so that neighbours do not overlap (CSS Backgrounds §5.5), and what is painted is the padding box, so the painted corner is the used radius
 * less the border (sideways: the left / right border; up and down: the top / bottom one). A half circle is rx = ry = painted height / 2.
 */
const radiiScript = `(m) => Object.fromEntries(Object.entries(m).map(([k, s]) => {
  const els = [...document.querySelectorAll(s)];
  if (!els.length) return [k, null];
  return [k, els.map((el) => {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect(), W = r.width, H = r.height;
    const num = (x, ref) => (x.endsWith("%") ? parseFloat(x) / 100 * ref : parseFloat(x));
    const corner = (name) => { const v = cs[name].split(" "); return [num(v[0], W), num(v[1] === undefined ? v[0] : v[1], H)]; };
    const tl = corner("borderTopLeftRadius"), tr = corner("borderTopRightRadius"), br = corner("borderBottomRightRadius"), bl = corner("borderBottomLeftRadius");
    const f = Math.min(1, W / ((tl[0] + tr[0]) || 1e9), W / ((bl[0] + br[0]) || 1e9), H / ((tl[1] + bl[1]) || 1e9), H / ((tr[1] + br[1]) || 1e9));
    const bt = parseFloat(cs.borderTopWidth), bb = parseFloat(cs.borderBottomWidth), bL = parseFloat(cs.borderLeftWidth), bR = parseFloat(cs.borderRightWidth);
    const inner = [[tl, bL, bt], [tr, bR, bt], [br, bR, bb], [bl, bL, bb]].map((c) => [Math.max(0, c[0][0] * f - c[1]), Math.max(0, c[0][1] * f - c[2])]);
    return { ph: H - bt - bb, inner: inner.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]) };
  })];
}))`;

/** The bounding box, in CSS pixels, of the pixels of a PNG that are one of the colours (a Manhattan distance of `tol` or less). Decoded in a page of its own (a canvas). */
const inkScript = (a: { b64: string; colors: number[][]; cw: number; tol: number }) => `(async (a) => {
  const img = new Image(); img.src = "data:image/png;base64," + a.b64; await img.decode();
  const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
  const g = cv.getContext("2d"); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, img.width, img.height).data, k = img.width / a.cw;
  let top = 1e9, bottom = -1, left = 1e9, right = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const o = (y * img.width + x) * 4;
    if (a.colors.some((c) => Math.abs(d[o] - c[0]) + Math.abs(d[o + 1] - c[1]) + Math.abs(d[o + 2] - c[2]) <= a.tol)) { if (y < top) top = y; if (y > bottom) bottom = y; if (x < left) left = x; if (x > right) right = x; }
  }
  return bottom < 0 ? null : { top: top / k, bottom: (bottom + 1) / k, left: left / k, right: (right + 1) / k };
})(${JSON.stringify(a)})`;

/** What a control looks like: its border box less the transparent borders (the hit box a control grew), so "drawn bigger" is measured on the painted box. */
const painted = (loc: any) => loc.evaluate((el: HTMLElement) => {
  const s = getComputedStyle(el) as any, r = el.getBoundingClientRect();
  // a transparent border is the room a control grew for its hit box: not painted (the pattern is a literal: no named helper inside evaluate, esbuild's __name is not in the page)
  const sizes = ["Left", "Right", "Top", "Bottom"].map((side) => (/^(rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0\s*\)|transparent)$/.test(s[`border${side}Color`]) ? parseFloat(s[`border${side}Width`]) : 0));
  return { w: Math.round((r.width - sizes[0]! - sizes[1]!) * 10) / 10, h: Math.round((r.height - sizes[2]! - sizes[3]!) * 10) / 10 };
});

for (const c of matrix(process.env.MATRIX ?? "desk-light-en,phone-dark-zh-TW")) {
  const name = caseName(c);
  const phone = c.device === "phone";
  const ids = seed(c);
  const { ctx, page } = await fx.page(c, { path: "/ui/fleet", storage: { agend_tasks_project: "" } });
  const errors: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 200)));
  const r: any = {};
  const chk: Record<string, boolean> = {};
  const settle = async () => { await page.waitForTimeout(450); };
  const toTop = async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator(".tb-home, .tb-board-page").first().evaluate((el: any) => { for (let n = el; n; n = n.parentElement) n.scrollTop = 0; });
  };
  /** The control boxes that must not overlap: each by a short name. */
  async function tapBoxes(sel: Record<string, string>) {
    const out: Record<string, Box | null> = {};
    for (const [k, s] of Object.entries(sel)) out[k] = await box(page.locator(s).first());
    return out;
  }
  /** Which of the selectors' controls (all matches of each) a tap reaches at five points of its box; `null` = no such control. */
  const reach = (sels: Record<string, string>): Promise<Record<string, boolean | null>> => page.evaluate(`(${reachScript})(${JSON.stringify(sels)})`) as any;
  const outlined = async (file: string, sels: string[]) => {
    await page.evaluate(`(${outlineScript})(${JSON.stringify(sels)})`);
    await page.screenshot({ path: shotPath(SMOKE, c, file) });
    await page.evaluate(() => { for (const d of document.querySelectorAll("[data-tap-box]")) d.remove(); });
  };
  let inkPage: any = null;
  /**
   * Where the pixels of a CSS colour (a custom property of the page) are on a control, relative to its box: a screenshot of the box and 8px round
   * it, decoded in a page of its own. `top` / `bottom` are measured from the box's top edge: a ring on the painted edge starts `--grow` px inside it.
   */
  async function ink(sel: string, vars: string[]) {
    const b: any = await page.locator(sel).first().boundingBox();
    const pad = 8, x0 = Math.max(0, b.x - pad), y0 = Math.max(0, b.y - pad);
    const clip = { x: x0, y: y0, width: Math.min(b.x + b.width + pad, 390) - x0, height: b.height + 2 * pad };
    const colors: number[][] = await page.evaluate((vs: any) => vs.map((v: any) => { const d = document.createElement("div"); d.style.setProperty("color", "var(" + v + ")"); document.body.appendChild(d); const m = getComputedStyle(d).color.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number); d.remove(); return m; }), vars) as any;
    const png = await page.screenshot({ clip });
    inkPage = inkPage || await ctx.newPage();
    const out: any = await inkPage.evaluate(inkScript({ b64: png.toString("base64"), colors, cw: clip.width, tol: 60 }));
    if (!out) return null;
    return { top: r1(clip.y + out.top - b.y), bottom: r1(clip.y + out.bottom - b.y), left: r1(clip.x + out.left - b.x), right: r1(clip.x + out.right - b.x), h: r1(out.bottom - out.top), w: r1(out.right - out.left), box: { h: r1(b.height), w: r1(b.width) } };
  }
  /** The corners of these controls (every match of each), as they are painted: a half circle (kind "pill") or the field's --r-sm (kind "field"). */
  async function corners(sels: Record<string, string>, fields: string[] = []) {
    const m: any = await page.evaluate(`(${radiiScript})(${JSON.stringify(sels)})`);
    const rsm = (await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--r-sm")))) as number;
    const bad: string[] = [];
    for (const [k, list] of Object.entries(m)) {
      if (!list) { bad.push(`${k}: not there`); continue; }
      for (const e of list as any[]) {
        const want = fields.includes(k) ? rsm : e.ph / 2;
        if (!e.inner.every((p: number[]) => Math.abs(p[0] - p[1]) <= 0.75 && Math.abs(p[0] - want) <= 0.75)) bad.push(`${k} ${JSON.stringify(e.inner[0])} (want ${want})`);
      }
    }
    return { bad, m };
  }
  const unreached = (m: Record<string, boolean | null>) => Object.entries(m).filter(([, v]) => v !== true).map(([k]) => k);
  const overlaps = (boxes: Record<string, Box | null>) => {
    const names = Object.keys(boxes).filter((k) => boxes[k]);
    const bad: string[] = [];
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      const a = boxes[names[i]!]!, b = boxes[names[j]!]!;
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > SLACK && oy > SLACK) bad.push(`${names[i]}×${names[j]} ${r1(ox)}×${r1(oy)}`);
    }
    return bad;
  };
  try {
    // ── Home ────────────────────────────────────────────────
    await page.waitForSelector(".tb-home .tb-project", { timeout: 15000 });
    await settle();
    await page.screenshot({ path: shotPath(SMOKE, c, "1-home") });
    if (!shotsOnly) {
      const head = await tapBoxes({ title: ".tb-home .tb-head h2", agent: ".tb-home .tb-head-actions .btn:not(.btn-primary)", add: ".tb-home .tb-head-actions .btn-primary", search: ".tb-home .tb-search input" });
      r.homeHead = head;
      if (phone) {
        chk.homeActionsInTitleRow = sameRow(head.title, head.agent) && sameRow(head.title, head.add) && head.agent!.x > head.title!.x + head.title!.w - 1 && head.add!.x > head.agent!.x;
        chk.homeActionsAtTheRight = !!head.add && head.add.x + head.add.w >= 390 - 24;
        chk.homeSearchUnderTheTitle = !!head.search && head.search.y >= bottomOf(head.agent!) - SLACK && head.search.w >= 390 - 48;
        chk.homeAgentTappable = tappable(head.agent);
        chk.homeAddTappable = tappable(head.add);
        chk.homeSearchTappable = tappable(head.search);
        r.homeAgentDrawn = await painted(page.locator(".tb-home .tb-head-actions .btn:not(.btn-primary)"));
        r.homeSearchDrawn = await painted(page.locator(".tb-home .tb-search input"));
        chk.homeButtonsNotDrawnBigger = r.homeAgentDrawn.h <= 38;
        chk.homeSearchNotDrawnBigger = r.homeSearchDrawn.h <= 38;
        chk.homeNoOverlap = overlaps(head).length === 0;
        r.homeUnreached = unreached(await reach({ agent: ".tb-home .tb-head-actions .btn:not(.btn-primary)", add: ".tb-home .tb-head-actions .btn-primary", search: ".tb-home .tb-search input" }));
        chk.homeBoxesReachTheControl = r.homeUnreached.length === 0;
        const hc = await corners({ agent: ".tb-home .tb-head-actions .btn:not(.btn-primary)", add: ".tb-home .tb-head-actions .btn-primary", search: ".tb-home .tb-search input", pick: ".tb-sort-pick" }, ["search"]);
        r.homeCorners = hc.m; r.homeCornersBad = hc.bad;
        chk.homeCornersAreTheDesks = hc.bad.length === 0;
        await outlined("9b-tap-boxes-home", [".tb-home .tb-head-actions .btn", ".tb-home .tb-search input", ".tb-sort-row .tb-wait-title", ".tb-sort-row .tb-sort-pick", ".tb-wait-actions .btn"]);
        r.homeOverlaps = overlaps(head);
      } else {
        // the desk keeps the page head as it was: the title at the left, the search, Agent and New project in a row at the right
        chk.deskHomeHeadInARow = sameRow(head.title, head.agent, 14) && head.add!.x > head.agent!.x && head.search!.x > head.title!.x + head.title!.w;
        r.deskHomeButtonH = head.agent!.h;
        chk.deskHomeStaysDense = head.agent!.h < TAP && head.search!.h < TAP;
      }
      chk.homeNoSidewaysScroll = await page.evaluate(OVERFLOW) as boolean;
    }

    // ── A project's board ───────────────────────────────────
    await page.locator(".tb-project").filter({ has: page.locator(".tb-project-name", { hasText: new RegExp(`^${labelOf(c, { en: "Game", zh: "遊戲" })}$`) }) }).locator(".tb-project-open").click();
    await page.waitForSelector(".tb-board-page", { timeout: 10000 });
    await settle();
    await toTop();
    await page.screenshot({ path: shotPath(SMOKE, c, "2-board") });
    if (shotsOnly && phone) {   // the first status (Open: three cards)
      await page.locator(".tb-status-seg .tb-seg-btn").first().click(); await page.waitForTimeout(350);
      await page.screenshot({ path: shotPath(SMOKE, c, "2b-board-open-status") });
    }
    if (!shotsOnly) {
      const B = await tapBoxes({
        back: ".tb-head-back", agent: ".tb-head-actions .btn:not(.btn-primary)", add: ".tb-head-actions .btn-primary", name: ".tb-name h2", insights: ".tb-insights",
        lead: ".tb-head-lead", pct: ".tb-progress .tb-pct", banner: ".tb-sort-link",
        board: ".tb-view-toggle .tb-seg-btn:nth-child(1)", list: ".tb-view-toggle .tb-seg-btn:nth-child(2)", filter: ".tb-filter-menu > button", display: ".tb-view-menu > button", find: ".tb-search-toggle",
      });
      r.head = B;
      const bar = await page.locator(".tb-progress .tb-bar, .tb-progress [role=progressbar], .tb-progress progress").first().boundingBox().catch(() => null);
      r.bar = bar;
      const seg = await tapBoxes({ seg: ".tb-status-seg" });
      if (phone) {
        // 1. the head
        chk.headRowOne = sameRow(B.back, B.agent) && sameRow(B.back, B.add) && B.back!.x < B.agent!.x && B.agent!.x < B.add!.x;
        chk.headActionsAtTheRight = !!B.add && B.add.x + B.add.w >= 390 - 24;
        chk.headRowTwo = !!B.name && !!B.insights && sameRow(B.name, B.insights, 6) && B.insights.x > B.name.x + 1;
        chk.insightsAtTheRight = !!B.insights && B.insights.x + B.insights.w >= 390 - 24;
        chk.nameUnderTheButtons = !!B.name && B.name.y >= bottomOf(B.back!) - SLACK - 2;
        chk.leadUnderTheName = !!B.lead && B.lead.y >= bottomOf(B.name!) - 2;
        chk.progressUnderTheLead = !!B.pct && B.pct.y >= bottomOf(B.lead!) - 2;
        // the bar takes what the numbers leave: the line is full (its last item ends at the page's edge) and the bar is not a stub
        const lineEnd = await page.locator(".tb-progress").evaluate((el: any) => Math.max(...[...el.children].filter((k: any) => k.getBoundingClientRect().top < el.getBoundingClientRect().top + 8).map((k: any) => k.getBoundingClientRect().right)));
        r.progressLineEnd = lineEnd;
        chk.barAcrossTheWidth = !!bar && bar.width >= 100 && lineEnd >= 390 - 16 - 2;
        chk.bannerOwnLine = !!B.banner && B.banner.y >= bottomOf(B.pct!) - 2 && B.banner.w >= 390 - 40;
        // 2. the toolbar: one row, the field closed
        chk.toolbarOneRow = sameRow(B.board, B.filter) && sameRow(B.board, B.display) && sameRow(B.board, B.find) && B.board!.x < B.list!.x && B.filter!.x < B.display!.x && B.display!.x < B.find!.x;
        chk.toolbarAtTheRight = !!B.find && B.find.x + B.find.w >= 390 - 24;
        chk.toolbarUnderTheBanner = !!B.board && B.board.y >= bottomOf(B.banner!) - SLACK;
        chk.searchClosed = !(await page.locator(".tb-find input").isVisible());
        // 3. the status row: one line, scrolls, the picked status is in view
        const pills = page.locator(".tb-status-seg .tb-seg-btn");
        const n = await pills.count();
        r.pills = n;
        chk.fivePills = n === 5;
        const tops = await Promise.all((await pills.all()).map(async (p: any) => (await box(p))!.y));
        chk.pillsOneLine = tops.every((y) => Math.abs(y - tops[0]!) <= 1);
        const sc = await page.locator(".tb-status-seg").evaluate((el: any) => ({ sw: el.scrollWidth, cw: el.clientWidth, left: el.scrollLeft, ox: getComputedStyle(el).overflowX }));
        r.pillScroller = sc;
        chk.pillsScrollSideways = sc.sw > sc.cw + 1 && /auto|scroll/.test(sc.ox);
        const inView = (sel: string) => page.evaluate((s) => {
          const p = document.querySelector(s) as HTMLElement | null, z = document.querySelector(".tb-status-seg") as HTMLElement | null;
          if (!p || !z) return false;
          const a = p.getBoundingClientRect(), b = z.getBoundingClientRect();
          return a.left >= b.left - 1 && a.right <= b.right + 1;
        }, sel);
        chk.pickedPillInView = await inView(".tb-status-seg .tb-seg-btn.active");   // Review is the 4th: it had to be scrolled to
        r.activePill = (await page.locator(".tb-status-seg .tb-seg-btn.active").innerText()).trim().replace(/\s+/g, " ");
        // zero-count pills: dimmed, still pickable
        const zero = page.locator(".tb-status-seg .tb-seg-btn.is-empty");
        r.emptyPills = await zero.count();
        chk.emptyPillsDimmed = r.emptyPills === 2 && (await zero.first().evaluate((el: any) => Number(getComputedStyle(el).opacity) < 1 || getComputedStyle(el).color !== getComputedStyle(document.querySelector(".tb-status-seg .tb-seg-btn:not(.is-empty):not(.active)")!).color));
        // 6. the controls, drawn and as hit
        const taps: Record<string, Box | null> = { back: B.back, agent: B.agent, add: B.add, insights: B.insights, banner: B.banner, board: B.board, list: B.list, filter: B.filter, display: B.display, find: B.find };
        for (const [k, b] of Object.entries(taps)) chk[`${k}Tappable`] = tappable(b);
        const pillBoxes = await Promise.all((await pills.all()).map((p: any) => box(p)));
        r.pillBoxes = pillBoxes;
        chk.pillsTappable = pillBoxes.every(tappable);
        const drawn = { agent: await painted(page.locator(".tb-head-actions .btn:not(.btn-primary)")), add: await painted(page.locator(".tb-head-actions .btn-primary")), filter: await painted(page.locator(".tb-filter-menu > button")), find: await painted(page.locator(".tb-search-toggle")), pill: await painted(pills.first()), insights: await painted(page.locator(".tb-insights")) };
        r.drawn = drawn;
        chk.controlsNotDrawnBigger = drawn.agent.h <= 38 && drawn.add.h <= 38 && drawn.filter.h <= 38 && drawn.find.h <= 38 && drawn.pill.h <= 38 && drawn.insights.h <= 38;
        const tile0 = await box(page.locator(".tb-col.is-current .tb-tile").first());
        const allTaps = { ...taps, ...Object.fromEntries(pillBoxes.map((b, i) => [`pill${i}`, b])), tile: tile0 };
        r.overlaps = overlaps(allTaps);
        chk.noTapBoxesOverlap = r.overlaps.length === 0;
        // a tap reaches the control at five points of its box (each pill is scrolled into its row first)
        r.unreached = unreached(await reach({ back: ".tb-head-back", agent: ".tb-head-actions .btn:not(.btn-primary)", add: ".tb-head-actions .btn-primary", insights: ".tb-insights", banner: ".tb-sort-link",
          board: ".tb-view-toggle .tb-seg-btn:nth-child(1)", list: ".tb-view-toggle .tb-seg-btn:nth-child(2)", filter: ".tb-filter-menu > button", display: ".tb-view-menu > button", find: ".tb-search-toggle", pills: ".tb-status-seg .tb-seg-btn" }));
        chk.boxesReachTheControl = r.unreached.length === 0;
        // the corners as painted: every pill and button is a half circle at both ends, not an oval
        const bc = await corners({ back: ".tb-head-back", agent: ".tb-head-actions .btn:not(.btn-primary)", add: ".tb-head-actions .btn-primary", insights: ".tb-insights", board: ".tb-view-toggle .tb-seg-btn:nth-child(1)", list: ".tb-view-toggle .tb-seg-btn:nth-child(2)",
          filter: ".tb-filter-menu > button", display: ".tb-view-menu > button", find: ".tb-search-toggle", pills: ".tb-status-seg .tb-seg-btn" });
        r.corners = bc.m; r.cornersBad = bc.bad;
        chk.cornersAreTheDesks = bc.bad.length === 0;
        await page.locator(".tb-status-seg").evaluate((el: any) => { el.scrollLeft = 0; });
        await page.evaluate(() => window.scrollTo(0, 0));
        await outlined("9-tap-boxes-board", [".tb-head-back", ".tb-head-actions .btn", ".tb-insights", ".tb-sort-link", ".tb-view-toggle .tb-seg-btn", ".tb-view-actions .btn", ".tb-status-seg .tb-seg-btn", ".tb-col.is-current .tb-tile"]);
        // 4. no frame: the column's own box is not drawn, the cards run the full width
        const frame = await page.locator(".tb-col.is-current").evaluate((el: any) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, bw: s.borderTopWidth, bs: s.borderTopStyle, bc: s.borderTopColor, pad: s.paddingLeft, rad: s.borderTopLeftRadius }; });
        r.frame = frame;
        chk.noColumnFrame = (/rgba\(0, 0, 0, 0\)|transparent/.test(frame.bg)) && frame.pad === "0px" && (frame.bs === "none" || frame.bw === "0px" || /rgba\(0, 0, 0, 0\)|transparent/.test(frame.bc));
        const tile = await tapBoxes({ tile: ".tb-col.is-current .tb-tile" });
        const page_ = await box(page.locator(".tb-board-page"));
        r.tile = tile.tile; r.pageBox = page_;
        chk.tileFullWidth = !!tile.tile && !!page_ && tile.tile.w >= page_.w - 1;
        chk.noSidewaysScroll = await page.evaluate(OVERFLOW) as boolean;
        // no box round the board scrolls sideways (the pill row bleeds into the page's padding, which is not an overflow of the page)
        chk.boardNoSidewaysScroll = await page.locator(".tb-board-page").evaluate((el: any) => {
          for (let n = el; n; n = n.parentElement) if (n.scrollWidth > n.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(n).overflowX) && n !== el) return false;
          return el.getBoundingClientRect().right <= window.innerWidth + 1;
        });
        // what reaches past the page, when something does (a diagnostic: named in the result)
        r.pastTheEdge = await page.locator(".tb-board-page *").evaluateAll((els: any[]) => els.filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5 && el.getBoundingClientRect().width > 0 && !el.closest(".tb-status-seg"))
          .slice(0, 6).map((el) => `${el.tagName.toLowerCase()}.${String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).split(" ").join(".")} ${Math.round(el.getBoundingClientRect().right)}`));
        // another status (an empty one too): the pill is picked, the row keeps it in view, the page does not scroll sideways
        await pills.nth(0).click(); await page.waitForTimeout(250);
        chk.firstPillPicks = (await pills.nth(0).getAttribute("aria-pressed")) === "true" && (await page.locator(".tb-col.is-current").count()) === 1;
        chk.firstPillInView = await inView(".tb-status-seg .tb-seg-btn.active");
        await page.screenshot({ path: shotPath(SMOKE, c, "2b-board-open-status") });
        await pills.nth(4).click(); await page.waitForTimeout(450);   // Done: empty, still pickable
        chk.emptyPillPicks = (await pills.nth(4).getAttribute("aria-pressed")) === "true";
        chk.lastPillInView = await inView(".tb-status-seg .tb-seg-btn.active");
        await page.screenshot({ path: shotPath(SMOKE, c, "3-board-empty-status") });
        await pills.nth(0).click(); await page.waitForTimeout(250);
        // the row scrolls by hand
        await page.locator(".tb-status-seg").evaluate((el: any) => { el.scrollLeft = 0; }); await page.waitForTimeout(100);
        await page.locator(".tb-status-seg").evaluate((el: any) => { el.scrollLeft = 80; }); await page.waitForTimeout(100);
        chk.pillRowScrollsByHand = (await page.locator(".tb-status-seg").evaluate((el: any) => el.scrollLeft)) > 40;
        await page.locator(".tb-status-seg").evaluate((el: any) => { el.scrollLeft = 0; });
        // the search: opens from the 🔍, focused; kept open while it holds words, and the 🔍 says so; Esc on an empty field closes it
        await page.locator(".tb-search-toggle").click(); await page.waitForTimeout(250);
        chk.searchOpens = await page.locator(".tb-find input").isVisible();
        chk.searchFocused = await page.evaluate(() => document.activeElement === document.querySelector(".tb-find input"));
        chk.findPressed = (await page.locator(".tb-search-toggle").getAttribute("aria-expanded")) === "true";
        const field = await box(page.locator(".tb-find input"));
        r.field = field;
        chk.searchFullWidthUnderToolbar = !!field && field.w >= 390 - 40 && field.y >= bottomOf(B.board!) - SLACK;
        chk.searchTappable = tappable(field);
        const open = await tapBoxes({ board: ".tb-view-toggle .tb-seg-btn:nth-child(1)", list: ".tb-view-toggle .tb-seg-btn:nth-child(2)", filter: ".tb-filter-menu > button", display: ".tb-view-menu > button", find: ".tb-search-toggle", field: ".tb-find input", pill0: ".tb-status-seg .tb-seg-btn:nth-child(1)", banner: ".tb-sort-link" });
        r.openOverlaps = overlaps(open);
        chk.openToolbarNoOverlap = r.openOverlaps.length === 0;
        r.openUnreached = unreached(await reach({ field: ".tb-find input", find: ".tb-search-toggle", board: ".tb-view-toggle .tb-seg-btn:nth-child(1)", pills: ".tb-status-seg .tb-seg-btn" }));
        chk.openBoxesReachTheControl = r.openUnreached.length === 0;
        await page.evaluate(() => window.scrollTo(0, 0));
        chk.searchNoSidewaysScroll = await page.evaluate(OVERFLOW) as boolean;
        await page.screenshot({ path: shotPath(SMOKE, c, "4-board-search-open") });
        await page.locator(".tb-find input").fill(labelOf(c, { en: "leader", zh: "排行榜" })); await page.waitForTimeout(350);
        chk.searchFilters = (await page.locator(".tb-col.is-current .tb-tile").count()) >= 1 && (await page.locator(".tb-col.is-current .tb-tile").count()) <= 2;
        await page.locator(".tb-find input").blur();
        await page.locator(".tb-search-toggle").click(); await page.waitForTimeout(250);   // with words in it, the 🔍 does not shut the field
        chk.searchStaysWithWords = await page.locator(".tb-find input").isVisible();
        {   // the 🔍 is on (words in the search): its blue is a ring on the painted 34px, not on the 44px box
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await page.mouse.move(195, 820); await page.waitForTimeout(200);
          const fc = await corners({ field: ".tb-find input" }, ["field"]);
          r.fieldCorners = fc.m; chk.fieldCornerIsTheDesks = fc.bad.length === 0;
          const dr = (await painted(page.locator(".tb-view-menu > button"))).h, ring = await ink(".tb-search-toggle", ["--accent"]);
          r.findRing = { ring, drawn: dr };
          chk.findRingIsThePaintedShape = !!ring && Math.abs(ring.h - dr) <= 1.5 && Math.abs(ring.w - dr) <= 1.5 && ring.top >= (ring.box.h - dr) / 2 - 1.5 && ring.top <= (ring.box.h - dr) / 2 + 1.5;
        }
        chk.findMarkedWithWords = await page.locator(".tb-search-toggle").evaluate((el: any) => el.classList.contains("active") || el.getAttribute("data-has-query") === "true");
        await page.screenshot({ path: shotPath(SMOKE, c, "5-board-search-words") });
        // a board read again from the address keeps the search (it is kept on the device) and opens the field
        await page.reload({ waitUntil: "load" }); await page.waitForSelector(".tb-board-page", { timeout: 10000 }); await settle();
        chk.searchOpenAfterReload = await page.locator(".tb-find input").isVisible() && (await page.locator(".tb-find input").inputValue()) !== "";
        await page.locator(".tb-find input").fill(""); await page.waitForTimeout(250);
        await page.locator(".tb-find input").focus(); await page.keyboard.press("Escape"); await page.waitForTimeout(250);
        chk.escapeOnEmptyCloses = !(await page.locator(".tb-find input").isVisible());
        // the list view: the same toolbar, the same head
        await page.locator(".tb-view-toggle .tb-seg-btn:nth-child(2)").click(); await page.waitForTimeout(450);
        chk.listHasNoPillRow = !(await page.locator(".tb-status-seg").count()) || !(await page.locator(".tb-status-seg").isVisible());
        chk.listNoSidewaysScroll = await page.evaluate(OVERFLOW) as boolean;
        await page.screenshot({ path: shotPath(SMOKE, c, "6-board-list") });
        await page.locator(".tb-view-toggle .tb-seg-btn:nth-child(1)").click(); await page.waitForTimeout(350);
        // the menus open inside the screen (Filter and Display sit at the right edge)
        for (const [k, sel] of [["filter", ".tb-filter-menu"], ["display", ".tb-view-menu"]] as const) {
          await page.locator(`${sel} > button`).click(); await page.waitForTimeout(250);
          const menu = await box(page.locator(`${sel} .menu-list`));
          chk[`${k}MenuInScreen`] = !!menu && menu.x >= 0 && menu.x + menu.w <= 390 + 0.5;
          if (k === "filter") await page.screenshot({ path: shotPath(SMOKE, c, "7-filter-menu") });
          await page.keyboard.press("Escape"); await page.waitForTimeout(150);
        }
        // a filter in force: its chip is under the toolbar row (not in it), across the page's width; nothing scrolls sideways
        await page.locator(".tb-filter-menu > button").click(); await page.waitForTimeout(250);
        await page.locator(".tb-filter-menu [role=menuitemcheckbox]").filter({ hasText: /^nightly$/ }).click(); await page.waitForTimeout(300);
        await page.keyboard.press("Escape"); await page.waitForTimeout(250);   // a tick keeps the menu open
        const chip = await box(page.locator(".tb-chip").first());
        r.chip = chip;
        chk.chipUnderTheToolbar = !!chip && chip.y >= bottomOf(B.board!) - SLACK && chip.x + chip.w <= 390;
        chk.chipNoSidewaysScroll = await page.evaluate(OVERFLOW) as boolean;
        chk.filterButtonMarked = await page.locator(".tb-filter-menu > button").evaluate((el: any) => el.classList.contains("active"));
        {   // Filter is on: its blue ring is drawn on the painted 34px (the same size as Display beside it), not on the 44px box
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await page.mouse.move(195, 820); await page.waitForTimeout(200);
          // the reference is Display, beside it and not on: its painted height (34). Filter's own painted height would be 44 if the border were coloured.
          const dr = (await painted(page.locator(".tb-view-menu > button"))).h, ring = await ink(".tb-filter-menu > button", ["--accent"]);
          r.filterRing = { ring, drawn: dr };
          chk.filterRingIsThePaintedShape = !!ring && Math.abs(ring.h - dr) <= 1.5 && ring.top >= (ring.box.h - dr) / 2 - 1.5 && ring.top <= (ring.box.h - dr) / 2 + 1.5 && ring.bottom <= ring.box.h - (ring.box.h - dr) / 2 + 1.5;
          // no pixel of the accent in the grown (transparent) border: the rows from the box's edge to the painted edge are clear
          chk.filterRingClearOfTheGrownBorder = !!ring && ring.top >= (ring.box.h - dr) / 2 - 1.5;
          // the keyboard focus ring: on Display (not on) and on the first pill, it hugs the painted edge: painted + 2 x (offset + 2px line)
          await page.locator(".tb-view-toggle .tb-seg-btn:nth-child(2)").focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await page.waitForTimeout(200);
          const onDisplay = await page.evaluate(() => document.activeElement === document.querySelector(".tb-view-menu > button"));
          const dd = (await painted(page.locator(".tb-view-menu > button"))).h, fr = await ink(".tb-view-menu > button", ["--focus"]);
          r.focusRing = { onDisplay, ring: fr, drawn: dd };
          chk.focusRingHugsThePaintedEdge = onDisplay && !!fr && Math.abs(fr.h - (dd + 8)) <= 1.5 && fr.top >= (fr.box.h - dd) / 2 - 4 - 1.5;
          await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await page.waitForTimeout(200);   // 🔍, then (the filter's chip: its three buttons, "Clear") — find the first pill by key
          for (let i = 0; i < 8 && !(await page.evaluate(() => !!document.activeElement?.closest(".tb-status-seg"))); i++) await page.keyboard.press("Tab");
          const pf = await ink(".tb-status-seg .tb-seg-btn:focus-visible", ["--focus"]).catch(() => null);
          r.pillFocusRing = pf;
          chk.pillFocusRingHugsThePaintedEdge = !!pf && Math.abs(pf.h - (32 + 6)) <= 1.5;
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        }
        await page.screenshot({ path: shotPath(SMOKE, c, "7b-board-filter-chip") });
        await page.locator(".tb-chip-x").first().click(); await page.waitForTimeout(350);
        // Insights: the button opens its dialog
        await page.locator(".tb-insights").click(); await page.waitForTimeout(450);
        chk.insightsOpens = (await page.locator("dialog[open]").count()) === 1;
        await page.keyboard.press("Escape"); await page.waitForTimeout(250);
        // a narrower phone (360px, the common Android width): whatever the head and the toolbar do to fit, no box overlaps another, nothing
        // is cut off and nothing scrolls the page sideways
        await page.setViewportSize({ width: 360, height: 740 }); await page.waitForTimeout(700);
        await page.evaluate(() => window.scrollTo(0, 0));
        const N = await tapBoxes({ back: ".tb-head-back", agent: ".tb-head-actions .btn:not(.btn-primary)", add: ".tb-head-actions .btn-primary", insights: ".tb-insights", banner: ".tb-sort-link", board: ".tb-view-toggle .tb-seg-btn:nth-child(1)",
          list: ".tb-view-toggle .tb-seg-btn:nth-child(2)", filter: ".tb-filter-menu > button", display: ".tb-view-menu > button", find: ".tb-search-toggle", pill0: ".tb-status-seg .tb-seg-btn:nth-child(1)", tile: ".tb-col.is-current .tb-tile" });
        r.narrow = N;
        r.narrowOverlaps = overlaps(N);
        chk.narrowNoTapBoxesOverlap = r.narrowOverlaps.length === 0;
        r.narrowUnreached = unreached(await reach({ back: ".tb-head-back", agent: ".tb-head-actions .btn:not(.btn-primary)", add: ".tb-head-actions .btn-primary", insights: ".tb-insights", board: ".tb-view-toggle .tb-seg-btn:nth-child(1)", filter: ".tb-filter-menu > button", display: ".tb-view-menu > button", find: ".tb-search-toggle", pills: ".tb-status-seg .tb-seg-btn" }));
        chk.narrowBoxesReachTheControl = r.narrowUnreached.length === 0;
        chk.narrowTappable = Object.entries(N).every(([k, b]) => ["banner", "tile", "pill0"].includes(k) || tappable(b));
        chk.narrowNoSidewaysScroll = await page.evaluate(OVERFLOW) as boolean;
        chk.narrowInsideTheScreen = Object.entries(N).every(([k, b]) => !b || (b.x >= -0.5 && b.x + b.w <= 360 + 0.5) || k === "pill0");
        await page.screenshot({ path: shotPath(SMOKE, c, "8a-narrow-360-board") });
        await page.locator(".tb-head-back").click(); await page.waitForSelector(".tb-home .tb-project", { timeout: 10000 }); await page.waitForTimeout(500);
        const NH = await tapBoxes({ title: ".tb-home .tb-head h2", agent: ".tb-home .tb-head-actions .btn:not(.btn-primary)", add: ".tb-home .tb-head-actions .btn-primary", search: ".tb-home .tb-search input" });
        r.narrowHome = NH;
        r.narrowHomeOverlaps = overlaps(NH);
        chk.narrowHomeNoOverlap = r.narrowHomeOverlaps.length === 0;
        chk.narrowHomeTappable = tappable(NH.agent) && tappable(NH.add) && tappable(NH.search);
        r.narrowHomeUnreached = unreached(await reach({ agent: ".tb-home .tb-head-actions .btn:not(.btn-primary)", add: ".tb-home .tb-head-actions .btn-primary", search: ".tb-home .tb-search input" }));
        chk.narrowHomeBoxesReachTheControl = r.narrowHomeUnreached.length === 0;
        chk.narrowHomeOneRow = sameRow(NH.title, NH.agent, 8) && sameRow(NH.title, NH.add, 8);
        chk.narrowHomeNoSidewaysScroll = await page.evaluate(OVERFLOW) as boolean;
        chk.narrowHomeInsideTheScreen = Object.values(NH).every((b) => !b || (b.x >= -0.5 && b.x + b.w <= 360 + 0.5));
        await page.screenshot({ path: shotPath(SMOKE, c, "8b-narrow-360-home") });
        await page.locator(".tb-project").filter({ has: page.locator(".tb-project-name", { hasText: new RegExp(`^${labelOf(c, { en: "Game", zh: "遊戲" })}$`) }) }).locator(".tb-project-open").click();
        await page.waitForSelector(".tb-board-page", { timeout: 10000 }); await page.waitForTimeout(400);
        // a touch screen wider than a phone (a tablet on its side: touch, 1024px) keeps the desk's layout; its controls get the 44px boxes too
        await page.setViewportSize({ width: 1024, height: 768 }); await page.waitForTimeout(900);
        const T = await tapBoxes({ back: ".tb-head-back", agent: ".tb-head-actions .btn:not(.btn-primary)", add: ".tb-head-actions .btn-primary", insights: ".tb-insights", board: ".tb-view-toggle .tb-seg-btn:nth-child(1)",
          list: ".tb-view-toggle .tb-seg-btn:nth-child(2)", filter: ".tb-filter-menu > button", display: ".tb-view-menu > button", find: ".tb-find input", scrollL: ".tb-scroll-nav .tb-seg-btn:nth-child(1)", scrollR: ".tb-scroll-nav .tb-seg-btn:nth-child(2)" });
        r.tablet = T;
        chk.tabletKeepsTheDeskLayout = !(await page.locator(".tb-status-seg").isVisible()) && !(await page.locator(".tb-search-toggle").isVisible()) && (await page.locator(".tb-find input").isVisible())
          && (await page.locator(".tb-col").evaluateAll((els: any[]) => els.length === 5 && els.every((el) => getComputedStyle(el).display !== "none" && getComputedStyle(el).backgroundColor !== "rgba(0, 0, 0, 0)")))
          && !!T.add && T.add.x > 1024 / 2 && !!T.insights && !!T.board && sameRow(T.board, T.filter, 14);
        r.tabletTaps = Object.fromEntries(Object.entries(T).map(([k, b]) => [k, b && tappable(b)]));
        chk.tabletTappable = Object.entries(T).every(([k, b]) => (k.startsWith("scroll") && !b) || tappable(b));
        chk.tabletScrollButtonsThere = !!T.scrollL && !!T.scrollR;
        const tc = await corners({ back: ".tb-head-back", agent: ".tb-head-actions .btn:not(.btn-primary)", add: ".tb-head-actions .btn-primary", insights: ".tb-insights", board: ".tb-view-toggle .tb-seg-btn:nth-child(1)", list: ".tb-view-toggle .tb-seg-btn:nth-child(2)",
          filter: ".tb-filter-menu > button", display: ".tb-view-menu > button", scrollL: ".tb-scroll-nav .tb-seg-btn:nth-child(1)", scrollR: ".tb-scroll-nav .tb-seg-btn:nth-child(2)", field: ".tb-find input" }, ["field"]);
        r.tabletCorners = tc.m; r.tabletCornersBad = tc.bad;
        chk.tabletCornersAreTheDesks = tc.bad.length === 0;
        r.tabletOverlaps = overlaps({ ...T, banner: await box(page.locator(".tb-sort-link")) });
        chk.tabletNoTapBoxesOverlap = r.tabletOverlaps.length === 0;
        r.tabletUnreached = unreached(await reach({ back: ".tb-head-back", agent: ".tb-head-actions .btn:not(.btn-primary)", add: ".tb-head-actions .btn-primary", insights: ".tb-insights", board: ".tb-view-toggle .tb-seg-btn:nth-child(1)",
          list: ".tb-view-toggle .tb-seg-btn:nth-child(2)", filter: ".tb-filter-menu > button", display: ".tb-view-menu > button", find: ".tb-find input", scrollL: ".tb-scroll-nav .tb-seg-btn:nth-child(1)", scrollR: ".tb-scroll-nav .tb-seg-btn:nth-child(2)" }));
        chk.tabletBoxesReachTheControl = r.tabletUnreached.length === 0;
        chk.tabletNoSidewaysScroll = await page.evaluate(OVERFLOW) as boolean;
        await page.screenshot({ path: shotPath(SMOKE, c, "8-tablet-board") });
        // 2x close-ups (the device pixel ratio is raised for these shots only, at the end): the toolbar and the pill row with Filter on, and Filter's menu open
        await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(600);
        const cdp = await ctx.newCDPSession(page);
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
        await page.waitForTimeout(700);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.locator(".tb-filter-menu > button").click(); await page.waitForTimeout(250);
        await page.locator(".tb-filter-menu [role=menuitemcheckbox]").filter({ hasText: /^nightly$/ }).click(); await page.waitForTimeout(300);
        await page.keyboard.press("Escape"); await page.waitForTimeout(250);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await page.mouse.move(195, 830); await page.waitForTimeout(250);
        const tbar: any = await box(page.locator(".tb-view-bar")), seg: any = await box(page.locator(".tb-status-seg"));
        await page.screenshot({ path: shotPath(SMOKE, c, "10-closeup-2x-pills-filter-on"), clip: { x: 0, y: tbar.y - 8, width: 390, height: seg.y + seg.h - tbar.y + 16 } });
        await page.locator(".tb-filter-menu > button").click(); await page.waitForTimeout(350);
        await page.screenshot({ path: shotPath(SMOKE, c, "10b-closeup-2x-filter-menu-open"), clip: { x: 0, y: tbar.y - 8, width: 390, height: 380 } });
        await page.keyboard.press("Escape"); await page.waitForTimeout(150);
      } else {
        // the desk, as it was: the head's buttons at the right of the title, the search open, no 🔍, no pill row, a framed column each
        chk.deskActionsAtTheRight = !!B.add && B.add.x > 1366 / 2;
        chk.deskInsightsInTheStatsLine = !!B.insights && !!B.pct && sameRow(B.insights, B.pct, 8) && B.insights.x > B.pct.x;
        chk.deskSearchOpen = await page.locator(".tb-find input").isVisible();
        chk.deskNoSearchToggle = !(await page.locator(".tb-search-toggle").isVisible());
        chk.deskNoPillRow = !(await page.locator(".tb-status-seg").isVisible());
        const frames = await page.locator(".tb-col").evaluateAll((els: any[]) => els.map((el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, pad: s.paddingLeft, rad: s.borderTopLeftRadius }; }));
        r.deskColumns = frames.length;
        chk.deskFiveFramedColumns = frames.length === 5 && frames.every((f) => !/rgba\(0, 0, 0, 0\)/.test(f.bg) && f.pad !== "0px" && f.rad !== "0px");
        chk.deskToolbarInARow = sameRow(B.board, B.filter, 14) && sameRow(B.board, B.display, 14);
        r.deskBtnH = { agent: B.agent!.h, filter: B.filter!.h };
        chk.deskStaysDense = B.agent!.h < TAP && B.filter!.h < TAP && B.back!.h < TAP;
        const dc = await corners({ back: ".tb-head-back", agent: ".tb-head-actions .btn:not(.btn-primary)", add: ".tb-head-actions .btn-primary", insights: ".tb-insights", board: ".tb-view-toggle .tb-seg-btn:nth-child(1)", list: ".tb-view-toggle .tb-seg-btn:nth-child(2)",
          filter: ".tb-filter-menu > button", display: ".tb-view-menu > button", field: ".tb-find input" }, ["field"]);
        r.deskCorners = dc.m; chk.deskCornersAreRound = dc.bad.length === 0;
        chk.noSidewaysScroll = await page.evaluate(OVERFLOW) as boolean;
      }
    }
  } catch (e) { r.error = String(e).slice(0, 500); chk.ranToTheEnd = false; await page.screenshot({ path: shotPath(SMOKE, c, "failure") }).catch(() => {}); }
  await ctx.close();
  r.checks = chk; r.errors = errors; r.game = ids.game;
  const bad = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length || errors.length) failed++;
  console.log(`${bad.length || errors.length ? "FAIL" : "ok  "} ${name}${bad.length ? ` [${bad.join(", ")}]` : ""}${errors.length ? " " + JSON.stringify(errors) : ""}${r.error ? " " + r.error : ""}`);
  results.cases[name] = r;
}
writeFileSync(shotPath(SMOKE, "results", "measures").replace(/\.png$/, ".json"), JSON.stringify(results, null, 1));
await fx.close();
process.exit(failed ? 1 : 0);
