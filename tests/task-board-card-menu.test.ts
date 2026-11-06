/**
 * A card's menu on the task board and stepping between cards (after Linear, as Circle draws them):
 *  - a right click on a board tile or a waiting row (or the menu key on it) opens the card's menu there: open, confirm /
 *    send back / answer when it waits for you, move, assignee, priority, copy, cancel — through the dialog's own calls;
 *    the moves a drop allows (a main task that follows its sub tasks: confirm, send back, block, resume); over the
 *    public link only open and copy;
 *  - the card's dialog steps to the previous / next card the page showed (its arrows, K / J), "2 / 3" between them; a
 *    sub task opened from its main task steps among its siblings.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage;
let app: any, nav: any, fleet: any, menu: any;
const calls: Array<{ method: string; path: string; body: any }> = [];
let handler: (path: string, method: string) => unknown = () => ({});
const fetchFake = async (path: string, o: any = {}) => {
  const method = o.method ?? "GET";
  calls.push({ method, path, body: o.body ? JSON.parse(o.body) : null });
  const body: any = await handler(path, method);
  return { ok: true, status: 200, json: async () => body };
};

const card = (over: Record<string, unknown>) => ({ id: "M-1", uuid: String(over.id ?? "M-1"), kind: "main", projectId: 1, parentId: null, title: "A card", status: "open",
  assignee: null, dispatcher: { kind: "person", name: "Ann" }, waitsForPerson: false, confirmer: null, priority: "normal", size: null, needsReview: true, dependsOn: [], goal: "", scope: "",
  acceptance: [], context: "", state: "", blockedReason: "", result: "done", sort: 1, createdBy: "Ann", version: 4, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
  startedAt: null, submittedAt: null, doneAt: null, progress: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 }, unmetDeps: [], commentCount: 0, newCommentCount: 0, lastComment: null, ...over });
const PROJECT = { id: 1, name: "Leaderboard", description: "", archived: false, sort: 1, createdAt: "2026-11-01T00:00:00.000Z" };
const M1 = card({ id: "M-1", title: "Serve the weekly leaderboard", status: "claimed", assignee: "alpha", sort: 1 });
const M2 = card({ id: "M-2", title: "Add the shop", status: "open", assignee: "beta", sort: 2, progress: { total: 2, open: 1, claimed: 0, blocked: 0, review: 0, done: 1 } });
const S1 = card({ id: "S-1", kind: "sub", parentId: "M-2", title: "Price list", status: "done", assignee: "alpha", sort: 1 });
const S2 = card({ id: "S-2", kind: "sub", parentId: "M-2", title: "Checkout", status: "open", assignee: "beta", sort: 2 });
const M3 = card({ id: "M-3", title: "Choose the badge", status: "review", assignee: "alpha", waitsForPerson: true, sort: 3 });
const CARDS = [M1, M2, S1, S2, M3];

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  fleet = await import("/ui/js/panel-fleet.js");
  menu = await import("/ui/js/fleet-task-menu.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  for (const k of ["agend_tasks_project", "agend_tasks_display", "agend_tasks_filters"]) (globalThis as any).localStorage.removeItem(k);
  delete (globalThis as any).document.body.dataset.publicLink;
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  calls.length = 0;
  handler = (path, method) => {
    if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS };
    const m = /^\/ui\/tasks\/cards\/([^/]+)(\/move)?$/.exec(path);
    if (m && method === "POST") return { card: CARDS.find((c) => c.id === decodeURIComponent(m[1]!)), notes: [] };
    if (m) { const c = CARDS.find((x) => x.id === decodeURIComponent(m[1]!)) ?? M1; return { card: c, parent: c.parentId ? M2 : null, children: c.id === "M-2" ? [S1, S2] : [], comments: [], logs: [], history: [] }; }
    return {};
  };
  app.applyStatus({ uptime: 1, instances: ["alpha", "beta"].map((name) => ({ name, status: "running", state: "idle", execution_state: "idle" })) });
});

let mounts = 0;
async function mount(project: string | null = "1") {
  if (project !== null) (globalThis as any).localStorage.setItem("agend_tasks_project", project);
  await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|cm-${++mounts}|en` }));
  await settle(8);
}
const q = (sel: string) => p.root.querySelector(sel) ?? (globalThis as any).document.querySelector(sel);
const qa = (sel: string) => [...(globalThis as any).document.querySelectorAll(sel)] as any[];
const labels = () => qa(".tb-card-menu > *").map((el) => (el.getAttribute("role") === "presentation" ? `# ${el.textContent}` : `${el.getAttribute("aria-checked") === "true" ? "✓ " : ""}${el.textContent}`));
async function rightClick(el: any, at = { clientX: 120, clientY: 340 }) { fire(el, "contextmenu", { cancelable: true, ...at }); await settle(6); }
async function choose(label: string) {
  const item = qa(".tb-card-menu [role^=menuitem]").find((b) => b.textContent === label);
  expect(item, label).toBeTruthy();
  fire(item, "click");
  await settle(8);
}

describe("what a card's menu offers", () => {
  const ids = (list: any[]) => list.map((c) => c.id);
  it("the moves a drop allows: any other status; a main task that follows its sub tasks only confirmed, sent back, blocked or resumed", () => {
    expect(menu.movesFor(card({ status: "open" }))).toEqual(["claimed", "blocked", "review", "done"]);
    const derived = { total: 2, open: 0, claimed: 0, blocked: 0, review: 0, done: 2 };
    expect(menu.movesFor(card({ status: "review", progress: derived }))).toEqual(["claimed", "blocked", "done"]);
    expect(menu.movesFor(card({ status: "claimed", progress: derived }))).toEqual(["blocked"]);
    expect(menu.movesFor(card({ status: "blocked", progress: derived }))).toEqual(["claimed"]);
    expect(menu.movesFor(card({ status: "cancelled" }))).toEqual([]);
    expect(ids([])).toEqual([]);
  });
  it("a card waiting for you: confirm and send back first; an agent's card in review: no confirm of yours", () => {
    const act = () => {};
    const keys = (c: any, writable = true) => menu.cardMenuItems(c, { writable, names: ["alpha", "beta"], act }).filter((i: any) => !i.heading).map((i: any) => i.key);
    expect(keys(M3).slice(0, 3)).toEqual(["open", "confirm", "sendBack"]);
    expect(keys({ ...M3, waitsForPerson: false })).not.toContain("confirm");
    expect(keys(card({ status: "blocked", waitsForPerson: true }))).toContain("answer");
    expect(keys(card({ status: "blocked" })).filter((k: string) => k.startsWith("assign")), "the names given, nobody, Other…").toEqual(["assign-alpha", "assign-beta", "assign-", "assign-other"]);
    expect(keys(card({ status: "done" })), "a finished card: no assignee, no cancel").toEqual(["open", "move-open", "move-claimed", "move-blocked", "move-review", "priority-urgent", "priority-high", "priority-normal", "priority-low", "copyLink", "copyId"]);
    expect(keys(M3, false), "over the public link: open and copy").toEqual(["open", "copyLink", "copyId"]);
    const assign = menu.cardMenuItems(card({ assignee: "gamma" }), { writable: true, names: ["beta", "alpha"], act }).filter((i: any) => i.key.startsWith("assign-"));
    expect(assign.map((i: any) => [i.label, i.checked])).toEqual([["alpha", false], ["beta", false], ["gamma", true], ["Unassigned", false], ["Other…", undefined]]);
  });
  it("stepping: the page's order, its ends; a sub task off the page among its siblings; nowhere to step", () => {
    expect(menu.stepsOf(["M-2", "M-1", "M-3"], "M-1", CARDS)).toEqual({ at: 2, total: 3, prev: "M-2", next: "M-3" });
    expect(menu.stepsOf(["M-2", "M-1", "M-3"], "M-2", CARDS)).toEqual({ at: 1, total: 3, prev: null, next: "M-1" });
    expect(menu.stepsOf(["M-2", "M-1", "M-3"], "S-2", CARDS)).toEqual({ at: 2, total: 2, prev: "S-1", next: null });
    expect(menu.stepsOf(["M-1"], "M-1", CARDS)).toBeNull();
    expect(menu.stepsOf(["M-1", "M-2"], "M-9", CARDS)).toBeNull();
  });
});

describe("the menu's words", () => {
  // Its namespace, run as dashboard-i18n.test.ts runs the others: the module's register() into app-i18n's dictionary.
  const UI = join(process.cwd(), "src", "ui");
  const strip = (src: string) => src.replace(/^import .*$/gm, "").replace(/^export /gm, "");
  const ctx = vm.createContext({ navigator: { language: "en" } });
  vm.runInContext(strip(readFileSync(join(UI, "shared", "app-i18n.js"), "utf8")), ctx);
  vm.runInContext(`(${/register\("taskmenu", (\{[\s\S]*?\n\})\);/.exec(readFileSync(join(UI, "fleet-task-menu.js"), "utf8"))![0].replace(/;$/, "")})`, ctx);
  const tables = vm.runInContext("tables", ctx) as Record<"en" | "zh-TW", Record<string, string>>;
  const keys = (lang: "en" | "zh-TW") => Object.keys(tables[lang]).filter((k) => k.startsWith("taskmenu."));
  it("every key in both languages, with the same {n}; every t(\"taskmenu.…\") names one", () => {
    expect(keys("en").sort()).toEqual(keys("zh-TW").sort());
    for (const k of keys("en")) expect((tables["zh-TW"][k]!.match(/\{\d\}/g) ?? []).join(), k).toBe((tables.en[k]!.match(/\{\d\}/g) ?? []).join());
    for (const file of ["fleet-task-menu.js", "fleet-tasks.js", "fleet-task-card.js"]) {
      for (const m of readFileSync(join(UI, file), "utf8").matchAll(/\bt\(\s*"(taskmenu\.[\w.]+)"/g)) expect(tables.en[m[1]!], `${file}: ${m[1]}`).toBeDefined();
    }
  });
});

describe("a right click on a card", () => {
  it("on a tile: its menu at the pointer — open, the moves, assignee, priority, copy, cancel", async () => {
    await mount();
    await rightClick(q('[data-tile="M-1"]'));
    const list = q(".tb-card-menu");
    expect(list.getAttribute("role")).toBe("menu");
    expect(list.getAttribute("aria-label")).toBe("M-1: actions");
    expect([list.style.left, list.style.top]).toEqual(["120px", "340px"]);
    expect(labels()).toEqual(["Open", "# Move to", "To do", "Blocked", "To confirm", "Done", "# Assignee", "✓ alpha", "beta", "Unassigned", "Other…",
      "# Priority", "Urgent", "High", "✓ Normal", "Low", "# ", "Copy link", "Copy card number", "Cancel this card…"]);
    expect((globalThis as any).document.activeElement.textContent, "the first item has the focus").toBe("Open");
  });

  it("a priority and an assignee: the card's update, with the version shown", async () => {
    await mount();
    await rightClick(q('[data-tile="M-1"]'));
    await choose("Urgent");
    expect(q(".tb-card-menu")).toBeNull();
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/ui/tasks/cards/M-1", body: { priority: "urgent", version: 4 } }]);
    await rightClick(q('[data-tile="M-1"]'));
    await choose("Unassigned");
    expect(calls.filter((c) => c.method === "POST").at(-1)).toEqual({ method: "POST", path: "/ui/tasks/cards/M-1", body: { assignee: null, version: 4 } });
    // Other…: any instance by name, asked as the dialog asks.
    await rightClick(q('[data-tile="M-1"]'));
    await choose("Other…");
    const ask = qa("dialog[open]").at(-1);
    ask.querySelector("textarea").value = "gamma";
    fire(ask.querySelector("textarea"), "input"); await settle(4);
    fire([...ask.querySelectorAll("button")].find((b: any) => b.textContent === "Save"), "click"); await settle(8);
    expect(calls.filter((c) => c.method === "POST").at(-1)).toEqual({ method: "POST", path: "/ui/tasks/cards/M-1", body: { assignee: "gamma", version: 4 } });
  });

  it("a move: through the dialog's moveCard (blocking asks why first)", async () => {
    await mount();
    await rightClick(q('[data-tile="M-1"]'));
    await choose("Blocked");
    const ask = qa("dialog[open]").at(-1);
    expect(ask.textContent).toContain("Blocked on: who has to answer what?");
    ask.querySelector("textarea").value = "Which scores count?";
    fire(ask.querySelector("textarea"), "input");
    await settle(4);
    fire([...ask.querySelectorAll("button")].find((b: any) => b.textContent === "Mark blocked"), "click");
    await settle(8);
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/ui/tasks/cards/M-1/move", body: { to: "blocked", reason: "Which scores count?", version: 4 } }]);
  });

  it("on a waiting row at Home: Confirm is there, and confirms", async () => {
    await mount(null);
    await rightClick(q('.tb-wait-row[data-wait="M-3"]'));
    expect(labels().slice(0, 3)).toEqual(["Open", "Confirm", "Send back"]);
    await choose("Confirm");
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ method: "POST", path: "/ui/tasks/cards/M-3/move", body: { to: "done", version: 4 } }]);
  });

  it("the menu key (no pointer): under the card; Esc closes it and gives the focus back to the card", async () => {
    await mount();
    await rightClick(q('[data-tile="M-2"] .tb-tile-title'), { clientX: 0, clientY: 0 });
    expect(q(".tb-card-menu").getAttribute("aria-label")).toBe("M-2: actions");
    expect(labels()).not.toContain("To do");                      // it follows its sub tasks: no free moves
    fire(q(".tb-card-menu"), "keydown", { key: "Escape" });
    await settle(4);
    expect(q(".tb-card-menu")).toBeNull();
    expect((globalThis as any).document.activeElement.className).toBe("tb-tile-title");
  });

  it("anywhere else: the browser's own menu; over the public link only open and copy", async () => {
    await mount();
    const e = fire(q(".tb-bar-head"), "contextmenu", { cancelable: true });
    expect(e.defaultPrevented).toBe(false);
    expect(q(".tb-card-menu")).toBeNull();
    const shift = fire(q('[data-tile="M-1"]'), "contextmenu", { cancelable: true, shiftKey: true });
    await settle(4);
    expect([shift.defaultPrevented, q(".tb-card-menu")], "Shift: the browser's, as on a chat message").toEqual([false, null]);
    (globalThis as any).document.body.dataset.publicLink = "1";
    await mount();
    await rightClick(q('[data-tile="M-1"]'));
    expect(labels()).toEqual(["Open", "# ", "Copy link", "Copy card number"]);
  });
});

describe("Previous / Next in a card's dialog", () => {
  const step = () => q("dialog[open] .tc-steps");
  it("the board's cards in the order shown; the arrows and K / J step, not while typing", async () => {
    await mount();
    fire(q('[data-tile="M-1"] .tb-tile-title'), "click");
    await settle(10);
    expect(step().querySelector(".tc-step-at").textContent).toBe("2 / 3");   // To do: M-2, In progress: M-1, To confirm: M-3
    const [prev, next] = step().querySelectorAll("button");
    expect([prev.getAttribute("aria-label"), next.getAttribute("aria-label")]).toEqual(["Previous card (K)", "Next card (J)"]);
    fire(next, "click"); await settle(10);
    expect(new URLSearchParams((globalThis as any).location.search).get("card")).toBe("M-3");
    expect(step().querySelector(".tc-step-at").textContent).toBe("3 / 3");
    expect(step().querySelectorAll("button")[1].disabled).toBe(true);
    fire((globalThis as any).document.body, "keydown", { key: "k" }); await settle(10);
    fire((globalThis as any).document.body, "keydown", { key: "k" }); await settle(10);
    expect(new URLSearchParams((globalThis as any).location.search).get("card")).toBe("M-2");
    const field = (globalThis as any).document.createElement("textarea");
    (globalThis as any).document.body.appendChild(field);
    fire(field, "keydown", { key: "j" }); await settle(10);
    expect(new URLSearchParams((globalThis as any).location.search).get("card"), "typing a j is typing").toBe("M-2");
    field.remove();
  });

  it("the project as a list: a row's menu, and the steps in the list's order", async () => {
    (globalThis as any).localStorage.setItem("agend_tasks_display", JSON.stringify({ view: "list", group: "none", order: "title" }));
    await mount();
    await rightClick(q('[data-row="M-2"]'));
    expect(q(".tb-card-menu").getAttribute("aria-label")).toBe("M-2: actions");
    fire(q(".tb-card-menu"), "keydown", { key: "Escape" }); await settle(4);
    fire(q('[data-row="M-1"] .tb-row-title'), "click"); await settle(10);
    // By title: Add the shop (M-2), Choose the badge (M-3), Serve the weekly leaderboard (M-1).
    expect(step().querySelector(".tc-step-at").textContent).toBe("3 / 3");
    fire(step().querySelectorAll("button")[0], "click"); await settle(10);
    expect(new URLSearchParams((globalThis as any).location.search).get("card")).toBe("M-3");
  });

  it("a sub task opened from its main task steps among its siblings", async () => {
    await mount();
    fire(q('[data-tile="M-2"] .tb-tile-title'), "click");
    await settle(10);
    const child = qa("dialog[open] .tc-children button").find((b) => b.textContent.includes("S-2"));
    fire(child, "click"); await settle(10);
    expect(step().querySelector(".tc-step-at").textContent).toBe("2 / 2");
    fire(step().querySelectorAll("button")[0], "click"); await settle(10);
    expect(new URLSearchParams((globalThis as any).location.search).get("card")).toBe("S-1");
  });
});
