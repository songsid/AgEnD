/**
 * The board's cards (Fleet › Tasks), after a layout comparison and four points of feedback:
 *  - wider, and as tall as the content: the columns are 272–360 px however many there are (more than fit scroll), the board
 *    page is not held to 1240 px; a title takes two lines and the status one at most (the whole text is the tooltip); the
 *    status line says ONE thing, by priority (stuck → waits for the person → running → next → the sub tasks' progress);
 *  - a card whose agent is running says so with the "Running" mark (the moving light of the first version is gone: the user found
 *    it repeated the mark); it stops with the run;
 *  - no coloured bar on the left edge, in any status;
 *  - the assignee's avatar is a button: the card page's picker (the card does not open), a choice saves with the version
 *    the card was drawn at, a conflict says so; Esc closes it, the focus returns; an info card on hover and on the
 *    keyboard's focus; the list's rows have it too; over a read-only link, and on a finished card, it is not a button;
 *  - the info card names nothing the viewer does not see;
 *  - the card page's activity is a stream: a card for each comment and progress note (an agent's without a coloured
 *    bar), a thin row for each thing the system did (every run between two cards folded into "› N activities", even one line),
 *    the comment box the last card; without a box (a read-only page) the stream is alone;
 *  - round 7: an author's avatar (28px) in the stream shows the board's own info card — pointing, the keyboard's focus, a tap —
 *    with a link to the instance's Agent page (none over a read-only link, none for a person, no card at all for an instance the
 *    viewer does not see); a comment is formatted as the instance chat's window formats a message (Markdown, tables, a code block
 *    with the language, Wrap and Copy, a long one folded); the "Progress" tag and filter say on hover what a progress note is.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage;
let fleet: any, common: any, owner: any, app: any, nav: any, i18n: any, toastMod: any;
const calls: Array<{ method: string; path: string; body: any }> = [];
let handler: (path: string, method: string, body: any) => unknown = () => ({});
const fetchFake = async (path: string, o: any = {}) => {
  const method = o.method ?? "GET";
  const body = o.body ? JSON.parse(o.body) : null;
  calls.push({ method, path, body });
  const out: any = await handler(path, method, body);
  const status = out && typeof out === "object" && "__status" in out ? out.__status : 200;
  return { ok: status < 400, status, json: async () => out };
};

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
/**
 * `min` minutes before now, for a stream of activity. The tests run in UTC, and a stream that spans two days has a day heading,
 * so a clock within three hours of UTC midnight is read as 03:00: what the fixtures say a few hours apart stays on one day.
 */
const stamp = (min: number) => { const now = Date.now(), day = now - (now % 86_400_000); return new Date(Math.max(now, day + 3 * 3_600_000) - min * 60_000).toISOString(); };
const card = (over: Record<string, unknown>) => ({ id: "M-1", uuid: String(over.id ?? "M-1"), kind: "main", projectId: 1, parentId: null, title: "A card", status: "open",
  assignee: null, dispatcher: { kind: "person", name: "Ann" }, waitsForPerson: false, confirmer: null, priority: "normal", size: null, needsReview: true, dependsOn: [], goal: "", scope: "",
  acceptance: [] as Array<{ text: string; done: boolean }>, context: "", state: "", blockedReason: "", result: "done", sort: 1, createdBy: "Ann", version: 4, createdAt: ago(10), updatedAt: ago(1), startedAt: null, submittedAt: null,
  doneAt: null, progress: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 }, unmetDeps: [], commentCount: 0, newCommentCount: 0, lastComment: null, ...over });
const PROJECT = { id: 1, name: "Leaderboard", description: "", archived: false, sort: 1, createdAt: ago(30), leadInstance: "alpha" };
const LONG = "Rework the nightly leaderboard rebuild so that ties, late submissions and region merges are all handled in one pass";
const REASON = "Which scores count: ranked games only? Nobody on this side knows which week the new season starts";

let CARDS: any[] = [];
const build = () => {
  // M-1 runs (its sub task S-1 is alpha's one card in progress); M-2 has sub tasks to start; M-3 waits for the person; M-4 is blocked;
  // M-5 is done; M-6 has nobody; M-7 has an assignee and a dispatcher the viewer does not see; M-8 has a title of 100+ characters;
  // M-9 has sub tasks and nothing running (only their progress to say).
  const m1 = card({ id: "M-1", title: "Serve the weekly leaderboard", status: "claimed", assignee: "alpha", priority: "high", size: "M", sort: 1, progress: { total: 2, open: 1, claimed: 1, blocked: 0, review: 0, done: 0 },
    acceptance: [{ text: "Ties share a rank", done: true }, { text: "Under 300 ms", done: false }], commentCount: 2 });
  const s1 = card({ id: "S-1", kind: "sub", parentId: "M-1", title: "Build the score API", status: "claimed", assignee: "alpha", needsReview: false, sort: 1 });
  const s1b = card({ id: "S-9", kind: "sub", parentId: "M-1", title: "Write the tests", status: "open", assignee: "beta", needsReview: false, sort: 2 });
  const m2 = card({ id: "M-2", title: "Add the shop", status: "open", assignee: "beta", size: "L", sort: 2, progress: { total: 2, open: 2, claimed: 0, blocked: 0, review: 0, done: 0 } });
  const s2 = card({ id: "S-2", kind: "sub", parentId: "M-2", title: "Price list", status: "open", assignee: "gamma", needsReview: false, sort: 1 });
  const s3 = card({ id: "S-3", kind: "sub", parentId: "M-2", title: "Checkout", status: "open", assignee: "gamma", needsReview: false, sort: 2 });
  const m3 = card({ id: "M-3", title: "Pick the badges", status: "review", assignee: "beta", waitsForPerson: true, priority: "urgent", sort: 3 });
  const m4 = card({ id: "M-4", title: "Adjust the anti-cheat rules", status: "blocked", assignee: "gamma", blockedReason: REASON, sort: 4 });
  const m5 = card({ id: "M-5", title: "Build the score store", status: "done", assignee: "alpha", doneAt: ago(1), sort: 5 });
  const m6 = card({ id: "M-6", title: "Nothing but a title", status: "open", assignee: null, sort: 6 });
  const m7 = card({ id: "M-7", title: "Old work", status: "open", assignee: "ghost", dispatcher: { kind: "instance", name: "hidden-bot" }, sort: 7 });
  const m8 = card({ id: "M-8", title: LONG, status: "open", assignee: "beta", sort: 8 });
  const m9 = card({ id: "M-9", title: "Both halves wait", status: "open", assignee: "gamma", sort: 9, progress: { total: 1, open: 0, claimed: 0, blocked: 0, review: 0, done: 1 } });
  const s9 = card({ id: "S-10", kind: "sub", parentId: "M-9", title: "One half", status: "done", assignee: "gamma", needsReview: false, sort: 1, doneAt: ago(1) });
  return [m1, s1, s1b, m2, s2, s3, m3, m4, m5, m6, m7, m8, m9, s9];
};
const STORE = (alpha: string) => [["alpha", alpha], ["beta", "idle"], ["gamma", "idle"]].map(([name, exec]) => ({ name, status: "running", state: exec, execution_state: exec }));

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  i18n = await import("/assets/app-i18n.js");
  toastMod = await import("/assets/ui-toast.js");
  fleet = await import("/ui/js/panel-fleet.js");
  common = await import("/ui/js/fleet-task-common.js");
  owner = await import("/ui/js/fleet-task-owner.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });

const body = () => (globalThis as any).document.body;
beforeEach(async () => {
  await p.unmount();
  i18n.setLang("en", { store: false });
  const ls = (globalThis as any).localStorage;
  for (const k of ["agend_tasks_project", "agend_tasks_display", "agend_tasks_filters", "agend_tasks_assignee", "agend_tasks_query", "agend_tasks_collapsed"]) ls.removeItem(k);
  for (const k of ["publicLink", "linkMedia", "tier"]) delete body().dataset[k];
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  (globalThis as any).history.entries.length = 1;
  (globalThis as any).history.states.length = 1;
  (globalThis as any).history.at = 0;
  calls.length = 0;
  CARDS = build();
  owner.quietInfo(-1);                    // the moment after a picker closes belongs to the test that closed it
  handler = (path, method) => {
    if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS, boardOff: [] };
    const m = /^\/ui\/tasks\/cards\/([^/]+)(\/move)?$/.exec(path);
    if (m && method === "POST") return { card: CARDS.find((x) => x.id === decodeURIComponent(m[1]!)), notes: [] };
    if (m) { const c = CARDS.find((x) => x.id === decodeURIComponent(m[1]!)) ?? CARDS[0]; return { card: c, parent: null, children: [], comments: [], logs: [], history: [] }; }
    return {};
  };
  app.applyStatus({ uptime: 1, instances: STORE("working") });
});

let mounts = 0;
async function mount(display: Record<string, unknown> | null = null) {
  await p.unmount();
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  (globalThis as any).localStorage.setItem("agend_tasks_project", "1");
  if (display) (globalThis as any).localStorage.setItem("agend_tasks_display", JSON.stringify(display));
  await p.mount(h("div", {}, h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|l316-${++mounts}|en` }), h(toastMod.Toasts, {})));
  await settle(8);
}
const q = (sel: string) => p.root.querySelector(sel);
const qa = (sel: string) => [...p.root.querySelectorAll(sel)] as any[];
const text = (el: any): string => (el ? el.childNodes.map((n: any) => (n.nodeType === 3 ? n.textContent : text(n)) ?? "").map((s: string) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ") : "");
const doc = () => (globalThis as any).document;
const tile = (id: string) => q(`[data-tile="${id}"]`);
const posts = () => calls.filter((c) => c.method === "POST");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The harness's elements name `on<event>` props they know; Preact falls back to the prop's own casing for the others.
const enter = (el: any) => { fire(el, "mouseenter"); fire(el, "MouseEnter"); };
const leave = (el: any) => { fire(el, "mouseleave"); fire(el, "MouseLeave"); };
// The keyboard's focus reaching an element, and leaving it (Preact binds `onFocusIn` under the name its DOM has; mini-dom has none).
const focusIn = (el: any) => { fire(el, "focusin"); fire(el, "FocusIn"); };
const focusOut = (el: any, to: any = null) => { fire(el, "focusout", { relatedTarget: to }); fire(el, "FocusOut", { relatedTarget: to }); };
const UI = join(process.cwd(), "src", "ui");
const CSS = readFileSync(join(UI, "shared", "app.css"), "utf8") + "\n" + readFileSync(join(UI, "shared", "task-board.css"), "utf8");
/** Every rule for a selector, joined (a selector can have a rule in app.css and another in task-board.css). */
const rules = (sel: string) => { const out: string[] = []; for (let i = CSS.indexOf(`\n${sel} {`); i >= 0; i = CSS.indexOf(`\n${sel} {`, i + 1)) out.push(CSS.slice(i + 1, CSS.indexOf("}", i) + 1)); return out.join("\n"); };
const rule = (sel: string) => { const i = CSS.indexOf(`\n${sel} {`); return i < 0 ? null : CSS.slice(i + 1, CSS.indexOf("}", i) + 1); };

describe("the status line says one thing, by priority", () => {
  const sub = (status: string, over: Record<string, unknown> = {}) => card({ id: "S-1", kind: "sub", status, ...over });
  const work = (status: string, label: string, tone: string) => ({ label, tone, cards: [sub(status)] });
  it("stuck → waits for the person → running → next → the sub tasks' progress; nothing: none", () => {
    const c = (over: Record<string, unknown>) => card({ status: "claimed", ...over });
    const all = { now: work("claimed", "tasks.nowDoing", "claimed"), run: { instance: "alpha", state: "working", shared: 0 }, hasSubs: true };
    // A blocked card with a reason says it, whatever else it could say.
    expect(common.tileStatus(c({ status: "blocked", blockedReason: "why?" }), all)).toMatchObject({ kind: "blocked", reason: "why?" });
    // A main task blocked by a sub task, with no reason of its own, names that sub task.
    expect(common.tileStatus(c({ status: "claimed" }), { now: work("blocked", "tasks.nowBlocked", "blocked"), run: all.run, hasSubs: true })).toMatchObject({ kind: "blocked", reason: "" });
    expect(common.tileStatus(c({ status: "review", waitsForPerson: true }), all)).toMatchObject({ kind: "review", you: true });
    expect(common.tileStatus(c({ status: "review", confirmer: "alpha" }), all)).toMatchObject({ kind: "review", you: false, label: "Waiting for alpha" });
    expect(common.tileStatus(c({}), all)).toMatchObject({ kind: "running", run: { state: "working" } });
    expect(common.tileStatus(c({}), { now: all.now, hasSubs: true })).toMatchObject({ kind: "running", run: null });
    expect(common.tileStatus(c({}), { run: { instance: "alpha", state: "needs", shared: 0 } })).toMatchObject({ kind: "running" });
    expect(common.tileStatus(c({}), { run: { instance: "alpha", state: "idle", shared: 0 } }), "an idle agent says nothing").toBeNull();
    expect(common.tileStatus(c({ status: "open" }), { now: work("open", "tasks.nowNext", "open"), hasSubs: true })).toMatchObject({ kind: "next" });
    expect(common.tileStatus(c({ status: "open" }), { hasSubs: true })).toEqual({ kind: "progress" });
    expect(common.tileStatus(c({ status: "open" }), {})).toBeNull();
  });

  it("on the board: each tile has at most one status element, the kind in its class; a card with nothing to say has no row", async () => {
    await mount();
    const kind = (id: string) => (tile(id).querySelector(".tb-tile-status")?.className.match(/k-(\w+)/) ?? [])[1] ?? null;
    expect(["M-1", "M-2", "M-3", "M-4", "M-6", "M-9"].map(kind)).toEqual(["running", "next", "review", "blocked", null, "progress"]);
    for (const t of qa(".tb-tile")) expect(t.querySelectorAll(".tb-tile-status").length, t.getAttribute("data-tile")).toBeLessThanOrEqual(1);
    expect(tile("M-6").querySelector(".tb-tile-status"), "no row for nothing").toBeNull();
    expect(text(tile("M-3").querySelector(".tb-tile-waits"))).toBe("Waiting for you");
    expect(text(tile("M-1").querySelector(".tb-tile-run"))).toContain("Running");
    expect(text(tile("M-1").querySelector(".tb-tile-now"))).toBe("S-1 Build the score API");
    expect(text(tile("M-2").querySelector(".tb-tile-now"))).toBe("Next S-2 Price list +1");
    expect(tile("M-9").querySelector(".tb-tile-progress"), "the progress is the line, with the sub tasks' toggle in it").toBeTruthy();
  });

  it("the whole text of a cut line is its tooltip; a blocked reason is one line (cut) with its text in the title", async () => {
    await mount();
    const note = tile("M-4").querySelector(".tb-tile-note");
    expect(note.getAttribute("title")).toBe(REASON);
    expect(text(note)).toBe(REASON);
    expect(rule(".tb-tile-note > span")).toMatch(/white-space: nowrap/);
    expect(rule(".tb-tile-note > span")).toMatch(/text-overflow: ellipsis/);
    expect(rule(".tb-tile-status")).toMatch(/overflow: hidden/);
    expect(rule(".tb-tile-note.st-blocked")).toMatch(/color: var\(--danger\)/);
    expect(rule(".tb-tile-waits")).toMatch(/color: var\(--warn\)/);
  });

  it("a status that is not the progress leaves the sub tasks' count in the foot, opening the list; a blocked sub task shows there", async () => {
    await mount();
    const toggle = tile("M-1").querySelector(".tb-tile-foot .tb-tile-subs");
    expect(text(toggle)).toBe("0 / 2");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fire(toggle, "click"); await settle(4);
    expect(tile("M-1").querySelector(".tb-subs")).toBeTruthy();
    expect(qa(".tp").length, "it did not open the card").toBe(0);
    expect(tile("M-9").querySelector(".tb-tile-foot .tb-tile-subs"), "the progress line is the toggle: not twice").toBeNull();
    CARDS[0].progress = { total: 2, open: 0, claimed: 1, blocked: 1, review: 0, done: 0 };
    await mount();
    expect(tile("M-1").querySelector(".tb-tile-subs").className).toContain("has-blocked");
  });

  it("the title is cut at two lines in CSS, and its whole text (with the drag hint) is the tooltip", async () => {
    await mount();
    const t = tile("M-8").querySelector(".tb-tile-title");
    expect(t.getAttribute("title")).toContain(LONG);
    expect(text(t.querySelector("span"))).toBe(LONG);
    expect(rule(".tb-tile-title > span")).toMatch(/-webkit-line-clamp: 2/);
    expect(rule(".tb-tile-title > span")).toMatch(/line-clamp: 2/);
    expect(rule(".tb-tile-title > span")).toMatch(/overflow: hidden/);
  });
});

describe("wider, and as tall as the content", () => {
  it("a column is 272–360 px however many there are; more than fit scroll; the phone stays one column", () => {
    const cols = rule(".tb-columns")!;
    expect(cols).toMatch(/grid-auto-flow: column/);
    expect(cols).toMatch(/grid-auto-columns: minmax\(272px, 360px\)/);
    expect(cols, "no fixed number of columns").not.toMatch(/repeat\(\d/);
    expect(cols).toMatch(/min-width: min-content/);
    const phone = CSS.slice(CSS.indexOf("@media (max-width: 899px), (pointer: coarse)", CSS.indexOf(".tb-columns {")));
    expect(phone).toMatch(/\.tb-columns \{ grid-auto-flow: row; grid-auto-columns: auto; grid-template-columns: minmax\(0, 1fr\)/);
    expect(CSS).not.toMatch(/\.tb-columns\.no-done/);
  });
  it("a project's page — the board and the list alike — is not held to 1240 px; Home keeps the Fleet page's width", async () => {
    expect(rule(".col.col-wide")).toMatch(/max-width: 1240px/);
    expect(rule(".col.col-wide:has(> .tb > .tb-board-page)")).toMatch(/max-width: none/);
    expect(CSS, "no rule is left that frees the board alone").not.toMatch(/is-board/);
    await mount();
    expect(q(".tb-board-page"), "the board").toBeTruthy();
    expect(q(".tb-board-page").className).toBe("tb-board-page");
    await mount({ view: "list" });
    expect(q(".tb-board-page .tb-list"), "the list is on the same page, so it has the same width").toBeTruthy();
    expect(q(".tb-board-page").className).toBe("tb-board-page");
    // Home (the projects) is not a board page: its rule is the Fleet page's.
    await p.unmount();
    (globalThis as any).localStorage.removeItem("agend_tasks_project");
    (globalThis as any).history.replaceState(null, "", "/ui/fleet");            // a project's board writes `?tp=` into the address
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|l316-home-${++mounts}|en` }));
    await settle(8);
    expect(q(".tb-home")).toBeTruthy();
    expect(q(".tb-board-page")).toBeNull();
  });
  it("the list's columns: the title takes what is left, every other column keeps its width (head and rows alike)", () => {
    expect(rule(".tb-row-text")).toMatch(/flex: 1/);
    expect(rule(".tb-lh-title")).toMatch(/flex: 1/);
    for (const [sel, width] of [[".tb-lh-prio", "84px"], [".tb-lh-who", "140px"], [".tb-lh-time", "7em"], [".tb-lh-code", "4.5em"], [".tb-row-prio", "84px"], [".tb-row-who", "140px"], [".tb-row-time", "7em"], [".tb-row-code", "4.5em"]] as const) {
      expect(rule(sel), sel).toContain(`width: ${width}`);
      expect(rule(sel), sel).not.toMatch(/(^|[ ;{])flex: [1-9]/);
    }
  });
  it("no fixed height anywhere on a tile: it follows its content", () => {
    for (const sel of [".tb-tile", ".tb-tile-top", ".tb-tile-title", ".tb-tile-status", ".tb-tile-foot"]) {
      const r = rule(sel);
      expect(r, sel).toBeTruthy();
      expect(r, sel).not.toMatch(/(^|[ ;{])height:/);
    }
  });
  it("a tile's columns count is the statuses shown, not five", async () => {
    await mount({ view: "board", group: "status", order: "manual", dir: "asc", done: "hide", subs: false });
    expect(qa(".tb-col").length).toBe(4);
    expect(q(".tb-columns").className).toBe("tb-columns");
  });
});

describe("no coloured bar on the left edge", () => {
  it("the shared bar's lists do not have the tile; the tile sets no bar colour in any status", () => {
    const lists = [...CSS.matchAll(/^\.lbar, [^{]*\{/gm)].map((m) => m[0]).join("\n") + [...CSS.matchAll(/^\.lbar::before, [^{]*\{/gm)].map((m) => m[0]).join("\n");
    expect(lists).toContain(".reply-bar");
    expect(lists, "the tile is not one of its places").not.toMatch(/\.tb-tile\b/);
    expect(CSS).not.toMatch(/\.tb-tile[.\w-]*\s*\{[^}]*--lbar-color/);
    expect(rule(".tb-tile")).not.toMatch(/--lbar-color/);
    expect(rule(".tb-tile")).toMatch(/padding: var\(--s-3\);/);
  });
  it("a tile of every status is drawn without a bar element or class", async () => {
    await mount();
    for (const t of qa(".tb-tile")) {
      expect(t.className, t.getAttribute("data-tile")).not.toMatch(/lbar|bar/);
      expect(t.querySelector(".lbar")).toBeNull();
    }
    expect(qa(".tb-tile").map((t) => t.className.match(/st-(\w+)/)![1]).sort()).toEqual(expect.arrayContaining(["claimed", "open", "review", "blocked", "done"]));
  });
});

describe("a card whose agent is running says so once, with the \"Running\" mark (no moving light)", () => {
  it("the running card has the mark in its status line and its `running` class; others have neither; no light layer", async () => {
    await mount();
    expect(tile("M-1").className).toContain(" running");
    expect(text(tile("M-1").querySelector(".tb-tile-run .tr-mark"))).toBe("Running");
    for (const id of ["M-2", "M-3", "M-4", "M-5", "M-6", "M-9"]) { expect(tile(id).className, id).not.toContain("running"); expect(tile(id).querySelector(".tr-mark"), id).toBeNull(); }
    for (const t of qa(".tb-tile")) expect(t.querySelector(".tb-tile-shine"), t.getAttribute("data-tile")).toBeNull();
    expect(tile("M-1").getAttribute("style"), "no style attribute (the CSP)").toBeNull();
  });
  it("it stops when the run does: the agent idle → no class, no mark; working again → back", async () => {
    await mount();
    app.applyStatus({ uptime: 2, instances: STORE("idle") }); await settle(6);
    expect(tile("M-1").className).not.toContain("running");
    expect(tile("M-1").querySelector(".tr-mark")).toBeNull();
    app.applyStatus({ uptime: 3, instances: STORE("working") }); await settle(6);
    expect(tile("M-1").className).toContain(" running");
    expect(tile("M-1").querySelector(".tr-mark")).toBeTruthy();
  });
  it("an agent with two cards in progress runs none of them (which one it is on is not known)", async () => {
    CARDS.push(card({ id: "M-20", title: "Second", status: "claimed", assignee: "beta", sort: 20 }), card({ id: "M-21", title: "Third", status: "claimed", assignee: "beta", sort: 21 }));
    app.applyStatus({ uptime: 2, instances: STORE("working").map((i: any) => (i.name === "beta" ? { ...i, state: "working", execution_state: "working" } : i)) });
    await mount();
    expect(tile("M-20").className).not.toContain("running");
    expect(tile("M-21").className).not.toContain("running");
  });
  it("the CSS has no light: no layer, no keyframes, no animation on a tile; the original running tile (edge, tint) stays", () => {
    expect(CSS).not.toMatch(/tb-tile-shine|tb-shine|tb-breathe/);
    expect(CSS, "nothing on a tile animates but its flash when a card changes").not.toMatch(/\.tb-tile[^{]*\{[^}]*animation: (?!tb-flash|none)/);
    expect(rule(".tb-tile.running")).toMatch(/border-color: var\(--accent\)/);
    expect(rule(".tb-tile.running")).toMatch(/background: color-mix\(in srgb, var\(--accent\) 6%, var\(--bg\)\)/);
    expect(rule(".tb-row.running")).toBeTruthy();
  });
});

describe("the avatar is the card page's assignee picker", () => {
  const chip = (id: string) => tile(id).querySelector(".tb-owner-btn");
  const picker = () => q(".tb-card-menu");
  const items = () => qa(".tb-card-menu button[role^=menuitem]").map((b) => `${b.getAttribute("aria-checked") === "true" ? "✓ " : ""}${text(b)}`);
  it("a button with a name that says what it does; a finished card's assignee is plain; nobody is a button too", async () => {
    await mount();
    expect(chip("M-1").tagName).toBe("BUTTON");
    expect(chip("M-1").getAttribute("aria-label")).toBe("alpha: change assignee");
    expect(chip("M-1").getAttribute("aria-haspopup")).toBe("menu");
    expect(chip("M-1").getAttribute("title"), "no tooltip of its own: the info card says more").toBeNull();
    expect(text(chip("M-1"))).toContain("alpha");
    expect(chip("M-6").tagName).toBe("BUTTON");
    expect(chip("M-6").getAttribute("aria-label")).toBe("Assign");
    expect(text(chip("M-6"))).toBe("Unassigned");
    expect(chip("M-5").tagName, "done: not changed").toBe("SPAN");
    expect(chip("M-5").className).toContain("is-static");
  });
  it("a click opens the picker the page has (nobody, each instance, Other…; this one ticked) and does not open the card", async () => {
    await mount();
    fire(chip("M-2"), "click"); await settle(4);
    expect(picker().getAttribute("role")).toBe("menu");
    expect(picker().getAttribute("aria-label")).toBe("beta: change assignee");
    expect(items()).toEqual(["Unassigned", "alpha", "✓ beta", "gamma", "Other…"]);
    expect(qa(".tp").length, "the card stayed shut").toBe(0);
    expect(calls.filter((c) => /\/ui\/tasks\/cards\/M-2$/.test(c.path) && c.method === "GET")).toEqual([]);
  });
  it("a choice saves with the version the card was drawn at, closes the picker and gives the focus back; the card stays shut", async () => {
    await mount();
    fire(chip("M-2"), "click"); await settle(4);
    fire(qa(".tb-card-menu [role=menuitemradio]").find((b) => text(b) === "gamma"), "click"); await settle(10);
    expect(posts().map((c) => [c.path, c.body])).toEqual([["/ui/tasks/cards/M-2", { assignee: "gamma", version: 4 }]]);
    expect(picker()).toBeNull();
    expect(doc().activeElement.className).toContain("tb-owner-btn");
    expect(qa(".tp").length).toBe(0);
    expect(calls.filter((c) => c.path.startsWith("/ui/tasks/board")).length, "the board is read again").toBeGreaterThanOrEqual(2);
  });
  it("Unassigned sends null", async () => {
    await mount();
    fire(chip("M-2"), "click"); await settle(4);
    fire(qa(".tb-card-menu [role=menuitemradio]").find((b) => text(b) === "Unassigned"), "click"); await settle(10);
    expect(posts().map((c) => c.body)).toEqual([{ assignee: null, version: 4 }]);
  });
  it("Esc closes it without sending, and the avatar has the focus back", async () => {
    await mount();
    fire(chip("M-2"), "click"); await settle(4);
    fire(picker(), "keydown", { key: "Escape", cancelable: true }); await settle(4);
    expect(picker()).toBeNull();
    expect(posts()).toEqual([]);
    expect(doc().activeElement.className).toContain("tb-owner-btn");
  });
  it("a card changed since (409) says so and the board is read again; nothing else is sent", async () => {
    handler = (path, method) => {
      if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS, boardOff: [] };
      if (method === "POST") return { __status: 409, error: "changed", key: "conflict", args: ["M-2", "alpha"] };
      return {};
    };
    await mount();
    const reads = () => calls.filter((c) => c.path.startsWith("/ui/tasks/board")).length;
    const before = reads();
    fire(chip("M-2"), "click"); await settle(4);
    fire(qa(".tb-card-menu [role=menuitemradio]").find((b) => text(b) === "gamma"), "click"); await settle(10);
    expect(posts().length).toBe(1);
    expect(text(q(".toasts"))).toContain("M-2 changed while you were choosing. The board is up to date: choose again.");
    expect(reads()).toBeGreaterThan(before);
  });
  it("an error says what the host said", async () => {
    handler = (path, method) => {
      if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS, boardOff: [] };
      if (method === "POST") return { __status: 400, error: "No such instance" };
      return {};
    };
    await mount();
    fire(chip("M-2"), "click"); await settle(4);
    fire(qa(".tb-card-menu [role=menuitemradio]").find((b) => text(b) === "gamma"), "click"); await settle(10);
    expect(text(q(".toasts"))).toContain("No such instance");
  });
  it("Other… asks for a name, and sends it", async () => {
    await mount();
    fire(chip("M-2"), "click"); await settle(4);
    fire(qa(".tb-card-menu [role=menuitem]").find((b) => text(b) === "Other…"), "click"); await settle(8);
    const box = q("dialog input, dialog textarea");
    expect(box, "the question").toBeTruthy();
    box.value = "delta"; fire(box, "input"); await settle(4);
    fire(q("dialog .btn-primary"), "click"); await settle(12);
    expect(posts().map((c) => c.body)).toEqual([{ assignee: "delta", version: 4 }]);
  });
  it("the tile's own menu (⋯) assigns through the same write, with the same conflict words", async () => {
    handler = (path, method) => {
      if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS, boardOff: [] };
      if (method === "POST") return { __status: 409, error: "changed", key: "conflict", args: ["M-2", "alpha"] };
      return {};
    };
    await mount();
    fire(tile("M-2").querySelector(".tb-tile-more"), "click"); await settle(6);
    fire(qa(".tb-card-menu [role=menuitemradio]").find((b) => text(b) === "gamma"), "click"); await settle(10);
    expect(posts().map((c) => c.body)).toEqual([{ assignee: "gamma", version: 4 }]);
    expect(text(q(".toasts"))).toContain("changed while you were choosing");
  });
  it("the picker is the page's: the same items for the same card", async () => {
    const card = await import("/ui/js/fleet-task-card.js") as any;
    await mount();
    fire(chip("M-2"), "click"); await settle(4);
    const page = card.assigneeItems(CARDS.find((c: any) => c.id === "M-2"), ["alpha", "beta", "gamma"], [], () => {}).map((i: any) => `${i.checked ? "✓ " : ""}${i.label}`);
    expect(items().concat([]).map((s) => s.replace(/^✓ /, "✓ ")), "the radio items, then Other…").toEqual(page);
  });
  it("the list's rows have the same avatar and picker", async () => {
    await mount({ view: "list", group: "status", order: "manual", dir: "asc", done: "recent", subs: false });
    const row = (id: string) => q(`[data-row="${id}"] .tb-row-who .tb-owner-btn`);
    expect(row("M-2").tagName).toBe("BUTTON");
    expect(row("M-5").tagName, "a finished card's: plain").toBe("SPAN");
    fire(row("M-2"), "click"); await settle(4);
    expect(items()).toEqual(["Unassigned", "alpha", "✓ beta", "gamma", "Other…"]);
    expect(qa(".tp").length, "the row did not open its card").toBe(0);
    fire(qa(".tb-card-menu [role=menuitemradio]").find((b) => text(b) === "alpha"), "click"); await settle(10);
    expect(posts().map((c) => [c.path, c.body])).toEqual([["/ui/tasks/cards/M-2", { assignee: "alpha", version: 4 }]]);
  });
  it("a main task whose sub tasks are someone else's: its owner is the avatar, the sub tasks' people follow it", async () => {
    await mount();
    expect(text(tile("M-2").querySelector(".tb-tile-foot .tb-owner"))).toContain("beta");
    expect(text(tile("M-2").querySelector(".tb-tile-foot .tb-people .tb-who"))).toBe("gamma");
    expect(tile("M-2").querySelector(".tb-tile-foot .tb-people").getAttribute("title")).toBe("Assigned to its sub tasks");
    expect(tile("M-9").querySelector(".tb-tile-foot .tb-people"), "no sub task to start or run: nobody follows").toBeNull();
  });
});

describe("over a read-only link, the avatar only shows", () => {
  const seen = async (set: Record<string, string>) => {
    for (const [k, v] of Object.entries(set)) body().dataset[k] = v;
    await mount();
  };
  it("a public link that is not an admin's: no button anywhere, a click picks nothing and opens only the card", async () => {
    await seen({ publicLink: "1" });
    expect(qa("button.tb-owner-btn").length).toBe(0);
    expect(qa(".tb-owner-btn.is-static").length).toBeGreaterThan(5);
    fire(tile("M-2").querySelector(".tb-owner-btn"), "click"); await settle(8);
    expect(q(".tb-card-menu")).toBeNull();
    expect(posts()).toEqual([]);
    expect(q(".tp"), "the avatar is part of the tile: the card opens").toBeTruthy();
  });
  it("a guest: the same; the list's rows too", async () => {
    await seen({ tier: "guest" });
    expect(qa("button.tb-owner-btn").length).toBe(0);
    await mount({ view: "list" });
    expect(qa("button.tb-owner-btn").length).toBe(0);
    expect(qa(".tb-row-who .tb-owner-btn.is-static").length).toBeGreaterThan(5);
  });
  it("an admin session over the link writes as itself (M-3278): the buttons are there", async () => {
    await seen({ publicLink: "1", linkMedia: "1" });
    expect(tile("M-2").querySelector(".tb-owner-btn").tagName).toBe("BUTTON");
  });
  it("the viewer's kind, in the one place that says it", () => {
    body().dataset.publicLink = "1"; expect(common.boardReadOnly()).toBe(true);
    body().dataset.linkMedia = "1"; expect(common.boardReadOnly()).toBe(false);
    delete body().dataset.publicLink; delete body().dataset.linkMedia; expect(common.boardReadOnly()).toBe(false);
    body().dataset.tier = "guest"; expect(common.boardReadOnly()).toBe(true);
  });
  it("the info card still shows (it only reads): read-only is not blind", async () => {
    await seen({ publicLink: "1" });
    const el = tile("M-1").querySelector(".tb-owner-btn");
    expect(el.getAttribute("tabindex")).toBe("0");
    enter(el); await wait(300); await settle(2);
    expect(q(".tb-owner-card")).toBeTruthy();
  });
});

describe("the info card", () => {
  const chip = (id: string) => tile(id).querySelector(".tb-owner-btn");
  const card = () => q(".tb-owner-card");
  const rows = () => {
    const kids = (q(".toc-rows")?.childNodes ?? []).filter((n: any) => n.nodeType === 1);
    return Object.fromEntries(kids.filter((n: any) => n.tagName === "DT").map((dt: any) => [text(dt), text(kids[kids.indexOf(dt) + 1])]));
  };
  it("pointing at the avatar shows it after a short pause: who, state, what it is doing, how many cards, the page's two facts", async () => {
    await mount();
    enter(chip("M-1"));
    await settle(2);
    expect(card(), "not at once").toBeNull();
    await wait(300); await settle(2);
    expect(text(q(".toc-head"))).toContain("alpha");
    expect(text(q(".toc-head .tr-mark"))).toBe("Running");
    expect(rows()).toEqual({ Now: "Working on S-1 Build the score API", Cards: "1 open · 1 in progress", Role: "Project lead", "Dispatched by": "Ann" });
    expect(card().getAttribute("role"), "a card with a link in it is a dialog, not a tooltip").toBe("dialog");
    expect(chip("M-1").getAttribute("aria-describedby")).toBe(card().getAttribute("id"));
    expect(q(".tb-owner-pop").getAttribute("style") ?? "", "placed through the CSSOM, never an attribute in the markup").toMatch(/^(left: [\d.]+px; top: [\d.]+px;)?$/);
  });
  it("leaving, a click, Esc and a scroll hide it; a quick pass shows nothing", async () => {
    await mount();
    enter(chip("M-1")); leave(chip("M-1")); await wait(300); await settle(2);
    expect(card(), "a quick pass").toBeNull();
    enter(chip("M-1")); await wait(300); await settle(2);
    expect(card()).toBeTruthy();
    leave(chip("M-1")); await wait(260); await settle(2);
    expect(card(), "leaving (after the short grace that lets the pointer reach the card)").toBeNull();
    enter(chip("M-1")); await wait(300); await settle(2);
    fire(chip("M-1"), "keydown", { key: "Escape" }); await settle(2);
    expect(card(), "Esc").toBeNull();
    leave(chip("M-1")); enter(chip("M-1")); await wait(300); await settle(2);
    fire(chip("M-1"), "click"); await settle(4);
    expect(card(), "a click (which opens the picker)").toBeNull();
    expect(q(".tb-card-menu")).toBeTruthy();
  });
  it("the keyboard's focus shows it at once; blur hides it; one card at a time", async () => {
    await mount();
    focusIn(chip("M-1")); await settle(2);
    expect(card(), "at once").toBeTruthy();
    enter(chip("M-3")); await wait(300); await settle(2);
    expect(qa(".tb-owner-card").length, "pointing at a second one hides the first").toBe(1);
    expect(text(q(".toc-head"))).toContain("beta");
    focusOut(chip("M-1")); leave(chip("M-3")); await wait(260); await settle(2);
    expect(qa(".tb-owner-card").length).toBe(0);
  });
  it("the focus coming back from the picker it opened does not show it", async () => {
    await mount();
    fire(chip("M-2"), "click"); await settle(4);
    fire(q(".tb-card-menu"), "keydown", { key: "Escape", cancelable: true }); await settle(4);
    focusIn(chip("M-2")); await settle(2);
    expect(card()).toBeNull();
    await wait(600);
    focusOut(chip("M-2")); focusIn(chip("M-2")); await settle(2);
    expect(card(), "a keyboard's focus later does").toBeTruthy();
  });
  it("what it says is from the board the viewer was sent and the instances they see", async () => {
    const facts = owner.ownerFacts("alpha", CARDS[0], CARDS, "alpha");
    expect(facts).toMatchObject({ total: 1, by: { claimed: 1, open: 0, blocked: 0, review: 0 }, lead: true, dispatcher: { kind: "person", name: "Ann" } });
    expect(facts.doing.map((c: any) => c.id)).toEqual(["S-1"]);
    // A main task that follows its sub tasks is not work in itself; a finished card is not in hand.
    expect(owner.ownerFacts("alpha", CARDS[0], CARDS, null).total, "M-1 follows its sub tasks and M-5 is done").toBe(1);
    expect(owner.ownerFacts("gamma", CARDS[0], CARDS, "alpha")).toMatchObject({ lead: false, total: 3 });
    expect(owner.ownerFacts("nobody", CARDS[0], [], null)).toMatchObject({ total: 0, doing: [] });
  });
  it("an instance the viewer does not see: no state, no dispatcher name; a person's name stays", async () => {
    await mount();
    enter(chip("M-7")); await wait(300); await settle(2);
    const all = text(card());
    expect(card()).toBeTruthy();
    expect(all).toContain("ghost");
    expect(all, "no state is claimed for an instance not shown").not.toMatch(/Running|Idle|Offline|Needs you|Looks stuck/);
    expect(all, "the dispatcher is an instance kept out of sight: not named").not.toContain("hidden-bot");
    expect(rows()["Dispatched by"], "…and no row for it").toBeUndefined();
    expect(owner.visibleDispatcher({ kind: "instance", name: "hidden-bot" }, { instances: [{ name: "alpha" }] })).toBeNull();
    expect(owner.visibleDispatcher({ kind: "instance", name: "alpha" }, { instances: [{ name: "alpha" }] })).toBe("alpha");
    expect(owner.visibleDispatcher({ kind: "person", name: "Ann" }, { instances: [] })).toBe("Ann");
    expect(owner.visibleDispatcher(null, { instances: [] })).toBeNull();
  });
  it("the states in words: running, needs you, stuck, idle; any other state of an instance shown is offline", () => {
    const st = (exec: string, status = "running") => owner.ownerState("alpha", { instances: [{ name: "alpha", status, execution_state: exec }], exec: { alpha: exec } });
    expect(st("working")).toMatchObject({ state: "running", text: "Running" });
    expect(st("idle")).toMatchObject({ state: "idle", text: "Idle" });
    expect(st("stuck")).toMatchObject({ state: "stuck", text: "Looks stuck" });
    expect(st("idle", "stopped")).toMatchObject({ state: "offline", text: "Offline" });
    expect(st("idle", "crashed")).toMatchObject({ state: "offline" });
    expect(owner.ownerState("alpha", { instances: [] }), "not shown: nothing claimed").toBeNull();
  });
  it("the words are in both languages with the same {n}, and every call names one", () => {
    const strip = (src: string) => src.replace(/^import .*$/gm, "").replace(/^export /gm, "");
    const ctx = vm.createContext({ navigator: { language: "en" } });
    vm.runInContext(strip(readFileSync(join(UI, "shared", "app-i18n.js"), "utf8")), ctx);
    const src = readFileSync(join(UI, "fleet-task-owner.js"), "utf8");
    vm.runInContext(`(${/register\("taskowner", (\{[\s\S]*?\n\})\);/.exec(src)![0].replace(/;$/, "")})`, ctx);
    const tables = vm.runInContext("tables", ctx) as Record<"en" | "zh-TW", Record<string, string>>;
    const keys = (lang: "en" | "zh-TW") => Object.keys(tables[lang]).filter((k) => k.startsWith("taskowner."));
    expect(keys("en").sort()).toEqual(keys("zh-TW").sort());
    for (const k of keys("en")) expect((tables["zh-TW"][k]!.match(/\{\d\}/g) ?? []).join(), k).toBe((tables.en[k]!.match(/\{\d\}/g) ?? []).join());
    for (const file of ["fleet-task-owner.js", "fleet-tasks.js", "fleet-task-view.js"]) {
      for (const m of readFileSync(join(UI, file), "utf8").matchAll(/\bt\(\s*"(taskowner\.[\w.]+)"/g)) expect(tables.en[m[1]!], `${file}: ${m[1]}`).toBeDefined();
    }
    for (const s of ["claimed", "open", "blocked", "review"]) expect(tables.en[`taskowner.part_${s}`], s).toBeDefined();
  });
});


describe("the card page's activity is a stream: a card for what is said, a thin row for what the system did", () => {
  const AT = stamp;
  const ev = (id: number, actor: string, min: number, type = "updated", data: any = { changes: { goal: ["a", "b"] } }, actorKind = "person") => ({ id, type, actor, actorKind, at: AT(min), data });
  const withActivity = (over: Record<string, unknown> = {}) => {
    handler = (path, method) => {
      if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS, boardOff: [] };
      const m = /^\/ui\/tasks\/cards\/([^/]+)$/.exec(path);
      if (m && method === "GET") {
        const c = CARDS.find((x: any) => x.id === decodeURIComponent(m[1]!)) ?? CARDS[0];
        return { card: c, parent: null, children: CARDS.filter((x: any) => x.parentId === c.id), watchers: [], inheritedWatchers: [], leader: null, followsProgress: true,
          comments: [{ id: 1, author: "Ann", authorKind: "person", text: "Please **check** this", at: AT(50) }, { id: 2, author: "alpha", authorKind: "instance", text: "Will do.", at: AT(30) }],
          logs: [{ id: 3, author: "alpha", authorKind: "instance", text: "Endpoint done", at: AT(20) }],
          history: [ev(10, "Ann", 90, "created", {}), ev(11, "alpha", 80, "moved", { from: "open", to: "claimed", auto: true }, "instance"), ev(12, "Ann", 70, "updated", { changes: { acceptance: [] } })], ...over };
      }
      return { card: CARDS[0], notes: [] };
    };
  };
  const open = async (id: string) => { fire(tile(id).querySelector(".tb-tile-title"), "click"); await settle(12); };
  const kids = (el: any) => [...el.childNodes].filter((n: any) => n.nodeType === 1);
  const unfold = async () => { for (const b of qa(".tl-more")) fire(b, "click"); await settle(4); };
  const listClasses = () => kids(q(".tp-activity .tl-list")).map((li: any) => li.className.split(" ").slice(0, 2).join(" "));
  it("the stream is the page's own flow — no panel, no .card — the heading and filter on top, the comment box last", async () => {
    withActivity();
    await mount(); await open("M-1");
    const stream = q(".tp-activity");
    expect(stream.className, "not a box").toBe("tp-activity");
    expect(qa(".tp-grid > *").map((el) => el.className).at(-1)).toBe("tp-activity");
    expect(kids(stream).map((n: any) => n.className.split(" ")[0]), "the stream, then the comment box").toEqual(["tl", "tc-composer"]);
    expect(text(q(".tp-activity .tl-bar h3"))).toBe("Activity");
    expect(qa(".tp-activity .tl-filter button").map((b) => text(b))).toEqual(["All", "Comments 2", "Progress 1", "History 3"]);
    expect(q(".tp-body").querySelector(".tp-activity"), "apart from the sub tasks and the spec").toBeNull();
  });
  it("every comment and every progress note is a card of its own; the system's lines are not cards", async () => {
    withActivity();
    await mount(); await open("M-1");
    // The run of history lines at the start (opened, moved, changed: three) is one folded row; then a card each, in time order.
    expect(listClasses()).toEqual(["tl-run", "tl-item tl-card", "tl-item tl-card", "tl-item tl-card"]);
    expect(qa(".tl-event").length, "folded: no line yet").toBe(0);
    await unfold();
    expect(qa(".tl-card").map((c) => c.className.split(" ").filter((x: string) => ["tl-comment", "tl-log", "person", "by-agent"].includes(x)).join(" "))).toEqual(["tl-comment person", "tl-comment by-agent", "tl-log by-agent"]);
    for (const line of qa(".tl-event")) {
      expect(line.className, "a system line").toBe("tl-item tl-line tl-event");
      expect(line.className).not.toContain("tl-card");
    }
    expect(qa(".tl-event").length).toBe(3);
  });
  it("a card's head: the avatar (an instance's with its state), the name, the Agent badge for an agent, the time (its whole time on hover); the text under the name, Markdown as before", async () => {
    withActivity();
    await mount(); await open("M-1");
    const [ann, alpha, note] = qa(".tl-card");
    expect(text(ann.querySelector(".tl-head")).startsWith("A Ann ")).toBe(true);
    expect(ann.querySelector(".tl-head .tb-av-dot"), "a person has no state dot").toBeNull();
    expect(ann.querySelector(".tl-head .tr-by"), "nor an Agent badge").toBeNull();
    expect(alpha.querySelector(".tl-head .tr-by"), "an agent's badge").toBeTruthy();
    expect(alpha.querySelector(".tl-head .tb-av-dot").className, "alpha is working: the dashboard's state, on the avatar").toContain("st-working");
    expect(alpha.querySelector(".tl-head time").getAttribute("title"), "the whole time on hover").toMatch(/\d/);
    expect(ann.querySelector(".tl-body.md strong"), "Markdown").toBeTruthy();
    expect(text(note.querySelector(".tl-head .tl-kind")), "a progress note says what it is").toBe("Progress");
    expect(text(note.querySelector(".tl-body"))).toBe("Endpoint done");
    expect(q(".tl-comment.person .tl-kind"), "a comment has no such tag").toBeNull();
  });
  it("no coloured bar at an agent's card (nor any `lbar`): the badge says who it is", async () => {
    withActivity();
    await mount(); await open("M-1");
    expect(qa(".tp-activity .lbar").length).toBe(0);
    expect(qa(".tl-card.by-agent").length).toBe(2);
    expect(CSS).not.toMatch(/\.tl-(comment|line|card|log)[^{]*by-agent[^{]*\{[^}]*lbar/);
    expect(CSS, "no bar colour set for an entry").not.toMatch(/\.tl-[a-z.-]*\s*\{[^}]*--lbar/);
  });
  it("a status change's row has the status's mark and a sentence the name leads", async () => {
    withActivity();
    await mount(); await open("M-1");
    await unfold();
    const moved = qa(".tl-event")[1];
    expect(moved.querySelector(".tl-mark .tb-dot").className).toContain("st-claimed");
    expect(text(moved.querySelector(".tl-sentence"))).toBe("alpha Agent changed status from To do to In progress (automatic)");
    expect(text(qa(".tl-event")[0].querySelector(".tl-sentence"))).toBe("Ann opened it");
    const act = await import("/ui/js/fleet-task-card.js") as any;
    expect(act.describeRow({ type: "assigned", data: { from: "alpha", to: "beta" } })).toBe("changed assignee from alpha to beta");
    expect(act.describeRow({ type: "created", data: {} }), "the others as before").toBe(act.describeEvent({ type: "created", data: {} }));
  });
  it("every run of system lines between cards is one \"› N activities\" row, folded — one line, three or six, the first run too; it opens and closes", async () => {
    const many = [ev(10, "Ann", 100, "created", {})].concat([1, 2, 3, 4, 5].map((i) => ev(10 + i, i % 2 ? "alpha" : "Ann", 95 - i, "updated", { changes: { [["goal", "scope", "context", "title", "priority"][i - 1]!]: ["a", "b"] } }, i % 2 ? "instance" : "person")));
    withActivity({ history: many });
    await mount(); await open("M-1");
    const more = q(".tl-more");
    expect(more, "a run of six folds").toBeTruthy();
    expect(text(more)).toBe("6 activities");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(qa(".tl-event").length, "closed: no lines").toBe(0);
    fire(more, "click"); await settle(4);
    expect(q(".tl-more").getAttribute("aria-expanded")).toBe("true");
    expect(qa(".tl-event").length, "open: every line").toBe(6);
    fire(q(".tl-more"), "click"); await settle(4);
    expect(qa(".tl-event").length, "closed again").toBe(0);
    // The History filter asks for them: no fold.
    fire(qa(".tp-activity .tl-filter button").find((b) => text(b).startsWith("History")), "click"); await settle(4);
    expect(q(".tl-more")).toBeNull();
    expect(qa(".tl-event").length).toBe(6);
  });
  it("a run of one line is folded too (\"1 activity\"); three lines the same; the sandwich — a comment, › N activities, a comment — is how a card with a quiet middle reads", async () => {
    const mid = (n: number) => Array.from({ length: n }, (_, i) => ev(30 + i, i % 2 ? "alpha" : "Ann", 45 - i, "updated", { changes: { [["goal", "scope", "context"][i]!]: ["a", "b"] } }, i % 2 ? "instance" : "person"));
    for (const [n, label] of [[1, "1 activity"], [2, "2 activities"], [3, "3 activities"]] as Array<[number, string]>) {
      withActivity({ history: mid(n) });                                  // between the two comments (50 and 30 minutes ago)
      await p.unmount(); await mount(); await open("M-1");
      expect(listClasses(), `${n}: the card, the fold, the card, the log`).toEqual(["tl-item tl-card", "tl-run", "tl-item tl-card", "tl-item tl-card"]);
      expect(text(q(".tl-more")), String(n)).toBe(label);
      expect(qa(".tl-event").length, `${n}: closed`).toBe(0);
      fire(q(".tl-more"), "click"); await settle(4);
      expect(qa(".tl-event").length, `${n}: open`).toBe(n);
    }
  });
  it("the \"› N activities\" row has no box: no fill, no border, no rounding, the system rows' size and colour; pointing changes the text colour only; the keyboard's ring stays", () => {
    const more = rules(".tl-more");
    expect(more).toMatch(/background: none/);
    expect(more).toMatch(/border: 0/);
    expect(more).toMatch(/border-radius: 0/);
    expect(more).toMatch(/box-shadow: none/);
    expect(more, "no fill by any other word").not.toMatch(/background(-color)?: (var|#|rgb|color-mix)/);
    expect(rule(".tl-line, .tl-more")).toMatch(/color: var\(--text-2\)/);          // the rows' colour, shared
    expect(rule(".tl-line, .tl-more")).toMatch(/font-size: var\(--fs-xs\)/);       // …and size
    expect(rules(".tl-more:hover, .tl-more:active")).not.toMatch(/background: (var|#|rgb)/);
    expect(rules(".tl-more:hover, .tl-more:active")).toMatch(/color: var\(--text\)/);
    expect(rule(".tl-more:focus-visible")).toMatch(/outline: 2px solid var\(--focus\)/);
    // The same on a phone: no rule gives it a box there.
    expect(CSS.slice(CSS.indexOf("A phone: the cards and the rows keep their forms"))).not.toMatch(/\.tl-more[^{]*\{[^}]*(background|border:)/);
  });
  it("the fold counts what the stream shows: equal lines already one (×N); every run folded by itself, whatever its length; History never folds", async () => {
    const same = [1, 2, 3, 4].map((i) => ev(20 + i, "Ann", 100 - i));        // four equal lines: one line ×4
    withActivity({ history: same });
    await mount(); await open("M-1");
    expect(text(q(".tl-more")), "four equal lines are one line: \"1 activity\"").toBe("1 activity");
    expect(q(".tl-count"), "folded: the count is inside").toBeNull();
    await unfold();
    expect(q(".tl-count").textContent).toBe("×4");
    const act = await import("/ui/js/fleet-task-activity.js") as any;
    const e = (key: string, type = "event") => ({ key, type, at: "2026-11-01T10:00:00Z" });
    const seq = [e("a"), e("b"), e("c"), e("d", "comment"), e("f"), e("g"), e("h"), e("i"), e("j", "log"), e("k")];
    const s = act.streamOf(seq);
    expect(s.map((i: any) => i.kind + (i.entries ? `:${i.entries.length}${i.fold ? "F" : ""}` : ""))).toEqual(["run:3F", "card", "run:4F", "card", "run:1F"]);
    expect(act.RUN_OPEN_MAX, "no length keeps a run open any more").toBeUndefined();
    expect(act.streamOf([e("a")]).map((i: any) => i.fold), "one line folds").toEqual([true]);
    expect(act.streamOf(seq, false).filter((i: any) => i.kind === "run").map((i: any) => i.fold), "the History filter shows them all, open").toEqual([false, false, false]);
  });
  it("without a comment box (a read-only page) the stream is alone; the card is still a card", async () => {
    withActivity();
    await p.unmount();
    const card = await import("/ui/js/fleet-task-card.js") as any;
    await p.mount(h(card.CardPage, { id: "M-1", tick: 0, projects: [PROJECT], writable: false, back: "Back to the board", onBack() {}, onOpen() {}, onStep() {}, reloadBoard() {} }));
    await settle(12);
    expect(kids(q(".tp-activity")).map((n: any) => n.className.split(" ")[0])).toEqual(["tl"]);
    expect(q(".tc-composer")).toBeNull();
    expect(qa(".tl-card").length).toBe(3);
  });
  it("the comment box is the last card: the card's look, Send inside it; what it does is as before", async () => {
    withActivity();
    await mount(); await open("M-1");
    const box = q(".tp-activity > .tc-composer");
    expect(kids(q(".tp-activity")).at(-1)).toBe(box);
    expect(box.querySelector("textarea")).toBeTruthy();
    expect(box.querySelector(".btn-primary"), "Send is in the box").toBeTruthy();
    expect(box.querySelector("textarea").getAttribute("placeholder")).toBe("Comment to alpha — @ names an instance (Ctrl+Enter sends)");
    const ta = box.querySelector("textarea"); ta.value = "hello"; fire(ta, "input"); await settle(3);
    fire(ta, "keydown", { key: "Enter", ctrlKey: true, cancelable: true }); await settle(10);
    expect(posts().map((c) => c.body)).toEqual([{ comment: "hello" }]);
  });
  it("it names nothing the viewer does not see: an instance not shown has no state dot and no title but the entry's own", async () => {
    withActivity({ comments: [{ id: 1, author: "ghost", authorKind: "instance", text: "From an instance this viewer does not see", at: AT(50) }, { id: 2, author: "alpha", authorKind: "instance", text: "Seen", at: AT(40) }], logs: [], history: [ev(10, "ghost", 60, "updated", { changes: { goal: ["a", "b"] } }, "instance")] });
    await mount(); await open("M-1");
    const [ghost, alpha] = qa(".tl-card");
    expect(ghost.querySelector(".tb-av-dot"), "an unseen instance: no state claimed").toBeNull();
    expect(alpha.querySelector(".tb-av-dot"), "a seen one: its state").toBeTruthy();
    for (const el of qa(".tp-activity [title]")) expect(el.getAttribute("title"), "no title that names a state or another instance").not.toMatch(/Running|Idle|Offline|hidden-bot/);
    // What a link's board has left out (an instance kept out of sight) is not in the payload, so nothing here can name it.
    withActivity({ comments: [{ id: 1, author: "Ann", authorKind: "person", text: "Only what the host sent", at: AT(50) }], logs: [], history: [] });
    await mount(); await open("M-1");
    expect(text(q(".tp-activity .tl-list"))).not.toContain("hidden-bot");
    expect(qa(".tl-card").length).toBe(1);
  });
  it("its look: a card is 1px, --r-md, --surface, 16px; a system row is none of that, small and in the secondary colour; tokens only", () => {
    const card = rule(".tl-card")!;
    expect(card).toMatch(/padding: var\(--s-4\)/);
    expect(card).toMatch(/border: 1px solid var\(--border\)/);
    expect(card).toMatch(/border-radius: var\(--r-md\)/);
    expect(card).toMatch(/background: var\(--surface\)/);
    expect(rule(".tl-list")).toMatch(/gap: var\(--s-3\)/);
    const row = rule(".tl-line, .tl-more")!;
    expect(row).toMatch(/font-size: var\(--fs-xs\)/);
    expect(row).toMatch(/color: var\(--text-2\)/);
    expect(row, "a thin row: no box").not.toMatch(/border: 1px|background: var\(--surface\)/);
    expect(rule(".tl-more:hover, .tl-more:active"), "pointing at the fold changes its colour only").toMatch(/background: none; color: var\(--text\)/);
    // The comment box is the card's look.
    const box = rules(".tc-composer");
    expect(box).toMatch(/border: 1px solid var\(--border\)/);
    expect(box).toMatch(/border-radius: var\(--r-md\)/);
    expect(box).toMatch(/background: var\(--surface\)/);
    expect(rules(".tc-composer > .btn")).toMatch(/align-self: flex-end/);
    for (const sel of [".tl-card", ".tl-list", ".tl-line, .tl-more", ".tl-more:hover, .tl-more:active", ".tc-composer", ".tl-kind", ".tl-mark"]) expect(rules(sel), sel).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    expect(rule(".tb-av-dot")).toMatch(/box-shadow: 0 0 0 2px var\(--surface\)/);
  });
  it("a phone keeps the two forms with less inside; the panel and its padding variable are gone", () => {
    const phone = CSS.slice(CSS.indexOf("A phone: the cards and the rows keep their forms"));
    expect(phone).toMatch(/\.tl-card \{ padding: var\(--s-3\); \}/);
    expect(phone).toMatch(/\.tl-line, \.tl-more \{ padding: 0 var\(--s-3\); \}/);
    expect(CSS).not.toMatch(/--tp-panel-pad|tp-activity\.card/);
  });
});

describe("round 7: an author's avatar in the stream is the board's info card, with a way to the Agent page", () => {
  const AT = stamp;
  const comments = (list: any[]) => {
    handler = (path, method) => {
      if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS, boardOff: [] };
      const m = /^\/ui\/tasks\/cards\/([^/]+)$/.exec(path);
      if (m && method === "GET") {
        const c = CARDS.find((x: any) => x.id === decodeURIComponent(m[1]!)) ?? CARDS[0];
        return { card: c, parent: null, children: [], comments: list, logs: [], history: [] };
      }
      return { card: CARDS[0], notes: [] };
    };
  };
  const THREE = [
    { id: 1, author: "Ann", authorKind: "person", text: "A person's comment", at: AT(50) },
    { id: 2, author: "alpha", authorKind: "instance", text: "An agent's comment", at: AT(40) },
    { id: 3, author: "ghost", authorKind: "instance", text: "An instance the viewer does not see", at: AT(30) },
  ];
  const open = async (id = "M-1") => { fire(tile(id).querySelector(".tb-tile-title"), "click"); await settle(12); };
  const authorBtn = (who: string) => qa(".tl-who-btn").find((b) => text(b).includes(who));
  const wrapOf = (btn: any) => btn.parentNode;
  const pop = () => q(".tb-owner-card");
  const rows = () => {
    const kids = (q(".toc-rows")?.childNodes ?? []).filter((n: any) => n.nodeType === 1);
    return Object.fromEntries(kids.filter((n: any) => n.tagName === "DT").map((dt: any) => [text(dt), text(kids[kids.indexOf(dt) + 1])]));
  };
  const links = () => qa('.tp-activity a[href*="/fleet/agent/"], .tb-owner-pop a');

  it("the same component as the board's: one OwnerCard, drawn for both; the same card for the same instance", async () => {
    const act = readFileSync(join(UI, "fleet-task-activity.js"), "utf8");
    expect(act, "the stream imports the card; it has no card of its own").toMatch(/import \{[^}]*WhoCard[^}]*\} from "\.\/fleet-task-owner\.js"/);
    expect(act).not.toMatch(/tb-owner-card|toc-head|toc-rows/);
    const src = readFileSync(join(UI, "fleet-task-owner.js"), "utf8");
    expect([...src.matchAll(/<\$\{OwnerCard\}/g)].length, "the board's chip and the stream's head both draw it").toBe(2);
    await mount();
    enter(tile("M-1").querySelector(".tb-owner-btn")); await wait(300); await settle(2);
    const board = { cls: pop().className, head: text(q(".toc-head")), rows: rows(), link: q(".toc-open") && q(".toc-open").getAttribute("href"), role: pop().getAttribute("role") };
    leave(tile("M-1").querySelector(".tb-owner-btn")); await wait(260); await settle(2);
    comments(THREE);
    await mount(); await open();
    enter(authorBtn("alpha")); await wait(300); await settle(2);
    expect(pop(), "the stream's card").toBeTruthy();
    expect(pop().className).toBe(board.cls);
    expect(pop().getAttribute("role")).toBe(board.role);
    expect(text(q(".toc-head"))).toBe(board.head);
    expect(rows(), "the board's facts; the stream's has no dispatcher (the comment is not a card)").toEqual({ Now: "Working on S-1 Build the score API", Cards: "1 open · 1 in progress", Role: "Project lead" });
    expect(q(".toc-open").getAttribute("href"), "the same way to the Agent page").toBe(board.link);
  });
  it("an author's avatar and name are one button: ~28px, with the name; its card shows on pointing, with the Agent page link", async () => {
    comments(THREE);
    await mount(); await open();
    const alpha = authorBtn("alpha")!;
    expect(alpha.tagName).toBe("BUTTON");
    expect(alpha.getAttribute("aria-haspopup")).toBe("dialog");
    expect(alpha.getAttribute("aria-expanded")).toBe("false");
    expect(alpha.querySelector(".tb-av"), "the avatar").toBeTruthy();
    expect(alpha.querySelector(".tb-who").textContent, "and the name").toBe("alpha");
    enter(alpha); await settle(2);
    expect(pop(), "not at once").toBeNull();
    await wait(300); await settle(2);
    expect(pop()).toBeTruthy();
    expect(pop().getAttribute("role")).toBe("dialog");
    expect(pop().getAttribute("aria-label")).toBe("alpha");
    expect(text(q(".toc-head .tr-mark")), "its state, as on the board").toBe("Running");
    const a = q(".toc-open");
    expect(a.tagName).toBe("A");
    expect(a.getAttribute("href"), "the instance's Agent page").toBe((await import("/assets/app-route.js") as any).detailsPath("alpha"));
    expect(a.getAttribute("href")).toBe("/ui/fleet/agent/alpha");
    expect(text(a)).toBe("Open Agent page");
    expect(alpha.getAttribute("aria-expanded")).toBe("true");
    expect(alpha.getAttribute("aria-describedby")).toBe(pop().getAttribute("id"));
    expect(q(".tb-owner-pop").getAttribute("style") ?? "", "placed through the CSSOM, never an attribute in the markup").toMatch(/^(left: [\d.]+px; top: [\d.]+px;)?$/);
  });
  it("the pointer can move from the avatar into the card (a short grace); going away closes it", async () => {
    comments(THREE);
    await mount(); await open();
    const alpha = authorBtn("alpha")!, box = wrapOf(alpha);
    enter(alpha); await wait(300); await settle(2);
    leave(box); await wait(60); enter(box); await wait(260); await settle(2);
    expect(pop(), "back inside within the grace: still open (the link can be clicked)").toBeTruthy();
    leave(box); await wait(260); await settle(2);
    expect(pop(), "left for good").toBeNull();
    enter(alpha); leave(box); await wait(300); await settle(2);
    expect(pop(), "a quick pass shows nothing").toBeNull();
  });
  it("the keyboard's focus opens it at once; Tab into the link keeps it open, Tab out closes; Esc closes and gives the focus back", async () => {
    comments(THREE);
    await mount(); await open();
    const alpha = authorBtn("alpha")!;
    focusIn(alpha); await settle(2);
    expect(pop(), "at once").toBeTruthy();
    const link = q(".toc-open");
    expect(link.getAttribute("tabindex"), "the link is in the Tab order").not.toBe("-1");
    expect([...wrapOf(alpha).childNodes].filter((n: any) => n.nodeType === 1).map((n: any) => n.tagName + "." + n.className.split(" ")[0]), "the card follows the button: Tab goes there next").toEqual(["BUTTON.tl-who-btn", "DIV.tb-owner-pop"]);
    focusOut(alpha, link); await settle(2);
    expect(pop(), "the focus went into the card").toBeTruthy();
    focusOut(link, doc().body); await wait(10); await settle(2);
    expect(pop(), "the focus left it").toBeNull();
    focusIn(alpha); await settle(2);
    expect(pop()).toBeTruthy();
    doc().body.focus();
    fire(alpha, "keydown", { key: "Escape" }); await settle(2);
    expect(pop(), "Esc").toBeNull();
    expect(doc().activeElement, "the focus is back on the avatar").toBe(alpha);
    expect(alpha.getAttribute("aria-expanded")).toBe("false");
    // From the link: Esc gives the focus back to the avatar, and the avatar's own focus event does not open the card again.
    await wait(450);
    focusOut(alpha); focusIn(alpha); await settle(2);
    focusOut(alpha, q(".toc-open")); await settle(2);
    expect(pop()).toBeTruthy();
    fire(q(".toc-open"), "keydown", { key: "Escape" }); focusOut(q(".toc-open") ?? alpha, alpha); focusIn(alpha); await settle(2);
    expect(pop(), "Esc on the link: closed, and not reopened by the focus coming back").toBeNull();
    await wait(450);
    focusOut(alpha); focusIn(alpha); await settle(2);
    expect(pop(), "a later keyboard focus opens it").toBeTruthy();
  });
  it("a tap opens it (a phone has no hover), a second tap closes it, a tap outside closes it; a tap inside does not", async () => {
    comments(THREE);
    await mount(); await open();
    const alpha = authorBtn("alpha")!;
    fire(alpha, "click"); await settle(3);
    expect(pop(), "a tap").toBeTruthy();
    fire(q(".toc-head"), "pointerdown"); await settle(2);
    expect(pop(), "a tap inside the card").toBeTruthy();
    fire(doc().body, "pointerdown"); await settle(2);
    expect(pop(), "a tap outside").toBeNull();
    fire(alpha, "click"); await settle(3);
    expect(pop()).toBeTruthy();
    fire(alpha, "click"); await settle(3);
    expect(pop(), "a second tap").toBeNull();
    fire(alpha, "click"); await settle(3);
    fire(alpha, "keydown", { key: "Escape" }); await settle(2);
    expect(pop(), "Esc").toBeNull();
  });
  it("a finger has no hover: the mouse events a browser makes up after a tap neither open the card nor close it", async () => {
    comments(THREE);
    await mount(); await open();
    const alpha = authorBtn("alpha")!, box = wrapOf(alpha);
    const touch = (el: any) => { fire(el, "pointerenter", { pointerType: "touch" }); fire(el, "PointerEnter", { pointerType: "touch" }); fire(el, "pointerdown", { pointerType: "touch" }); fire(el, "PointerDown", { pointerType: "touch" }); };
    touch(alpha); enter(box); fire(alpha, "click"); await wait(300); await settle(3);
    expect(pop(), "the tap opened it; the made-up mouseenter did not close or double it").toBeTruthy();
    leave(box); await wait(300); await settle(2);
    expect(pop(), "the made-up mouseleave (the mouse \"moves away\") does not close it").toBeTruthy();
    fire(doc().body, "pointerdown", { pointerType: "touch" }); await settle(2);
    expect(pop(), "a tap outside does").toBeNull();
    enter(box); await wait(300); await settle(2);
    expect(pop(), "a made-up mouseenter alone opens nothing").toBeNull();
    // A real mouse over the same avatar afterwards is a hover again.
    fire(box, "pointerenter", { pointerType: "mouse" }); fire(box, "PointerEnter", { pointerType: "mouse" });
    enter(alpha); await wait(300); await settle(2);
    expect(pop(), "a mouse hovers as before").toBeTruthy();
  });
  it("only one card at a time: the board's and the stream's, one author's and another's", async () => {
    comments(THREE);
    await mount(); await open();
    fire(authorBtn("alpha"), "click"); await settle(3);
    fire(authorBtn("Ann"), "click"); await settle(3);
    expect(qa(".tb-owner-card").length).toBe(1);
    expect(text(q(".toc-head"))).toContain("Ann");
  });
  it("a person: the name and that it is a person, nothing else — no state, no rows, no link", async () => {
    comments(THREE);
    await mount(); await open();
    fire(authorBtn("Ann"), "click"); await settle(3);
    expect(pop()).toBeTruthy();
    expect(text(q(".toc-head"))).toBe("A Ann Person");
    expect(q(".toc-person").textContent).toBe("Person");
    expect(q(".toc-rows")).toBeNull();
    expect(q(".toc-open")).toBeNull();
    expect(pop().querySelector("a")).toBeNull();
    i18n.setLang("zh-TW", { store: false });
    await mount(); await open();
    fire(authorBtn("Ann"), "click"); await settle(3);
    expect(q(".toc-person").textContent, "in zh-TW").toBe("人");
    i18n.setLang("en", { store: false });
  });
  it("an instance the viewer does not see has no card, no link and no button: its name is the entry's own, plain", async () => {
    comments(THREE);
    await mount(); await open();
    expect(authorBtn("ghost"), "no button").toBeUndefined();
    const ghost = qa(".tl-card")[2];
    expect(ghost.querySelector(".tb-who").textContent).toBe("ghost");
    enter(ghost.querySelector(".tl-head")); fire(ghost.querySelector(".tb-who"), "click"); await wait(300); await settle(3);
    expect(pop()).toBeNull();
    expect(links().filter((a) => a.getAttribute("href").endsWith("/ghost")), "no link to its page").toEqual([]);
  });
  it("over a public link: a seen instance has a card and no link, a person a card, an unseen instance nothing; no link to a page that needs a sign-in; the hidden name appears nowhere new", async () => {
    comments(THREE);
    for (const set of [{ publicLink: "1" }, { tier: "guest" }]) {
      for (const k of ["publicLink", "linkMedia", "tier"]) delete body().dataset[k];
      for (const [k, v] of Object.entries(set)) body().dataset[k] = v;
      await mount(); await open();
      fire(authorBtn("alpha"), "click"); await settle(3);
      expect(pop(), `${JSON.stringify(set)}: it still reads`).toBeTruthy();
      expect(text(q(".toc-head .tr-mark"))).toBe("Running");
      expect(q(".toc-open"), "no link to the Agent page (a sign-in page)").toBeNull();
      fire(authorBtn("Ann"), "click"); await settle(3);
      expect(text(q(".toc-head"))).toContain("Person");
      expect(q(".toc-open")).toBeNull();
      expect(authorBtn("ghost")).toBeUndefined();
      expect(links(), "not one link to an Agent page in the stream or in a card").toEqual([]);
      expect(qa(".tp-activity a, .tb-owner-pop a").filter((a) => /\/fleet\/agent\//.test(a.getAttribute("href") ?? "")), "nor by another way").toEqual([]);
      expect(text(q(".tp-activity")), "nothing about the unseen instance but what the entry says").not.toMatch(/hidden-bot/);
    }
    for (const k of ["publicLink", "linkMedia", "tier"]) delete body().dataset[k];
  });
  it("what gets a card, and a link: the one place that says it", () => {
    const store = { instances: [{ name: "alpha" }] };
    const at = (name: string, kind: string, readOnly: boolean) => owner.infoFor(name, { kind, store, readOnly });
    expect(at("alpha", "instance", false)).toEqual({ card: true, link: "/ui/fleet/agent/alpha" });
    expect(at("alpha", "instance", true), "read-only: the card, not the link").toEqual({ card: true, link: "" });
    expect(at("Ann", "person", false)).toEqual({ card: true, link: "" });
    expect(at("Ann", "person", true)).toEqual({ card: true, link: "" });
    expect(at("ghost", "instance", false), "an instance not shown").toEqual({ card: false, link: "" });
    expect(at("ghost", "instance", true)).toEqual({ card: false, link: "" });
    expect(at("ghost", "", true), "an older entry of unknown kind, read-only: nothing").toEqual({ card: false, link: "" });
    expect(at("", "instance", false)).toEqual({ card: false, link: "" });
    expect(at("old", "none", false)).toEqual({ card: false, link: "" });
  });
  it("the card's words are in both languages; Open Agent page and Person in zh-TW", () => {
    const strip = (src: string) => src.replace(/^import .*$/gm, "").replace(/^export /gm, "");
    const ctx = vm.createContext({ navigator: { language: "en" } });
    vm.runInContext(strip(readFileSync(join(UI, "shared", "app-i18n.js"), "utf8")), ctx);
    const src = readFileSync(join(UI, "fleet-task-owner.js"), "utf8");
    vm.runInContext(`(${/register\("taskowner", (\{[\s\S]*?\n\})\);/.exec(src)![0].replace(/;$/, "")})`, ctx);
    const tables = vm.runInContext("tables", ctx) as Record<"en" | "zh-TW", Record<string, string>>;
    expect(tables.en["taskowner.openAgent"]).toBe("Open Agent page");
    expect(tables["zh-TW"]["taskowner.openAgent"]).toBe("開啟 Agent 頁面");
    expect(tables.en["taskowner.person"]).toBe("Person");
    expect(tables["zh-TW"]["taskowner.person"]).toBe("人");
  });
  it("its look: the author 28px (the dot scaled, the name centred with it); the text under the name; system rows keep their small marks; the link is an accent link; the card is interactive", () => {
    expect(rule(".tl-head .tb-av")).toMatch(/width: 28px; height: 28px/);
    expect(rule(".tl-head .tb-av-dot")).toMatch(/width: 11px; height: 11px/);
    expect(rule(".tl-head")).toMatch(/align-items: center/);
    expect(rule(".tl-head .tb-person")).toMatch(/align-items: center/);
    expect(rule(".tl-who-btn")).toMatch(/align-items: center/);
    expect(rule(".tl-body")).toMatch(/padding-left: 36px/);
    expect(rule(".tl-mark"), "a system row's mark is as small as before").not.toMatch(/28px/);
    expect(CSS).not.toMatch(/\.tl-(line|more|event)[^{]*\.tb-av/);
    expect(rule(".toc-open")).toMatch(/color: var\(--accent\)/);
    expect(rule(".toc-open:focus-visible")).toMatch(/outline: 2px solid var\(--focus\)/);
    expect(rule(".tb-owner-pop"), "interactive: no pointer-events: none").not.toMatch(/pointer-events: none/);
    expect(rule(".tb-owner-pop")).toMatch(/position: fixed/);
  });
});

describe("round 7: a comment is formatted as the instance chat's window formats a message", () => {
  const AT = stamp;
  const AGENT_MD = [
    "### Result", "", "Rebuilt the board with `npm run build`; see [the notes](https://example.com/notes).", "",
    "- ties share a rank", "- late rows kept", "  - region merges too", "",
    "| Step | Status |", "| --- | :---: |", "| build | ok |", "| test | **12 failed** |", "",
    "```json", '{"ok": true, "scores": [1, 2, 3], "meta": {"season": "2026", "note": null}}', "```",
  ].join("\n");
  const PERSON_MD = ["Try this:", "", "```python", "def rank(rows):", "    return sorted(rows, key=lambda r: -r.score)", "```"].join("\n");
  const long = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join("\n");
  const seed = (list: any[], logs: any[] = []) => {
    handler = (path, method) => {
      if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS, boardOff: [] };
      const m = /^\/ui\/tasks\/cards\/([^/]+)$/.exec(path);
      if (m && method === "GET") {
        const c = CARDS.find((x: any) => x.id === decodeURIComponent(m[1]!)) ?? CARDS[0];
        return { card: c, parent: null, children: [], watchers: [], inheritedWatchers: [], leader: null, followsProgress: true, comments: list, logs, history: [] };
      }
      return { card: CARDS[0], notes: [] };
    };
  };
  const open = async () => { fire(tile("M-1").querySelector(".tb-tile-title"), "click"); await settle(12); };
  const agentBody = () => qa(".tl-comment")[0].querySelector(".tl-body");
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let mdSeen: string[] = [];

  it("a card's page fills the content area like the board — no max width on its column; the label, properties and main columns share it; prose stops at a measure", async () => {
    seed([{ id: 1, author: "alpha", authorKind: "instance", text: "a comment", at: AT(20) }]);
    await mount(); await open();
    // The rule applies to this page: the card page is a direct child of `.tb`, which is a direct child of the Fleet column.
    expect(q(".col.col-wide > .tb > .tp"), "the card page sits where the rule looks").toBeTruthy();
    expect(rule(".col.col-wide:has(> .tb > .tp)"), "the card page").toMatch(/max-width: none/);
    expect(rule(".col.col-wide:has(> .tb > .tb-board-page)"), "the board, as before").toMatch(/max-width: none/);
    expect(rule(".col.col-wide"), "Home keeps the Fleet page's width").toMatch(/max-width: 1240px/);
    // Columns: the properties column grows with the window (300 → 460px; 301px on a 1366px window, where it was 300), the main takes the rest.
    expect(rule(".tp-grid")).toMatch(/grid-template-columns: minmax\(0, 1fr\) clamp\(300px, 22vw, 460px\)/);
    expect(rule(".tp-grid")).not.toMatch(/ 300px;/);
    expect(Math.round(1366 * 0.22), "22vw at 1366px is the old 300px, give or take one").toBeLessThanOrEqual(301);
    // The label column grows 7rem → 10rem; the rows keep one label column and one value column.
    expect(rules(".tp")).toMatch(/--tp-label: clamp\(7rem, 6vw, 10rem\)/);
    expect(rule(".tp .tc-field, .tp .tp-subs")).toMatch(/grid-template-columns: var\(--tp-label\) minmax\(0, 1fr\)/);
    // The line of prose stops at a measure; frames, the checklist, the sub tasks and the cards do not.
    expect(rules(".tp")).toMatch(/--tp-measure: 72rem/);
    expect(rule(".tp .tc-text, .tp .tl-body")).toBe(".tp .tc-text, .tp .tl-body { max-width: var(--tp-measure); }");
    expect(CSS).not.toMatch(/\.tp-body \{[^}]*max-width/);
    expect(CSS).not.toMatch(/\.tl-card \{[^}]*max-width/);
    // The phone: one column (the narrow rule is after the wide one, so it wins) and the label above its value.
    const phone = CSS.slice(CSS.indexOf("@media (max-width: 899px), (pointer: coarse)", CSS.indexOf(".tp-grid {")));
    expect(phone).toMatch(/\.tp-grid \{ grid-template-columns: minmax\(0, 1fr\); grid-template-rows: none;/);
    expect(phone).toMatch(/\.tp \.tc-field, \.tp \.tp-subs, \.tp-agent \.tc-field \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  });

  it("an agent's comment: heading, list (nested), table, a JSON block, inline code and a link, as the chat draws them", async () => {
    seed([{ id: 1, author: "alpha", authorKind: "instance", text: AGENT_MD, at: AT(30) }]);
    await mount(); await open();
    const b = agentBody();
    expect(b.className).toContain("md");
    expect(b.querySelector("h5").textContent, "### is the chat's h5 (it keeps the page's own headings above)").toBe("Result");
    expect(b.querySelector("p code").textContent, "inline code").toBe("npm run build");
    expect(b.querySelector("a").getAttribute("href")).toBe("https://example.com/notes");
    expect([...b.querySelectorAll("li")].slice(0, 2).map((li: any) => li.childNodes[0].textContent.trim())).toEqual(["ties share a rank", "late rows kept"]);
    expect(b.querySelector("li ul li").textContent.trim(), "a nested list").toBe("region merges too");
    expect(b.querySelector(".tbl table"), "a table in its scrolling wrapper").toBeTruthy();
    expect([...b.querySelectorAll("th")].map((c: any) => c.textContent)).toEqual(["Step", "Status"]);
    expect([...b.querySelectorAll("td")].map((c: any) => c.textContent)).toEqual(["build", "ok", "test", "12 failed"]);
    expect(b.querySelector("td strong").textContent, "inline formatting in a cell").toBe("12 failed");
    const code = b.querySelector(".codeblock");
    expect(code, "the JSON block is a code block").toBeTruthy();
    expect(code.querySelector(".cb-lang").textContent).toBe("json");
    expect(code.querySelector("pre code").textContent).toBe('{"ok": true, "scores": [1, 2, 3], "meta": {"season": "2026", "note": null}}');
    expect(code.querySelector("pre code [class^='tk-'], pre code .tk-s, pre code .tk-k, pre code .tk-n"), "highlighted as the chat does").toBeTruthy();
    expect(b.querySelector("p code").closest(".codeblock"), "the inline code is not in a block").toBeNull();
  });
  it("a code block has the chat's header: the language, Wrap and Copy; the buttons are buttons", async () => {
    seed([{ id: 1, author: "alpha", authorKind: "instance", text: AGENT_MD, at: AT(30) }, { id: 2, author: "Ann", authorKind: "person", text: PERSON_MD, at: AT(20) }]);
    await mount(); await open();
    const [a, b] = qa(".codeblock");
    expect([...a.querySelector(".cb-head").childNodes].map((n: any) => n.tagName + ":" + n.textContent)).toEqual(["SPAN:json", "BUTTON:Wrap", "BUTTON:Copy"]);
    expect(b.querySelector(".cb-lang").textContent, "a person's block, another language").toBe("python");
    expect(b.querySelector("pre code").textContent).toContain("def rank(rows):");
    expect(b.querySelector("pre code").textContent).toContain("    return sorted");
    expect([...b.querySelectorAll(".cb-head button")].map((x: any) => [x.className, x.getAttribute("type"), x.dataset.act])).toEqual([["chip-btn", "button", "toggleWrap"], ["chip-btn", "button", "copyCode"]]);
    expect(qa(".tl-comment")[1].className, "the person's card").toContain("person");
    i18n.setLang("zh-TW", { store: false });
    await mount(); await open();
    expect([...qa(".codeblock")[0].querySelectorAll(".cb-head button")].map((x: any) => x.textContent), "in zh-TW").toEqual(["換行", "複製"]);
    i18n.setLang("en", { store: false });
  });
  it("Copy puts the block's text on the clipboard and says so (then says Copy again); a failure says so", async () => {
    seed([{ id: 1, author: "Ann", authorKind: "person", text: PERSON_MD, at: AT(20) }]);
    await mount(); await open();
    const nav = (globalThis as any).navigator, was = { c: nav.clipboard, s: (globalThis as any).isSecureContext };
    const writes: string[] = [];
    nav.clipboard = { writeText: async (x: string) => { writes.push(x); } };
    (globalThis as any).isSecureContext = true;
    try {
      const btn = qa(".codeblock .cb-head button")[1];
      fire(btn, "click"); await settle(6);
      expect(writes).toEqual([q(".codeblock pre").textContent]);
      expect(btn.textContent).toBe("Copied");
      await wait(1300); await settle(2);
      expect(btn.textContent).toBe("Copy");
      nav.clipboard = { writeText: async () => { throw new Error("no"); } };
      doc().execCommand = () => false;
      fire(btn, "click"); await settle(6);
      expect(btn.textContent).toBe("Copy failed");
    } finally { nav.clipboard = was.c; (globalThis as any).isSecureContext = was.s; delete doc().execCommand; }
  });
  it("a block of more than 30 lines is folded until opened (Show all N lines / Show less); a short one is not", async () => {
    seed([{ id: 1, author: "alpha", authorKind: "instance", text: "```text\n" + long + "\n```", at: AT(30) }, { id: 2, author: "Ann", authorKind: "person", text: PERSON_MD, at: AT(20) }]);
    await mount(); await open();
    const [big, small] = qa(".codeblock");
    expect(big.className).toContain("folded");
    expect(small.className).not.toContain("folded");
    expect(small.querySelector(".cb-more")).toBeNull();
    const more = big.querySelector(".cb-more");
    expect(more.textContent).toBe("Show all 45 lines");
    fire(more, "click"); await settle(3);
    expect(big.className).not.toContain("folded");
    expect(more.textContent).toBe("Show less");
    fire(more, "click"); await settle(3);
    expect(big.className).toContain("folded");
    expect(more.textContent).toBe("Show all 45 lines");
    const R = (globalThis as any).AgendChatRender;
    expect(R.CODE_FOLD_LINES, "the chat's own limit").toBe(30);
  });
  it("Wrap turns on wrapping for the stream's code and the choice is kept (the chat's storage key); again turns it off", async () => {
    seed([{ id: 1, author: "Ann", authorKind: "person", text: PERSON_MD, at: AT(20) }]);
    const ls = (globalThis as any).localStorage;
    ls.removeItem("agend_code_wrap");
    await mount(); await open();
    expect(q(".tl").className).not.toContain("wrap-code");
    fire(qa(".codeblock .cb-head button")[0], "click"); await settle(3);
    expect(q(".tl").className).toContain("wrap-code");
    expect(ls.getItem("agend_code_wrap")).toBe("1");
    await mount(); await open();
    expect(q(".tl").className, "kept").toContain("wrap-code");
    fire(qa(".codeblock .cb-head button")[0], "click"); await settle(3);
    expect(q(".tl").className).not.toContain("wrap-code");
    expect(ls.getItem("agend_code_wrap")).toBe("0");
    ls.removeItem("agend_code_wrap");
  });
  it("it stays one code block when the card draws again (a status change, a new comment): no second header", async () => {
    seed([{ id: 1, author: "Ann", authorKind: "person", text: PERSON_MD, at: AT(20) }]);
    await mount(); await open();
    fire(q(".tl-filter button"), "click"); await settle(4);
    fire(qa(".tl-filter button")[1], "click"); await settle(4);
    fire(qa(".tl-filter button")[0], "click"); await settle(4);
    expect(qa(".codeblock").length).toBe(1);
    expect(qa(".codeblock .cb-head").length).toBe(1);
  });
  it("a progress note stays one plain line: no Markdown, no code block, no card for its author but the head's", async () => {
    seed([{ id: 1, author: "Ann", authorKind: "person", text: "x", at: AT(20) }], [{ id: 5, author: "alpha", authorKind: "instance", text: "Ran **tests** and `lint`\n```js\nlet a\n```", at: AT(10) }]);
    await mount(); await open();
    const note = q(".tl-log .tl-body");
    expect(note.className).toBe("tl-body");
    expect(note.querySelector("strong, code, pre, .codeblock, table, h3"), "no formatting at all").toBeNull();
    expect(note.textContent).toBe("Ran **tests** and `lint`\n```js\nlet a\n```");
    expect(rule(".tl-body")).toMatch(/white-space: pre-wrap/);
  });
  it("what the comment says is escaped first: a tag is text, a link to javascript: is not a link", async () => {
    seed([{ id: 1, author: "alpha", authorKind: "instance", text: "<img src=x onerror=alert(1)> and [x](javascript:alert(1))", at: AT(20) }]);
    await mount(); await open();
    const b = agentBody();
    expect(b.querySelector("img")).toBeNull();
    expect(b.textContent).toContain("<img src=x onerror=alert(1)>");
    expect([...b.querySelectorAll("a")].filter((a: any) => /^javascript:/i.test(a.getAttribute("href") ?? ""))).toEqual([]);
  });
  it("the same renderer and the same code-block frame as the chat: one Markdown, the chat's classes and actions, the chat's strings", () => {
    // the Markdown pieces live in fleet-task-md.js (a card's fields and a file's preview draw them too); the timeline imports them.
    const act = readFileSync(join(UI, "fleet-task-md.js"), "utf8");
    const chat = readFileSync(join(UI, "shared", "chat-thread.js"), "utf8");
    expect(act, "the shared renderer, not a copy").toMatch(/AgendChatRender/);
    expect(act).not.toMatch(/function renderMarkdown|escapeHtml\(/);
    const sig = (src: string, from: string, to: string) => {
      const part = src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));
      return { classes: [...part.matchAll(/className = "([\w -]+)"/g)].map((m) => m[1]).sort(), acts: [...part.matchAll(/dataset\.act = "(\w+)"/g)].map((m) => m[1]).sort(), strings: [...new Set([...part.matchAll(/\bt[rf]{0,2}\("(chat\.\w+)"/g)].map((m) => m[1]))].sort() };
    };
    const mine = sig(act, "export function decorateCode", "/** A click on one");
    const theirs = sig(chat, "function decorateCode(root)", "// HTML cards (#1306)");
    expect(mine.classes, "the same elements").toEqual(theirs.classes);
    expect(mine.acts, "the same actions").toEqual(theirs.acts);
    expect(mine.strings, "the same words").toEqual(theirs.strings);
    expect(mine.classes).toEqual(["cb-head", "cb-lang", "cb-more", "chip-btn", "chip-btn", "codeblock"]);
  });
  it("the sheet: a comment's Markdown takes the chat's values, rule for rule (the table's header row alone sits on the card's surface)", () => {
    const decls = (sel: string) => { const r = rule(sel); return r ? r.slice(r.indexOf("{") + 1, r.lastIndexOf("}")).trim().replace(/\s+/g, " ") : null; };
    const pairs: Array<[string, string]> = [
      [".msg .md p", ".tl-body.md p"], [".msg .md code", ".tl-body.md code"], [".msg .md a", ".tl-body.md a"], [".msg .md blockquote", ".tl-body.md blockquote"],
      [".msg .md li > ul, .msg .md li > ol", ".tl-body.md li > ul, .tl-body.md li > ol"], [".msg .md hr", ".tl-body.md hr"],
      [".msg .md .tbl", ".tl-body.md .tbl"], [".msg .md table", ".tl-body.md table"], [".msg .md .codeblock pre code", ".tl-body.md .codeblock pre code"],
    ];
    for (const [chat, mine] of pairs) expect(decls(mine), `${mine} = ${chat}`).toBe(decls(chat));
    expect(decls(".tl-body.md ul, .tl-body.md ol")).toBe(decls(".msg .md ul, .msg .md ol"));
    expect(decls(".tl-body.md th, .tl-body.md td"), "cell borders, padding, whole words, 5em").toBe("border: 1px solid var(--border); padding: 5px 9px; text-align: left; vertical-align: top; overflow-wrap: break-word; word-break: normal; min-width: 5em;");
    expect(decls(".tl-body.md th")).toMatch(/background: var\(--surface-2\); font-weight: var\(--fw-semibold\)/);
    expect(decls(".tl-body.md h3, .tl-body.md h4, .tl-body.md h5, .tl-body.md h6")).toBe(decls(".msg .md h3, .msg .md h4, .msg .md h5, .msg .md h6"));
    // The frame itself (header, Wrap/Copy, fold, long lines) is the one `.codeblock` rule set, not scoped to the chat: nothing here overrides it.
    const over = [...CSS.matchAll(/\n([^\n{}]*\.tl-[^\n{}]*\.codeblock[^\n{}]*) \{/g)].map((m) => m[1]);
    expect(over, "the only rule on a code block inside a comment is the chat's `pre code` reset").toEqual([".tl-body.md .codeblock pre code"]);
    expect(rule(".wrap-code .codeblock pre")).toMatch(/pre-wrap/);
    expect(CSS, "the colours of the highlight, from the same tokens").toMatch(/\.tl-body\.md \.tk-k \{ color: var\(--tk-k\); \}/);
  });
  it("the progress filter and the tag say what a progress note is, on hover, in both languages; the label is unchanged", async () => {
    seed([{ id: 1, author: "Ann", authorKind: "person", text: "x", at: AT(20) }], [{ id: 5, author: "alpha", authorKind: "instance", text: "Did a thing", at: AT(10) }]);
    await mount(); await open();
    const tip = "A one-line work note an agent or member wrote down — not a comment";
    const btn = qa(".tl-filter button").find((b) => text(b).startsWith("Progress"))!;
    expect(btn.getAttribute("title")).toBe(tip);
    expect(text(btn)).toBe("Progress 1");
    expect(qa(".tl-filter button").filter((b) => b !== btn).map((b) => b.getAttribute("title")), "the other filters have none").toEqual([null, null, null]);
    const tag = q(".tl-log .tl-kind");
    expect(tag.getAttribute("title")).toBe(tip);
    expect(text(tag)).toBe("Progress");
    i18n.setLang("zh-TW", { store: false });
    await mount(); await open();
    const zh = "agent 或成員記下的一行工作紀錄，不是留言";
    expect(qa(".tl-filter button").find((b) => text(b).startsWith("進度"))!.getAttribute("title")).toBe(zh);
    expect(q(".tl-log .tl-kind").getAttribute("title")).toBe(zh);
    expect(text(q(".tl-log .tl-kind")), "the label is as it was").toBe("進度");
    i18n.setLang("en", { store: false });
  });
});

describe("Tasks is dressed as Settings is (one product)", () => {
  const LIST = { view: "list", group: "status", order: "manual", dir: "asc", done: "recent", subs: false };
  it("a project's page head is Settings' page head: its classes, a title with its badge, the description as the lead, the actions at the right", async () => {
    PROJECT.description = "Weekly and seasonal rankings";
    await mount();
    const head = q(".tb-bar-head");
    expect(head.className).toBe("tb-bar-head s-page-head");
    const kids = [...head.childNodes].filter((n: any) => n.nodeType === 1);
    expect(kids.map((n: any) => n.className.split(" ")[0]), "what it says, then what it offers").toEqual(["tb-head-main", "tb-head-actions"]);
    expect(q(".tb-head-main .tb-title.s-page-title h2")).toBeTruthy();
    expect(text(q(".tb-head-main .tb-title h2"))).toBe("Leaderboard");
    expect(text(q(".tb-head-main > p.s-page-lead"))).toBe("Weekly and seasonal rankings");
    expect(q(".tb-head-main .tb-stats"), "its numbers").toBeTruthy();
    expect(q(".tb-head-actions .btn-primary"), "the main action").toBeTruthy();
    // The first ghost button of the head is still the way back (tests, smokes and keyboards rely on it).
    expect(text(q(".tb-bar-head .btn-ghost"))).toBe("Projects");
    PROJECT.description = "";
  });
  it("an archived project says so as Settings badges a scope (.s-scope)", async () => {
    (PROJECT as any).archived = true;
    await mount();
    expect(text(q(".tb-title .s-scope"))).toBe("Archived");
    (PROJECT as any).archived = false;
  });
  it("Home has the same head: the title, then the search, Instances and New project", async () => {
    await p.unmount();
    (globalThis as any).localStorage.removeItem("agend_tasks_project");
    (globalThis as any).history.replaceState(null, "", "/ui/fleet");
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|l316-head-${++mounts}|en` }));
    await settle(8);
    const head = q(".tb-head");
    expect(head.className).toBe("list-head tb-head s-page-head");
    expect(text(q(".tb-head .s-page-title h2"))).toBe("Projects");
    expect([...q(".tb-head .tb-head-actions").childNodes].filter((n: any) => n.nodeType === 1).length).toBeGreaterThanOrEqual(3);
    expect(q(".tb-head .btn-primary")).toBeTruthy();
  });
  it("the CSS takes Settings' values (tokens only): the 24px title from .s-page-head, the search field, the list container, the project tile", () => {
    expect(CSS).toMatch(/\.s-page-head h2 \{[^}]*font-size: 24px/);
    expect(rule(".tb-title h2"), "no size of its own: Settings' title").not.toMatch(/font-size/);
    expect(rule(".tb-search input")).toMatch(/background: var\(--surface\)/);
    expect(rule(".tb-search input")).toMatch(/border: 0/);
    expect(rule(".tb-search input")).toMatch(/border-radius: var\(--r-sm\)/);
    const list = rule(".tb-list")!;
    expect(list).toMatch(/border: 1px solid var\(--border\)/);
    expect(list).toMatch(/border-radius: var\(--r-md\)/);
    expect(list).toMatch(/background: var\(--surface\)/);
    expect(list).toMatch(/gap: 0/);
    expect(rule(".tb-group-head")).toMatch(/background: var\(--surface-2\)/);
    expect(rule(".tb-group-head")).toMatch(/border-radius: 0/);
    expect(rule(".tb-list-head")).toMatch(/background: var\(--surface-2\)/);
    expect(rule(".tb-project")).toMatch(/border-radius: var\(--r-md\)/);
    for (const sel of [".tb-list", ".tb-group-head", ".tb-list-head", ".tb-search input", ".tb-project", ".tb-head-main", ".tb-head-actions"]) expect(rule(sel), sel).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
  });
  it("the list is one container with its header and groups inside; rows and groups behave as before", async () => {
    await mount(LIST);
    const list = q(".tb-list");
    expect([...list.childNodes].filter((n: any) => n.nodeType === 1).map((n: any) => n.className.split(" ")[0])[0]).toBe("tb-list-head");
    expect(qa(".tb-list > .tb-group").length, "one per status").toBe(5);
    expect(qa(".tb-row").length).toBeGreaterThanOrEqual(8);
    fire(q(".tb-group-toggle"), "click"); await settle(4);
    expect(qa(".tb-list > .tb-group.shut").length, "a group still folds").toBe(1);
  });
});
