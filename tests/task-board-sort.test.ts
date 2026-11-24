/**
 * "No project" made hard to miss (Fleet › Tasks, fleet-task-sort.js). A card an agent opens without a project lands there, and
 * the tile for it was the last on Home (and only there) while the page reopens the project last looked at. When the board has a
 * project and a live main task has none:
 *  - Home lists the newest such cards (at most five) above the projects, each with a picker that files it at once, and the
 *    No project tile comes first with "N to file";
 *  - a project's header says how many are not in a project, and its link opens No project;
 *  - the No project board says what the place is for.
 * A board with no active project asks for nothing (No project is then the whole board); finished, cancelled and sub task
 * cards are not "to sort"; a read-only viewer sees the list but no picker.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage;
let app: any, fleet: any, sort: any, i18n: any;
const calls: Array<{ method: string; path: string; body: any }> = [];
let handler: (path: string, method: string, body: any) => unknown = () => ({});
const fetchFake = async (path: string, o: any = {}) => {
  const method = o.method ?? "GET";
  const body = o.body ? JSON.parse(o.body) : null;
  calls.push({ method, path, body });
  const out: any = await handler(path, method, body);
  return { ok: true, status: 200, json: async () => out };
};

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const card = (over: Record<string, unknown>) => ({ id: "M-1", uuid: String(over.id ?? "M-1"), kind: "main", projectId: null, parentId: null, title: "A card", status: "open",
  assignee: null, dispatcher: null, waitsForPerson: false, confirmer: null, priority: "normal", size: null, needsReview: false, dependsOn: [], goal: "", scope: "",
  acceptance: [], context: "", state: "", blockedReason: "", result: "", sort: 1, createdBy: "master", version: 1, createdAt: ago(1), updatedAt: ago(1), startedAt: null, submittedAt: null,
  doneAt: null, progress: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 }, unmetDeps: [], commentCount: 0, newCommentCount: 0, lastComment: null, ...over });
const project = (id: number, name: string, over: Record<string, unknown> = {}) => ({ id, name, description: "", archived: false, sort: id, createdAt: ago(30), ...over });
const GAME = project(1, "Game"), SHOP = project(2, "Shop"), OLD = project(3, "Old", { archived: true });
const IN_GAME = card({ id: "M-1", title: "Leaderboard", projectId: 1, createdBy: "Ann", status: "claimed" });
/** Seven live cards in no project, M-10 the oldest … M-16 the newest, with the ones that are not to sort among them. */
const LOOSE = [10, 11, 12, 13, 14, 15, 16].map((n) => card({ id: `M-${n}`, title: `Loose ${n}`, createdAt: ago(20 - n), version: n }));
const NOT_TO_SORT = [card({ id: "M-30", title: "Finished loose", status: "done", doneAt: ago(1) }), card({ id: "M-31", title: "Cancelled loose", status: "cancelled" }),
  card({ id: "S-1", kind: "sub", parentId: "M-1", title: "A step", projectId: null })];

let board: { projects: unknown[]; cards: unknown[] } = { projects: [], cards: [] };
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  const nav = await import("/assets/app-nav.js");
  fleet = await import("/ui/js/panel-fleet.js");
  sort = await import("/ui/js/fleet-task-sort.js");
  i18n = await import("/assets/app-i18n.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  const ls = (globalThis as any).localStorage;
  for (const k of ["agend_tasks_project", "agend_tasks_display", "agend_tasks_filters", "agend_tasks_assignee", "agend_tasks_query", "agend_tasks_collapsed"]) ls.removeItem(k);
  for (const k of ["publicLink", "linkMedia", "tier"]) delete (globalThis as any).document.body.dataset[k];
  (globalThis as any).history.replaceState(null, "", "/ui/fleet");
  calls.length = 0;
  i18n.setLang("en", { store: false });
  board = { projects: [GAME, SHOP, OLD], cards: [IN_GAME, ...LOOSE, ...NOT_TO_SORT] };
  handler = (path, method, body) => {
    if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: board.projects, cards: board.cards, boardOff: [] };
    const m = /^\/ui\/tasks\/cards\/([^/]+)$/.exec(path);
    if (m && method === "POST") return { card: { ...(board.cards.find((c: any) => c.id === decodeURIComponent(m[1]!)) as object), ...body }, notes: [] };
    return {};
  };
  app.applyStatus({ uptime: 1, instances: ["master"].map((name) => ({ name, status: "running", state: "idle", execution_state: "idle" })) });
});

let mounts = 0;
async function mount(storage: Record<string, string> = {}) {
  await p.unmount();
  for (const [k, v] of Object.entries(storage)) (globalThis as any).localStorage.setItem(k, v);
  await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|sort-${++mounts}|en` }));
  await settle(8);
}
const q = (sel: string) => p.root.querySelector(sel);
const qa = (sel: string) => [...p.root.querySelectorAll(sel)] as any[];
const text = (el: any): string => (el ? el.childNodes.map((n: any) => (n.nodeType === 3 ? n.textContent : text(n)) ?? "").map((s: string) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ") : "");
const posts = () => calls.filter((c) => c.method === "POST");

describe("what is to sort (pure)", () => {
  it("a live main task with no project; not a finished, cancelled, sub or filed one", () => {
    const cards = [IN_GAME, ...LOOSE, ...NOT_TO_SORT];
    expect(cards.filter(sort.isLoose).map((c: any) => c.id).sort()).toEqual(LOOSE.map((c) => c.id).sort());
    expect(sort.isLoose(IN_GAME)).toBe(false);
  });
  it("newest first", () => {
    expect(sort.looseCards([...LOOSE]).map((c: any) => c.id)).toEqual(["M-16", "M-15", "M-14", "M-13", "M-12", "M-11", "M-10"]);
  });
  it("counted only while the board has an active project to file them in", () => {
    const cards = [...LOOSE, ...NOT_TO_SORT];
    expect(sort.sortCount(cards, [GAME, SHOP, OLD])).toBe(7);
    expect(sort.sortCount(cards, [OLD])).toBe(0);
    expect(sort.sortCount(cards, [])).toBe(0);
    expect(sort.sortCount([IN_GAME], [GAME])).toBe(0);
  });
});

describe("Home", () => {
  it("lists the five newest cards in no project above the projects, with the count, and the No project tile first with its badge", async () => {
    await mount();
    const section = q(".tb-sort");
    expect(section, "the list is there").toBeTruthy();
    expect(text(section.querySelector(".tb-section-title"))).toBe("No project: 7 to file");
    expect(qa(".tb-sort-row").map((r) => r.dataset.sort)).toEqual(["M-16", "M-15", "M-14", "M-13", "M-12"]);
    expect(text(qa(".tb-sort-row")[0])).toContain("Loose 16");
    expect(text(qa(".tb-sort-row")[0])).toContain("by master");
    expect(text(section.querySelector(".tb-sort-foot .btn"))).toBe("See all 7");
    // above the projects
    const page = q(".tb-home");
    const kids = page.children as any[];
    expect(kids.indexOf(kids.find((k: any) => k.classList.contains("tb-sort")))).toBeLessThan(kids.indexOf(kids.find((k: any) => k.classList.contains("tb-projects"))));
    // the tile: first, badge, the picker's projects (active only)
    const tiles = qa(".tb-projects .tb-project");
    expect(text(tiles[0].querySelector(".tb-project-name"))).toBe("No project");
    expect(tiles[0].classList.contains("needs-sort")).toBe(true);
    expect(text(tiles[0].querySelector(".tb-sort-flag"))).toBe("7 to file");
    expect(tiles.slice(1).map((t) => text(t.querySelector(".tb-project-name")))).toEqual(["Game", "Shop"]);
    const options = [...qa(".tb-sort-pick")[0].querySelectorAll("option")].map((o: any) => text(o));
    expect(options).toEqual(["File in…", "Game", "Shop"]);
  });

  it("choosing a project files the card at once, with the version it shows, and the board is read again", async () => {
    await mount();
    const pick = qa(".tb-sort-pick")[0];                                  // M-16, version 16
    pick.value = "2";
    fire(pick, "change"); await settle(10);
    expect(posts().map((c) => [c.path, c.body])).toEqual([["/ui/tasks/cards/M-16", { projectId: 2, version: 16 }]]);
    expect(calls.filter((c) => c.path.startsWith("/ui/tasks/board")).length, "the board is read again").toBeGreaterThan(1);
  });

  it("'See all' opens No project", async () => {
    await mount();
    fire(q(".tb-sort-foot .btn"), "click"); await settle(8);
    expect(text(q(".tb-title h2"))).toBe("No project");
    expect(new URLSearchParams((globalThis as any).location.search).get("tp")).toBe("none");
    expect(text(q(".tb-head-lead"))).toBe("Cards opened without a project. Open one and choose its project, or file them from Home.");
  });

  it("with five or fewer the button just opens No project; nothing to sort draws nothing and the tile keeps its old place", async () => {
    board = { projects: [GAME, SHOP], cards: [IN_GAME, ...LOOSE.slice(0, 2)] };
    await mount();
    expect(qa(".tb-sort-row")).toHaveLength(2);
    expect(text(q(".tb-sort-foot .btn"))).toBe("Open No project");
    board = { projects: [GAME, SHOP], cards: [IN_GAME, ...NOT_TO_SORT] };
    await mount();
    expect(q(".tb-sort")).toBeNull();
    expect(q(".needs-sort")).toBeNull();
    const names = qa(".tb-projects .tb-project").map((t) => text(t.querySelector(".tb-project-name")));
    expect(names).toEqual(["Game", "Shop", "No project"]);              // the finished loose card still has its tile, last, as before
  });

  it("a board with no active project asks for nothing: no list, no badge, the tile where it was", async () => {
    board = { projects: [OLD], cards: [...LOOSE] };
    await mount();
    expect(q(".tb-sort")).toBeNull();
    expect(q(".tb-sort-flag")).toBeNull();
    expect(qa(".tb-projects .tb-project").map((t) => text(t.querySelector(".tb-project-name")))).toEqual(["No project"]);
  });

  it("a read-only viewer sees the list and no picker", async () => {
    (globalThis as any).document.body.dataset.publicLink = "1";
    await mount();
    expect(qa(".tb-sort-row")).toHaveLength(5);
    expect(qa(".tb-sort-pick")).toHaveLength(0);
  });

  it("a refused filing says why and the board is read again (the card moved on)", async () => {
    await mount();
    handler = (path, method) => {
      if (path.startsWith("/ui/tasks/board")) return { rev: 2, projects: board.projects, cards: board.cards, boardOff: [] };
      if (method === "POST") throw Object.assign(new Error("changed"), { key: "conflict" });
      return {};
    };
    const pick = qa(".tb-sort-pick")[0];
    pick.value = "1";
    fire(pick, "change"); await settle(10);
    expect(calls.filter((c) => c.path.startsWith("/ui/tasks/board")).length).toBeGreaterThan(1);
    expect(qa(".tb-sort-row")).toHaveLength(5);
  });
});

describe("a project's board", () => {
  it("says how many cards are not in a project, and the link opens No project (the project last looked at is remembered, so Home may never be seen)", async () => {
    await mount({ agend_tasks_project: "1" });
    expect(text(q(".tb-title h2"))).toBe("Game");
    const link = q(".tb-sort-link");
    // the desk's pill and the phone's banner are one button (CSS shows one wording or the other)
    expect(text(link.querySelector(".tb-sort-link-short"))).toBe("7 in No project");
    expect(text(link.querySelector(".tb-sort-link-long"))).toBe("No project: 7 to file");
    expect(text(link.querySelector(".tb-sort-link-go"))).toBe("File them");
    fire(link, "click"); await settle(8);
    expect(text(q(".tb-title h2"))).toBe("No project");
    expect(q(".tb-sort-link"), "No project does not link to itself").toBeNull();
  });
  it("says nothing when no card waits to be sorted", async () => {
    board = { projects: [GAME, SHOP], cards: [IN_GAME] };
    await mount({ agend_tasks_project: "1" });
    expect(q(".tb-sort-link")).toBeNull();
  });
});

describe("the words", () => {
  it("English and Traditional Chinese have the same keys and the numbers fill in", () => {
    const keys = ["title", "hint", "pick", "pickFor", "moved", "by", "openAll", "seeAll", "tileBadge", "headerLink", "headerLinkTip", "go", "placeLead"];
    for (const lang of ["en", "zh-TW"]) {
      for (const k of keys) expect(i18n.tIn(lang, `tasksort.${k}`, "A", "B"), `${lang} ${k}`).not.toBe(`tasksort.${k}`);
    }
    i18n.setLang("zh-TW", { store: false });
    expect(i18n.t("tasksort.title", 7)).toBe("未分類：7 張待歸檔");
    expect(i18n.t("tasksort.tileBadge", 7)).toBe("7 張待歸檔");
    expect(i18n.t("tasksort.headerLink", 7)).toBe("未分類 7 張");   // one name for the place: the tile's 未分類
    expect(i18n.t("tasksort.go")).toBe("前往歸檔");
    expect(i18n.t("tasksort.moved", "M-16", "Shop")).toBe("M-16 已歸檔到 Shop");
    i18n.setLang("en", { store: false });
    expect(i18n.t("tasksort.moved", "M-16", "Shop")).toBe("M-16 filed in Shop");
  });
});
