/**
 * The card's page, laid out lighter (scheme A).
 *  - a spec field nobody filled in (goal, scope, definition of done, context) is a small "+ Add" button, not an empty block;
 *    a button opens its field in place, an empty one closed again folds back, a saved one is a field like the others;
 *  - what an agent writes (state, result) is not in the spec: it is in the agent's block with "Agent activity" — one line while
 *    there is nothing to show (and the buttons to write them by hand), open once there is;
 *  - the sub tasks are a bordered list with done / total, a bar and a line to add one;
 *  - the properties are three groups; "needs my confirmation" is a switch; the "Now" row is gone; Mark blocked is in the header;
 *  - nothing changes in what can be seen or edited, nor over a read-only link; both languages say it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage;
let fleet: any, cardMod: any, i18n: any, preact: any, app: any, nav: any;
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
const card = (over: Record<string, unknown>) => ({ id: "M-1", uuid: String(over.id ?? "M-1"), kind: "main", projectId: 1, parentId: null, title: "A card", status: "open",
  assignee: null, dispatcher: { kind: "person", name: "Ann" }, waitsForPerson: false, confirmer: null, priority: "normal", size: null, needsReview: true, dependsOn: [], goal: "", scope: "",
  acceptance: [] as Array<{ text: string; done: boolean }>, context: "", state: "", blockedReason: "", result: "", sort: 1, createdBy: "Ann", version: 4, createdAt: ago(10), updatedAt: ago(1), startedAt: null, submittedAt: null,
  doneAt: null, progress: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 }, unmetDeps: [], commentCount: 0, newCommentCount: 0, lastComment: null, ...over });
const PROJECT = { id: 1, name: "Leaderboard", description: "", archived: false, sort: 1, createdAt: ago(30) };

let CARDS: any[] = [];
const build = () => {
  // M-2: a main task with sub tasks and nothing written; M-1: every field filled; M-5: no sub tasks, nothing written; M-6: finished.
  const m1 = card({ id: "M-1", title: "Serve the weekly leaderboard", status: "claimed", assignee: "alpha", goal: "Players see their rank", scope: "In: ranks / Out: prizes",
    acceptance: [{ text: "Ties share a rank", done: true }, { text: "Under 300 ms", done: false }], context: "See M-4", state: "Endpoint done, tests next", result: "src/rank.ts; npm test passes", sort: 1 });
  const m2 = card({ id: "M-2", title: "Add the shop", status: "open", assignee: "beta", sort: 2, progress: { total: 2, open: 1, claimed: 0, blocked: 0, review: 0, done: 1 } });
  const s1 = card({ id: "S-1", kind: "sub", parentId: "M-2", title: "Price list", status: "done", assignee: "alpha", sort: 1 });
  const s2 = card({ id: "S-2", kind: "sub", parentId: "M-2", title: "Checkout", status: "open", assignee: "beta", sort: 2 });
  const m5 = card({ id: "M-5", title: "Nobody has it", status: "open", sort: 5 });
  const m6 = card({ id: "M-6", title: "Shipped", status: "done", assignee: "alpha", doneAt: ago(1), sort: 6, progress: { total: 2, open: 0, claimed: 0, blocked: 0, review: 0, done: 2 } });
  return [m1, m2, s1, s2, m5, m6];
};
const detailOf = (id: string) => {
  const c: any = CARDS.find((x: any) => x.id === id) ?? card({ id });
  return { card: c, parent: c.parentId ? { id: "M-2", title: "Add the shop", status: "open" } : null, children: c.kind === "main" ? CARDS.filter((x: any) => x.parentId === c.id) : [],
    comments: [], logs: [], history: [], watchers: [], inheritedWatchers: [], leader: null, followsProgress: true };
};

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  i18n = await import("/assets/app-i18n.js");
  preact = await import("/assets/app-html.js");
  fleet = await import("/ui/js/panel-fleet.js");
  cardMod = await import("/ui/js/fleet-task-card.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });

beforeEach(async () => {
  await p.unmount();
  i18n.setLang("en", { store: false });
  const ls = (globalThis as any).localStorage;
  for (const k of ["agend_tasks_project", "agend_tasks_display", "agend_tasks_filters", "agend_tasks_assignee", "agend_tasks_query", "agend_tasks_collapsed"]) ls.removeItem(k);
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  (globalThis as any).history.entries.length = 1;
  (globalThis as any).history.states.length = 1;
  (globalThis as any).history.at = 0;
  calls.length = 0;
  CARDS = build();
  handler = (path, method, body) => {
    if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS, boardOff: [] };
    if (path === "/ui/tasks/cards" && method === "POST") return { card: card({ id: "S-9", kind: "sub", parentId: body.parent, title: body.title }), notes: [] };
    const m = /^\/ui\/tasks\/cards\/([^/]+)(\/move)?$/.exec(path);
    if (m && method === "POST") {
      // A write lands on the card, so the page's next read shows it (the version moves on as the board's does).
      const c: any = CARDS.find((x: any) => x.id === decodeURIComponent(m[1]!));
      if (c && body) { for (const k of ["goal", "scope", "context", "state", "result", "needsReview"]) if (k in body) c[k] = body[k]; if ("acceptance" in body) c.acceptance = body.acceptance.map((text: string) => ({ text, done: false })); c.version += 1; }
      return { card: c, notes: [] };
    }
    if (m) return detailOf(decodeURIComponent(m[1]!));
    return {};
  };
  app.applyStatus({ uptime: 1, instances: ["alpha", "beta", "gamma"].map((name) => ({ name, status: "running", state: "idle", execution_state: "idle" })) });
});

let mounts = 0;
async function mount(display: Record<string, unknown> | null = null) {
  await p.unmount();
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  (globalThis as any).localStorage.setItem("agend_tasks_project", "1");
  if (display) (globalThis as any).localStorage.setItem("agend_tasks_display", JSON.stringify(display));
  await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|l314-${++mounts}|en` }));
  await settle(8);
}
const q = (sel: string) => p.root.querySelector(sel);
const qa = (sel: string) => [...p.root.querySelectorAll(sel)] as any[];
const text = (el: any): string | null => (el ? el.childNodes.map((n: any) => (n.nodeType === 3 ? n.textContent : text(n)) ?? "").map((s: string) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ") : null);
const doc = () => (globalThis as any).document;
const posts = () => calls.filter((c) => c.method === "POST");
async function openCard(id: string) { fire(q(`[data-tile="${id}"] .tb-tile-title`) ?? q(`[data-row="${id}"] .tb-row-title`), "click"); await settle(10); }
const typeInto = async (el: any, value: string) => { el.value = value; el.selectionStart = value.length; fire(el, "input"); await settle(4); };
const linkBtn = () => qa(".tp-bar .icon-btn").find((b) => (b.getAttribute("aria-label") ?? "").includes("link"));
const adders = (scope = ".tp-body > .tp-adders") => qa(`${scope} .tp-add`).map((b) => text(b));
const fieldOf = (title: string) => qa(".tp-body .tc-field").find((f) => text(f.querySelector("h3")) === title);

describe("a spec field nobody filled in is a button", () => {
  it("a card with nothing written has the four buttons and no empty block; a filled card has its four fields and no button", async () => {
    await mount(); await openCard("M-2");
    expect(q(".tp-spec"), "no field is shown").toBeNull();
    expect(qa(".tp-body .tc-field").length).toBe(0);
    expect(adders()).toEqual(["Add goal", "Add scope", "Add definition of done", "Add context"]);
    await mount(); await openCard("M-1");
    expect(qa(".tp-spec .tc-field h3").map((h) => text(h))).toEqual(["Goal", "Scope", "Definition of done", "Context"]);
    expect(q(".tp-body > .tp-adders"), "every spec field holds text: no button").toBeNull();
    expect(text(q(".tp-spec .tc-text"))).toBe("Players see their rank");
  });

  it("a sub task says Acceptance, has no scope, and keeps the same buttons", async () => {
    await mount(); await openCard("M-2");
    fire(qa(".tc-children button").find((b) => text(b)!.includes("S-2")), "click"); await settle(10);
    expect(adders()).toEqual(["Add goal", "Add acceptance", "Add context"]);
  });

  it("a button opens its field in place with the focus; left empty it folds back and sends nothing", async () => {
    await mount(); await openCard("M-2");
    fire(q('.tp-add[data-add="scope"]'), "click"); await settle(4);
    expect(text(fieldOf("Scope")!.querySelector("h3"))).toBe("Scope");
    const box = fieldOf("Scope")!.querySelector("textarea");
    expect(box, "open as it appears").toBeTruthy();
    expect(doc().activeElement).toBe(box);
    expect(adders(), "its button is gone while it is open").toEqual(["Add goal", "Add definition of done", "Add context"]);
    fire(box, "blur"); await settle(8);
    expect(posts()).toEqual([]);
    expect(fieldOf("Scope"), "folded back").toBeUndefined();
    expect(adders()).toEqual(["Add goal", "Add scope", "Add definition of done", "Add context"]);
    fire(q('.tp-add[data-add="goal"]'), "click"); await settle(4);                  // Esc folds it back too
    fire(fieldOf("Goal")!.querySelector("textarea"), "keydown", { key: "Escape", cancelable: true }); await settle(6);
    expect(fieldOf("Goal")).toBeUndefined();
    expect(q(".tp"), "the box took the Esc, the page stays").toBeTruthy();
  });

  it("what is typed saves as it does anywhere (the version it started from) and the field is then a field, in its place", async () => {
    await mount(); await openCard("M-2");
    fire(q('.tp-add[data-add="context"]'), "click"); await settle(4);
    fire(q('.tp-add[data-add="goal"]'), "click"); await settle(4);                  // opened second, shown first (the spec's order)
    expect(qa(".tp-spec .tc-field h3").map((h) => text(h))).toEqual(["Goal", "Context"]);
    const box = fieldOf("Context")!.querySelector("textarea");
    await typeInto(box, "See M-4");
    fire(box, "keydown", { key: "Enter", ctrlKey: true, cancelable: true }); await settle(12);
    expect(posts().map((c) => [c.path, c.body])).toEqual([["/ui/tasks/cards/M-2", { context: "See M-4", version: 4 }]]);
    expect(text(fieldOf("Context")!.querySelector(".tc-text"))).toBe("See M-4");
    expect(fieldOf("Context")!.querySelector("textarea"), "the edit is closed, the field stays").toBeNull();
    expect(fieldOf("Goal")!.querySelector("textarea"), "another open field is not disturbed by it").toBeTruthy();
    expect(adders()).toEqual(["Add scope", "Add definition of done"]);
  });

  it("the definition of done opens its list editor, one item per line", async () => {
    await mount(); await openCard("M-2");
    fire(q('.tp-add[data-add="definition"]'), "click"); await settle(4);
    const box = fieldOf("Definition of done")!.querySelector("textarea");
    expect(doc().activeElement).toBe(box);
    await typeInto(box, "Prices shown\nCheckout works");
    fire(box, "blur"); await settle(12);
    expect(posts().map((c) => c.body)).toEqual([{ acceptance: ["Prices shown", "Checkout works"], version: 4 }]);
    expect(qa(".tc-checklist li").length).toBe(2);
  });

  it("a filled field closed by emptying it is a button again; the next card starts with its own buttons", async () => {
    await mount(); await openCard("M-1");
    fire(fieldOf("Scope")!.querySelector(".tc-text"), "click"); await settle(4);
    const box = fieldOf("Scope")!.querySelector("textarea");
    await typeInto(box, "");
    fire(box, "blur"); await settle(12);
    expect(posts().map((c) => c.body)).toEqual([{ scope: "", version: 4 }]);
    expect(fieldOf("Scope")).toBeUndefined();
    expect(adders()).toEqual(["Add scope"]);
  });
});

describe("what the agent writes is its own block, a line while it has nothing", () => {
  it("nothing written, not running: one line; no State or Result field in the spec; the buttons are in the line", async () => {
    await mount(); await openCard("M-2");
    const line = q(".tr-run");
    expect(line.className).toContain("is-strip");
    expect(text(q(".tp-agent-note"))).toBe("Not started: beta will update this once it takes the card");
    expect(text(line.querySelector(".tr-title"))).toBe("Agent activity");
    expect(adders(".tr-run")).toEqual(["Add state", "Add result"]);
    expect(fieldOf("State")).toBeUndefined();
    expect(qa(".tp-spec h3").map((h) => text(h)), "State and Result are not spec").not.toContain("State");
    expect(qa(".tp-body > *").map((el) => el.className.split(" ")[0]), "the line is after the spec, before the sub tasks").toEqual(["tp-adders", "tr-run", "tp-subs"]);
  });

  it("a button in the line opens that field inside the block, which then opens up; closing it empty is the line again", async () => {
    await mount(); await openCard("M-2");
    fire(q('.tr-run .tp-add[data-add="state"]'), "click"); await settle(4);
    const block = q(".tr-run");
    expect(block.className).not.toContain("is-strip");
    expect(block.querySelector(".tp-agent-fields .tc-field h3").textContent).toBe("State");
    expect(doc().activeElement).toBe(block.querySelector("textarea"));
    expect(q(".tp-spec"), "not in the spec").toBeNull();
    expect(adders(".tr-run")).toEqual(["Add result"]);
    fire(block.querySelector("textarea"), "keydown", { key: "Escape", cancelable: true }); await settle(6);
    expect(q(".tr-run").className).toContain("is-strip");
  });

  it("a card with a state and a result: the block is open with both fields, apart from the spec", async () => {
    await mount(); await openCard("M-1");
    const block = q(".tr-run");
    expect(block.className).not.toContain("is-strip");
    expect(qa(".tr-run .tc-field h3").map((h) => text(h))).toEqual(["State", "Result"]);
    expect(qa(".tp-spec .tc-field h3").map((h) => text(h))).toEqual(["Goal", "Scope", "Definition of done", "Context"]);
    expect(text(block.querySelector(".tr-title"))).toBe("Agent activity");
    expect(text(block.querySelector(".tb-who"))).toBe("alpha");
    expect(block.querySelector("a.tr-open").getAttribute("href")).toBe("/ui/chat/alpha");
    expect(q(".tr-run .tp-agent-add"), "both are written: no button left").toBeNull();
  });

  it("a state is edited in place and saved like any text", async () => {
    await mount(); await openCard("M-1");
    fire(qa(".tr-run .tc-field").find((f) => text(f.querySelector("h3")) === "State")!.querySelector(".tc-text"), "click"); await settle(4);
    const box = q(".tr-run textarea");
    await typeInto(box, "Tests green");
    fire(box, "blur"); await settle(12);
    expect(posts().map((c) => c.body)).toEqual([{ state: "Tests green", version: 4 }]);
  });
});

describe("the sub tasks: rows on the page's grid", () => {
  it("done / total and the bar on top, the sub tasks, the line to add one last", async () => {
    await mount(); await openCard("M-2");
    const subs = q(".tp-subs");
    expect(text(subs.querySelector("h3"))).toBe("Sub tasks");
    expect(text(subs.querySelector(".tp-subs-count"))).toBe("1 / 2");
    expect(subs.querySelector("svg.tb-bar"), "the shared progress bar").toBeTruthy();
    expect(qa(".tp-subs .tc-children li").map((li) => text(li))).toEqual(["Done S-1 Price list alpha", "To do S-2 Checkout Ready beta"]);
    expect(qa(".tp-subs .tc-children button").map((b) => [...b.children].map((c: any) => c.className.split(" ")[0])), "a row's columns: status, number, title, who — what is going on is a short label inside the title's cell, never a line of its own")
      .toEqual([["tb-pill", "tb-code", "tc-child-title", "tb-who"], ["tb-pill", "tb-code", "tc-child-title", "tb-who"]]);
    expect(qa(".tp-subs .tc-children .tc-child-title .tf-chip").map((c) => text(c)), "S-2 is ready, nobody has started it").toEqual(["Ready"]);
    const body = subs.querySelector(".tc-field-body");
    const last = body.children[body.children.length - 1];
    expect(last.className).toBe("tc-quick-add");
    await typeInto(last, "Receipts");
    fire(last, "keydown", { key: "Enter", cancelable: true }); await settle(12);
    expect(posts().map((c) => [c.path, c.body])).toEqual([["/ui/tasks/cards", { parent: "M-2", title: "Receipts" }]]);
  });

  it("a main task without sub tasks has the list to add the first; a finished one only reads", async () => {
    await mount(); await openCard("M-5");
    expect(text(q(".tp-subs h3"))).toBe("Sub tasks");
    expect(q(".tp-subs .tp-subs-count"), "nothing to count yet").toBeNull();
    expect(q(".tp-subs .tc-quick-add")).toBeTruthy();
    await mount({ done: "all" }); await openCard("M-6");
    expect(text(q(".tp-subs .tp-subs-count"))).toBe("2 / 2");
    expect(q(".tp-subs .tc-quick-add"), "a finished card takes no more").toBeNull();
  });

  it("a sub task has no list of its own", async () => {
    await mount(); await openCard("M-2");
    fire(qa(".tc-children button").find((b) => text(b)!.includes("S-2")), "click"); await settle(10);
    expect(q(".tp-subs")).toBeNull();
  });
});

describe("the properties in three groups", () => {
  it("core state, project and people, flow — and no 'Now' row", async () => {
    await mount(); await openCard("M-2");
    const rows = (i: number) => qa(".tp-group")[i].querySelectorAll(".tp-row dt").map((d: any) => text(d));
    expect(qa(".tp-group").length).toBe(3);
    expect(rows(0)).toEqual(["Status", "Assignee", "Priority", "Size"]);
    expect(rows(1)).toEqual(["Project", "Leader", "Dispatched by", "Watchers"]);
    expect(rows(2), "(Position: this card has a neighbour to move past)").toEqual(["Needs my confirmation", "Waits for", "Position"]);
    expect(qa(".tp-group").map((g) => g.getAttribute("role"))).toEqual(["group", "group", "group"]);
    expect(qa(".tp-props .tp-row dt").map((d) => text(d))).not.toContain("Now");
    expect(q(".tp-side").textContent).not.toContain("Next");
  });

  it("a sub task's group has its main task where the project is", async () => {
    await mount(); await openCard("M-2");
    fire(qa(".tc-children button").find((b) => text(b)!.includes("S-2")), "click"); await settle(10);
    expect(qa(".tp-group")[1].querySelectorAll(".tp-row dt").map((d: any) => text(d))).toEqual(["Main task", "Leader", "Dispatched by", "Watchers"]);
  });

  it("needs my confirmation is a switch that saves at once", async () => {
    await mount(); await openCard("M-2");
    const sw = q(".tp-switch input");
    expect(sw.getAttribute("role")).toBe("switch");
    expect(sw.className).toContain("s-ui-toggle");
    expect(sw.getAttribute("aria-label")).toBe("Stop at review for my confirmation");
    expect(sw.checked).toBe(true);
    sw.checked = false;
    fire(sw, "change"); await settle(12);
    expect(posts().map((c) => [c.path, c.body])).toEqual([["/ui/tasks/cards/M-2", { needsReview: false, version: 4 }]]);
  });
});

describe("the header toolbar", () => {
  it("Mark blocked is beside the link and ⋯, not under the title; only where it was offered before", async () => {
    await mount(); await openCard("M-2");
    const bar = q(".tp-bar");
    expect(text(bar.querySelector(".tp-block-btn"))).toBe("Mark blocked");
    expect(linkBtn(), "the link is in the toolbar").toBeTruthy();
    expect(bar.querySelector(".tp-more")).toBeTruthy();
    expect(qa(".tc-actions .btn").map((b) => text(b)), "not the page's most obvious button under the title").toEqual([]);
    expect(text(q(".tp-derived"))).toBe("It has sub tasks: its status follows them");
    expect(text(q(".tc-head")), "the chip is not in the heading").toBe("Add the shop");
    fire(bar.querySelector(".tp-block-btn"), "click"); await settle(6);
    expect(qa("dialog[open]").at(-1)?.textContent, "it asks why, as before").toContain("Blocked on");
  });

  it("a card that does not follow sub tasks, a blocked one and a finished one have none", async () => {
    await mount(); await openCard("M-5");
    expect(q(".tp-block-btn")).toBeNull();
    expect(q(".tp-derived")).toBeNull();
    expect(q(".tp-bar .tp-more"), "⋯ keeps cancel").toBeTruthy();
    await mount({ done: "all" }); await openCard("M-6");
    expect(q(".tp-block-btn")).toBeNull();
    expect(q(".tp-bar .tp-more"), "nothing to put in ⋯ for a finished card").toBeNull();
    expect(linkBtn(), "the link is always there").toBeTruthy();
    expect(qa(".tc-actions .btn").map((b) => text(b))).toEqual(["Reopen"]);
  });
});

describe("read only: what is there is shown, nothing is offered", () => {
  it("over a link that cannot write: no buttons, no empty field, the text of the others", async () => {
    await p.unmount();
    const c = CARDS.find((x: any) => x.id === "M-2");
    CARDS = CARDS.map((x: any) => (x.id === "M-2" ? { ...c, goal: "Players buy badges" } : x));
    await p.mount(h(cardMod.CardPage, { id: "M-2", tick: 0, projects: [PROJECT], writable: false, back: "Back to the board", onBack() {}, onOpen() {}, onStep() {}, reloadBoard() {} }));
    await settle(10);
    expect(q(".tp-add")).toBeNull();
    expect(qa(".tp-body .tc-field h3").map((h) => text(h))).toEqual(["Goal"]);
    expect(text(q(".tp-spec .tc-text"))).toBe("Players buy badges");
    expect(q(".tr-run").className, "the agent's line says it, and has no button").toContain("is-strip");
    expect(q(".tr-run .tp-add")).toBeNull();
    expect(q(".tc-quick-add")).toBeNull();
    expect(q(".tp-switch")).toBeNull();
    expect(q(".tp-props input")).toBeNull();
    expect(q(".tp-props button.tp-chip")).toBeNull();
    expect(q(".tp-block-btn")).toBeNull();
    expect(q(".tc-composer")).toBeNull();
  });
});

describe("both languages", () => {
  it("every string the new layout uses is in English and Traditional Chinese, with the same holes", () => {
    const keys = ["groupCore", "groupTeam", "groupFlow", "addGoal", "addScope", "addDefinition", "addAcceptance", "addContext", "addState", "addResult", "subs", "subsDone", "reviewShort", "review", "deps"]
      .map((k) => `taskcard.${k}`).concat(["waiting", "waitingNobody", "viaSubs", "nothingYet"].map((k) => `taskrun.${k}`));
    const holes = (s: string) => [...new Set(s.match(/\{\d\}/g) ?? [])].sort().join();
    for (const key of keys) {
      const en = i18n.tIn("en", key), zh = i18n.tIn("zh-TW", key);
      expect(en, key).not.toBe(key);
      expect(zh, key).not.toBe(key);
      expect(zh, `${key} is translated`).not.toBe(en);
      expect(holes(zh), `${key} placeholders`).toBe(holes(en));
    }
  });

  it("in Traditional Chinese: the buttons, the groups, the line", async () => {
    i18n.setLang("zh-TW", { store: false });
    await mount(); await openCard("M-2");
    expect(adders()).toEqual(["新增目標", "新增範圍", "完成定義", "補充背景"]);
    expect(qa(".tp-group-title").map((g) => text(g))).toEqual(["核心狀態", "專案與協作", "流程控制"]);
    expect(text(q(".tp-agent-note"))).toBe("待啟動：beta 接手後會在這裡更新");
    expect(text(q(".tp-subs-count"))).toBe("1 / 2");
    expect(qa(".tp-group")[2].querySelectorAll(".tp-row dt").map((d: any) => text(d))).toEqual(["待我確認", "相依卡片", "位置"]);
  });
});

describe("one invisible grid: label column, value column", () => {
  it("every labelled row of the main column is a label and a body — the spec, the agent's fields, the sub tasks", async () => {
    await mount(); await openCard("M-1");
    for (const f of qa(".tp-body .tc-field")) {
      expect([...f.children].map((c: any) => c.tagName + "." + c.className), text(f.querySelector("h3"))!).toEqual(["H3.", "DIV.tc-field-body"]);
    }
    expect([...q(".tp-subs").children].map((c: any) => c.tagName + "." + c.className)).toEqual(["H3.", "DIV.tc-field-body"]);
    expect(qa(".tp-body .tc-field").length, "goal, scope, definition, context, state, result").toBe(6);
  });

  it("the number and the status are above the title; the 'follows sub tasks' chip is on the same row", async () => {
    await mount(); await openCard("M-2");
    const row = q(".tp-idrow");
    expect(text(row.querySelector(".tp-code"))).toBe("M-2");
    expect(row.querySelector(".tb-pill.st-open")).toBeTruthy();
    expect(text(row.querySelector(".tp-derived"))).toBe("It has sub tasks: its status follows them");
    expect([...q(".tp-head").children].map((c: any) => c.className.split(" ")[0])).toEqual(["tp-idrow", "tc-head", "tc-actions"]);
    expect(text(q(".tc-head")), "the heading is the title only").toBe("Add the shop");
  });

  it("a timeline line is columns: mark, who, words, time", async () => {
    CARDS = build();
    const base = handler;
    handler = (path, method, body) => {
      const r: any = base(path, method, body);
      if (r && r.card && r.card.id === "M-1" && !r.logs?.length && method === "GET") return { ...r, logs: [{ id: 1, author: "alpha", authorKind: "instance", text: "Endpoint done", at: "2026-11-02T11:00:00.000Z" }], history: [{ id: 2, actor: "Ann", actorKind: "person", type: "created", data: {}, at: "2026-11-01T08:00:00.000Z" }] };
      return r;
    };
    await mount(); await openCard("M-1");
    for (const b of qa(".tl-more")) fire(b, "click");
    await settle(4);
    // A history line is a thin row — a mark, the sentence (who, then what), the time; a progress note is a card.
    const lines = qa(".tl-line");
    expect(lines.length, "the history line only: the progress note is a card").toBe(1);
    expect([...lines[0].children].map((c: any) => c.className.split(" ")[0]), "mark, sentence, time").toEqual(["tl-mark", "tl-sentence", "muted"]);
    expect(text(lines[0].querySelector(".tl-who"))).toBe("Ann");
    expect(text(lines[0].querySelector(".tl-text"))).toBe("opened it");
    const note = q(".tl-card.tl-log");
    expect(text(note.querySelector(".tl-head")), "who, the agent's badge, what it is, when").toMatch(/^A alpha Agent Progress /);
    expect(text(note.querySelector(".tl-body"))).toBe("Endpoint done");
  });
});

describe("the timeline: what is said and done leads, the history is quiet", () => {
  const at = (days: number, h = 10) => { const d = new Date(Date.now() - days * 86_400_000); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  const detailWith = (over: Record<string, unknown>) => {
    const base = handler;
    handler = (path, method, body) => {
      const r: any = base(path, method, body);
      return r && r.card && r.card.id === "M-1" && method === "GET" ? { ...r, ...over } : r;
    };
  };
  const ev = (id: number, actor: string, at: string, type = "updated", data: any = { changes: { acceptance: [] } }, actorKind = "person") => ({ id, actor, actorKind, type, data, at });

  it("collapseEvents: a run of the same line from the same hand is one with a count and the latest time; nothing else merges", async () => {
    const act = await import("/ui/js/fleet-task-activity.js");
    const describe = (e: any) => e.data.text ?? e.type;
    const E = (key: string, who: string, text: string, at: string, type = "event") => ({ key, type, who, by: "person", at, ev: { type: "updated", data: { text } } });
    const out = act.collapseEvents([E("a", "ann", "x", "2026-11-01T10:00:00Z"), E("b", "ann", "x", "2026-11-01T11:00:00Z"), E("c", "ann", "x", "2026-11-01T12:00:00Z"),
      E("d", "ann", "y", "2026-11-01T13:00:00Z"), E("e", "bob", "y", "2026-11-01T14:00:00Z"), E("f", "bob", "y", "2026-11-01T15:00:00Z"),
      { key: "g", type: "comment", who: "bob", by: "person", at: "2026-11-01T16:00:00Z", text: "hi" }, E("h", "bob", "y", "2026-11-01T17:00:00Z")], describe);
    expect(out.map((e: any) => [e.key, e.count ?? 1, e.at.slice(11, 13)])).toEqual([["a", 3, "12"], ["d", 1, "13"], ["e", 2, "15"], ["g", 1, "16"], ["h", 1, "17"]]);
    const same = [E("a", "ann", "x", "2026-11-01T10:00:00Z", "log"), E("b", "ann", "x", "2026-11-01T11:00:00Z", "log")].map((e: any) => ({ ...e, type: "log" }));
    expect(act.collapseEvents(same, describe).length, "progress notes never merge").toBe(2);
  });

  it("three equal history lines are one line ×3; the history is not bold and an agent's has no bar; a progress note is a line of its own", async () => {
    const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    detailWith({ comments: [], logs: [{ id: 1, author: "alpha", authorKind: "instance", text: "Endpoint done", at: ago(10) }],
      history: [ev(1, "web-user", ago(4)), ev(2, "web-user", ago(3)), ev(3, "web-user", ago(2)), ev(4, "alpha", ago(1), "moved", { from: "open", to: "claimed", auto: true }, "instance")] });
    await mount(); await openCard("M-1");
    expect(qa(".tl-line").length, "the history is folded at first").toBe(0);
    expect(qa(".tl-more").map((b) => text(b)), "the three equal lines are one line, so the run is two lines").toEqual(["2 activities"]);
    for (const b of qa(".tl-more")) fire(b, "click");
    await settle(4);
    const lines = qa(".tl-line");
    expect(lines.length, "four history lines: the three equal ones are one").toBe(2);
    expect(qa(".tl-card.tl-log").length, "and the progress note is a card").toBe(1);
    const merged = lines.find((l) => l.querySelector(".tl-count"));
    expect(merged.querySelector(".tl-count").textContent).toBe("×3");
    expect(merged.querySelector(".tl-count").getAttribute("title")).toBe("The same, 3 times in a row");
    expect(qa(".tl-item").filter((l) => l.className.includes("by-agent")).map((l) => l.className.includes("tl-log") ? "log" : "event"), "only the agent's progress note is marked (a badge; no bar)").toEqual(["log"]);
    expect(qa(".tp-activity .lbar").length, "no coloured bar on the stream").toBe(0);
    expect(qa(".tl-filter button").map((b) => text(b)), "the numbers are the lines each filter shows: four history entries, three of them one line").toEqual(["All", "Comments 0", "Progress 1", "History 2"]);
    fire(qa(".tl-filter button")[3], "click"); await settle(4);
    expect(qa(".tl-item").length, "History shows as many lines as its button says").toBe(2);
  });

  it("a comment has no box: who and when, then its text as Markdown (escaped first)", async () => {
    detailWith({ comments: [{ id: 1, author: "Ann", authorKind: "person", kind: "comment", text: "Use **bold**, `code` and\n- a\n- b\n<script>x</script>", at: at(0) }], logs: [], history: [] });
    await mount(); await openCard("M-1");
    const c = q(".tl-comment");
    expect(c.className).not.toContain("box");
    expect(c.querySelector(".tl-head .tb-who").textContent).toBe("Ann");
    const body = c.querySelector(".tl-body");
    expect(body.className).toContain("md");
    expect(body.querySelector("strong").textContent).toBe("bold");
    expect(body.querySelector("code").textContent).toBe("code");
    expect([...body.querySelectorAll("li")].map((li: any) => li.textContent)).toEqual(["a", "b"]);
    expect(body.querySelector("script"), "no tag of the message's own").toBeNull();
    expect(body.textContent).toContain("<script>x</script>");
  });

  it("a hostile comment makes no link of a script URL and no attribute of its own (the page's last regression net for the chat's renderer)", async () => {
    const hostile = [
      "[x](javascript:alert(1))", "[x](JaVaScRiPt:alert(1))", "[x]( javascript:alert(1))", "[x](vbscript:msgbox(1))", "[x](//evil.example/x)",
      "[x](data:text/html,<script>alert(1)</script>)", '"onmouseover="alert(1)" x', '[x](https://a.example" onmouseover="alert(1))',
      'https://a.example/x"onmouseover="alert(1)', "<img src=x onerror=alert(1)>", '<a href="javascript:alert(1)" onclick="alert(2)">y</a>', "[x](mailto:a@b.example)",
    ];
    detailWith({ comments: [{ id: 1, author: "Mallory", authorKind: "person", kind: "comment", text: hostile.join("\n\n"), at: at(0) }], logs: [], history: [] });
    await mount(); await openCard("M-1");
    const body = q(".tl-comment .tl-body");
    const els = [...body.querySelectorAll("*")] as any[];
    expect(els.length, "it did render").toBeGreaterThan(hostile.length);
    // Only the tags the renderer's own Markdown makes: nothing a message could add of its own.
    expect([...new Set(els.map((e) => e.localName))].sort()).toEqual(["a", "p"]);
    const allowed = new Set(["href", "target", "rel", "data-trust"]);
    for (const e of els) {
      for (const a of e.attributes) {
        expect(allowed.has(a.name), `${e.localName}: ${a.name}`).toBe(true);
        expect(a.name.startsWith("on"), `${e.localName}: ${a.name}`).toBe(false);
      }
    }
    // A link is only an http(s) or mailto one, opened in a new tab without the opener.
    const links = els.filter((e) => e.localName === "a");
    expect(links.length, "the mailto, and the https one that ends before its quote (a URL with a quote in it stays text)").toBe(2);
    for (const a of links) {
      expect(a.getAttribute("href")).toMatch(/^(https?:\/\/|mailto:)/);
      expect([a.getAttribute("target"), a.getAttribute("rel")]).toEqual(["_blank", "noopener noreferrer"]);
    }
    expect(links.map((a) => a.getAttribute("href")).filter((h: string) => /^https?:/.test(h)).every((h: string) => h.startsWith("https://a.example")), "no link to a host the text did not name").toBe(true);
    // What is not a link stays the text it was, not a link without an address either.
    for (const t of ["[x](javascript:alert(1))", "[x](JaVaScRiPt:alert(1))", "[x](vbscript:msgbox(1))", "[x](//evil.example/x)", "<img src=x onerror=alert(1)>"]) expect(body.textContent, t).toContain(t);
    expect(els.filter((e) => e.localName === "a" && !e.hasAttribute("href")).length).toBe(0);
  });

  it("a day change is a separator (Today / Yesterday / a date) only when the list spans days", async () => {
    detailWith({ comments: [{ id: 1, author: "Ann", authorKind: "person", kind: "comment", text: "first", at: at(3) }, { id: 2, author: "Ann", authorKind: "person", kind: "comment", text: "second", at: at(1) }, { id: 3, author: "Ann", authorKind: "person", kind: "comment", text: "third", at: at(0) }], logs: [], history: [] });
    await mount(); await openCard("M-1");
    const labels = qa(".tl-day").map((d) => text(d));
    expect(labels.length).toBe(3);
    expect(labels.slice(1)).toEqual(["Yesterday", "Today"]);
    expect(labels[0]).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/);
    expect(qa(".tl-item").length, "the separators are not entries").toBe(3);
    detailWith({ comments: [{ id: 1, author: "Ann", authorKind: "person", kind: "comment", text: "only today", at: at(0, 8) }, { id: 2, author: "Ann", authorKind: "person", kind: "comment", text: "also today", at: at(0, 9) }], logs: [], history: [] });
    await mount(); await openCard("M-1");
    expect(qa(".tl-day").length, "one day needs no heading").toBe(0);
  });
});
