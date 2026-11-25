/**
 * The task board laid out as an issue page.
 *  - a card is a page of its own: in the address (`?card=`), one history entry (Back returns to the board or the list), the
 *    previous / next arrows replace it; its properties are chips that open menus and save at once; text edits where it is
 *    read — leaving the box or Ctrl+Enter saves, Esc drops it — and a 409 keeps the edit open for an explicit overwrite;
 *    comments, progress log and history are one timeline, the comment box last;
 *  - the toolbar is one row (board / list, search, Filter, Display); the list sorts by its header, folds its groups, and
 *    every row shows its priority; the search and the Needs you filter narrow board and list alike; all of it is kept on
 *    the device, and an older device's stored choices still read;
 *  - a new main task needs only a title; a phone shows one status at a time and every card has a ⋯ menu;
 *  - what an older board holds — every status, no project, dependencies, a dispatcher gone, cancelled cards — opens.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { parseMentions } from "../src/scheduler/task-board-mentions.js";

const UI = fileURLToPath(new URL("../src/ui", import.meta.url));
let p: AppPage;
let app: any, nav: any, fleet: any, view: any, activity: any, cardMod: any, create: any, common: any, workMod: any;
const calls: Array<{ method: string; path: string; body: any }> = [];
type Reply = unknown | { __status: number; [k: string]: unknown };
let handler: (path: string, method: string, body: any) => Reply = () => ({});
const fetchFake = async (path: string, o: any = {}) => {
  const method = o.method ?? "GET";
  const body = o.body ? JSON.parse(o.body) : null;
  calls.push({ method, path, body });
  const out: any = await handler(path, method, body);
  const status = out && typeof out === "object" && "__status" in out ? out.__status : 200;
  return { ok: status < 400, status, json: async () => out };
};

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const card = (over: Record<string, unknown>) => ({ id: "M-1", uuid: String(over.id ?? "M-1"), kind: "main", projectId: 1, parentId: null, title: "A card", status: "open",
  assignee: null, dispatcher: { kind: "person", name: "Ann" }, waitsForPerson: false, confirmer: null, priority: "normal", size: null, needsReview: true, dependsOn: [], goal: "", scope: "",
  acceptance: [], context: "", state: "", blockedReason: "", result: "", sort: 1, createdBy: "Ann", version: 4, createdAt: ago(10), updatedAt: ago(1), startedAt: null, submittedAt: null,
  doneAt: null, progress: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 }, unmetDeps: [], commentCount: 0, newCommentCount: 0, lastComment: null, ...over });
const PROJECT = { id: 1, name: "Leaderboard", description: "", archived: false, sort: 1, createdAt: ago(30) };
const M1 = card({ id: "M-1", title: "Serve the weekly leaderboard", status: "claimed", assignee: "alpha", priority: "high", goal: "Players see their rank", acceptance: [{ text: "Ties share a rank", done: true }, { text: "Under 300 ms", done: false }], sort: 1, createdAt: ago(9), updatedAt: ago(1) });
const M2 = card({ id: "M-2", title: "Add the shop", status: "open", assignee: "beta", priority: "low", size: "S", sort: 2, createdAt: ago(3), updatedAt: ago(4), progress: { total: 2, open: 1, claimed: 0, blocked: 0, review: 0, done: 1 } });
const S1 = card({ id: "S-1", kind: "sub", parentId: "M-2", title: "Price list", status: "done", assignee: "alpha", sort: 1, updatedAt: ago(2) });
const S2 = card({ id: "S-2", kind: "sub", parentId: "M-2", title: "Checkout", status: "open", assignee: "beta", sort: 2, updatedAt: ago(2) });
const M3 = card({ id: "M-3", title: "Choose the badge", status: "review", assignee: "alpha", waitsForPerson: true, priority: "urgent", sort: 3, result: "B recommended", createdAt: ago(7), updatedAt: ago(3) });
const M4 = card({ id: "M-4", title: "Bootstrap", status: "done", assignee: "alpha", sort: 4, doneAt: ago(1), createdAt: ago(20), updatedAt: ago(1) });
const CARDS = [M1, M2, S1, S2, M3, M4];

const ENTRIES = {
  comments: [
    { id: 11, author: "Ann", authorKind: "person", kind: "comment", text: "Keep it under 300 ms.", at: "2026-11-02T10:00:00.000Z" },
    { id: 12, author: "alpha", authorKind: "instance", kind: "comment", text: "Understood.", at: "2026-11-02T12:00:00.000Z" },
    { id: 13, author: "Ann", authorKind: "person", kind: "reject", text: "Ties must share a rank.", at: "2026-11-03T09:00:00.000Z" },
  ],
  logs: [{ id: 21, author: "alpha", text: "Endpoint skeleton done", at: "2026-11-02T11:00:00.000Z" }],
  history: [
    { id: 31, actor: "Ann", type: "created", data: {}, at: "2026-11-01T08:00:00.000Z" },
    { id: 32, actor: "alpha", type: "moved", data: { from: "open", to: "claimed" }, at: "2026-11-02T09:00:00.000Z" },
    { id: 33, actor: "Ann", type: "commented", data: { text: "Keep it under 300 ms." }, at: "2026-11-02T10:00:00.000Z" },
    { id: 34, actor: "alpha", type: "logged", data: { text: "Endpoint skeleton done" }, at: "2026-11-02T11:00:00.000Z" },
    { id: 35, actor: "Ann", type: "moved", data: { from: "review", to: "claimed", reason: "Ties must share a rank." }, at: "2026-11-03T09:00:00.000Z" },
  ],
};

const detailOf = (id: string, over: Record<string, unknown> = {}) => {
  const c: any = CARDS.find((x: any) => x.id === id) ?? card({ id, title: `Card ${id}` });
  return { card: c, parent: c.parentId ? { id: "M-2", title: M2.title, status: "open" } : null, children: c.id === "M-2" ? [S1, S2] : [], ...ENTRIES, ...over };
};

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  fleet = await import("/ui/js/panel-fleet.js");
  view = await import("/ui/js/fleet-task-view.js");
  activity = await import("/ui/js/fleet-task-activity.js");
  cardMod = await import("/ui/js/fleet-task-card.js");
  create = await import("/ui/js/fleet-task-create.js");
  common = await import("/ui/js/fleet-task-common.js");
  workMod = await import("/ui/js/fleet-task-work.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
let boardOff: string[] = [];
beforeEach(async () => {
  await p.unmount();
  const ls = (globalThis as any).localStorage;
  for (const k of ["agend_tasks_project", "agend_tasks_display", "agend_tasks_filters", "agend_tasks_assignee", "agend_tasks_query", "agend_tasks_collapsed"]) ls.removeItem(k);
  for (const k of ["publicLink", "linkMedia", "tier"]) delete (globalThis as any).document.body.dataset[k];
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  (globalThis as any).history.entries.length = 1;
  (globalThis as any).history.states.length = 1;
  (globalThis as any).history.at = 0;
  calls.length = 0;
  boardOff = [];
  handler = (path, method, body) => {
    if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS, boardOff };
    if (path === "/ui/tasks/cards" && method === "POST") return { card: card({ id: "M-9", title: body.title, projectId: body.project, priority: body.priority, assignee: body.assignee }), notes: [] };
    const m = /^\/ui\/tasks\/cards\/([^/]+)(\/move)?$/.exec(path);
    if (m && method === "POST") return { card: CARDS.find((c: any) => c.id === decodeURIComponent(m[1]!)) ?? M1, notes: [] };
    if (m) return detailOf(decodeURIComponent(m[1]!));
    return {};
  };
  app.applyStatus({ uptime: 1, instances: ["alpha", "beta", "gamma"].map((name) => ({ name, status: "running", state: "idle", execution_state: "idle" })) });
});

let mounts = 0;
/** The tab opened afresh, on what this device has stored (a tab opened again is a new one: nothing of the last one's state). */
async function mount(storage: Record<string, string> = { agend_tasks_project: "1" }) {
  await p.unmount();
  for (const [k, v] of Object.entries(storage)) (globalThis as any).localStorage.setItem(k, v);
  await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|rv-${++mounts}|en` }));
  await settle(8);
}
const doc = () => (globalThis as any).document;
const q = (sel: string) => p.root.querySelector(sel);
const qa = (sel: string) => [...p.root.querySelectorAll(sel)] as any[];
const text = (el: any): string | null => (el ? el.childNodes.map((n: any) => (n.nodeType === 3 ? n.textContent : text(n)) ?? "").map((s: string) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ") : null);
const search = () => new URLSearchParams((globalThis as any).location.search);
const posts = () => calls.filter((c) => c.method === "POST");
const hist = () => (globalThis as any).history;
async function openCard(id: string) { fire(q(`[data-tile="${id}"] .tb-tile-title`) ?? q(`[data-row="${id}"] .tb-row-title`), "click"); await settle(10); }
const rowOf = (label: string) => qa(".tp-row").find((r) => text(r.querySelector("dt")) === label);
async function chip(label: string, choose: string) {
  const row = rowOf(label);
  expect(row, label).toBeTruthy();
  fire(row.querySelector("button.tp-chip"), "click"); await settle(4);
  const item = qa(".tp-row .menu-list button").find((b) => text(b) === choose);
  expect(item, `${choose} in ${label}`).toBeTruthy();
  fire(item, "click"); await settle(10);
}
const typeInto = async (el: any, value: string, caret = value.length) => { el.value = value; el.selectionStart = caret; fire(el, "input"); await settle(4); };

// ── What the page, the toolbar and the box compute (pure) ──────────────────────────────

describe("the timeline: comments, progress log and history in one list", () => {
  it("oldest first; a history line that repeats a comment or a log entry is dropped; at one instant the move comes before its words", () => {
    const tl = activity.timelineOf(detailOf("M-1"));
    expect(tl.map((e: any) => `${e.type}:${e.key}`)).toEqual(["event:h31", "event:h32", "comment:c11", "log:l21", "comment:c12", "event:h35", "comment:c13"]);
    expect(activity.timelineOf(null)).toEqual([]);
  });
  it("a filter shows one kind", () => {
    const tl = activity.timelineOf(detailOf("M-1"));
    expect(activity.timelineShown(tl, "all")).toHaveLength(7);
    expect(activity.timelineShown(tl, "comments").map((e: any) => e.key)).toEqual(["c11", "c12", "c13"]);
    expect(activity.timelineShown(tl, "log").map((e: any) => e.key)).toEqual(["l21"]);
    expect(activity.timelineShown(tl, "history").map((e: any) => e.key)).toEqual(["h31", "h32", "h35"]);
  });
});

describe("a change of the card's watchers is a line of the timeline", () => {
  const WATCH = { id: 36, actor: "Ann", type: "logged", data: { text: "watchers: +ops, -dev-b", watchers: { added: ["ops"], removed: ["dev-b"] } }, at: "2026-11-04T08:00:00.000Z" };
  it("the history event that carries `data.watchers` stays in the merge, among the other history lines; a plain log's event is still dropped (its entry is shown)", () => {
    const tl = activity.timelineOf(detailOf("M-1", { history: [...ENTRIES.history, WATCH] }));
    expect(tl.map((e: any) => `${e.type}:${e.key}`)).toEqual(["event:h31", "event:h32", "comment:c11", "log:l21", "comment:c12", "event:h35", "comment:c13", "event:h36"]);
    expect(activity.timelineShown(tl, "history").map((e: any) => e.key)).toEqual(["h31", "h32", "h35", "h36"]);
    expect(activity.timelineShown(tl, "log").map((e: any) => e.key), "the log filter lists log entries only").toEqual(["l21"]);
  });
  it("it is worded in English and in Traditional Chinese, from the names the board wrote (the event's text when the lists are missing)", async () => {
    const i18n = await import("/assets/app-i18n.js");
    try {
      i18n.setLang("en", { store: false });
      expect(cardMod.describeEvent(WATCH)).toBe("changed watchers: +ops, \u2212dev-b");
      expect(cardMod.describeEvent({ ...WATCH, data: { text: "watchers: +ops", watchers: { added: ["ops"] } } })).toBe("changed watchers: +ops");
      expect(cardMod.describeEvent({ ...WATCH, data: { text: "watchers: -dev-b", watchers: {} } }), "no lists: the text without its prefix").toBe("changed watchers: -dev-b");
      expect(cardMod.describeEvent(ENTRIES.history[3]), "a plain log line is worded as before").toBe("log: Endpoint skeleton done");
      i18n.setLang("zh-TW", { store: false });
      expect(cardMod.describeEvent(WATCH)).toBe("修改關注者：+ops, \u2212dev-b");
    } finally { i18n.setLang("en", { store: false }); }
  });
});

describe("a card that waits for a card kept out of sight (the public link says how many, never which)", () => {
  // `hiddenUnmet` is the link's: the unfinished dependencies its read left out (the numbers are not in `unmetDeps`).
  const ONE = card({ id: "M-5", title: "Waits for a hidden card", assignee: "beta", sort: 5, unmetDeps: [], hiddenUnmet: 1 });
  const TWO = card({ id: "M-6", title: "Waits for two hidden cards and M-2", assignee: "beta", sort: 6, dependsOn: ["M-2"], unmetDeps: ["M-2"], hiddenUnmet: 2 });
  const NONE = card({ id: "M-7", title: "Waits for nothing", assignee: "beta", sort: 7 });
  const withThese = () => {
    const base = handler;
    handler = (path, method, body) => {
      if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: [...CARDS, ONE, TWO, NONE], boardOff };
      const m = /^\/ui\/tasks\/cards\/(M-[567])$/.exec(path);
      if (m && method === "GET") return detailOf(m[1]!, { card: [ONE, TWO, NONE].find((c: any) => c.id === m[1]) });
      return base(path, method, body);
    };
  };
  const clock = (id: string) => [...qa(`[data-tile="${id}"] .tb-tile-stats [title]`), ...qa(`[data-row="${id}"] [title]`)].map((el) => el.getAttribute("title") as string).filter((s) => s.startsWith("Waits for"));

  it("a work line says what it waits for without a number: \"a card that is not public\" (after the numbers, when there are some); with nothing to say there is no suffix", async () => {
    const i18n = await import("/assets/app-i18n.js");
    const note = (c: any) => workMod.workLines({ waiting: [c] })[0].note;
    try {
      i18n.setLang("en", { store: false });
      expect(note(ONE)).toBe("waits for a card that is not public");
      expect(note(TWO)).toBe("waits for M-2, 2 cards that are not public");
      expect(note(card({ id: "M-8", unmetDeps: ["M-2", "M-3"] })), "the dashboard's: the numbers, as before").toBe("waits for M-2, M-3");
      expect(note(NONE), "no empty \"waits for \"").toBe("");
      i18n.setLang("zh-TW", { store: false });
      expect(note(ONE)).toBe("等 一張不公開的卡");
      expect(note(TWO)).toBe("等 M-2、2 張不公開的卡");
    } finally { i18n.setLang("en", { store: false }); }
  });

  it("a sub task that waits for one is not the next one to start (a main task's current work), numbered or not", () => {
    const subs = [card({ id: "S-5", kind: "sub", parentId: "M-2", status: "open", hiddenUnmet: 1 }), card({ id: "S-6", kind: "sub", parentId: "M-2", status: "open" })];
    expect(common.currentWork(M2, subs).cards.map((c: any) => c.id)).toEqual(["S-6"]);
    expect(common.currentWork(M2, [subs[0]]), "nothing else can start").toBeNull();
    expect(common.currentWork(M2, [{ ...subs[0], hiddenUnmet: 0 }]).cards.map((c: any) => c.id), "none left out: it can start").toEqual(["S-5"]);
  });

  it("the board's tile and the list's row show the clock, titled without a number; a card that waits for nothing has none", async () => {
    withThese();
    await mount();
    expect(clock("M-5")).toEqual(["Waits for a card that is not public"]);
    expect(clock("M-6")).toEqual(["Waits for M-2, 2 cards that are not public"]);
    expect(clock("M-7")).toEqual([]);
    await mount({ agend_tasks_project: "1", agend_tasks_display: JSON.stringify({ view: "list" }) });
    expect(clock("M-5")).toEqual(["Waits for a card that is not public"]);
    expect(clock("M-7")).toEqual([]);
  });

  it("the card's page lists them in the dependencies row, not \"None\"; the row still says \"None\" for a card that waits for nothing", async () => {
    withThese();
    const open = async (id: string) => { (globalThis as any).history.replaceState(null, "", "/ui/fleet"); await mount(); await openCard(id); return text(rowOf("Waits for")); };
    const one = await open("M-5");
    expect(one).toContain("a card that is not public");
    expect(one).not.toContain("None");
    const two = await open("M-6");
    expect(two).toContain("M-2");
    expect(two).toContain("2 cards that are not public");
    expect(await open("M-7")).toContain("None");
  });
});

describe("completing an @ in the comment box", () => {
  it("the @name at the caret: after a space, a bracket or the start — never inside a word (an e-mail)", () => {
    expect(activity.mentionAt("hi @al", 6)).toEqual({ start: 3, query: "al" });
    expect(activity.mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(activity.mentionAt("(@x-y.z", 7)).toEqual({ start: 1, query: "x-y.z" });
    expect(activity.mentionAt("ask @小金", 7)).toEqual({ start: 4, query: "小金" });
    expect(activity.mentionAt("mail me@host", 12)).toBeNull();
    expect(activity.mentionAt("hi @al", 2)).toBeNull();            // the caret is before the @
    expect(activity.mentionAt("hi @al and", 10)).toBeNull();       // past the name
    expect(activity.mentionAt("", 0)).toBeNull();
  });
  it("not offered where the board would not read it as a mention: after @, / or \\, a letter, digit, _ . - (an address, a path)", () => {
    for (const [text, why] of [["@@x", "a doubled @"], ["a/@x", "a path"], ["C:\\@x", "a Windows path"], ["me@x", "an e-mail"], ["v1.@x", "after a dot"], ["x-@x", "after a dash"], ["_@x", "after an underscore"], ["9@x", "after a digit"]] as const) {
      expect(activity.mentionAt(text, text.length), `${text}: ${why}`).toBeNull();
    }
    // …and where the board reads it, it is: a space, a bracket, a quote, a colon, a newline, CJK text or another script's letter before it.
    for (const text of ["hi @x", "(@x", "\"@x", "see:@x", "a\n@x", "請@x", "é@x", "，@x", "> @x"]) {
      expect(activity.mentionAt(text, text.length), text).toEqual({ start: text.length - 2, query: "x" });
    }
  });
  it("not offered inside code — inline, or in a fenced block (closed or not): the board reads none of it", () => {
    const none = (text: string) => activity.mentionAt(text, text.length);
    expect(none("`ask @x"), "an inline code never closed is not code (yet)").toEqual({ start: 5, query: "x" });
    expect(activity.mentionAt("`ask @x`", 7), "inline code, caret before its closing backtick").toBeNull();
    expect(activity.mentionAt("`ask @x`", 7 + 1)).toBeNull();
    expect(none("see `a` and `b @x"), "an earlier closed code does not reach the next @").toEqual({ start: 15, query: "x" });
    expect(none("```\n@x"), "a fence not closed runs to the end").toBeNull();
    expect(none("```js\nlet a = 1;\n@x"), "inside an open fence").toBeNull();
    expect(activity.mentionAt("```\n@x\n```", 6), "inside a closed fence").toBeNull();
    expect(none("```\ncode\n```\n@x"), "after a closed fence").toEqual({ start: 13, query: "x" });
    expect(none("`code`@x"), "right after code: the board blanks the code, so the @ stands alone").toEqual({ start: 6, query: "x" });
    expect(none("a `b` @x"), "after a closed inline code and a space").toEqual({ start: 6, query: "x" });
    expect(activity.withoutCode("a `b` d")).toBe("a     d");
    expect(activity.withoutCode("x\n```\nc\n```\ny")).toBe("x\n   \n \n   \ny");
  });
  it("a name is typed as it is read: when the text after the caret would run it on into a longer instance's name, the box adds a space", () => {
    const names = ["a", "a b", "alpha"];
    const at = (text: string, caret: number) => activity.mentionAt(text, caret);
    let t = "Ping @a b later";
    let m = at(t, 7);
    expect(activity.insertMention(t, m, 7, "a", names), "@a before \" b\" would read as @a b").toEqual({ text: "Ping @a  b later", caret: 8 });
    expect(activity.insertMention(t, m, 7, "a", ["a"]), "no longer name: the space already there serves").toEqual({ text: "Ping @a b later", caret: 8 });
    t = "Ping @a x";
    m = at(t, 7);
    expect(activity.insertMention(t, m, 7, "a", names), "after the space comes something else").toEqual({ text: "Ping @a x", caret: 8 });
  });
  it("names that start with the query first, then those that contain it; case does not matter; at most eight", () => {
    const names = ["beta", "alpha", "Alphonse", "gamma-al", "delta"];
    expect(activity.mentionMatches(names, "al")).toEqual(["alpha", "Alphonse", "gamma-al"]);
    expect(activity.mentionMatches(names, "")).toEqual(names);
    expect(activity.mentionMatches(names, "zz")).toEqual([]);
    expect(activity.mentionMatches(Array.from({ length: 20 }, (_, i) => `a${i}`), "a")).toHaveLength(8);
  });
  it("a choice replaces the @query with @name and a space; an existing space or newline is not doubled; the caret lands after", () => {
    const m = activity.mentionAt("Ping @al now", 8);
    expect(activity.insertMention("Ping @al now", m, 8, "alpha")).toEqual({ text: "Ping @alpha now", caret: 12 });
    expect(activity.insertMention("Ping @al", activity.mentionAt("Ping @al", 8), 8, "alpha")).toEqual({ text: "Ping @alpha ", caret: 12 });
    expect(activity.insertMention("@a\nnext", activity.mentionAt("@a\nnext", 2), 2, "alpha")).toEqual({ text: "@alpha\nnext", caret: 6 });
  });
});

describe("what a property's chip offers", () => {
  const act = () => {};
  it("status: every column, the card's own ticked; a main task that follows its sub tasks may only be moved as the card menu allows, and says why", () => {
    const derived = card({ status: "claimed", progress: { total: 2, open: 0, claimed: 1, blocked: 0, review: 0, done: 1 } });
    const items = cardMod.statusItems(derived, act);
    expect(items.map((i: any) => [i.key, i.checked, i.disabled])).toEqual([["open", false, true], ["claimed", true, false], ["blocked", false, false], ["review", false, true], ["done", false, true]]);
    expect(items.find((i: any) => i.key === "open").title).toContain("follows");
    expect(cardMod.statusItems(card({ status: "open" }), act).every((i: any) => !i.disabled)).toBe(true);
    expect(cardMod.statusItems(card({ status: "cancelled" }), act), "a cancelled card is reopened by its button, not a chip").toEqual([]);
  });
  it("assignee: nobody, each instance (one with the board off is disabled, unless it already has the card), Other…", () => {
    const items = cardMod.assigneeItems(card({ assignee: "beta" }), ["gamma", "alpha"], ["gamma", "beta"], act);
    expect(items.map((i: any) => [i.key, i.checked, !!i.disabled])).toEqual([["none", false, false], ["n:alpha", false, false], ["n:beta", true, false], ["n:gamma", false, true], ["other", undefined, false]]);
    expect(items[0].checked).toBe(false);
    expect(cardMod.assigneeItems(card({ assignee: null }), ["alpha"], [], act)[0].checked).toBe(true);
  });
  it("dispatcher: me, nobody, an instance — and the value each sends", () => {
    const items = cardMod.dispatcherItems(card({ dispatcher: { kind: "instance", name: "alpha" } }), ["alpha", "beta"], act);
    expect(items.map((i: any) => [i.key, i.checked])).toEqual([["me", false], ["none", false], ["n:alpha", true], ["n:beta", false]]);
    expect(cardMod.dispatcherValue("\u0000me")).toEqual({ kind: "person" });
    expect(cardMod.dispatcherValue("\u0000none")).toBeNull();
    expect(cardMod.dispatcherValue("beta")).toEqual({ kind: "instance", name: "beta" });
  });
});

describe("the toolbar's search, sort and the Needs you filter", () => {
  it("a search needs every word, in the number, title, fields, checklist or assignee; case does not matter", () => {
    expect(view.searchMatches(M1, "")).toBe(true);
    expect(view.searchMatches(M1, "WEEKLY leader")).toBe(true);
    expect(view.searchMatches(M1, "m-1")).toBe(true);
    expect(view.searchMatches(M1, "alpha")).toBe(true);
    expect(view.searchMatches(M1, "ties share")).toBe(true);       // a checklist item
    expect(view.searchMatches(M1, "weekly shop")).toBe(false);
    expect(view.mainMatches(M2, [S1, S2], [], "price"), "a main task stays when one of its sub tasks matches").toBe(true);
    expect(view.mainMatches(M2, [S1, S2], [], "price checkout"), "…but every word must be in the same card").toBe(false);
    expect(view.mainMatches(M2, [S1, S2], [], "mortgage")).toBe(false);
  });
  it("Needs you is a filter like the others: it keeps the cards that wait for the person, rides in the address, and an older link still reads", () => {
    const f = [{ field: "waits", not: false, values: ["you"] }];
    expect(CARDS.filter((c: any) => view.cardMatches(c, f)).map((c: any) => c.id)).toEqual(["M-3"]);
    expect(CARDS.filter((c: any) => view.cardMatches(c, [{ ...f[0], not: true }])).map((c: any) => c.id)).toEqual(["M-1", "M-2", "S-1", "S-2", "M-4"]);
    expect(view.formatFilters(f)).toBe("waits:you");
    expect(view.parseFilters("waits:you;assignee:alpha")).toEqual([{ field: "waits", not: false, values: ["you"] }, { field: "assignee", not: false, values: ["alpha"] }]);
    expect(view.parseFilters("waits:nobody;status:open")).toEqual([{ field: "status", not: false, values: ["open"] }]);
  });
  it("rows sort by priority (urgent first), assignee (nobody last), number, and any of them turned round", () => {
    const rows = [M1, M2, M3, card({ id: "M-10", assignee: null, priority: "normal", sort: 5 })];
    const ids = (r: any[]) => r.map((c) => c.id);
    expect(ids(view.orderRows(rows, "priority"))).toEqual(["M-3", "M-1", "M-10", "M-2"]);
    expect(ids(view.orderRows(rows, "priority", new Map(), "desc"))).toEqual(["M-2", "M-10", "M-1", "M-3"]);
    expect(ids(view.orderRows(rows, "assignee"))).toEqual(["M-1", "M-3", "M-2", "M-10"]);
    expect(ids(view.orderRows(rows, "assignee", new Map(), "desc")), "turned round: beta first (ties turned too), but nobody still last").toEqual(["M-2", "M-3", "M-1", "M-10"]);
    expect(ids(view.orderRows(rows, "code"))).toEqual(["M-1", "M-2", "M-3", "M-10"]);
    expect(ids(view.orderRows(rows, "code", new Map(), "desc"))).toEqual(["M-10", "M-3", "M-2", "M-1"]);
    expect(ids(view.orderRows([S1, M2, M1], "code")), "main tasks before sub tasks").toEqual(["M-1", "M-2", "S-1"]);
  });
  it("a header click sorts by that column; the same column again turns it round; another starts from its own end", () => {
    const d = { ...view.DEFAULT_DISPLAY };
    expect(view.sortedBy(d, "priority")).toMatchObject({ order: "priority", dir: "asc" });
    expect(view.sortedBy({ ...d, order: "priority", dir: "asc" }, "priority")).toMatchObject({ order: "priority", dir: "desc" });
    expect(view.sortedBy({ ...d, order: "priority", dir: "desc" }, "title")).toMatchObject({ order: "title", dir: "asc" });
  });
  it("display choices from an older device (no direction) still read; a direction is one of two", () => {
    expect(view.cleanDisplay({ view: "list", group: "status", order: "title", done: "all", subs: true })).toEqual({ view: "list", group: "status", order: "title", dir: "asc", done: "all", subs: true });
    expect(view.cleanDisplay({ dir: "sideways" }).dir).toBe("asc");
    expect(view.cleanDisplay({ order: "assignee", dir: "desc" })).toMatchObject({ order: "assignee", dir: "desc" });
  });
});

describe("a new main task: what the quick create sends", () => {
  const f = { project: "", title: "  Build it ", goal: "", scope: "", acceptance: "", context: "", size: "", priority: "normal", assignee: "", needsReview: true };
  it("a title alone: no assignee, no size, normal priority, stops at review — as the long form's defaults were", () => {
    expect(create.createSpec(f)).toEqual({ kind: "main", project: null, title: "Build it", goal: "", scope: "", acceptance: [], context: "", size: null, priority: "normal", assignee: null, needsReview: true });
  });
  it("the chips and the folded fields: project by id, assignee trimmed, a checklist one per line", () => {
    expect(create.createSpec({ ...f, project: "3", assignee: " alpha ", priority: "urgent", size: "M", acceptance: "a\n\n b ", needsReview: false }))
      .toMatchObject({ project: 3, assignee: "alpha", priority: "urgent", size: "M", acceptance: ["a", "b"], needsReview: false });
  });
});

// ── The page, in the app ───────────────────────────────────────────────────────

describe("a card is a page of its own", () => {
  it("opens in place of the board (no dialog), says where it is, and takes the focus; the address names it", async () => {
    await mount();
    const entries = hist().entries.length;
    await openCard("M-1");
    expect(q(".tp").getAttribute("data-card")).toBe("M-1");
    expect(q("dialog")).toBeNull();
    expect(q(".tb-columns"), "the page takes the board's place").toBeNull();
    expect(text(q(".tp-crumbs"))).toBe("Leaderboard M-1");
    expect(text(q(".tp-back"))).toBe("Back to the board");
    expect(search().get("card")).toBe("M-1");
    expect(hist().entries.length, "one history entry for it").toBe(entries + 1);
    expect(hist().state).toEqual({ tbCard: 1 });
    expect(doc().activeElement.className).toBe("tc-head");
    expect(qa(".tp-grid > *").map((el) => el.className), "a phone's single column is this order; the properties are the app's plain .card; the activity is a stream, not a box").toEqual(["tp-head", "tp-body", "card tp-side", "tp-activity"]);
  });

  it("Back (its button, or the browser's) returns to the board with the card's tile; the entry it added is gone", async () => {
    await mount();
    await openCard("M-1");
    fire(q(".tp-back"), "click"); await settle(8);
    expect(q(".tp")).toBeNull();
    expect(q(".tb-columns")).toBeTruthy();
    expect(search().get("card")).toBeNull();
    expect(hist().entries.length).toBe(2);   // the board's entry and the one now behind it
    expect(doc().activeElement.className, "the card's own title has the focus back").toBe("tb-tile-title");
    await openCard("M-3");
    hist().back(); await settle(8);              // the browser's Back
    expect(q(".tp")).toBeNull();
    expect(q(".tb-columns")).toBeTruthy();
    hist().forward(); await settle(8);
    expect(q(".tp").getAttribute("data-card")).toBe("M-3");
  });

  it("a card's page starts at its top, and Back brings the board to the place it was left", async () => {
    await mount();
    const body = q(".panel-body");
    body.scrollTop = 120;
    await openCard("M-1");
    expect(body.scrollTop, "the panel was scrolled on the board; the page starts at its top").toBe(0);
    body.scrollTop = 40;
    fire(q(".tp-back"), "click"); await settle(8);
    expect(body.scrollTop).toBe(120);
    body.scrollTop = 75;
    await openCard("M-3");
    hist().back(); await settle(8);                                // the browser's Back brings it too
    expect(body.scrollTop).toBe(75);
  });

  it("a link to a card (a notice's) opens it directly; Back then drops the address's card and shows the board", async () => {
    (globalThis as any).history.replaceState(null, "", "/ui/fleet?card=M-3");
    await mount();
    expect(q(".tp").getAttribute("data-card")).toBe("M-3");
    fire(q(".tp-back"), "click"); await settle(8);
    expect(q(".tp")).toBeNull();
    expect(search().get("card")).toBeNull();
    expect(q(".tb-columns")).toBeTruthy();
  });

  it("a sub task opened from its main task is one entry deeper, and Back goes all the way to the board; previous / next only replace", async () => {
    await mount();
    await openCard("M-2");
    const first = hist().entries.length;
    fire(qa(".tp .tc-children button").find((b) => b.textContent.includes("S-2")), "click"); await settle(10);
    expect(q(".tp").getAttribute("data-card")).toBe("S-2");
    expect(hist().entries.length).toBe(first + 1);
    expect(hist().state).toEqual({ tbCard: 2 });
    expect(text(q(".tp-crumbs"))).toContain("M-2 Add the shop");
    fire(q(".tp .tc-steps button"), "click"); await settle(10);                          // previous: S-1
    expect(q(".tp").getAttribute("data-card")).toBe("S-1");
    expect(hist().entries.length, "stepping adds no entry").toBe(first + 1);
    fire(q(".tp-back"), "click"); await settle(8);
    expect(q(".tp")).toBeNull();
    expect(q(".tb-columns")).toBeTruthy();
    expect(hist().entries.length).toBe(first + 1);
  });

  it("Esc goes back to the board — but not out of a text box", async () => {
    await mount();
    await openCard("M-1");
    fire(q(".tp-body .tc-text"), "click"); await settle(4);
    const box = q(".tp-body .tc-edit textarea");
    fire(box, "keydown", { key: "Escape", cancelable: true }); await settle(4);
    expect(q(".tp"), "the box took the Esc").toBeTruthy();
    expect(q(".tp-body .tc-edit")).toBeNull();
    fire(doc().body, "keydown", { key: "Escape" }); await settle(8);
    expect(q(".tp")).toBeNull();
  });

  it("the page's order: title, spec, the agent's line, sub tasks, properties, activity (a phone's single column keeps this order)", async () => {
    await mount();
    await openCard("M-1");
    expect(qa(".tp-group").map((g) => text(g.querySelector(".tp-group-title"))), "three groups").toEqual(["Core", "Project and people", "Flow"]);
    expect(qa(".tp-props .tp-row dt").map((d) => text(d))).toEqual(["Status", "Assignee", "Priority", "Size",
      "Project", "Leader", "Dispatched by", "Watchers",
      "Needs my confirmation", "Waits for"]);
    expect(qa(".tp-group").map((g) => qa(".tp-group").indexOf(g) + ":" + g.querySelectorAll(".tp-row").length)).toEqual(["0:4", "1:4", "2:2"]);
    // M-1: its goal and definition of done are filled (the spec); scope and context are buttons; the agent has written nothing (a line); no sub tasks yet (the list is there to add one).
    expect(qa(".tp-body > *").map((el) => el.className.split(" ")[0])).toEqual(["tp-spec", "tp-adders", "tr-run", "tp-subs"]);
    expect(qa(".tp-spec .tc-field h3").map((h) => text(h))).toEqual(["Goal", "Definition of done"]);
    expect(qa(".tp-activity > *").map((el) => el.className.split(" ")[0]), "then the timeline and the comment box").toEqual(["tl", "tc-composer"]);
  });
});

describe("a property is a chip: choosing saves at once", () => {
  it("priority → Low: one write, with the version the card was read at", async () => {
    await mount();
    await openCard("M-1");
    await chip("Priority", "Low");
    expect(posts()).toEqual([{ method: "POST", path: "/ui/tasks/cards/M-1", body: { priority: "low", version: 4 } }]);
  });
  it("size, project and dispatcher the same way", async () => {
    await mount();
    await openCard("M-1");
    await chip("Size", "Large");
    await chip("Project", "No project");
    await chip("Dispatched by", "Nobody");
    expect(posts().map((c) => c.body)).toEqual([{ size: "L", version: 4 }, { projectId: null, version: 4 }, { dispatcher: null, version: 4 }]);
  });
  it("status: Blocked asks why first (the same question as everywhere), then moves; a derived card's other statuses are disabled", async () => {
    await mount();
    await openCard("M-1");
    fire(rowOf("Status").querySelector("button.tp-chip"), "click"); await settle(4);
    const items = qa(".tp-row .menu-list button");
    expect(items.map((b) => [text(b), b.getAttribute("aria-checked"), !!b.disabled])).toEqual([["To do", "false", false], ["In progress", "true", false], ["Blocked", "false", false], ["To confirm", "false", false], ["Done", "false", false]]);
    fire(items.find((b) => text(b) === "Blocked"), "click"); await settle(8);
    const ask = qa("dialog[open]").at(-1);
    expect(ask, "asks why").toBeTruthy();
    ask.querySelector("textarea").value = "Which scores count?"; fire(ask.querySelector("textarea"), "input"); await settle(2);
    fire(ask.querySelector(".btn-primary"), "click"); await settle(10);
    expect(posts().map((c) => [c.path, c.body])).toEqual([["/ui/tasks/cards/M-1/move", { to: "blocked", reason: "Which scores count?", version: 4 }]]);
  });
  it("assignee: choosing an instance saves; Other… asks for a name; an instance with the board off is listed but cannot be chosen", async () => {
    boardOff = ["gamma"];
    await mount();
    await openCard("M-1");
    fire(rowOf("Assignee").querySelector("button.tp-chip"), "click"); await settle(4);
    const items = qa(".tp-row .menu-list button");
    expect(items.map((b) => [text(b), !!b.disabled])).toEqual([["Unassigned", false], ["alpha", false], ["beta", false], ["gamma (task board off)", true], ["Other…", false]]);
    fire(items.find((b) => text(b) === "beta"), "click"); await settle(10);
    expect(posts().map((c) => c.body)).toEqual([{ assignee: "beta", version: 4 }]);
    calls.length = 0;
    await chip("Assignee", "Other…");
    const ask = qa("dialog[open]").at(-1);
    ask.querySelector("textarea").value = "delta"; fire(ask.querySelector("textarea"), "input"); await settle(2);
    fire(ask.querySelector(".btn-primary"), "click"); await settle(10);
    expect(posts().map((c) => c.body)).toEqual([{ assignee: "delta" }]);   // a named other instance is sent without a version check, as before
  });
  it("two quick choices go one after the other, the second on the card as the first left it (not on the version it was drawn at)", async () => {
    let version = 4;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });          // the first write is still on its way when the second is chosen
    handler = async (path, method, body) => {
      if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS };
      if (path === "/ui/tasks/cards/M-1" && method === "POST") {
        if (body.priority !== undefined) await held;
        if (body.version !== version) return { __status: 409, error: "stale", key: "conflict", args: ["M-1", "alpha"] };
        version++;
        return { card: { ...M1, version }, notes: [] };
      }
      if (path === "/ui/tasks/cards/M-1") return detailOf("M-1", { card: { ...M1, version } });
      return {};
    };
    await mount();
    await openCard("M-1");
    fire(rowOf("Priority").querySelector("button.tp-chip"), "click"); await settle(2);
    fire(qa(".tp-row .menu-list button").find((b) => text(b) === "Low"), "click"); await settle(2);
    fire(rowOf("Size").querySelector("button.tp-chip"), "click"); await settle(2);
    fire(qa(".tp-row .menu-list button").find((b) => text(b) === "Large"), "click"); await settle(4);
    expect(posts().map((c) => c.body), "the second waits for the first").toEqual([{ priority: "low", version: 4 }]);
    release(); await settle(16);
    expect(posts().map((c) => c.body)).toEqual([{ priority: "low", version: 4 }, { size: "L", version: 5 }]);
  });
  it("the page's controls are the dashboard's: every property but the dependencies' list is a chip", async () => {
    await mount();
    await openCard("M-1");
    expect(qa(".tp-props button.tp-chip").map((b) => b.getAttribute("aria-label"))).toEqual(["Status", "Assignee", "Priority", "Size", "Project", "Dispatched by"]);
    expect(qa(".tp-props input[type=checkbox]").length, "needs my confirmation is a switch").toBe(1);
    expect(q(".tp-props input[type=checkbox]").getAttribute("role")).toBe("switch");
  });
});

describe("text edits where it is read", () => {
  const fieldOf = (title: string) => qa(".tp-body .tc-field").find((f) => text(f.querySelector("h3")) === title);
  const ADD: Record<string, string> = { Goal: "goal", Scope: "scope", "Definition of done": "definition", Context: "context", State: "state", Result: "result" };
  /** A field that holds text opens on a click; an empty one is a "+ Add" button first (and opens as it appears). */
  const open = async (title: string) => {
    if (fieldOf(title)) fire(fieldOf(title).querySelector(".tc-text"), "click");
    else fire(q(`.tp-add[data-add="${ADD[title]}"]`), "click");
    await settle(4);
    return fieldOf(title).querySelector("textarea");
  };

  it("leaving the box saves, and there is no Save or Cancel button on the way", async () => {
    await mount();
    await openCard("M-1");
    const box = await open("Goal");
    expect(doc().activeElement).toBe(box);
    await typeInto(box, "Players see their rank at once");
    expect(fieldOf("Goal").querySelectorAll("button").length, "no buttons while editing").toBe(0);
    fire(box, "blur"); await settle(10);
    expect(posts()).toEqual([{ method: "POST", path: "/ui/tasks/cards/M-1", body: { goal: "Players see their rank at once", version: 4 } }]);
    expect(fieldOf("Goal").querySelector("textarea"), "the edit closes once saved").toBeNull();
  });
  it("Ctrl+Enter saves; Esc drops it, and the blur that follows saves nothing; an unchanged text sends nothing", async () => {
    await mount();
    await openCard("M-1");
    let box = await open("Context");
    await typeInto(box, "See M-4");
    fire(box, "keydown", { key: "Enter", ctrlKey: true, cancelable: true }); await settle(10);
    expect(posts().map((c) => c.body)).toEqual([{ context: "See M-4", version: 4 }]);
    calls.length = 0;
    box = await open("State");
    await typeInto(box, "half-typed");
    fire(box, "keydown", { key: "Escape", cancelable: true }); await settle(4);
    fire(box, "blur"); await settle(8);
    expect(posts()).toEqual([]);
    expect(fieldOf("State"), "an empty field closed again folds back into its button").toBeUndefined();
    expect(q('.tp-add[data-add="state"]')).toBeTruthy();
    box = await open("Goal");                                   // opened and left as it was
    fire(box, "blur"); await settle(8);
    expect(posts()).toEqual([]);
  });
  it("a text over its limit is not sent; the counter says so, and the box stays", async () => {
    await mount();
    await openCard("M-1");
    const box = await open("Goal");
    await typeInto(box, "x".repeat(301));
    expect(text(fieldOf("Goal").querySelector(".tc-counter"))).toBe("301 / 300");
    fire(box, "blur"); await settle(8);
    expect(posts()).toEqual([]);
    expect(fieldOf("Goal").querySelector("textarea")).toBeTruthy();
  });
  it("the title: Enter or leaving saves, Esc drops; an emptied title goes back to what it was", async () => {
    await mount();
    await openCard("M-1");
    fire(q(".tc-head .tc-title"), "click"); await settle(4);
    let input = q(".tc-head input");
    await typeInto(input, "Serve the leaderboard weekly");
    fire(input, "keydown", { key: "Enter", cancelable: true }); await settle(10);
    expect(posts().map((c) => c.body)).toEqual([{ title: "Serve the leaderboard weekly", version: 4 }]);
    calls.length = 0;
    fire(q(".tc-head .tc-title"), "click"); await settle(4);
    input = q(".tc-head input");
    await typeInto(input, "   ");
    fire(input, "blur"); await settle(8);
    expect(posts()).toEqual([]);
    expect(q(".tc-head input")).toBeNull();
  });
  it("the checklist: a tick saves at once; editing the list saves on leaving", async () => {
    await mount();
    await openCard("M-1");
    fire(qa(".tc-checklist input")[1], "change"); await settle(10);
    expect(posts().map((c) => c.body)).toEqual([{ check: [2], version: 4 }]);
    calls.length = 0;
    fire(qa(".tp-body .tc-field").find((f) => text(f.querySelector("h3")) === "Definition of done").querySelector("button.btn"), "click"); await settle(4);
    const box = q(".tc-edit textarea");
    await typeInto(box, "Ties share a rank\nUnder 300 ms\nOld scores kept");
    fire(box, "blur"); await settle(10);
    expect(posts().map((c) => c.body)).toEqual([{ acceptance: ["Ties share a rank", "Under 300 ms", "Old scores kept"], version: 4 }]);
  });

  it("when the card changed meanwhile (409) the edit stays open with a line saying so; leaving the box does not overwrite, Overwrite does", async () => {
    let refuse = true;
    const base = handler;
    handler = (path, method, body) => {
      if (path === "/ui/tasks/cards/M-1" && method === "POST") {
        if (refuse && body.version !== undefined) return { __status: 409, error: "changed", key: "conflict", args: ["M-1", "alpha"] };
        return { card: { ...M1, goal: body.goal }, notes: [] };
      }
      return base(path, method, body);
    };
    await mount();
    await openCard("M-1");
    const box = await open("Goal");
    await typeInto(box, "My text");
    fire(box, "blur"); await settle(10);
    expect(posts()).toHaveLength(1);
    expect(fieldOf("Goal").querySelector("textarea"), "the draft is still there").toBeTruthy();
    expect(text(fieldOf("Goal").querySelector(".tc-edit-bar .err"))).toContain("changed meanwhile");
    expect(text(fieldOf("Goal").querySelector(".tc-edit-bar"))).toContain("Overwrite");
    fire(box, "blur"); await settle(6);
    expect(posts(), "leaving the box again does not send it over the newer card").toHaveLength(1);
    refuse = false;
    fire(fieldOf("Goal").querySelector(".tc-edit-bar .btn-primary"), "click"); await settle(10);
    expect(posts()).toHaveLength(2);
    expect(posts()[1]!.body, "no version check: on purpose").toEqual({ goal: "My text" });
    expect(fieldOf("Goal").querySelector("textarea")).toBeNull();
  });
  it("Discard my change in a conflict closes the edit without sending", async () => {
    const base = handler;
    handler = (path, method, body) => (path === "/ui/tasks/cards/M-1" && method === "POST" ? { __status: 409, error: "changed", key: "conflict", args: ["M-1", "alpha"] } : base(path, method, body));
    await mount();
    await openCard("M-1");
    const box = await open("Goal");
    await typeInto(box, "Mine");
    fire(box, "blur"); await settle(10);
    const discard = qa(".tc-edit-bar .btn").find((b) => text(b) === "Discard my change");
    fire(discard, "click"); await settle(6);
    expect(posts()).toHaveLength(1);
    expect(fieldOf("Goal").querySelector("textarea")).toBeNull();
  });

  // A save that is still on its way when more is typed: the text typed after what was sent is newer than what the server holds,
  // so it is not thrown away when the first save succeeds — the box stays open on it, and its save is on the card as the first left it.
  // `agentRightAfter`: another agent changes the goal the instant after the first save was applied, so the page's next read of the card
  // is the agent's revision while the first save's own answer said the revision before it. `external()`: such a write, any time.
  const slowSave = (opts: { agentRightAfter?: boolean; omitVersion?: boolean } = {}) => {
    let version = 4, goal = M1.goal, first = true;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const base = handler;
    handler = async (path, method, body) => {
      if (path === "/ui/tasks/cards/M-1" && method === "POST") {
        const wasFirst = first;
        if (first) { first = false; await held; }
        if (body.version !== undefined && body.version !== version) return { __status: 409, error: "stale", key: "conflict", args: ["M-1", "alpha"] };
        version++; goal = body.goal;
        const answer = { card: { ...M1, goal, version: opts.omitVersion ? undefined : version }, notes: [] };
        if (wasFirst && opts.agentRightAfter) { version++; goal = "Another agent's goal"; }
        return answer;
      }
      if (path === "/ui/tasks/cards/M-1") return detailOf("M-1", { card: { ...M1, goal, version } });
      return base(path, method, body);
    };
    return { release: () => release(), external: (text: string) => { version++; goal = text; }, server: () => ({ version, goal }) };
  };
  /** The board's "tasks" stream event, the page's own way to read the card again (once per burst, after a short pause). */
  const refreshFromStream = async (fire_: (name: string, data: unknown) => void) => { fire_("tasks", { rev: 90 + mounts, ids: ["M-1"] }); await new Promise((r) => setTimeout(r, 330)); await settle(10); };
  it("text typed while a save is on its way is kept: the box stays open on it, and its save sends the new text on the version the first save left", async () => {
    const slow = slowSave();
    await mount();
    await openCard("M-1");
    const box = await open("Goal");
    await typeInto(box, "First draft");
    fire(box, "keydown", { key: "Enter", ctrlKey: true, cancelable: true }); await settle(4);      // sent; the answer is held
    expect(text(fieldOf("Goal").querySelector(".tc-edit-bar")), "it says it is saving").toContain("Saving");
    await typeInto(box, "First draft, and more typed while it saved");                            // the box still takes text meanwhile
    slow.release(); await settle(12);
    expect(posts().map((c) => c.body), "only the first draft had gone").toEqual([{ goal: "First draft", version: 4 }]);
    const again = fieldOf("Goal").querySelector("textarea");
    expect(again, "the first save went through, and the box is still open").toBeTruthy();
    expect(again.value, "…on the newer text").toBe("First draft, and more typed while it saved");
    expect(fieldOf("Goal").querySelector(".tc-edit-bar .err"), "no conflict, no failure").toBeNull();
    fire(again, "keydown", { key: "Enter", ctrlKey: true, cancelable: true }); await settle(10);
    expect(posts().map((c) => c.body)[1], "the new text, on the new version").toEqual({ goal: "First draft, and more typed while it saved", version: 5 });
    expect(posts()).toHaveLength(2);
    expect(fieldOf("Goal").querySelector("textarea"), "nothing newer is left: the edit closes").toBeNull();
  });
  it("leaving the box while a save is on its way saves what was typed after it, once the first save is over; and typing nothing more closes the box as before", async () => {
    const slow = slowSave();
    await mount();
    await openCard("M-1");
    let box = await open("Goal");
    await typeInto(box, "First draft");
    fire(box, "keydown", { key: "Enter", ctrlKey: true, cancelable: true }); await settle(4);
    await typeInto(box, "First draft, plus a line");
    fire(box, "blur"); await settle(4);                                                           // left while the first is still on its way
    expect(posts()).toHaveLength(1);
    slow.release(); await settle(14);
    expect(posts().map((c) => c.body)).toEqual([{ goal: "First draft", version: 4 }, { goal: "First draft, plus a line", version: 5 }]);
    expect(fieldOf("Goal").querySelector("textarea"), "both are saved: the box is closed").toBeNull();
    // Nothing typed after the send: the box closes once saved, as before.
    calls.length = 0;
    box = await open("Context");
    await typeInto(box, "See M-4");
    fire(box, "keydown", { key: "Enter", ctrlKey: true, cancelable: true }); await settle(10);
    expect(posts()).toHaveLength(1);
    expect(fieldOf("Context")?.querySelector("textarea") ?? null).toBeNull();
  });
  it("the kept text is pinned to the revision its own save produced: another agent's write after that, read by a normal refresh, makes it a conflict that needs an explicit Overwrite", async () => {
    const slow = slowSave();
    const handlers: Record<string, Array<(d: unknown) => void>> = {};
    const before = app.appStore.get().streamOn;
    app.appStore.set({ streamOn: (name: string, fn: (d: unknown) => void) => { (handlers[name] ??= []).push(fn); return () => {}; } });
    try {
      await mount();
      await openCard("M-1");
      const box = await open("Goal");
      await typeInto(box, "First draft");
      fire(box, "keydown", { key: "Enter", ctrlKey: true, cancelable: true }); await settle(4);
      await typeInto(box, "First draft, and a second draft typed while it saved");
      slow.release(); await settle(12);
      expect(posts().map((c) => c.body)).toEqual([{ goal: "First draft", version: 4 }]);
      expect(fieldOf("Goal").querySelector("textarea").value, "the second draft is kept, in an open box").toBe("First draft, and a second draft typed while it saved");
      // Another agent changes the goal (revision 6); the page reads the card again by its normal refresh; the box stays open.
      slow.external("Another agent's goal");
      await refreshFromStream((name, data) => { for (const fn of handlers[name] ?? []) fn(data); });
      expect(calls.filter((c) => c.method === "GET" && c.path === "/ui/tasks/cards/M-1").length, "the page did read the card again").toBeGreaterThan(1);
      expect(fieldOf("Goal").querySelector("textarea").value, "the kept draft is still there after the refresh").toBe("First draft, and a second draft typed while it saved");
      // Saving it sends revision 5 — its own save's — so the host refuses it and the page asks, as in any conflict.
      fire(fieldOf("Goal").querySelector("textarea"), "keydown", { key: "Enter", ctrlKey: true, cancelable: true }); await settle(12);
      expect(posts()).toHaveLength(2);
      expect(posts()[1]!.body, "the revision its own save produced, not the page's latest").toEqual({ goal: "First draft, and a second draft typed while it saved", version: 5 });
      expect(slow.server().goal, "the other agent's text was not overwritten").toBe("Another agent's goal");
      expect(text(fieldOf("Goal").querySelector(".tc-edit-bar .err"))).toContain("changed meanwhile");
      expect(text(fieldOf("Goal").querySelector(".tc-edit-bar"))).toContain("Overwrite");
      fire(fieldOf("Goal").querySelector("textarea"), "blur"); await settle(6);
      expect(posts(), "leaving the box does not send it over the newer card").toHaveLength(2);
      // Only an explicit Overwrite sends it over revision 6, and then with no revision check.
      fire(fieldOf("Goal").querySelector(".tc-edit-bar .btn-primary"), "click"); await settle(12);
      expect(posts()).toHaveLength(3);
      expect(posts()[2]!.body).toEqual({ goal: "First draft, and a second draft typed while it saved" });
      expect(slow.server().goal).toBe("First draft, and a second draft typed while it saved");
      expect(fieldOf("Goal").querySelector("textarea"), "overwritten on purpose: the edit closes").toBeNull();
    } finally { app.appStore.set({ streamOn: before }); }
  });
  it("the same when the box was left while the first save was pending: the automatic save of the kept text sends the first save's revision, so another agent's write meanwhile is a conflict", async () => {
    const slow = slowSave({ agentRightAfter: true });
    await mount();
    await openCard("M-1");
    const box = await open("Goal");
    await typeInto(box, "First draft");
    fire(box, "keydown", { key: "Enter", ctrlKey: true, cancelable: true }); await settle(4);
    await typeInto(box, "First draft, plus a line typed while it saved");
    fire(box, "blur"); await settle(4);                                                            // left while the first save is still on its way
    slow.release(); await settle(16);                                                              // the first save is applied (revision 5), an agent writes (6), the page reads 6
    expect(posts().map((c) => c.body)).toEqual([{ goal: "First draft", version: 4 }, { goal: "First draft, plus a line typed while it saved", version: 5 }]);
    expect(slow.server().goal, "the agent's text survives").toBe("Another agent's goal");
    expect(text(fieldOf("Goal").querySelector(".tc-edit-bar .err")), "the normal conflict, with the draft kept").toContain("changed meanwhile");
    expect(fieldOf("Goal").querySelector("textarea").value).toBe("First draft, plus a line typed while it saved");
    fire(fieldOf("Goal").querySelector(".tc-edit-bar .btn-primary"), "click"); await settle(12);
    expect(posts()[2]!.body, "an explicit Overwrite, no revision check").toEqual({ goal: "First draft, plus a line typed while it saved" });
    expect(slow.server().goal).toBe("First draft, plus a line typed while it saved");
  });
  it("an answer that does not say its revision never lets the kept text overwrite: it is sent on the revision the edit started from, and meets a conflict", async () => {
    const slow = slowSave({ omitVersion: true });
    await mount();
    await openCard("M-1");
    const box = await open("Goal");
    await typeInto(box, "First draft");
    fire(box, "keydown", { key: "Enter", ctrlKey: true, cancelable: true }); await settle(4);
    await typeInto(box, "First draft, and more");
    slow.release(); await settle(12);
    fire(fieldOf("Goal").querySelector("textarea"), "keydown", { key: "Enter", ctrlKey: true, cancelable: true }); await settle(12);
    expect(posts().map((c) => c.body)).toEqual([{ goal: "First draft", version: 4 }, { goal: "First draft, and more", version: 4 }]);
    expect(slow.server().goal, "nothing was overwritten").toBe("First draft");
    expect(text(fieldOf("Goal").querySelector(".tc-edit-bar .err"))).toContain("changed meanwhile");
  });
  it("Esc while a save is on its way drops the edit; the save that was sent still goes through and does not reopen the box", async () => {
    const slow = slowSave();
    await mount();
    await openCard("M-1");
    const box = await open("Goal");
    await typeInto(box, "First draft");
    fire(box, "keydown", { key: "Enter", ctrlKey: true, cancelable: true }); await settle(4);
    await typeInto(box, "First draft, more");
    fire(box, "keydown", { key: "Escape", cancelable: true }); await settle(4);
    slow.release(); await settle(12);
    expect(posts().map((c) => c.body)).toEqual([{ goal: "First draft", version: 4 }]);
    expect(fieldOf("Goal").querySelector("textarea"), "dropped means closed").toBeNull();
  });
});

describe("the timeline and the comment box on the page", () => {
  // The system's lines between cards are folded at first ("› N activities"); these tests read them, so they open every fold.
  const unfold = async () => { for (const b of qa(".tl-more")) fire(b, "click"); await settle(4); };
  it("one list, comments with their writers, the log and the history between them; each filter shows one kind", async () => {
    await mount();
    await openCard("M-1");
    expect(qa(".tl-item").length, "the history is folded: the cards only").toBe(4);
    expect(qa(".tl-more").map((b) => text(b)), "a day change cuts a run: three runs of one line").toEqual(["1 activity", "1 activity", "1 activity"]);
    await unfold();
    expect(qa(".tl-item").length).toBe(7);
    expect(qa(".tl-item").map((li) => li.className.split(" ").slice(1, 3).join(" "))).toEqual(["tl-line tl-event", "tl-line tl-event", "tl-card tl-comment", "tl-card tl-log", "tl-card tl-comment", "tl-line tl-event", "tl-card tl-comment"]);
    expect(text(qa(".tl-comment")[2].querySelector(".tb-tag"))).toBe("Sent back");
    const filters = qa(".tl-filter button");
    expect(filters.map((b) => text(b))).toEqual(["All", "Comments 3", "Progress 1", "History 3"]);
    fire(filters[1], "click"); await settle(4);
    expect(qa(".tl-item").length).toBe(3);
    fire(filters[2], "click"); await settle(4);
    expect(text(q(".tl-item"))).toContain("Endpoint skeleton done");
    fire(filters[0], "click"); await settle(4);
    expect(qa(".tl-item").length, "a fold opened stays open when the filter comes back").toBe(7);
  });
  it("a watcher change is a history line on the card's page (not a log entry), in the existing line style and under the History filter", async () => {
    const watched = { id: 36, actor: "Ann", actorKind: "person", type: "logged", data: { text: "watchers: +beta", watchers: { added: ["beta"], removed: [] } }, at: "2026-11-04T08:00:00.000Z" };
    handler = (path, method) => (path.startsWith("/ui/tasks/board") ? { rev: 1, projects: [PROJECT], cards: CARDS } : method === "GET" ? detailOf("M-1", { history: [...ENTRIES.history, watched] }) : {});
    await mount();
    await openCard("M-1");
    await unfold();
    expect(qa(".tl-item").length).toBe(8);
    const last = qa(".tl-item")[7];
    expect(last.className).toContain("tl-line tl-event");
    expect([text(last.querySelector(".tl-who")), text(last.querySelector(".tl-text"))], "who and what are columns of the line").toEqual(["Ann", "changed watchers: +beta"]);
    const filters = qa(".tl-filter button");
    expect(filters.map((b) => text(b))).toEqual(["All", "Comments 3", "Progress 1", "History 4"]);
    fire(filters[3], "click"); await settle(4);
    expect(qa(".tl-item").map((li) => text(li.querySelector(".tl-who")) + " " + text(li.querySelector(".tl-text")))).toContain("Ann changed watchers: +beta");
    fire(filters[2], "click"); await settle(4);
    expect(text(q(".tl-list"))).not.toContain("changed watchers");
  });
  it("a card with no activity says what shows here", async () => {
    handler = (path, method) => (path.startsWith("/ui/tasks/board") ? { rev: 1, projects: [PROJECT], cards: CARDS } : method === "GET" ? detailOf("M-1", { comments: [], logs: [], history: [] }) : {});
    await mount();
    await openCard("M-1");
    expect(text(q(".tl-none"))).toContain("Nothing yet");
  });
  it("typing @ lists the instances; the arrows and Enter type the name; the box keeps its text and Esc closes only the list", async () => {
    boardOff = ["gamma"];
    await mount();
    await openCard("M-1");
    const box = q(".tc-composer textarea");
    await typeInto(box, "Ping @");
    expect(qa(".tc-mentions li").map((li) => li.textContent.replace(/\s+/g, " ").trim())).toEqual(["@alpha", "@beta", "@gammatask board off"]);   // the card's assignee first
    expect(qa(".tc-mentions li")[0].getAttribute("aria-selected")).toBe("true");
    await typeInto(box, "Ping @b");
    expect(qa(".tc-mentions li").map((li) => li.textContent)).toEqual(["@beta"]);
    fire(box, "keydown", { key: "Enter", cancelable: true }); await settle(6);
    expect(box.value).toBe("Ping @beta ");
    expect(q(".tc-mentions")).toBeNull();
    expect(posts(), "choosing a name sends nothing").toEqual([]);
    await typeInto(box, "Ping @beta and @g");
    expect(qa(".tc-mentions button")[0].disabled, "a board-off instance cannot be chosen").toBe(true);
    fire(box, "keydown", { key: "Enter", cancelable: true }); await settle(4);
    expect(box.value, "Enter on a disabled name types nothing").toBe("Ping @beta and @g");
    fire(box, "keydown", { key: "Escape", cancelable: true }); await settle(4);
    expect(q(".tc-mentions")).toBeNull();
    expect(box.value).toBe("Ping @beta and @g");
  });
  it("only the fleet's instances are listed: an assignee that has left the fleet (or a person) is not, and the assignee that is one comes first", async () => {
    handler = (path, method, body) => (path === "/ui/tasks/cards/M-1" && method === "GET" ? detailOf("M-1", { card: { ...M1, assignee: "ghost" } }) : path.startsWith("/ui/tasks/board") ? { rev: 1, projects: [PROJECT], cards: CARDS } : {});
    await mount();
    await openCard("M-1");
    const box = q(".tc-composer textarea");
    await typeInto(box, "Ping @");
    expect(qa(".tc-mentions li").map((li) => li.textContent.replace(/\s+/g, " ").trim()), "no @ghost").toEqual(["@alpha", "@beta", "@gamma"]);
    await typeInto(box, "Ping @gh");
    expect(q(".tc-mentions"), "nothing completes a name that is no instance").toBeNull();
    handler = (path, method, body) => (path === "/ui/tasks/cards/M-1" && method === "GET" ? detailOf("M-1", { card: { ...M1, assignee: "gamma" } }) : path.startsWith("/ui/tasks/board") ? { rev: 1, projects: [PROJECT], cards: CARDS } : {});
    (globalThis as any).history.replaceState(null, "", "/ui/fleet");
    await mount();
    await openCard("M-1");
    await typeInto(q(".tc-composer textarea"), "@");
    expect(qa(".tc-mentions li").map((li) => li.textContent.replace(/\s+/g, " ").trim()), "the assignee, when it is an instance, first").toEqual(["@gamma", "@alpha", "@beta"]);
  });
  it("no list where the board would not read the @ — after a path's / or \\, after another @, inside code or a fence — and one after CJK text", async () => {
    await mount();
    await openCard("M-1");
    const box = q(".tc-composer textarea");
    for (const text of ["@@al", "see src/@al", "C:\\@al", "`ask @al", "```\n@al"].map((t, i) => (i === 3 ? "`ask @al`" : t))) {
      await typeInto(box, text, text === "`ask @al`" ? text.length - 1 : text.length);
      expect(q(".tc-mentions"), text).toBeNull();
    }
    await typeInto(box, "請@al");
    expect(qa(".tc-mentions li").map((li) => li.textContent), "after CJK text the board reads it, so the list is there").toEqual(["@alpha"]);
  });
  it("an @ inside a word is not offered; clicking a name types it; sending posts the plain text", async () => {
    await mount();
    await openCard("M-1");
    const box = q(".tc-composer textarea");
    await typeInto(box, "write to me@host");
    expect(q(".tc-mentions")).toBeNull();
    await typeInto(box, "@al");
    fire(qa(".tc-mentions button")[0], "click"); await settle(6);
    expect(box.value).toBe("@alpha ");
    await typeInto(box, "@alpha please look");
    fire(box, "keydown", { key: "Enter", ctrlKey: true, cancelable: true }); await settle(10);
    expect(posts().map((c) => c.body), "the plain text, `@alpha` and all (what it does is the board's business)").toEqual([{ comment: "@alpha please look" }]);   // a comment carries no version: it never conflicts
  });
});

// ── The toolbar, the list and the board ──────────────────────────────────────────

describe("one toolbar row", () => {
  const rows = () => qa(".tb-row").map((r) => r.getAttribute("data-row"));
  const tiles = () => qa(".tb-tile").map((t) => t.getAttribute("data-tile"));
  const toggle = async (label: string) => { fire(qa(".tb-view-toggle button").find((b) => text(b) === label), "click"); await settle(6); };

  it("the board / list switch, search, Filter and Display are one row; the choice of view is remembered", async () => {
    await mount();
    expect(qa(".tb-view-bar").length).toBe(1);
    // One row: the switch, the search field, then Filter, Display and the phone's 🔍 together (a phone puts them at the row's right).
    expect([...q(".tb-view-bar").children].map((el: any) => el.className.split(" ")[0])).toEqual(["tb-seg", "tb-search", "tb-view-actions"]);
    expect([...q(".tb-view-actions").children].map((el: any) => el.className.split(" ")[0])).toEqual(["menu", "menu", "btn"]);
    expect(qa(".tb-view-toggle button").map((b) => [text(b), b.getAttribute("aria-pressed")])).toEqual([["Board", "true"], ["List", "false"]]);
    await toggle("List");
    expect(q(".tb-columns")).toBeNull();
    expect(rows().length).toBeGreaterThan(0);
    expect(JSON.parse((globalThis as any).localStorage.getItem("agend_tasks_display"))).toMatchObject({ view: "list" });
    await mount({ agend_tasks_project: "1" });                 // opened again: still the list
    expect(q(".tb-list")).toBeTruthy();
    await toggle("Board");
    expect(q(".tb-columns")).toBeTruthy();
  });

  it("the search narrows the board and the list as you type, is kept with the other conditions, and Esc clears it", async () => {
    await mount();
    const input = q(".tb-find input");
    await typeInto(input, "shop");
    expect(tiles()).toEqual(["M-2"]);
    expect((globalThis as any).localStorage.getItem("agend_tasks_query")).toBe("shop");
    await toggle("List");
    expect(rows()).toEqual(["M-2"]);
    await typeInto(input, "zzz");
    expect(text(q(".empty"))).toContain("No main tasks match the filter");
    // The empty message has the way out: Clear search (the search is kept on the device, so a reload would show it again).
    const clear = qa(".empty button").find((b) => text(b) === "Clear search");
    expect(clear, "Clear search").toBeTruthy();
    fire(clear, "click"); await settle(6);
    expect(q(".tb-find input").value).toBe("");
    expect((globalThis as any).localStorage.getItem("agend_tasks_query")).toBeNull();
    expect(rows().length).toBe(4);
    await typeInto(q(".tb-find input"), "zzz");
    fire(q(".tb-find input"), "keydown", { key: "Escape", cancelable: true }); await settle(6);
    expect(q(".tb-find input").value).toBe("");
    expect((globalThis as any).localStorage.getItem("agend_tasks_query")).toBeNull();
    expect(rows().length).toBe(4);
    await mount({ agend_tasks_project: "1", agend_tasks_query: "badge" });   // what was searched comes back
    expect(rows()).toEqual(["M-3"]);
  });

  it("a phone's search is behind the 🔍 in the row: it opens the field and puts the cursor in it, stays open while the field has words, and Esc on an empty field closes it", async () => {
    await mount();
    const find = () => q(".tb-find"), button = () => q(".tb-search-toggle");
    expect(button().getAttribute("aria-controls"), "it names the field it opens").toBe(q(".tb-find input").id);
    expect(find().className, "closed to begin with (the page's CSS draws it closed on a phone only; a desk always shows it)").toContain("is-closed");
    expect(button().getAttribute("aria-expanded")).toBe("false");
    fire(button(), "click"); await settle(6);
    expect(find().className).not.toContain("is-closed");
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(doc().activeElement, "the cursor is in the field").toBe(q(".tb-find input"));
    fire(button(), "click"); await settle(6);
    expect(find().className, "the 🔍 again, with nothing typed, shuts it").toContain("is-closed");
    fire(button(), "click"); await settle(6);
    await typeInto(q(".tb-find input"), "shop");
    expect(button().className, "a search with words marks the 🔍").toContain("active");
    fire(button(), "click"); await settle(6);
    expect(find().className, "with words in it the field stays open").not.toContain("is-closed");
    expect(doc().activeElement).toBe(q(".tb-find input"));
    await typeInto(q(".tb-find input"), "");
    expect(find().className, "emptied by hand: still open").not.toContain("is-closed");
    expect(button().className).not.toContain("active");
    fire(q(".tb-find input"), "keydown", { key: "Escape", cancelable: true }); await settle(6);
    expect(find().className, "Esc on an empty field closes it").toContain("is-closed");
    expect(button().getAttribute("aria-expanded")).toBe("false");
  });

  it("a search kept on the device opens the field with the board (and marks the 🔍), so the narrowed board is never a mystery", async () => {
    await mount({ agend_tasks_project: "1", agend_tasks_query: "badge" });
    expect(q(".tb-find").className).not.toContain("is-closed");
    expect(q(".tb-find input").value).toBe("badge");
    expect(q(".tb-search-toggle").className).toContain("active");
  });

  it("a main task stays when one of its sub tasks matches the search", async () => {
    await mount({ agend_tasks_project: "1", agend_tasks_query: "checkout" });
    expect(tiles()).toEqual(["M-2"]);
  });

  it("Filter has Needs you: it keeps the cards waiting for the person, and the chip says so", async () => {
    await mount();
    fire(q(".tb-filter-menu > button"), "click"); await settle(4);
    const item = qa(".tb-filter-menu .menu-list [role=menuitemcheckbox]").find((b) => text(b) === "Waiting for me");
    expect(item, "Needs you → Waiting for me").toBeTruthy();
    fire(item, "click"); await settle(6);
    expect(tiles()).toEqual(["M-3"]);
    expect(text(q(".tb-chip"))).toContain("Needs you");
    expect(search().get("tf")).toBe("waits:you");
    expect((globalThis as any).localStorage.getItem("agend_tasks_filters")).toBe("waits:you");
  });

  it("the list shows every row's priority and sorts by its header: priority, then turned round; the choice is kept", async () => {
    await mount({ agend_tasks_project: "1", agend_tasks_display: JSON.stringify({ view: "list", group: "none" }) });
    expect(qa(".tb-row").every((r) => r.querySelector(".tb-row-prio"))).toBe(true);
    expect(qa(".tb-row").map((r) => [r.getAttribute("data-row"), text(r.querySelector(".tb-row-prio"))])).toEqual([["M-1", "High"], ["M-2", "Low"], ["M-3", "Urgent"], ["M-4", "Normal"]]);
    expect(qa(".tb-lh").map((b) => text(b))).toEqual(["ID", "Title", "Priority", "Assignee", "Updated"]);
    fire(q(".tb-lh-prio"), "click"); await settle(6);
    expect(rows()).toEqual(["M-3", "M-1", "M-4", "M-2"]);
    expect(q(".tb-lh-prio").getAttribute("aria-pressed")).toBe("true");
    fire(q(".tb-lh-prio"), "click"); await settle(6);
    expect(rows()).toEqual(["M-2", "M-4", "M-1", "M-3"]);
    expect(JSON.parse((globalThis as any).localStorage.getItem("agend_tasks_display"))).toMatchObject({ order: "priority", dir: "desc" });
    fire(q(".tb-lh-who"), "click"); await settle(6);
    expect(rows()).toEqual(["M-1", "M-3", "M-4", "M-2"]);          // by assignee: alpha's three, beta's
  });

  it("a group folds away at its heading and opens again; which groups are folded is kept on the device", async () => {
    await mount({ agend_tasks_project: "1", agend_tasks_display: JSON.stringify({ view: "list" }) });
    const toggleOf = (label: string) => qa(".tb-group-toggle").find((b) => (text(b) ?? "").startsWith(label));
    expect(rows().length).toBe(4);
    fire(toggleOf("In progress"), "click"); await settle(4);
    expect(rows()).toEqual(["M-2", "M-3", "M-4"]);
    expect(toggleOf("In progress").getAttribute("aria-expanded")).toBe("false");
    expect(JSON.parse((globalThis as any).localStorage.getItem("agend_tasks_collapsed"))).toEqual(["1/status:claimed"]);
    await mount({ agend_tasks_project: "1" });                     // opened again: still folded
    expect(rows()).toEqual(["M-2", "M-3", "M-4"]);
    fire(toggleOf("In progress"), "click"); await settle(4);
    expect(rows().length).toBe(4);
    expect(JSON.parse((globalThis as any).localStorage.getItem("agend_tasks_collapsed"))).toEqual([]);
  });

  it("what is folded is per project: folding a status in one project leaves the same status open in another", async () => {
    const P2 = { ...PROJECT, id: 2, name: "Billing", sort: 2 };
    const B1 = card({ id: "M-21", projectId: 2, title: "Reconcile invoices", status: "claimed", assignee: "alpha", sort: 1 });
    const board = { rev: 1, projects: [PROJECT, P2], cards: [...CARDS, B1], boardOff: [] };
    const base = handler;
    handler = (path, method, body) => (path.startsWith("/ui/tasks/board") ? board : base(path, method, body));
    await mount({ agend_tasks_project: "1", agend_tasks_display: JSON.stringify({ view: "list" }) });
    const toggleOf = (label: string) => qa(".tb-group-toggle").find((b) => (text(b) ?? "").startsWith(label));
    fire(toggleOf("In progress"), "click"); await settle(4);
    expect(rows()).toEqual(["M-2", "M-3", "M-4"]);
    (globalThis as any).history.replaceState(null, "", "/ui/fleet");
    await mount({ agend_tasks_project: "2", agend_tasks_display: JSON.stringify({ view: "list" }) });
    expect(rows(), "Billing's In progress is open").toEqual(["M-21"]);
    fire(toggleOf("In progress"), "click"); await settle(4);
    expect(rows()).toEqual([]);
    expect(JSON.parse((globalThis as any).localStorage.getItem("agend_tasks_collapsed")).sort()).toEqual(["1/status:claimed", "2/status:claimed"]);
    (globalThis as any).history.replaceState(null, "", "/ui/fleet");
    await mount({ agend_tasks_project: "1", agend_tasks_display: JSON.stringify({ view: "list" }) });
    expect(rows(), "back in the first project: still its own folding").toEqual(["M-2", "M-3", "M-4"]);
    fire(toggleOf("In progress"), "click"); await settle(4);                   // open it again here; the other stays folded
    expect(JSON.parse((globalThis as any).localStorage.getItem("agend_tasks_collapsed"))).toEqual(["2/status:claimed"]);
  });

  it("a main task's sub tasks open up in the list", async () => {
    await mount({ agend_tasks_project: "1", agend_tasks_display: JSON.stringify({ view: "list" }) });
    fire(q('[data-row="M-2"] .tb-row-progress'), "click"); await settle(6);
    expect(qa('[data-row="M-2"] .tb-subs li').map((li) => text(li.querySelector(".tb-code")))).toEqual(["S-1", "S-2"]);
  });
});

describe("a phone: one status at a time, and a ⋯ on every card", () => {
  it("the board has a switch of statuses with their counts; the one with the person's cards is first shown; a choice shows that column", async () => {
    await mount();
    const seg = q(".tb-status-seg");
    expect(qa(".tb-status-seg button").map((b) => text(b))).toEqual(["To do 1", "In progress 1", "Blocked 0", "To confirm 1", "Done 1"]);
    expect(qa(".tb-col.is-current").map((c) => c.getAttribute("aria-label")), "the status waiting for the person first").toEqual(["To confirm"]);
    expect(seg.getAttribute("aria-label")).toBe("Show one status");
    fire(qa(".tb-status-seg button")[1], "click"); await settle(4);
    expect(qa(".tb-col.is-current").map((c) => c.getAttribute("aria-label"))).toEqual(["In progress"]);
    expect(qa(".tb-status-seg button")[1].getAttribute("aria-pressed")).toBe("true");
  });
  it("a status without cards is marked (a phone draws it quieter) and can still be picked", async () => {
    await mount();
    expect(qa(".tb-status-seg button").map((b) => [text(b), b.className.split(" ").includes("is-empty")])).toEqual(
      [["To do 1", false], ["In progress 1", false], ["Blocked 0", true], ["To confirm 1", false], ["Done 1", false]]);
    fire(qa(".tb-status-seg button")[2], "click"); await settle(4);
    expect(qa(".tb-col.is-current").map((c) => c.getAttribute("aria-label")), "the empty status is shown, with nothing in it").toEqual(["Blocked"]);
    expect(qa(".tb-status-seg button")[2].getAttribute("aria-pressed")).toBe("true");
    expect(qa(".tb-col.is-current .tb-tile").length).toBe(0);
  });
  it("every tile and row has a ⋯ that opens the card's menu (Move to …), so a phone needs no drag or right click", async () => {
    await mount();
    fire(q('[data-tile="M-2"] .tb-tile-more'), "click"); await settle(6);
    expect(q(".tb-card-menu").getAttribute("aria-label")).toBe("M-2: actions");
    expect(qa(".tb-card-menu .menu-heading").map((el) => el.textContent)).toContain("Move to");
    fire(q(".tb-card-menu"), "keydown", { key: "Escape" }); await settle(4);
    expect(q(".tb-card-menu")).toBeNull();
    expect(doc().activeElement.className, "the focus goes back to the button").toContain("tb-tile-more");
    fire(qa(".tb-view-toggle button")[1], "click"); await settle(6);
    fire(q('[data-row="M-1"] .tb-more'), "click"); await settle(6);
    expect(q(".tb-card-menu").getAttribute("aria-label")).toBe("M-1: actions");
    // …and a move from it is the card's own: a write with the version the card has.
    fire(qa(".tb-card-menu button").find((b) => b.textContent === "To do"), "click"); await settle(10);
    expect(posts().map((c) => [c.path, c.body])).toEqual([["/ui/tasks/cards/M-1/move", { to: "open", version: 4 }]]);
  });
});

describe("a new main task needs only a title", () => {
  const open = async () => { fire(q(".tb-bar-head .btn-primary"), "click"); await settle(8); };
  it("the title, three chips (project, assignee, priority) and the rest folded away", async () => {
    await mount();
    await open();
    const d = q("dialog");
    expect(d.querySelector(".tb-qc-title")).toBeTruthy();
    expect(qa(".tb-qc-chip").map((c) => text(c.querySelector("span")))).toEqual(["Project", "Assignee", "Priority"]);
    expect(d.querySelector(".tb-qc-more").tagName).toBe("DETAILS");
    expect(qa(".tb-qc-more .field").length).toBeGreaterThan(3);
    expect(d.querySelector(".btn-primary").disabled, "no title, no Create").toBe(true);
  });
  it("Enter in the title creates it with the project it was opened in and nothing else asked; the new card's page opens", async () => {
    await mount();
    await open();
    await typeInto(q(".tb-qc-title"), "Rank ties by earliest score");
    fire(q(".tb-qc-title"), "keydown", { key: "Enter", cancelable: true });   // not a key the form needs: the form's own submit
    fire(q(".tb-qc"), "submit", { cancelable: true }); await settle(12);
    expect(posts().map((c) => [c.path, c.body])).toEqual([["/ui/tasks/cards", { kind: "main", project: 1, title: "Rank ties by earliest score", goal: "", scope: "", acceptance: [], context: "", size: null, priority: "normal", assignee: null, needsReview: true }]]);
    expect(q(".tp").getAttribute("data-card")).toBe("M-9");
    expect(q("dialog")).toBeNull();
  });
  it("the chips set the project, assignee and priority; Ctrl+Enter creates", async () => {
    await mount();
    await open();
    await typeInto(q(".tb-qc-title"), "Add anti-cheat");
    const [project, assignee, priority] = qa(".tb-qc-chip select");
    assignee.value = "beta"; fire(assignee, "change");
    priority.value = "urgent"; fire(priority, "change");
    project.value = ""; fire(project, "change"); await settle(2);
    fire(q(".tb-qc"), "keydown", { key: "Enter", ctrlKey: true, cancelable: true }); await settle(12);
    expect(posts()[0]!.body).toMatchObject({ title: "Add anti-cheat", project: null, assignee: "beta", priority: "urgent" });
  });
  it("without a title nothing is sent, and it says so", async () => {
    await mount();
    await open();
    fire(q(".tb-qc"), "submit", { cancelable: true }); await settle(6);
    expect(posts()).toEqual([]);
  });
});

// ── An older board and an older device ────────────────────────────────────────────

describe("what an existing user's board holds still opens, and their stored choices still read", () => {
  // Every shape the board has made: each status, a card outside any project, dependencies met and unmet, a dispatcher that
  // was deleted, an agent's card waiting for an agent, a cancelled card, a card with nothing filled in, a very old one.
  const OLD = [
    card({ id: "M-1", title: "Open, nothing filled in", status: "open" }),
    card({ id: "M-2", title: "Claimed with sub tasks", status: "claimed", assignee: "alpha", progress: { total: 2, open: 0, claimed: 1, blocked: 0, review: 0, done: 1 } }),
    card({ id: "S-1", kind: "sub", parentId: "M-2", title: "Done sub task", status: "done", assignee: "alpha", doneAt: ago(2), sort: 1 }),
    card({ id: "S-2", kind: "sub", parentId: "M-2", title: "Waits for S-1's friend", status: "claimed", assignee: "alpha", dependsOn: ["S-1", "M-9"], unmetDeps: ["M-9"], sort: 2 }),
    card({ id: "M-3", title: "Blocked", status: "blocked", assignee: "beta", blockedReason: "Which?", waitsForPerson: true }),
    card({ id: "M-4", title: "In review for an agent", status: "review", assignee: "alpha", dispatcher: { kind: "instance", name: "beta" }, confirmer: "beta", result: "ok" }),
    card({ id: "M-5", title: "Done", status: "done", assignee: "alpha", doneAt: ago(1) }),
    card({ id: "M-6", title: "Cancelled", status: "cancelled", assignee: "beta" }),
    card({ id: "M-7", title: "No project, dispatcher gone", status: "open", projectId: null, dispatcher: null, assignee: null }),
    card({ id: "M-8", title: "Long ".repeat(18), status: "open", goal: "g".repeat(300), context: "c".repeat(1000), acceptance: Array.from({ length: 10 }, (_, i) => ({ text: `Item ${i}`, done: i % 2 === 0 })), size: "L" }),
  ];
  it("every card of it opens as a page without an error, each in its own status", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    handler = (path, method) => {
      if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: OLD };
      const m = /^\/ui\/tasks\/cards\/([^/]+)$/.exec(path);
      if (m && method === "GET") {
        const c: any = OLD.find((x: any) => x.id === decodeURIComponent(m[1]!));
        return { card: c, parent: c.parentId ? { id: c.parentId, title: "Claimed with sub tasks", status: "claimed" } : null, children: c.id === "M-2" ? OLD.filter((x: any) => x.parentId === "M-2") : [], comments: [], logs: [], history: [] };
      }
      return {};
    };
    for (const c of OLD as any[]) {
      (globalThis as any).history.replaceState(null, "", `/ui/fleet?card=${c.id}`);
      await mount({ agend_tasks_project: "1" });
      expect(q(".tp-grid"), c.id).toBeTruthy();
      expect(text(q(".tc-head")), c.id).toBe(c.title.trim());
      expect(q(".tp-props").textContent.length, c.id).toBeGreaterThan(20);
    }
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
    // A cancelled card is reopened by its button; its status is no chip.
    (globalThis as any).history.replaceState(null, "", "/ui/fleet?card=M-6");
    await mount();
    expect(rowOf("Status").querySelector("button.tp-chip")).toBeNull();
    expect(qa(".tc-actions .btn").map((b) => text(b))).toEqual(["Reopen"]);
  });
  it("the board, the list and the cards outside a project show them all; an older device's stored choices and an older address still read", async () => {
    handler = (path) => (path.startsWith("/ui/tasks/board") ? { rev: 1, projects: [PROJECT], cards: OLD } : {});
    (globalThis as any).history.replaceState(null, "", "/ui/fleet?tp=1&tf=status%3Aopen%3Bpriority!%3Alow");
    await mount({ agend_tasks_project: "1", agend_tasks_display: JSON.stringify({ view: "list", group: "assignee", order: "updated", done: "all", subs: true }), agend_tasks_assignee: "alpha" });
    expect(q(".tb-list")).toBeTruthy();
    expect(qa(".tb-chip").length, "the address's filters, as before").toBe(2);
    (globalThis as any).history.replaceState(null, "", "/ui/fleet");
    (globalThis as any).localStorage.removeItem("agend_tasks_assignee");
    await mount({ agend_tasks_project: "none", agend_tasks_display: JSON.stringify({ view: "board" }) });
    expect(qa(".tb-tile").map((t) => t.getAttribute("data-tile"))).toEqual(["M-7"]);
  });
});

// ── Who may change the board: the Tasks tab itself decides, for every control the page draws ────────────────

describe("who may change the board — through the real Tasks tab", () => {
  // `body` flags the host sets: a guest (`tier`), a session over the public link (`publicLink`), and an admin's among them (`linkMedia`).
  const WHO: Array<[string, Record<string, string>, boolean]> = [
    ["a guest", { tier: "guest" }, false],
    ["a read-only session over the public link", { publicLink: "1" }, false],
    ["a guest over the public link", { publicLink: "1", tier: "guest" }, false],
    ["an admin session over the public link (M-3278)", { publicLink: "1", linkMedia: "1" }, true],
    ["the dashboard itself", {}, true],
  ];
  const setWho = (flags: Record<string, string>) => {
    for (const k of ["publicLink", "linkMedia", "tier"]) delete doc().body.dataset[k];
    Object.assign(doc().body.dataset, flags);
  };
  afterEach(() => setWho({}));

  for (const [who, flags, writes] of WHO) {
    it(`${who}: ${writes ? "every control that changes the board is drawn" : "the board, the list and the card are for reading — nothing that edits, creates or moves is drawn"}`, async () => {
      setWho(flags);
      // A card with a watcher and a leader, and an instance with the task board off: the rows and the note a writer gets.
      boardOff = ["gamma"];
      const base = handler;
      handler = (path, method, body) => (method === "GET" && path === "/ui/tasks/cards/M-1"
        ? detailOf("M-1", { watchers: ["beta"], inheritedWatchers: [], leader: { name: "alpha", via: "project" }, followsProgress: true }) : base(path, method, body));
      // Home: the projects, and what waits for the person.
      await mount({});
      expect(!!q(".tb-home"), "the tab opens on its projects").toBe(true);
      expect(!!q(".tb-readonly:not(.tb-boardoff)"), "the read-only note").toBe(!writes);
      expect(!!q(".list-head .btn-primary"), "New project").toBe(writes);
      // A project's board.
      await mount();
      expect(!!q(".tb-board-page")).toBe(true);
      expect(!!q(".tb-readonly:not(.tb-boardoff)"), "the read-only note on the board").toBe(!writes);
      expect(!!q(".tb-bar-head .btn-primary"), "the Main task button").toBe(writes);
      expect(!!q(".tb-boardoff"), "the note that names an instance with the task board off and where to turn it on").toBe(writes);
      expect(qa(".tb-tile").map((el) => el.getAttribute("draggable")), "a tile is dragged only by a writer").toEqual(qa(".tb-tile").map(() => (writes ? "true" : "false")));
      expect(qa(".tb-tile .tb-owner-btn:not(.is-static)").length > 0, "the avatar picks another assignee").toBe(writes);
      // The list.
      fire(qa(".tb-view-toggle button").find((b) => text(b) === "List"), "click"); await settle(6);
      expect(qa(".tb-row").length).toBeGreaterThan(0);
      expect(qa(".tb-row .tb-owner-btn:not(.is-static)").length > 0, "the list's avatar").toBe(writes);
      // A card's page.
      await openCard("M-1");
      expect(!!q(".tp"), "the card opens as a page").toBe(true);
      const titleEl = q(".tp .tp-head .tc-title, .tp .tc-title");
      expect(titleEl.tagName, "the title is text, or a field to edit").toBe(writes ? "BUTTON" : "H2");
      expect(qa(".tp-side button.tp-chip").length > 0, "properties are chips that open menus").toBe(writes);
      expect(qa(".tp-side .tp-static").length > 0, "…or values as text").toBe(!writes);
      expect(!!q(".tp-switch input"), "the Needs my confirmation switch").toBe(writes);
      expect(!!q(".tc-composer"), "the comment box").toBe(writes);
      expect([!!q('[data-follow="watchers"]'), !!q('[data-follow="leader"]')], "the Watchers and Leader rows are read by every reader").toEqual([true, true]);
      expect(qa(".tp-watch").map((el) => el.getAttribute("data-watcher")), "the watcher is listed").toEqual(["beta"]);
      expect(!!q(".tp-watch-x"), "a watcher's ✕").toBe(writes);
      expect(!!q(".tp-watch-add"), "Add a watcher").toBe(writes);
      expect(!!q(".tc-mentions"), "no @ list without a comment box").toBe(false);
      expect(!!q(".tp-body .tc-quick-add"), "adding a sub task").toBe(writes);
      expect(qa(".tp-add").length > 0, "the + Add buttons of the empty fields").toBe(writes);
      // (a text that is there is read as Markdown — a box that opens on a click too — an empty one is the button.)
      expect(qa(".tp-body .tc-field .tc-text").filter((el) => el.tagName === "BUTTON" || String(el.parentNode?.className).includes("tc-md-wrap")).length > 0, "a text opens as a box on a click").toBe(writes);
      expect(qa(".tp-body .tb-check input").every((el) => el.disabled === !writes) && qa(".tp-body .tb-check input").length > 0, "ticks").toBe(true);
      expect(!!q(".tp-body .tc-editlist"), "Edit the list").toBe(writes);
      expect(qa(".tp .tc-actions button, .tp .tp-bar .tp-more, .tp .tp-bar .menu-trigger").length > 0, "Mark blocked, the ⋯ menu and the card's actions").toBe(writes);
      expect(qa(".tp-row .tc-dep + .btn, .tp-row .btn").filter((b) => text(b) === "Edit").length > 0, "Edit the dependencies").toBe(writes);
      // Whatever it is, nothing was written by looking.
      expect(posts()).toEqual([]);
    });
  }
});

// ── Columns that do not fit: a way to reach them that can be seen ──────────────────────────────────────────

describe("the columns that do not fit the window", () => {
  // The test DOM has no layout: the scroll box is given the measures a browser would read, then told it scrolled.
  const measure = async (box: any, m: { scrollWidth: number; clientWidth: number; scrollLeft: number }) => { Object.assign(box, m); fire(box, "scroll"); await settle(3); };
  const buttons = () => qa(".tb-scroll-nav .tb-scroll-btn");
  const state = () => buttons().map((b) => b.getAttribute("aria-disabled"));

  it("scrollReach: columns that fit reach nowhere; past their box they reach to the right, then both ways, then only to the left", () => {
    expect(view.scrollReach({ scrollWidth: 1000, clientWidth: 1000, scrollLeft: 0 })).toEqual({ over: false, left: false, right: false });
    expect(view.scrollReach({ scrollWidth: 1001, clientWidth: 1000, scrollLeft: 0 }), "a pixel of rounding is not an overflow").toEqual({ over: false, left: false, right: false });
    expect(view.scrollReach({ scrollWidth: 1900, clientWidth: 1000, scrollLeft: 0 })).toEqual({ over: true, left: false, right: true });
    expect(view.scrollReach({ scrollWidth: 1900, clientWidth: 1000, scrollLeft: 400 })).toEqual({ over: true, left: true, right: true });
    expect(view.scrollReach({ scrollWidth: 1900, clientWidth: 1000, scrollLeft: 900 })).toEqual({ over: true, left: true, right: false });
  });
  it("while columns are out of sight the toolbar has ‹ › buttons; a click scrolls by most of a screen; a button with nothing to reach is dimmed and keeps the focus", async () => {
    await mount();
    const box = q(".tb-scroll");
    expect(q(".tb-scroll-nav"), "nothing out of sight: no buttons").toBeNull();
    await measure(box, { scrollWidth: 1900, clientWidth: 1000, scrollLeft: 0 });
    expect(q(".tb-view-bar .tb-scroll-nav"), "in the toolbar").toBeTruthy();
    expect(q(".tb-scroll-nav").getAttribute("role")).toBe("group");
    expect(buttons().map((b) => b.tagName), "real buttons: reachable and pressable by keyboard").toEqual(["BUTTON", "BUTTON"]);
    expect(buttons().map((b) => b.getAttribute("aria-label"))).toEqual(["Columns to the left", "Columns to the right"]);
    expect(state(), "at the start there is nothing to the left").toEqual(["true", "false"]);
    fire(buttons()[0], "click"); await settle(2);
    expect(box.scrollLeft, "a dimmed button does nothing").toBe(0);
    fire(buttons()[1], "click"); await settle(2);
    expect(box.scrollLeft, "80% of the box").toBe(800);
    await measure(box, { scrollWidth: 1900, clientWidth: 1000, scrollLeft: 800 });
    expect(state()).toEqual(["false", "false"]);
    await measure(box, { scrollWidth: 1900, clientWidth: 1000, scrollLeft: 900 });
    expect(state(), "at the end there is nothing to the right").toEqual(["false", "true"]);
    fire(buttons()[0], "click"); await settle(2);
    expect(box.scrollLeft).toBe(100);
    await measure(box, { scrollWidth: 1000, clientWidth: 1000, scrollLeft: 0 });
    expect(q(".tb-scroll-nav"), "the window grew: they fit again, the buttons go").toBeNull();
  });
  it("the list has no columns to scroll: no buttons there, and they are back on the board", async () => {
    await mount();
    await measure(q(".tb-scroll"), { scrollWidth: 1900, clientWidth: 1000, scrollLeft: 0 });
    expect(q(".tb-scroll-nav")).toBeTruthy();
    fire(qa(".tb-view-toggle button").find((b) => text(b) === "List"), "click"); await settle(6);
    expect(q(".tb-scroll-nav"), "the list").toBeNull();
    fire(qa(".tb-view-toggle button").find((b) => text(b) === "Board"), "click"); await settle(6);
    expect(q(".tb-scroll-nav"), "nothing measured yet on the new board box").toBeNull();
    await measure(q(".tb-scroll"), { scrollWidth: 1900, clientWidth: 1000, scrollLeft: 0 });
    expect(q(".tb-scroll-nav")).toBeTruthy();
  });
  it("the words are in both languages, and the buttons are styled from the shared segmented control with no colour or style of their own", async () => {
    const css = readFileSync(join(UI, "shared", "task-board.css"), "utf8");
    const rules = css.split("\n").filter((l) => /\.tb-scroll-(nav|btn)/.test(l)).join("\n");
    expect(rules).toMatch(/\.tb-scroll-nav \{ margin-left: auto; \}/);
    expect(rules, "no colour literal").not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    const i18n = await import("/assets/app-i18n.js");
    try {
      i18n.setLang("zh-TW", { store: false });
      expect([i18n.t("taskview.scrollColumns"), i18n.t("taskview.columnsLeft"), i18n.t("taskview.columnsRight")]).toEqual(["捲動欄位", "左邊的欄位", "右邊的欄位"]);
    } finally { i18n.setLang("en", { store: false }); }
  });
  it("a project's head keeps its parts as they were, in two groups a phone lays out: the name, and the progress line (Insights and the banner stay the stats' own)", async () => {
    await mount();
    expect([...q(".tb-title").children].map((el: any) => el.className.split(" ")[0]), "the way back, then the name with its badge").toEqual(["btn", "tb-name"]);
    expect([...q(".tb-name").children].map((el: any) => el.tagName.toLowerCase())).toEqual(["h2"]);
    expect(text(q(".tb-name h2"))).toBe("Leaderboard");
    const stats = [...q(".tb-stats").children].map((el: any) => el.className.split(" ")[0]);
    expect(stats[0], "the numbers are one group").toBe("tb-progress");
    expect(stats.at(-1), "Insights is the stats' own last child (a phone puts it beside the name)").toBe("btn");
    expect(q(".tb-stats > .tb-insights")).toBeTruthy();
    expect(text(q(".tb-progress .tb-pct"))).toMatch(/%$/);
    expect(q(".tb-progress svg.tb-bar")).toBeTruthy();
    const instances = qa(".tb-head-actions .btn").find((b) => !b.className.includes("btn-primary"));
    expect(text(instances.querySelector(".tb-btn-label")), "its label is a span of its own (a narrow phone draws the icon only; a screen reader still gets the words)").toBe("Instances");
    expect(text(instances)).toBe("Instances");
  });
  it("on a desk the groups take no part (display: contents, outside any media query), and the phone's layout and 44px boxes are in the media queries meant for them", () => {
    const css = readFileSync(join(UI, "shared", "task-board.css"), "utf8");
    const depthAt = (i: number) => { let d = 0; for (let k = 0; k < i; k++) { if (css[k] === "{") d++; else if (css[k] === "}") d--; } return d; };
    const mediaOf = (needle: string) => { const at = css.indexOf(needle); expect(at, needle).toBeGreaterThan(0); const m = css.lastIndexOf("@media", at); return { depth: depthAt(at), query: css.slice(m, css.indexOf("{", m)).trim() }; };
    const PHONE = "@media (max-width: 899px), (pointer: coarse) and (max-height: 500px) and (max-width: 1023px)";
    const TOUCH = "@media (pointer: coarse), (max-width: 899px)";
    expect(mediaOf(".tb-name, .tb-progress, .tb-view-actions { display: contents; }").depth, "the wrappers: for every screen").toBe(0);
    expect(mediaOf(".tb-search-toggle { display: none; }").depth, "no 🔍 on a desk").toBe(0);
    for (const needle of [".tb-bar-head { display: grid", ".tb-home > .tb-head { display: flex", ".tb-status-seg { display: flex", ".tb-find.is-closed { display: none; }", ".tb-col { padding: 0; border-width: 0"]) {
      expect(mediaOf(needle), needle).toEqual({ depth: 1, query: PHONE });
    }
    for (const needle of [":is(.tb-head-back, .tb-bar-head .tb-head-actions .btn", ":is(.tb-search input)"]) expect(mediaOf(needle), needle).toEqual({ depth: 1, query: TOUCH });
    expect(mediaOf(".tb-btn-label { position: absolute"), "a phone under 390px keeps only the Instances icon").toEqual({ depth: 1, query: "@media (max-width: 389px)" });
    // On: Filter / Display / the 🔍 keep the border transparent and the painted background at the padding edge, with the ring inside (the desk rule's
    // accent border and its `background` shorthand would paint the whole 44px box); every grown control's corner is worked out for the painted shape
    // (a half circle is --drawn / 2 across and --tap / 2 down once the 6px border is off), and the picker's too; the focus ring is the painted edge's.
    expect(css).toMatch(/\.tb-view-bar \.tb-view-actions > \.menu > \.menu-text\.active, \.tb-view-bar \.tb-view-actions > \.tb-search-toggle\.active \{ border-color: transparent; background-clip: padding-box; box-shadow: inset 0 0 0 1px var\(--accent\); \}/);
    expect(css).toMatch(/border-radius: calc\(var\(--drawn, 36px\) \/ 2 \+ var\(--bx, 1px\)\) \/ calc\(var\(--tap\) \/ 2\);/);
    expect(css).toMatch(/\.tb-status-seg \.tb-seg-btn \{[^}]*border-radius: calc\(var\(--drawn\) \/ 2\) \/ calc\(var\(--tap\) \/ 2\);/);
    expect(css).toMatch(/:focus-visible::after \{\s*content: ""; position: absolute; inset: 0; border-radius: var\(--r-full\); outline: 2px solid var\(--focus\); outline-offset: 2px;/);
    expect(readFileSync(join(UI, "shared", "app.css"), "utf8")).toMatch(/\.tb-sort-row \.tb-sort-pick \{[^}]*border-radius: calc\(\(var\(--tap\) - 12px\) \/ 2\) \/ calc\(var\(--tap\) \/ 2\);/);
    // The waiting row on a phone: the name, then the two answers on ONE line (they shared two lines at 360px); a 320px phone gives the name its own line.
    const app = readFileSync(join(UI, "shared", "app.css"), "utf8");
    expect(app).toMatch(/\.tb-wait-actions \{ flex-basis: 100%; margin-left: 0; flex-wrap: nowrap; \}[\s\S]*\.tb-wait-actions \.btn \{ flex: 1 0 auto; padding-inline: var\(--s-2\); \}/);
    const at = app.indexOf(".tb-wait-actions { flex-basis: 100%; margin-left: 0; flex-wrap: nowrap; }");
    expect(app.slice(app.lastIndexOf("@media", at), at), "in the phone's media query").toContain("(max-width: 899px)");
    expect(app).toMatch(/@media \(max-width: 339px\) \{\s*\.tb-wait-actions \{ flex-wrap: wrap; \}\s*\.tb-wait-actions > \.muted \{ flex-basis: 100%; \}/);
    // a control is grown by a transparent border and a negative margin, never drawn bigger
    const grown = css.slice(css.indexOf(":is(.tb-head-back, .tb-bar-head .tb-head-actions .btn"), css.indexOf(":is(.tb-head-back, .tb-bar-head .tb-head-actions .btn") + 600);
    expect(grown).toMatch(/min-height: var\(--tap\); border-block: var\(--grow\) solid transparent; margin-block: calc\(-1 \* var\(--grow\)\); background-clip: padding-box;/);
  });
  it("the @ list's board-off row reads at 4.5:1 or more in every theme: its colour is --text-3 on the menu's --bg, never dimmed by an opacity (#4367 review)", () => {
    const css = readFileSync(join(UI, "shared", "task-board.css"), "utf8");
    const rule = css.split("\n").find((l) => l.startsWith(".tc-mentions button:disabled"))!;
    expect(rule).toMatch(/color: var\(--text-3\)/);
    expect(rule).not.toMatch(/opacity/);
    expect(css.split("\n").find((l) => l.startsWith(".tc-mentions {"))).toMatch(/background: var\(--bg\)/);
    const lum = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x! + 0.05) / (y! + 0.05); };
    // Every theme block of the tokens that sets both.
    const tokens = readFileSync(join(UI, "shared", "tokens.css"), "utf8");
    const blocks = tokens.split("}").map((b) => ({ bg: /--bg: (#[0-9a-fA-F]{6});/.exec(b)?.[1], text3: /--text-3: (#[0-9a-fA-F]{6});/.exec(b)?.[1] })).filter((b) => b.bg && b.text3);
    expect(blocks.length).toBeGreaterThan(4);
    for (const b of blocks) expect(ratio(b.text3!, b.bg!), `${b.text3} on ${b.bg}`).toBeGreaterThanOrEqual(4.5);
  });
});

// ── The comment box and the board read an @ the same way ─────────────────────────────

describe("whenever the comment box offers a name, the board reads the text it types as that instance", () => {
  const NAMES = ["alpha", "beta", "dev", "dev-a", "Lead", "lead-2", "a", "a b", "小金", "x.y", "docs writer"];
  const BEFORE = ["", "hi ", "(", "\n", "請", "é", "a", "a.", "x-", "_", "9", "/", "a/", "C:\\", "@", "`", "`x ", "```\n", "```\nx\n```\n", "`a` ", "a`b` ", "> ", "，"];
  const AFTER = ["", " tail", "\n", ", ok", ".", "`", "`\n", "\n```", " b", " b c", " writer", "請看", "-1", " -1"];
  it("over every prefix, instance name, part of it typed and text after the caret of a battery (the board's own parser reads each result)", async () => {
    const board = { parseMentions };
    let offered = 0;
    const wrong: string[] = [];
    for (const before of BEFORE) for (const name of NAMES) for (let k = 0; k <= name.length; k++) for (const after of AFTER) {
      const text = `${before}@${name.slice(0, k)}${after}`, caret = before.length + 1 + k;
      const m = activity.mentionAt(text, caret);
      if (!m || !activity.mentionMatches(NAMES, m.query).includes(name)) continue;
      offered++;
      const typed = activity.insertMention(text, m, caret, name, NAMES);
      const read = board.parseMentions(typed.text, NAMES).names;
      if (!read.includes(name)) wrong.push(JSON.stringify({ text, caret, typed: typed.text, read }));
    }
    expect(offered, "the battery offers the list in many places").toBeGreaterThan(2000);
    expect(wrong.slice(0, 5), `${wrong.length} of ${offered} offers type a name the board does not read as that instance`).toEqual([]);
  });
  it("and the places the board refuses are the places the box does not offer", async () => {
    const board = { parseMentions };
    for (const text of ["@@alpha", "a/@alpha", "C:\\@alpha", "me@alpha", "`@alpha`", "```\n@alpha", "```\n@alpha\n```"]) {
      expect(board.parseMentions(text, NAMES).names, `the board: ${text}`).toEqual([]);
      expect(activity.mentionAt(text, text.indexOf("@alpha") + 6), `the box: ${text}`).toBeNull();
    }
    for (const text of ["請@alpha", "é@alpha", "(@alpha)"]) {
      expect(board.parseMentions(text, NAMES).names, `the board: ${text}`).toEqual(["alpha"]);
      expect(activity.mentionAt(text, text.indexOf("@alpha") + 6), `the box: ${text}`).not.toBeNull();
    }
  });
});
