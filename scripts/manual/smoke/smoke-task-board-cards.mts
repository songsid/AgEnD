// The board's cards, drawn in real Chromium and measured — what was asked for after comparing layouts:
//  1. wider: the board fills the content area, a column is 272–360 px however many there are, more columns than fit scroll
//     sideways (the number of columns each width shows is written to the results); a card is as tall as its content, the
//     title at two lines and the status at one at most (cut with "…", the whole text is the tooltip);
//  2. a card whose agent is running says "Running" once (the mark in its status line; no moving light);
//  3. no coloured bar on the left edge, in any status;
//  7. in the list a running card's "Running" mark is before its title (after the number), not among the tags at the right;
//  6. the project's list fills the content area like the board (same side margins; at 1440 and 1920 px), the title column takes
//     the extra width and number / priority / assignee / time keep theirs; a phone's list is unchanged;
//  5. the card page's activity is a stream: each comment and progress note is a card (1px, radius, surface, padding;
//     no bar at an agent's), what the system did is a thin row (no box), many in a row fold into "› N activities", the comment box is
//     the last card; the stream starts on the page's left edge, as the sub tasks above it do (light / dark, desk / phone);
//  4. the avatar on a card is a button: it opens the picker the card page has (the card does not open), a choice saves,
//     Esc closes it and the focus returns; pointing at it shows an info card (state, what it does, cards in hand);
//     the list's rows have the same avatar; over a read-only link it is not a button and a choice cannot be made.
//  8. (round 7) every run of system lines between two cards is one "› N activities" row, even a run of one: the stream reads
//     comment → › N activities → comment; an author's avatar is 28px with its name centred on it and shows the board's info card
//     (pointing, the keyboard's focus, a tap) with a link to the Agent page — the pointer can go into the card, Tab reaches the link,
//     Esc closes it; a person's card has no link; over a read-only link there is no link; a comment is formatted as the chat's
//     window formats a message — the computed look of every Markdown part is compared with an injected `.msg .md` probe built from
//     the same HTML (the comparison table is written to the results), Copy puts the block on the clipboard, a long block folds.
// Run on the base commit (REPO=<checkout of it>) the same shots are the "before"; the checks that name new things fail there.
//   PW_DIR=<dir with playwright-core> CHROME=<chrome> REPO=<checkout> OUT=<dir> MATRIX=desk-dark-zh-TW,desk-light-en \
//   npx --prefix <checkout> tsx scripts/manual/smoke/smoke-task-board-cards.mts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootFixture, caseName, labelOf, matrix, shotPath, type MatrixCase } from "../smoke-fixture/index.mts";

const SMOKE = "smoke-task-board-cards";
const REPO = process.env.REPO!;
const NAMES = ["dev-a", "dev-b", "docs"];
const roster = NAMES.map((name, i) => ({ name, backend: "claude-code" as const, status: "running" as const, ...(i === 0 ? { general: true } : {}) }));
const fx = await bootFixture({ port: Number(process.env.HP ?? 48490), roster, classic: false });
const fm = fx.fm;
// dev-a and dev-b are working (the dashboard's state, which the board reads for "running"); docs is idle.
fm.getInstanceExecutionState = (n: string) => (n === "dev-a" || n === "dev-b" ? "working" : "idle");
const { Scheduler, DEFAULT_SCHEDULER_CONFIG } = await import(REPO + "/src/scheduler/index.ts");

const ANN = { kind: "person", name: "operator" } as const;
const agent = (name: string) => ({ kind: "instance", name }) as const;

const AGENT_MD = [
  "### Weekly leaderboard API", "",
  "Rebuilt with `npm run build`; notes in [the design doc](https://example.com/leaderboard-notes).", "",
  "- ties share a rank (verified)", "- late rows are kept for the next round", "  - region merges get their own card", "",
  "| Step | Result | Time |", "| --- | :---: | ---: |", "| build | passed | 12 s |", "| tests | **2 failed** | 41 s |", "| preview deploy | passed | 8 s |", "",
  "The response looks like this:", "",
  "```json",
  JSON.stringify({ week: "2026-W46", ranked: true, top: [{ rank: 1, player: "ann", score: 9120 }, { rank: 1, player: "bo", score: 9120 }], paging: { next: "cursor-2", limit: 50 }, note: null }, null, 2),
  "```",
].join("\n");
const PERSON_MD = ["Got it — here is how I would rank them:", "", "```python", "def rank(rows):", "    # ties share a rank, the next rank skips", "    rows = sorted(rows, key=lambda r: -r[\"score\"])", "    out, last, place = [], None, 0", "    for i, r in enumerate(rows, 1):", "        if r[\"score\"] != last:", "            place, last = i, r[\"score\"]", "        out.append({**r, \"rank\": place})", "    return out", "```", "", "No need to copy it: **the logic matching** is enough."].join("\n");
const LONG_LOG = ["$ npm test -- --run leaderboard", ...Array.from({ length: 42 }, (_, i) => `  ✓ leaderboard › case ${String(i + 1).padStart(2, "0")} (${5 + ((i * 7) % 23)} ms)`), "Test Files  1 passed (1)", "     Tests  42 passed (42)"].join("\n");

/** The same cards in each language; the first six are the screenshot the person sent. */
function seed(c: MatrixCase) {
  fm.scheduler?.db.close();
  fm.scheduler = new Scheduler(join(fm.dataDir, `scheduler-${caseName(c)}.db`), () => {}, DEFAULT_SCHEDULER_CONFIG, (n: string) => !!fm.fleetConfig.instances[n]);
  (fm as any).attachTaskBoard(fm.scheduler.db);
  const board = fm.scheduler.db.board;
  const L = (en: string, zh: string) => labelOf(c, { en, zh });
  const project = board.createProject(ANN, { name: L("Leaderboard", "排行榜"), description: L("Weekly and seasonal rankings", "每週與每季排行榜"), leadInstance: "dev-a" });
  const P = project.id;
  const main = (title: string, extra: Record<string, unknown> = {}) => board.createCards(ANN, { project: P, cards: [{ title, ...extra }] }).cards[0]!.code as string;
  const sub = (parent: string, title: string, extra: Record<string, unknown> = {}) => board.createCards(ANN, { cards: [{ parent, title, ...extra }] }).cards[0]!.code as string;
  const move = (who: any, code: string, to: string, o: Record<string, unknown> = {}) => board.moveCard(who, code, to, o);

  const m1 = main(L("Serve the weekly leaderboard", "提供每週排行榜"), { assignee: "dev-a", priority: "high", size: "M", acceptance: ["Ties share a rank", "Under 300 ms", "Paged", "Cached"] });
  const m2 = main(L("Add the shop", "新增商店"), { assignee: "dev-b", size: "L" });
  const m3 = main(L("Pick the badges", "挑選徽章"), { assignee: "dev-b", priority: "urgent", acceptance: ["Six badges"] });
  const m4 = main(L("Build the score store", "建立分數儲存"), { assignee: "docs", size: "S" });
  const m5 = main(L("Adjust the anti-cheat rules", "調整防作弊規則"), { assignee: "docs", priority: "high" });
  const m6 = main(L("Write the season rules", "撰寫賽季規則"), { assignee: "dev-b", priority: "urgent", size: "S", acceptance: ["Rules page", "Translated"] });
  // M-1: three sub tasks, one done, one in progress (its agent is running), a card that comments.
  const s1 = sub(m1, L("Design the schema", "設計資料表"), { assignee: "dev-a" });
  const s2 = sub(m1, L("Build the score API", "建立分數 API"), { assignee: "dev-a" });
  sub(m1, L("Write the tests", "撰寫測試"), { assignee: "dev-b" });
  move(agent("dev-a"), s1, "claimed"); move(agent("dev-a"), s1, "done", { result: "ok" });
  move(agent("dev-a"), s2, "claimed");
  for (const patch of [{ goal: L("Players see their weekly rank", "玩家看得到本週名次") }, { scope: L("In: ranks. Out: prizes", "做：名次。不做：獎勵") }, { context: L("See M-4", "見 M-4") }, { priority: "high" }]) board.updateCard(ANN, m1, patch);
  board.updateCard(ANN, m1, { check: [1], comment: L("Please keep the page size at 50.", "每頁請維持 50 筆。") });
  board.updateCard(agent("dev-a"), m1, { comment: L("Will do.", "好的。") });
  board.updateCard(agent("dev-a"), m1, { log: L("Endpoint skeleton done, paging next", "端點骨架完成，接著做分頁") });
  board.updateCard(ANN, m1, { comment: L("Thanks!", "謝謝！") });
  // Round 7: comment → › 2 activities → an agent's Markdown comment → › 1 activity → a person's comment with a Python block.
  // (the board stamps in milliseconds and an event sorts before a comment of the same instant: a tick keeps the order written)
  const tick = () => { const t = Date.now(); while (Date.now() - t < 3); };
  tick(); board.updateCard(ANN, m1, { size: "L" }); tick(); board.updateCard(ANN, m1, { size: "M" }); tick();
  board.updateCard(agent("dev-a"), m1, { comment: AGENT_MD }); tick();
  board.updateCard(ANN, m1, { priority: "urgent" }); tick();
  board.updateCard(ANN, m1, { comment: PERSON_MD });
  // M-2: two sub tasks, none started: "Next".
  sub(m2, L("Price list", "價目表"), { assignee: "dev-b" });
  sub(m2, L("Checkout", "結帳"), { assignee: "dev-b" });
  board.updateCard(agent("dev-b"), m2, { comment: "Test output:\n\n```text\n" + LONG_LOG + "\n```" });
  // M-3: waits for the person; M-4: done; M-5: blocked with a reason; M-6: in progress (running).
  move(agent("dev-b"), m3, "claimed"); board.updateCard(agent("dev-b"), m3, { check: [1] }); move(agent("dev-b"), m3, "review", { result: "Badges chosen" });
  move(agent("docs"), m4, "claimed"); move(agent("docs"), m4, "review", { result: "ok" }); move(ANN, m4, "done");
  move(agent("docs"), m5, "claimed");
  move(agent("docs"), m5, "blocked", { reason: L("Which scores count: ranked games only?", "哪些分數算數：只算排位賽嗎？") });
  move(agent("dev-b"), m6, "claimed");
  // The hard ones: a title of 100 characters, a long reason, a card with nothing but a title, a size and no priority.
  const long = L("Rework the nightly leaderboard rebuild so that ties, late submissions and region merges are all handled in one pass", "重新設計每晚的排行榜重建流程，讓同分、延遲提交、跨區合併與賽季切換都能在同一次處理中完成並且不會漏算任何一位玩家的成績")
    .slice(0, 100);
  const m7 = main(long, { assignee: "dev-a", priority: "urgent", size: "L" });
  const m8 = main(L("Nothing but a title", "只有標題"));
  const m9 = main(L("Fix the season rollover", "修正賽季交接"), { assignee: "docs", priority: "high" });
  move(agent("docs"), m9, "claimed");
  move(agent("docs"), m9, "blocked", { reason: L("Waiting for the season calendar from the game team — nobody on this side knows which week the new season starts, and the dates in the old design doc disagree with the shop's.", "等遊戲團隊提供賽季日曆 — 這邊沒有人知道新賽季從哪一週開始，舊設計文件與商店頁面的日期也對不起來。") });
  const m10 = main(L("A card with only a size", "只有大小的卡片"), { size: "M" });
  return { m1, m2, m6, m7, m8, m9, m10, P };
}

// What the page lays out: per tile, its box and the parts the checks name.
const MEASURE = `(() => {
  // Lines of text drawn in an element: the boxes inside it (a clamped title still has the boxes of the lines it hides).
  const textLines = (root) => { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), ys = [], box = root.getBoundingClientRect();
    for (let n = w.nextNode(); n; n = w.nextNode()) { if (!n.textContent.trim()) continue; const rg = document.createRange(); rg.selectNodeContents(n); for (const b of rg.getClientRects()) { const y = b.top + b.height / 2; if (y <= box.bottom + 1) ys.push(y); } }
    ys.sort((a, b) => a - b); let lines = 0, last = -99; for (const y of ys) { if (y - last > 6) lines++; last = y; } return lines; };
  const rect = (el, root) => { if (!el) return null; const b = el.getBoundingClientRect(), o = root.getBoundingClientRect(); return { x: Math.round((b.left - o.left) * 10) / 10, y: Math.round((b.top - o.top) * 10) / 10, w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 }; };
  return [...document.querySelectorAll(".tb-tile")].map((t) => {
    const title = t.querySelector(".tb-tile-title"), span = title.querySelector("span") || title, status = t.querySelector(".tb-tile-status"), cs = getComputedStyle(t), before = getComputedStyle(t, "::before");
    const r = t.getBoundingClientRect();
    return {
      id: t.dataset.tile, col: t.closest(".tb-col").getAttribute("aria-label"), width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10,
      titleLines: textLines(span), titleCut: span.scrollHeight > span.clientHeight + 1, titleAttr: title.getAttribute("title"),
      statusLines: status ? textLines(status) : 0, statusKind: status ? (status.className.match(/k-(\\w+)/) || [])[1] : null, statusText: status ? status.textContent.replace(/\\s+/g, " ").trim() : "",
      statusCut: status ? [...status.querySelectorAll("*")].some((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow === "ellipsis") : false,
      barContent: before.content, borderLeft: cs.borderLeftWidth, borderLeftColor: cs.borderLeftColor, borderTopColor: cs.borderTopColor, paddingLeft: cs.paddingLeft, paddingTop: cs.paddingTop,
      running: t.classList.contains("running"), mark: !!t.querySelector(".tr-mark"), shine: !!t.querySelector(".tb-tile-shine"),
      // what moves besides the Running mark's own pulsing dot (the mark is the one thing that says "running")
      animated: [cs, before, ...[...t.querySelectorAll("*")].filter((e) => !e.classList.contains("tr-dot")).map((e) => getComputedStyle(e))].some((c) => c.animationName !== "none" && c.animationName !== "tb-flash"),
      owner: t.querySelector(".tb-owner-btn") ? { tag: t.querySelector(".tb-owner-btn").tagName, text: t.querySelector(".tb-owner-btn").textContent.trim(), static: t.querySelector(".tb-owner-btn").classList.contains("is-static") } : null,
      leftEdges: ["tb-tile-top", "tb-tile-title", "tb-tile-status", "tb-tile-foot"].map((c) => { const e = t.querySelector("." + c); return e ? Math.round(e.getBoundingClientRect().left - r.left) : null; }),
    };
  });
})()`;
const COLS = `(() => { const sc = document.querySelector(".tb-scroll"), s = sc.getBoundingClientRect();
  const cols = [...document.querySelectorAll(".tb-col")].map((c) => c.getBoundingClientRect());
  return { viewport: innerWidth, scroll: Math.round(s.width), columns: cols.length, visible: cols.filter((c) => c.left >= s.left - 1 && c.right <= s.right + 1).length, widths: [...new Set(cols.map((c) => Math.round(c.width)))],
    scrolls: sc.scrollWidth > sc.clientWidth + 1, pageWidth: Math.round(document.querySelector(".tb-board-page").getBoundingClientRect().width), left: Math.round(document.querySelector(".tb-board-page").getBoundingClientRect().left), right: Math.round(innerWidth - document.querySelector(".tb-board-page").getBoundingClientRect().right), overflowX: document.documentElement.scrollWidth - innerWidth }; })()`;

// The card page's activity stream: its cards and rows, their boxes and where they start.
const STREAM = `(() => {
  const p = document.querySelector(".tp-activity");
  if (!p) return null;
  const pr = p.getBoundingClientRect(), cs = getComputedStyle(p), subs = document.querySelector(".tp-subs"), head = document.querySelector(".tp-head");
  const bg = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c; } return "none"; };
  const box = (el) => { const c = getComputedStyle(el), r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), border: c.borderTopWidth, radius: c.borderTopLeftRadius, bg: c.backgroundColor, pad: [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft], fs: parseFloat(c.fontSize), color: c.color, barContent: getComputedStyle(el, "::before").content }; };
  const cards = [...p.querySelectorAll(".tl-card")].map((c) => ({ ...box(c), agent: c.classList.contains("by-agent"), borderLeft: getComputedStyle(c).borderLeftWidth, borderLeftColor: getComputedStyle(c).borderLeftColor, borderTopColor: getComputedStyle(c).borderTopColor, lbar: c.classList.contains("lbar"), hasDot: !!c.querySelector(".tb-av-dot"), hasBadge: !!c.querySelector(".tr-by"), tag: !!c.querySelector(".tl-kind"), bodyX: c.querySelector(".tl-body") ? Math.round(c.querySelector(".tl-body").getBoundingClientRect().left + parseFloat(getComputedStyle(c.querySelector(".tl-body")).paddingLeft)) : null, nameX: Math.round(c.querySelector(".tb-who").getBoundingClientRect().left) }));
  const lines = [...p.querySelectorAll(".tl-line")].map(box);
  const composer = p.querySelector(".tc-composer");
  return { x: Math.round(pr.left), page: bg(p.parentElement), cardsN: cards.length, cards, lines, more: [...p.querySelectorAll(".tl-more")].map((m) => ({ text: m.textContent.trim(), open: m.getAttribute("aria-expanded") })),
    gaps: cards.slice(1).map((c, i) => c.y - (cards[i].y + cards[i].h)),
    composer: composer ? { ...box(composer), last: p.lastElementChild === composer, inside: !!composer.querySelector("textarea") && !!composer.querySelector(".btn-primary") } : null,
    edges: { stream: Math.round(pr.left), head: head ? Math.round(head.getBoundingClientRect().left) : null, subs: subs ? Math.round(subs.getBoundingClientRect().left) : null },
    panel: p.className, overflowX: document.documentElement.scrollWidth - innerWidth };
})()`;

// Round 7: the author's avatar and name, the sandwich, the info card, and the Markdown of the comments; plus the chat parity probe.
const AUTHOR = `(() => {
  const r = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.left * 10) / 10, y: Math.round(b.top * 10) / 10, w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 }; };
  const list = document.querySelector(".tp-activity .tl-list");
  const seq = [...list.children].map((li) => li.classList.contains("tl-run") ? "run:" + (li.querySelector(".tl-more") ? li.querySelector(".tl-more").textContent.trim() : "open") : li.classList.contains("tl-day") ? "day" : li.classList.contains("tl-comment") ? "comment" : li.classList.contains("tl-log") ? "log" : "other");
  const heads = [...document.querySelectorAll(".tp-activity .tl-card .tl-head")].map((h) => {
    const btn = h.querySelector(".tl-who-btn"), av = h.querySelector(".tb-av"), name = h.querySelector(".tb-who"), dot = h.querySelector(".tb-av-dot");
    if (!av || !name) return null;
    const a = r(av), n = r(name);
    return { btn: !!btn, avatar: a, dot: dot ? r(dot) : null, name: n, centreOff: Math.abs((a.y + a.h / 2) - (n.y + n.h / 2)), who: name.textContent };
  });
  const mark = document.querySelector(".tp-activity .tl-line .tl-mark");
  return { seq, heads, systemMark: mark ? r(mark) : null };
})()`;
const MD_PROPS = ["fontSize", "fontWeight", "lineHeight", "color", "backgroundColor", "marginTop", "marginBottom", "paddingTop", "paddingLeft", "borderTopWidth", "borderTopColor", "borderTopLeftRadius", "fontFamily", "listStyleType", "textDecorationLine", "overflowX", "whiteSpace", "minWidth"];
const MD_SELS = ["h5", "p", "p code", "a", "ul", "li", "ul ul", ".tbl", "table", "th", "td", ".codeblock", ".cb-head", ".cb-lang", ".cb-head .chip-btn", "pre", "pre code", ".tk-s", ".tk-k", ".tk-n"];
// The same HTML drawn once in a comment and once in the chat's own container (.msg > .md): where they differ, the table says so.
const PARITY = `((props, sels) => {
  const src = [...document.querySelectorAll(".tp-activity .tl-comment.by-agent .tl-body.md")].find((b) => b.querySelector(".tbl"));
  const probe = document.createElement("div"), msg = document.createElement("div"), md = document.createElement("div");
  probe.id = "chat-probe"; msg.className = "msg agent"; md.className = "md"; md.innerHTML = src.innerHTML; msg.appendChild(md); probe.appendChild(msg); document.body.appendChild(probe);
  const read = (root, sel) => { const e = root.querySelector(sel); if (!e) return null; const c = getComputedStyle(e); return Object.fromEntries(props.map((k) => [k, c[k]])); };
  const out = {};
  for (const sel of sels) { const a = read(src, sel), b = read(md, sel); out[sel] = a && b ? { same: props.filter((k) => a[k] === b[k]).length, diff: props.filter((k) => a[k] !== b[k]).map((k) => ({ prop: k, comment: a[k], chat: b[k] })) } : { missing: !a ? "comment" : "chat" }; }
  probe.remove();
  return out;
})(${JSON.stringify(MD_PROPS)}, ${JSON.stringify(MD_SELS)})`;
const MDMEASURE = `(() => {
  const cs = (e) => getComputedStyle(e);
  const body = [...document.querySelectorAll(".tp-activity .tl-comment.by-agent .tl-body.md")].find((b) => b.querySelector(".tbl"));
  const q = (sel) => body.querySelector(sel);
  const toks = [...body.querySelectorAll("pre .tk-s, pre .tk-k, pre .tk-n")].map((e) => cs(e).color);
  const pre = q("pre"), head = q(".cb-head");
  return {
    h5: !!q("h5"), list: q("ul") ? cs(q("ul")).listStyleType : null, nested: !!q("li ul li"), link: q("a") ? { href: q("a").getAttribute("href"), underline: cs(q("a")).textDecorationLine, color: cs(q("a")).color } : null,
    inlineCode: q("p code") ? { bg: cs(q("p code")).backgroundColor, font: cs(q("p code")).fontFamily } : null,
    table: q("table") ? { cells: body.querySelectorAll("td").length, tdBorder: cs(q("td")).borderTopWidth, thBorder: cs(q("th")).borderTopWidth, thBg: cs(q("th")).backgroundColor, collapse: cs(q("table")).borderCollapse, wrapperScrolls: cs(q(".tbl")).overflowX } : null,
    codeblock: pre ? { lang: q(".cb-lang").textContent, buttons: [...head.querySelectorAll("button")].map((b) => b.textContent.trim()), mono: /mono|Mono|Consolas|Courier/.test(cs(pre).fontFamily), whiteSpace: cs(pre).whiteSpace, tokenColours: [...new Set(toks)].length, plainColour: cs(q("pre code")).color, jsonText: q("pre code").textContent.slice(0, 40) } : null,
    personBlocks: [...document.querySelectorAll(".tp-activity .tl-comment.person .codeblock .cb-lang")].map((e) => e.textContent),
    progressPlain: [...document.querySelectorAll(".tp-activity .tl-log .tl-body")].every((b) => !b.querySelector("pre, table, strong, code, h5")),
  };
})()`;

// The project's page and its list's columns: where the page is, and how wide each column of the first row is.
const LISTM = `(() => {
  const row = document.querySelector(".tb-row"), page = document.querySelector(".tb-board-page").getBoundingClientRect();
  const w = (sel) => { const e = row && row.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().width * 10) / 10 : null; };
  const head = (sel) => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().width * 10) / 10 : null; };
  return { viewport: innerWidth, page: Math.round(page.width), left: Math.round(page.left), right: Math.round(innerWidth - page.right), row: row ? Math.round(row.getBoundingClientRect().width) : null,
    title: w(".tb-row-text"), code: w(".tb-row-code"), prio: w(".tb-row-prio"), who: w(".tb-row-who"), time: w(".tb-row-time"),
    headTitle: head(".tb-lh-title"), headPrio: head(".tb-lh-prio"), headWho: head(".tb-lh-who"), headTime: head(".tb-lh-time"),
    marks: [...document.querySelectorAll(".tb-row .tr-mark")].map((m) => { const row = m.closest(".tb-row"), t = row.querySelector(".tb-row-title").getBoundingClientRect(), c = row.querySelector(".tb-row-code").getBoundingClientRect(), b = m.getBoundingClientRect();
      return { id: row.dataset.row, afterCode: b.left >= c.right - 1, beforeTitle: b.right <= t.left + 1, sameLine: Math.abs((b.top + b.height / 2) - (t.top + t.height / 2)) < 8, inTags: !!m.closest(".tb-row-tags") }; }),
    rows: document.querySelectorAll(".tb-row").length, overflowX: document.documentElement.scrollWidth - innerWidth };
})()`;

// The folded row's own look: no fill, no border, no rounding; where its mark is.
const FOLD = `(() => { const m = document.querySelector(".tp-activity .tl-more"), c = getComputedStyle(m);
  return { bg: c.backgroundColor, border: c.borderTopWidth, radius: c.borderTopLeftRadius, shadow: c.boxShadow, color: c.color, fs: parseFloat(c.fontSize), outline: c.outlineStyle + " " + c.outlineWidth, markX: Math.round(m.querySelector(".tl-mark").getBoundingClientRect().left), expanded: m.getAttribute("aria-expanded") }; })()`;

const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const results: any = { browser: fx.browser.version(), cases: {} };
let failed = 0;
// SHOTS_ONLY=1: only the board's pictures (the same seed), for a checkout that has none of the new behaviour (the "before");
const shotsOnly = !!process.env.SHOTS_ONLY;

for (const c of matrix(process.env.MATRIX ?? "desk-dark-zh-TW,desk-light-en,phone-dark-zh-TW")) {
  const name = caseName(c);
  const ids = seed(c);
  const phone = c.device === "phone";
  const { ctx, page } = await fx.page(c, { path: "/ui/fleet", storage: { agend_tasks_project: String(ids.P) } });
  const errors: string[] = [];
  page.on("pageerror", (e: any) => errors.push(String(e).slice(0, 200)));
  const r: any = {};
  const chk: Record<string, boolean> = {};
  try {
    await page.waitForSelector(".tb-tile", { state: "attached", timeout: 15000 });
    if (!phone) await page.setViewportSize({ width: 1470, height: 760 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: shotPath(SMOKE, c, "1-board") });
    // Home (the projects) and back: the page heads and the project tile, as Settings' are.
    await page.locator(".tb-bar-head .btn-ghost").first().click();
    await page.waitForSelector(".tb-home .tb-project", { timeout: 10000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: shotPath(SMOKE, c, "0-home") });
    await page.locator(".tb-project-open").first().click();
    await page.waitForSelector(".tb-tile", { state: "attached", timeout: 10000 });
    await page.waitForTimeout(300);
    let tiles: any[];
    if (phone) {
      tiles = [];
      const tabs = await page.locator(".tb-status-seg .tb-seg-btn").count();
      for (let i = 0; i < tabs; i++) {
        await page.locator(".tb-status-seg .tb-seg-btn").nth(i).click(); await page.waitForTimeout(200);
        tiles.push(...(await page.evaluate(MEASURE) as any[]).filter((t) => t.width > 0));
        if (i < 2) await page.screenshot({ path: shotPath(SMOKE, c, `1-board-tab${i}`) });
      }
    } else {
      tiles = await page.evaluate(MEASURE) as any[];
    }
    r.tiles = tiles;
    r.statuses = Object.fromEntries(tiles.map((t) => [t.id, `${t.statusKind}: ${t.statusText}`]));
    const rendered = tiles.filter((t) => t.width > 0);
    // 3. no bar: a tile draws nothing at ::before and has no thicker edge on the left than on the top.
    chk.noLeftBar = rendered.every((t) => (t.barContent === "none" || t.barContent === "normal") && t.borderLeft === "1px" && t.borderLeftColor === t.borderTopColor);
    chk.tilePaddingEven = uniq(rendered.map((t) => t.paddingLeft)).length === 1 && rendered.every((t) => t.paddingLeft === t.paddingTop);
    // 1. caps on rows, natural height.
    chk.titleTwoLinesMax = rendered.every((t) => t.titleLines <= 2) && rendered.some((t) => t.titleCut);
    chk.cutTitleHasTooltip = rendered.filter((t) => t.titleCut).every((t) => (t.titleAttr ?? "").length >= 20);
    chk.statusOneLine = rendered.every((t) => t.statusLines <= 1) && rendered.some((t) => t.statusCut);
    chk.heightFollowsContent = uniq(rendered.map((t) => t.height)).length > 1;
    chk.leftEdgesAlign = rendered.every((t) => uniq(t.leftEdges.filter((x: number | null) => x !== null)).length === 1);
    if (!phone) {
      chk.columnsWide = true;   // checked on the columns at each width below
      // The board's width at 1366 / 1440 / 1920, and how many columns each shows.
      r.widths = {};
      for (const w of [1366, 1440, 1920]) {
        await page.setViewportSize({ width: w, height: 760 }); await page.waitForTimeout(250);
        r.widths[w] = await page.evaluate(COLS);
        await page.screenshot({ path: shotPath(SMOKE, c, `1-board-${w}`) });
      }
      chk.columnsWide = Object.values(r.widths).every((x: any) => x.widths.every((w: number) => w >= 272 && w <= 360));
      chk.noPageOverflow = Object.values(r.widths).every((x: any) => x.overflowX <= 0);
      chk.pageFillsAt1920 = r.widths[1920].pageWidth > 1300 && r.widths[1920].columns === 5;
      await page.setViewportSize({ width: 1470, height: 760 });
      await page.waitForTimeout(250);
    } else {
      chk.phoneNoSideScroll = (await page.evaluate(COLS) as any).overflowX <= 0;
    }
    // 2. running: the card whose agent works has the mark and its class, and nothing on the page moves for it.
    const running = rendered.filter((t) => t.running);
    chk.runningMark = running.length >= 1 && running.every((t) => t.mark && !t.shine) && rendered.filter((t) => !t.running).every((t) => !t.mark);
    chk.nothingAnimates = rendered.every((t) => !t.animated);
    if (!phone) {
      await page.locator(".tb-tile.running").first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: shotPath(SMOKE, c, "2-running") });
    }
    // 6. the project's list: as wide as the board.
    {
      const toggle = page.locator(".tb-view-toggle .tb-seg-btn");
      await toggle.nth(1).click(); await page.waitForSelector(".tb-row", { timeout: 10000 }); await page.waitForTimeout(300);
      if (phone) {
        const list = await page.evaluate(LISTM) as any;
        r.list = { phone: list };
        chk.phoneListNoSideScroll = list.overflowX <= 0;
        chk.phoneListMarkBeforeTitle = list.marks.length >= 1 && list.marks.every((m: any) => m.afterCode && m.beforeTitle && m.sameLine && !m.inTags);
        chk.phoneListUnchanged = list.page === 358 || list.page === 390 - 2 * list.left;   // the phone's gutters, as before: the page is the window less its margins
        await page.screenshot({ path: shotPath(SMOKE, c, "7-list") });
      } else {
        r.list = {};
        for (const w of [1366, 1440, 1920]) {
          await page.setViewportSize({ width: w, height: 760 }); await page.waitForTimeout(300);
          r.list[w] = await page.evaluate(LISTM);
          await page.screenshot({ path: shotPath(SMOKE, c, `7-list-${w}`) });
        }
        const L = r.list as Record<number, any>, B = r.widths as Record<number, any>;
        chk.listFillsContent = L[1920].page > 1300 && L[1920].page === B[1920].pageWidth && L[1440].page === B[1440].pageWidth;
        chk.listMarginsLikeTheBoard = [1366, 1440, 1920].every((w) => L[w].left === B[w].left && L[w].right === B[w].right);
        chk.listOtherColumnsKeepWidth = ["prio", "who", "time", "code"].every((k) => L[1920][k] === L[1440][k] && L[1440][k] === L[1366][k])
          && ["headPrio", "headWho", "headTime"].every((k) => L[1920][k] === L[1440][k]);
        chk.listTitleTakesTheRest = Math.abs((L[1920].title - L[1440].title) - (L[1920].page - L[1440].page)) <= 2 && L[1920].title > L[1440].title && Math.abs(L[1920].headTitle - L[1440].headTitle - (L[1920].page - L[1440].page)) <= 2;
        chk.listNoSideScroll = [1366, 1440, 1920].every((w) => L[w].overflowX <= 0);
        // The Running mark leads the title (after the number), on the title's line, at every width.
        chk.listMarkBeforeTitle = [1366, 1440, 1920].every((w) => L[w].marks.length >= 2 && L[w].marks.every((m: any) => m.afterCode && m.beforeTitle && m.sameLine && !m.inTags));
        await page.setViewportSize({ width: 1470, height: 760 }); await page.waitForTimeout(250);
      }
      await toggle.nth(0).click(); await page.waitForSelector(".tb-tile", { state: "attached", timeout: 10000 }); await page.waitForTimeout(300);
      if (phone) { await page.locator(".tb-status-seg .tb-seg-btn").nth(1).click(); await page.waitForTimeout(200); }
    }
    // 5. the card page: the activity is a stream.
    if (phone) { await page.locator(".tb-status-seg .tb-seg-btn").nth(1).click(); await page.waitForTimeout(200); }
    await page.locator('[data-tile="' + ids.m1 + '"] .tb-tile-title').click();
    await page.waitForSelector(".tp-activity", { timeout: 10000 });
    await page.waitForTimeout(500);
    const st = await page.evaluate(STREAM) as any;
    r.stream = st;
    const cards = (st?.cards ?? []) as any[], lines = (st?.lines ?? []) as any[];
    chk.streamNotAPanel = !!st && st.panel === "tp-activity";
    chk.commentsAreCards = cards.length >= 3 && cards.every((k) => parseFloat(k.border) >= 1 && parseFloat(k.radius) >= 8 && k.bg !== st.page && uniq(k.pad).length === 1 && parseFloat(k.pad[0]) >= 12);
    // 12px between two cards; more where a system row (a day's separator, a run) sits between them
    chk.cardsApart = st?.gaps?.length > 0 && st.gaps.every((g: number) => g >= 12) && st.gaps.some((g: number) => g === 12);
    chk.noBarAtAnAgent = cards.filter((k) => k.agent).length >= 1 && cards.every((k) => !k.lbar && (k.barContent === "none" || k.barContent === "normal") && k.borderLeft === k.border && k.borderLeftColor === k.borderTopColor);
    chk.agentHeadHasDotAndBadge = cards.filter((k) => k.agent).every((k) => k.hasBadge && k.hasDot) && cards.filter((k) => !k.agent).every((k) => !k.hasBadge && !k.hasDot);
    chk.bodyUnderTheName = cards.every((k) => k.bodyX === null || Math.abs(k.bodyX - k.nameX) <= 1);
    chk.progressNoteIsACard = cards.some((k) => k.tag);
    chk.systemRowsFoldAndOpen = (st?.more ?? []).length >= 1 && st.more.every((m: any) => /\d/.test(m.text) && m.open === "false");
    chk.streamOnThePageEdge = !!st && st.edges.stream === st.edges.head && (st.edges.subs === null || st.edges.subs === st.edges.stream);
    chk.commentBoxIsTheLastCard = !!st?.composer && st.composer.last && st.composer.inside && parseFloat(st.composer.border) >= 1 && parseFloat(st.composer.radius) >= 8 && st.composer.bg !== st.page;
    chk.streamNoSideScroll = !!st && st.overflowX <= 0;
    await page.locator(".tp-activity").scrollIntoViewIfNeeded();
    await page.screenshot({ path: shotPath(SMOKE, c, "6-card-activity") });
    // The folded row has no box: at rest, pointed at (the text turns primary, nothing is filled), and with the keyboard's ring.
    const fold = page.locator(".tp-activity .tl-more").first();
    await page.mouse.move(2, 2); await page.waitForTimeout(150);
    const rest = await page.evaluate(FOLD) as any;
    await fold.hover(); await page.waitForTimeout(150);
    const hover = await page.evaluate(FOLD) as any;
    await page.mouse.move(2, 2);
    await page.keyboard.press("Shift"); await fold.focus(); await page.waitForTimeout(100);
    const focus = await page.evaluate(FOLD) as any;
    r.fold = { rest, hover, focus };
    const noBox = (f: any) => (f.bg === "rgba(0, 0, 0, 0)" || f.bg === "transparent") && f.border === "0px" && f.radius === "0px" && f.shadow === "none";
    chk.foldRowHasNoBox = noBox(rest) && noBox(hover);
    chk.foldRowHoverOnlyRecolours = hover.color !== rest.color && noBox(hover);
    chk.foldRowKeepsItsRing = !/^none/.test(focus.outline) && !(focus.outline.startsWith("0px"));
    await page.locator(".tp-activity").evaluate((el: HTMLElement) => (document.activeElement as HTMLElement | null)?.blur());
    // Open the folded run: its lines come in.
    await fold.click(); await page.waitForTimeout(250);
    // A hand-over of a sub task is a row of its own that is never folded away, so it splits the history into runs: open the others too.
    for (let i = 1, n = await page.locator(".tp-activity .tl-more").count(); i < n; i++) { await page.locator(".tp-activity .tl-more").nth(i).click(); await page.waitForTimeout(150); }
    const opened = await page.evaluate(`document.querySelectorAll(".tp-activity .tl-event").length`) as number;
    chk.foldOpens = opened >= 4 && (await page.locator(".tp-activity .tl-more").first().getAttribute("aria-expanded")) === "true";
    const open2 = await page.evaluate(STREAM) as any;
    chk.systemRowsAreThin = open2.lines.length >= 4 && open2.lines.every((l: any) => l.border === "0px" && (l.bg === "rgba(0, 0, 0, 0)" || l.bg === "transparent") && l.fs < cards[0].fs);
    chk.systemRowsOnTheCardsEdge = open2.lines.every((l: any) => l.x === open2.cards[0].x);
    const openFold = await page.evaluate(FOLD) as any;
    chk.foldRowMarkUnderTheRowsMarks = openFold.markX === await page.locator(".tp-activity .tl-line .tl-mark").first().evaluate((e: HTMLElement) => Math.round(e.getBoundingClientRect().left));
    chk.foldRowSameSizeAsRows = openFold.fs === open2.lines[0].fs && openFold.expanded === "true" && noBox(openFold);
    await page.screenshot({ path: shotPath(SMOKE, c, "6-card-activity-open") });
    await page.locator(".tp-activity").screenshot({ path: shotPath(SMOKE, c, "6-card-activity-stream") });
    // The other runs, opened above for the count, are closed again: what follows reads the page as it opens.
    for (let i = (await page.locator(".tp-activity .tl-more").count()) - 1; i >= 1; i--) { const b = page.locator(".tp-activity .tl-more").nth(i); if ((await b.getAttribute("aria-expanded")) === "true") { await b.click(); await page.waitForTimeout(100); } }
    // 8. round 7. Close the fold again; the sandwich; the avatar; the Markdown.
    await page.locator(".tp-activity .tl-more").first().click(); await page.waitForTimeout(150);
    const au = await page.evaluate(AUTHOR) as any;
    r.author = au;
    const seqs = au.seq as string[];
    chk.everyRunIsFolded = seqs.some((x) => x.startsWith("run:")) && seqs.filter((x) => x.startsWith("run:")).every((x) => /activit|項動態/.test(x));
    chk.oneLineRunIsFolded = seqs.some((x) => /^run:1 (activity|項動態)/.test(x));
    chk.sandwich = seqs.some((x, i) => x === "comment" && /^run:\d+ /.test(seqs[i + 1] ?? "") && seqs[i + 2] === "comment");
    const heads = (au.heads as any[]).filter(Boolean);
    chk.authorAvatar28 = heads.length >= 3 && heads.every((h) => h.avatar.w === 28 && h.avatar.h === 28);
    chk.authorDotScaled = heads.filter((h) => h.dot).length >= 1 && heads.filter((h) => h.dot).every((h) => h.dot.w >= 10 && h.dot.w <= 12);
    chk.authorNameCentred = heads.every((h) => h.centreOff <= 1.5);
    chk.authorIsAButton = heads.every((h) => h.btn);
    await page.locator(".tp-activity .tl-more").first().click(); await page.waitForTimeout(150);
    chk.systemRowMarksStaySmall = ((await page.evaluate(AUTHOR) as any).systemMark?.w ?? 99) <= 20;
    await page.locator(".tp-activity .tl-more").first().click(); await page.waitForTimeout(150);
    // The run between two comments, closed and open: a picture of the comment above, the row, and the top of the comment below.
    {
      const vpS = page.viewportSize()!;
      await page.setViewportSize({ width: vpS.width, height: phone ? 1400 : 1100 }); await page.waitForTimeout(250);
      const at = await page.evaluate(`(() => { const lis = [...document.querySelectorAll(".tp-activity .tl-list > li")]; for (let i = 1; i < lis.length - 1; i++) if (lis[i].classList.contains("tl-run") && lis[i - 1].classList.contains("tl-comment") && lis[i + 1].classList.contains("tl-comment")) return i; return -1; })()`) as number;
      chk.aRunSitsBetweenTwoComments = at > 0;
      if (at > 0) {
        const li = (k: number) => page.locator(".tp-activity .tl-list > li").nth(at + k);
        await li(0).evaluate((e: HTMLElement) => e.scrollIntoView({ block: "center" })); await page.waitForTimeout(200);
        const clipOf = async (below: number) => { const a = (await li(-1).boundingBox())!, r = (await li(0).boundingBox())!; return { x: Math.max(0, a.x - 8), y: Math.max(0, a.y - 8), width: Math.min(vpS.width - Math.max(0, a.x - 8), a.width + 16), height: Math.min(r.y + r.height + below - (a.y - 8), page.viewportSize()!.height - Math.max(0, a.y - 8)) }; };
        await page.screenshot({ path: shotPath(SMOKE, c, "6-between-closed"), clip: await clipOf(180) });
        await li(0).locator(".tl-more").click(); await page.waitForTimeout(250);
        const rows = await li(0).locator(".tl-line").count();
        chk.runBetweenCommentsOpens = rows >= 1 && (await li(0).locator(".tl-more").getAttribute("aria-expanded")) === "true";
        await page.screenshot({ path: shotPath(SMOKE, c, "6-between-open"), clip: await clipOf(180) });
        await li(0).locator(".tl-more").click(); await page.waitForTimeout(150);
        chk.runBetweenCommentsCloses = (await li(0).locator(".tl-line").count()) === 0;
      }
      await page.setViewportSize(vpS); await page.waitForTimeout(250);
    }
    // The Markdown of the comments, and the chat probe.
    const md = await page.evaluate(MDMEASURE) as any;
    r.markdown = md;
    chk.mdHeadingListTable = md.h5 && md.list === "disc" && md.nested && !!md.table && md.table.cells === 9 && md.table.tdBorder === "1px" && md.table.thBorder === "1px" && md.table.collapse === "collapse";
    chk.mdLinkAndInlineCode = !!md.link && md.link.underline.includes("underline") && !!md.inlineCode && md.inlineCode.bg !== "rgba(0, 0, 0, 0)" && /mono|Mono|Consolas|Courier/.test(md.inlineCode.font);
    chk.mdJsonBlockLikeTheChat = !!md.codeblock && md.codeblock.lang === "json" && md.codeblock.buttons.join(",") === labelOf(c, { en: "Wrap,Copy", zh: "換行,複製" }) && md.codeblock.mono && md.codeblock.whiteSpace === (phone ? "pre-wrap" : "pre") && md.codeblock.tokenColours >= 2;
    chk.mdPersonBlockOtherLanguage = md.personBlocks.includes("python");
    chk.progressNotePlain = md.progressPlain;
    const par = await page.evaluate(PARITY) as any;
    r.parity = par;
    const missing = Object.entries(par).filter(([, v]: any) => v.missing).map(([k]) => k);
    chk.parityEveryPartPresent = missing.length === 0;
    // Where the comment and the chat differ at all: only the text's own size/colour inherited from the bubble are expected to; record them.
    r.parityDiffs = Object.fromEntries(Object.entries(par).filter(([, v]: any) => v.diff && v.diff.length).map(([k, v]: any) => [k, v.diff]));
    // Expected: the text's size follows the card (13px, the board's body text; the chat's is 15px) and what is em-based follows it; the
    // table's header row is on the card's surface; a code block that ends a comment has no margin under it (the card's padding is).
    const allowed = (sel: string, d: any) => ["fontSize", "lineHeight", "color"].includes(d.prop) || (sel === "th" && d.prop === "backgroundColor") || (sel === ".codeblock" && d.prop === "marginBottom") || (d.prop === "listStyleType" && !["ul", "li", "ul ul"].includes(sel));
    chk.parityNothingButInheritedDiffers = Object.entries(r.parityDiffs).every(([sel, diffs]: any) => diffs.every((d: any) => allowed(sel, d)));
    r.parityUnexpected = Object.entries(r.parityDiffs).flatMap(([sel, diffs]: any) => diffs.filter((d: any) => !allowed(sel, d)).map((d: any) => ({ sel, ...d })));
    await page.locator(".tp-activity .tl-comment.by-agent").nth(1).scrollIntoViewIfNeeded().catch(() => {});
    await page.locator(".tp-activity .tl-comment.by-agent .tl-body.md").first().evaluate((el: HTMLElement) => el.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(150);
    await page.screenshot({ path: shotPath(SMOKE, c, "8-markdown") });
    // The two comments whole: a window tall enough for them (an element's picture is cut at the window's edge).
    const vp0 = page.viewportSize()!;
    await page.setViewportSize({ width: vp0.width, height: phone ? 2300 : 1500 }); await page.waitForTimeout(250);
    await page.locator(".tp-activity .tl-comment.by-agent").filter({ has: page.locator(".tl-body.md .tbl") }).first().screenshot({ path: shotPath(SMOKE, c, "8-markdown-agent") });
    await page.locator(".tp-activity .tl-comment.person").filter({ has: page.locator(".codeblock") }).first().screenshot({ path: shotPath(SMOKE, c, "8-markdown-person") });
    await page.setViewportSize(vp0); await page.waitForTimeout(250);
    // Copy: the block's text is on the clipboard.
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    const copyBtn = page.locator(".tp-activity .tl-comment.by-agent .codeblock .cb-head button").nth(1);
    await copyBtn.click(); await page.waitForTimeout(300);
    const clip = await page.evaluate(`navigator.clipboard.readText().catch(() => "?")`) as string;
    const jsonText = await page.locator(".tp-activity .tl-comment.by-agent .codeblock pre").first().textContent();
    chk.copyPutsTheBlockOnTheClipboard = clip === jsonText && clip.includes('"ranked": true') && (await copyBtn.textContent())?.trim() === labelOf(c, { en: "Copied", zh: "已複製" });
    // Wrap turns on wrapping.
    await page.locator(".tp-activity .tl-comment.by-agent .codeblock .cb-head button").first().click(); await page.waitForTimeout(150);
    chk.wrapWraps = (await page.evaluate(`getComputedStyle(document.querySelector(".tp-activity .codeblock pre")).whiteSpace`)) === "pre-wrap";
    await page.locator(".tp-activity .tl-comment.by-agent .codeblock .cb-head button").first().click(); await page.waitForTimeout(100);
    // M-2's long block is folded until opened.
    await page.locator(".tp-back").first().click(); await page.waitForSelector(".tb-tile", { state: "attached", timeout: 10000 });
    if (phone) { await page.locator(".tb-status-seg .tb-seg-btn").nth(0).click(); await page.waitForTimeout(200); }
    await page.locator('[data-tile="' + ids.m2 + '"] .tb-tile-title').click(); await page.waitForSelector(".tp-activity", { timeout: 10000 }); await page.waitForTimeout(400);
    const longBlock = page.locator(".tp-activity .codeblock").filter({ has: page.locator(".cb-more") }).first();   // not by `.folded`: opening it takes the class away
    const folded = await longBlock.evaluate((el: HTMLElement) => ({ h: Math.round(el.getBoundingClientRect().height), more: el.querySelector(".cb-more")?.textContent?.trim() }));
    await longBlock.locator(".cb-more").click(); await page.waitForTimeout(200);
    const unfolded = await longBlock.evaluate((el: HTMLElement) => ({ h: Math.round(el.getBoundingClientRect().height), more: el.querySelector(".cb-more")?.textContent?.trim(), folded: el.classList.contains("folded") }));
    r.longBlock = { folded, unfolded };
    chk.longBlockFoldsAndOpens = folded.h < unfolded.h && !unfolded.folded && folded.more === labelOf(c, { en: "Show all 45 lines", zh: "展開全部 45 行" }) && unfolded.more === labelOf(c, { en: "Show less", zh: "收合" });
    await longBlock.locator(".cb-more").click(); await page.waitForTimeout(150);
    await longBlock.scrollIntoViewIfNeeded(); await page.screenshot({ path: shotPath(SMOKE, c, "8-markdown-long") });
    await page.locator(".tp-back").first().click(); await page.waitForSelector(".tb-tile", { state: "attached", timeout: 10000 });
    if (phone) { await page.locator(".tb-status-seg .tb-seg-btn").nth(1).click(); await page.waitForTimeout(200); }
    await page.locator('[data-tile="' + ids.m1 + '"] .tb-tile-title').click(); await page.waitForSelector(".tp-activity", { timeout: 10000 }); await page.waitForTimeout(400);
    // The info card on an author: pointing, into the card, the link, the keyboard, a person, a tap.
    const agentAuthor = page.locator(".tp-activity .tl-comment.by-agent .tl-who-btn").first();
    const personAuthor = page.locator(".tp-activity .tl-comment.person .tl-who-btn").first();
    const cardsN = () => page.locator(".tb-owner-card").count();
    await page.mouse.move(2, 2); await page.waitForTimeout(150);
    if (!phone) {
      await agentAuthor.scrollIntoViewIfNeeded(); await agentAuthor.hover(); await page.waitForTimeout(450);
      chk.authorHoverShowsCard = (await cardsN()) === 1 && (await page.locator(".tb-owner-card").getAttribute("role")) === "dialog";
      r.authorCard = ((await page.locator(".tb-owner-card").first().textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
      chk.authorCardHasAgentLink = (await page.locator(".tb-owner-card a.toc-open").count()) === 1 && (await page.locator(".tb-owner-card a.toc-open").getAttribute("href")) === "/ui/fleet/agent/dev-a" && /dev-a/.test(r.authorCard);
      await page.screenshot({ path: shotPath(SMOKE, c, "9-author-info") });
      await page.locator(".tb-owner-card").first().screenshot({ path: shotPath(SMOKE, c, "9-author-info-card") });
      await page.locator(".tb-owner-card a.toc-open").hover(); await page.waitForTimeout(350);
      chk.pointerCanEnterTheCard = (await cardsN()) === 1;
      await page.mouse.move(2, 2); await page.waitForTimeout(350);
      chk.leavingClosesTheAuthorCard = (await cardsN()) === 0;
      await personAuthor.hover(); await page.waitForTimeout(450);
      const ptxt = ((await page.locator(".tb-owner-card").first().textContent().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
      r.personCard = ptxt;
      chk.personCardIsNameAndPersonOnly = (await cardsN()) === 1 && ptxt.includes(labelOf(c, { en: "Person", zh: "人" })) && (await page.locator(".tb-owner-card a, .tb-owner-card dl").count()) === 0;
      await page.screenshot({ path: shotPath(SMOKE, c, "9-person-info") });
      await page.mouse.move(2, 2); await page.waitForTimeout(350);
      // Keyboard: focus → card; Tab → the link (the card stays); Esc → closed, the focus back on the avatar.
      await page.keyboard.press("Shift"); await agentAuthor.focus(); await page.waitForTimeout(250);
      chk.authorFocusShowsCard = (await cardsN()) === 1;
      await page.keyboard.press("Tab"); await page.waitForTimeout(150);
      chk.tabReachesTheLink = (await cardsN()) === 1 && await page.evaluate(`document.activeElement?.classList.contains("toc-open")`) as boolean;
      await page.keyboard.press("Escape"); await page.waitForTimeout(150);
      chk.escClosesAuthorCardAndReturnsFocus = (await cardsN()) === 0 && await page.evaluate(`document.activeElement?.classList.contains("tl-who-btn")`) as boolean;
      // The link takes the page to the instance's Agent page.
      await agentAuthor.hover(); await page.waitForTimeout(450);
      await page.locator(".tb-owner-card a.toc-open").click(); await page.waitForTimeout(900);
      r.afterLink = await page.evaluate(`location.pathname`);
      chk.linkGoesToTheAgentPage = r.afterLink === "/ui/fleet/agent/dev-a";
      await page.screenshot({ path: shotPath(SMOKE, c, "9-agent-page") });
      await page.goBack(); await page.waitForTimeout(900);
      if ((await page.locator(".tp-activity").count()) === 0) {
        if ((await page.locator(".tb-tile").count()) === 0) await page.waitForSelector(".tb-tile", { state: "attached", timeout: 10000 });
        await page.locator('[data-tile="' + ids.m1 + '"] .tb-tile-title').click(); await page.waitForSelector(".tp-activity", { timeout: 10000 }); await page.waitForTimeout(400);
      }
    } else {
      // A phone: a tap opens it (a tap is not a hover), a tap outside closes it.
      await agentAuthor.scrollIntoViewIfNeeded();
      await agentAuthor.tap(); await page.waitForTimeout(350);
      chk.tapOpensTheCard = (await cardsN()) === 1 && (await page.locator(".tb-owner-card a.toc-open").count()) === 1;
      const box = await page.locator(".tb-owner-card").first().boundingBox();
      const vw = page.viewportSize()!;
      chk.phoneCardInsideTheScreen = !!box && box.x >= 0 && box.x + box.width <= vw.width + 0.5 && box.y >= 0 && box.y + box.height <= vw.height + 0.5;
      await page.screenshot({ path: shotPath(SMOKE, c, "9-author-info") });
      await page.touchscreen.tap(vw.width - 5, Math.round(vw.height / 2)); await page.waitForTimeout(300);   // the page's right gutter: outside the card, nothing to press
      chk.tapOutsideClosesTheCard = (await cardsN()) === 0;
      await personAuthor.tap(); await page.waitForTimeout(300);
      chk.phonePersonCardNoLink = (await cardsN()) === 1 && (await page.locator(".tb-owner-card a").count()) === 0;
      await page.touchscreen.tap(vw.width - 5, Math.round(vw.height / 2)); await page.waitForTimeout(300);
    }
    // Over a read-only link the card has no link (the Agent page needs a sign-in) and nothing else links there.
    await page.evaluate(`document.body.dataset.publicLink = "1"`);
    await page.locator(".tp-back").first().click(); await page.waitForSelector(".tb-tile", { state: "attached", timeout: 10000 });
    if (phone) { await page.locator(".tb-status-seg .tb-seg-btn").nth(1).click(); await page.waitForTimeout(200); }
    await page.locator('[data-tile="' + ids.m1 + '"] .tb-tile-title').click(); await page.waitForSelector(".tp-activity", { timeout: 10000 }); await page.waitForTimeout(400);
    const roAuthor = page.locator(".tp-activity .tl-comment.by-agent .tl-who-btn").first();
    await roAuthor.scrollIntoViewIfNeeded();
    if (phone) await roAuthor.tap(); else await roAuthor.hover();
    await page.waitForTimeout(450);
    chk.readOnlyCardHasNoLink = (await cardsN()) === 1 && (await page.locator(".tb-owner-card a").count()) === 0 && (await page.locator('.tp-activity a[href*="/fleet/agent/"]').count()) === 0;
    await page.evaluate(`delete document.body.dataset.publicLink`);
    await page.mouse.move(2, 2); await page.waitForTimeout(250);
    await page.locator(".tp-back").first().click();
    await page.waitForSelector(".tb-tile", { state: "attached", timeout: 10000 });
    await page.waitForTimeout(300);
    if (!shotsOnly) {
    // 4. the avatar: a button; its picker; a choice saves; the card does not open. The info card.
    const db = fm.scheduler.db;
    const assigneeOf = (code: string) => db.board.getCard(code).assignee as string | null;
    // A finished card's assignee is not changed (the card page does not offer it either): static there, a button elsewhere.
    chk.avatarIsButton = rendered.filter((t) => t.col !== labelOf(c, { en: "Done", zh: "完成" })).every((t) => t.owner && t.owner.tag === "BUTTON" && !t.owner.static)
      && rendered.filter((t) => t.col === labelOf(c, { en: "Done", zh: "完成" })).every((t) => t.owner && t.owner.static);
    if (phone) { await page.locator(".tb-status-seg .tb-seg-btn").nth(0).click(); await page.waitForTimeout(200); }
    const owner = page.locator(`[data-tile="${ids.m2}"] .tb-owner-btn`);
    await owner.click(); await page.waitForTimeout(250);
    chk.pickerOpens = (await page.locator(".tb-card-menu").count()) === 1 && (await page.locator(".tb-card-menu [role=menuitemradio]").count()) >= 4;
    chk.cardStaysClosed = (await page.locator(".tp").count()) === 0;
    chk.pickerHasCurrentTicked = (await page.locator('.tb-card-menu [aria-checked="true"]').first().textContent() ?? "").includes("dev-b");
    await page.screenshot({ path: shotPath(SMOKE, c, "3-owner-picker") });
    await page.keyboard.press("Escape"); await page.waitForTimeout(150);
    chk.escClosesAndFocusReturns = (await page.locator(".tb-card-menu").count()) === 0 && await page.evaluate(`document.activeElement?.classList.contains("tb-owner-btn")`) as boolean;
    await owner.click(); await page.waitForTimeout(200);
    await page.locator('.tb-card-menu [role=menuitemradio]', { hasText: "docs" }).first().click();
    for (let i = 0; i < 30 && assigneeOf(ids.m2) !== "docs"; i++) await page.waitForTimeout(100);
    chk.choiceSaves = assigneeOf(ids.m2) === "docs";
    await page.waitForTimeout(400);
    chk.cardStillClosed = (await page.locator(".tp").count()) === 0 && (await page.locator(`[data-tile="${ids.m2}"] .tb-owner-btn`).textContent() ?? "").includes("docs");
    if (!phone) {
      // Keyboard: Tab to the avatar and Enter opens the picker, Esc closes it.
      await page.waitForTimeout(700);                 // past the quiet moment after a choice
      await page.keyboard.press("Shift");             // the keyboard was the last input: the focus is a keyboard's
      await page.locator(`[data-tile="${ids.m6}"] .tb-owner-btn`).focus();
      await page.waitForTimeout(300);
      chk.focusShowsInfo = (await page.locator(".tb-owner-card").count()) === 1;
      await page.keyboard.press("Escape"); await page.waitForTimeout(100);
      chk.escHidesInfo = (await page.locator(".tb-owner-card").count()) === 0;
      await page.keyboard.press("Enter"); await page.waitForTimeout(200);
      chk.enterOpensPicker = (await page.locator(".tb-card-menu").count()) === 1;
      await page.keyboard.press("Escape"); await page.waitForTimeout(150);
      // Pointing at the running card's avatar: the info card.
      await page.mouse.move(2, 2);
      await page.locator(`[data-tile="${ids.m1}"] .tb-owner-btn`).hover(); await page.waitForTimeout(450);
      const info = await page.locator(".tb-owner-card").first().textContent().catch(() => "") ?? "";
      r.info = info.replace(/\\s+/g, " ").trim();
      chk.hoverShowsInfo = (await page.locator(".tb-owner-card").count()) === 1 && /dev-a/.test(info) && /S-2/.test(info);
      await page.screenshot({ path: shotPath(SMOKE, c, "4-owner-info") });
      await page.mouse.move(2, 2); await page.waitForTimeout(250);
      chk.leavingHidesInfo = (await page.locator(".tb-owner-card").count()) === 0;
      // The list: the same avatar.
      await page.locator(".tb-view-toggle .tb-seg-btn").nth(1).click(); await page.waitForTimeout(400);
      chk.listHasAvatarButtons = (await page.locator(".tb-row .tb-row-who .tb-owner-btn:not(.is-static)").count()) >= 5;
      await page.locator(".tb-row .tb-row-who .tb-owner-btn").first().click(); await page.waitForTimeout(200);
      chk.listPickerOpens = (await page.locator(".tb-card-menu").count()) === 1 && (await page.locator(".tp").count()) === 0;
      await page.screenshot({ path: shotPath(SMOKE, c, "5-list-owner-picker") });
      await page.keyboard.press("Escape"); await page.waitForTimeout(150);
      await page.screenshot({ path: shotPath(SMOKE, c, "5-list") });
      await page.locator(".tb-view-toggle .tb-seg-btn").nth(0).click(); await page.waitForTimeout(300);
    }
    }
  } catch (e) { r.error = String(e).slice(0, 500); chk.ranToTheEnd = false; await page.screenshot({ path: shotPath(SMOKE, c, "failure") }).catch(() => {}); }
  r.checks = chk; r.errors = errors;
  const bad = Object.entries(chk).filter(([, v]) => !v).map(([k]) => k);
  if (bad.length || errors.length) failed++;
  console.log(`${bad.length || errors.length ? "FAIL" : "ok  "} ${name}${bad.length ? ` [${bad.join(", ")}]` : ""}${errors.length ? " " + JSON.stringify(errors) : ""}${r.error ? " " + r.error : ""}`);
  results.cases[name] = r;
  await ctx.close();
}
writeFileSync(shotPath(SMOKE, "results", "measures").replace(/\.png$/, ".json"), JSON.stringify(results, null, 1));
await fx.close();
process.exit(failed ? 1 : 0);
