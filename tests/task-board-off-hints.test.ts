/**
 *, the hints for a task board that is switched off (a new fleet.yaml leaves it on now, but an older one may say
 * `dashboard.task_board: false`, for all agents or for some):
 *  - the Tasks page names the instances that have it off, says what that means, and where to turn it on;
 *  - a card's comment box names the instance a comment would not wake — the card's assignee, an @name in the text — under the
 *    box as the person types, and nothing when every instance it would reach has the board on;
 *  - a `#` reference sent to an instance with the board off: the server says so in the chat (tests/web-chat-task-refs.test.ts).
 * Over a read-only link the page shows no hint (the viewer cannot turn anything on).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage;
let fleet: any, common: any, app: any, nav: any, i18n: any;
const calls: Array<{ method: string; path: string; body: any }> = [];
let BOARD_OFF: string[] = [];
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const card = (over: Record<string, unknown>) => ({ id: "M-1", uuid: String(over.id ?? "M-1"), kind: "main", projectId: 1, parentId: null, title: "A card", status: "claimed",
  assignee: "alpha", dispatcher: { kind: "person", name: "Ann" }, waitsForPerson: false, confirmer: null, priority: "normal", size: null, needsReview: false, dependsOn: [], goal: "", scope: "",
  acceptance: [], context: "", state: "", blockedReason: "", result: "", sort: 1, createdBy: "Ann", version: 2, createdAt: ago(10), updatedAt: ago(1), startedAt: null, submittedAt: null,
  doneAt: null, progress: { total: 0, open: 0, claimed: 0, blocked: 0, review: 0, done: 0 }, unmetDeps: [], commentCount: 0, newCommentCount: 0, lastComment: null, ...over });
const PROJECT = { id: 1, name: "Leaderboard", description: "", archived: false, sort: 1, createdAt: ago(30), leadInstance: null };
let CARDS: any[] = [];
const fetchFake = async (path: string, o: any = {}) => {
  const method = o.method ?? "GET";
  calls.push({ method, path, body: o.body ? JSON.parse(o.body) : null });
  const out: any = (() => {
    if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS, boardOff: BOARD_OFF, leads: ["alpha", "beta", "gamma"] };
    const m = /^\/ui\/tasks\/cards\/([^/]+)$/.exec(path);
    if (m) { const c = CARDS.find((x) => x.id === decodeURIComponent(m[1]!)) ?? CARDS[0]; return { card: c, parent: null, children: [], comments: [], logs: [], history: [], watchers: [], inheritedWatchers: [], leader: null, followsProgress: true }; }
    return {};
  })();
  return { ok: true, status: 200, json: async () => out };
};

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  i18n = await import("/assets/app-i18n.js");
  fleet = await import("/ui/js/panel-fleet.js");
  common = await import("/ui/js/fleet-task-common.js");
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
  (globalThis as any).history.entries.length = 1; (globalThis as any).history.states.length = 1; (globalThis as any).history.at = 0;
  calls.length = 0;
  BOARD_OFF = [];
  CARDS = [card({ id: "M-1", title: "Serve the weekly leaderboard", assignee: "alpha" }), card({ id: "M-2", title: "Add the shop", assignee: "beta", sort: 2 })];
  app.applyStatus({ uptime: 1, instances: ["alpha", "beta", "gamma"].map((name) => ({ name, status: "running", state: "idle", execution_state: "idle" })) });
});

let mounts = 0;
async function mount(card?: string) {
  await p.unmount();
  (globalThis as any).history.replaceState(null, "", card ? `/ui/fleet?card=${card}` : "/ui/fleet");
  (globalThis as any).localStorage.setItem("agend_tasks_project", "1");
  await p.mount(h("div", {}, h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|d5-${++mounts}` })));
  await settle(10);
}
const q = (sel: string) => p.root.querySelector(sel);
const text = (el: any): string => (el ? el.childNodes.map((n: any) => (n.nodeType === 3 ? n.textContent : text(n)) ?? "").map((s: string) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ") : "");
const note = () => q(".tb-boardoff");

describe("the pure part: which instances a comment would not wake", () => {
  const names = [{ name: "alpha", off: true }, { name: "beta", off: false }, { name: "gamma", off: true }, { name: "dev-a", off: true }];
  it("the card's assignee when it has the board off; an @name in the text; neither when the board is on", () => {
    expect(common.boardOffTargets(names, "alpha", "")).toEqual(["alpha"]);
    expect(common.boardOffTargets(names, "beta", "")).toEqual([]);
    expect(common.boardOffTargets(names, "beta", "please look @gamma")).toEqual(["gamma"]);
    expect(common.boardOffTargets(names, "alpha", "@gamma and @beta, thanks")).toEqual(["alpha", "gamma"]);
    expect(common.boardOffTargets(names, null, "(@dev-a) and 請@gamma看")).toEqual(["gamma", "dev-a"]);
  });
  it("read as the server reads a mention: case does not matter; code is not one; a longer name or an address is not it", () => {
    expect(common.boardOffTargets(names, "beta", "@Gamma")).toEqual(["gamma"]);
    expect(common.boardOffTargets(names, "beta", "`@gamma` and ```\n@alpha\n```")).toEqual([]);
    expect(common.boardOffTargets(names, "beta", "me@example.com and @gamma-2 and a/@gamma")).toEqual([]);
    expect(common.boardOffTargets(names, "beta", "@dev-a2")).toEqual([]);
    expect(common.boardOffTargets(undefined, "alpha", "x")).toEqual([]);
  });
});

describe("the Tasks page", () => {
  it("names the instances with the task board off, what that means, and where to turn it on", async () => {
    BOARD_OFF = ["beta", "gamma"];
    await mount();
    const n = note();
    expect(n).toBeTruthy();
    expect(n.getAttribute("role")).toBe("note");
    expect(text(n)).toBe("The task board is switched off for beta, gamma: cards cannot be handed to them, comments and @mentions do not wake them, and they get no [Task board] notices. Turn it on in Settings → Shared agent settings (every agent), or in the agent's own Settings → Advanced → Dashboard access.");
    expect(n.querySelector("a").getAttribute("href")).toBe("/settings/agent-defaults");
  });
  it("says nothing when every instance has it on", async () => {
    await mount();
    expect(note()).toBeNull();
  });
  it("is in 繁體中文 too", async () => {
    BOARD_OFF = ["beta"];
    i18n.setLang("zh-TW", { store: false });
    await mount();
    expect(text(note()).replace(/\s+/g, "")).toBe("beta 的任務板是關閉的：不能指派卡片給它，留言和 @ 也叫不醒它，它也收不到 [Task board] 通知。要打開：設定 → Agent 共用設定（所有 Agent），或這個 Agent 自己的設定 → 進階 → 網頁儀表板權限。".replace(/\s+/g, ""));
  });
  it("over a read-only link there is no hint: the viewer cannot turn anything on; the link's admin session (M-3278) sees it", async () => {
    BOARD_OFF = ["beta"];
    body().dataset.publicLink = "1";
    await mount();
    expect(note()).toBeNull();
    body().dataset.linkMedia = "1";
    await mount();
    expect(note()).toBeTruthy();
  });
});

describe("a card's comment box", () => {
  const box = () => q(".tc-composer textarea");
  const type = async (value: string) => { box().value = value; fire(box(), "input"); await settle(4); };
  it("names the assignee when it has the board off — before anything is typed — and an @name that has it off", async () => {
    BOARD_OFF = ["alpha", "gamma"];
    await mount("M-1");
    expect(box()).toBeTruthy();
    expect(text(note())).toContain("The task board is switched off for alpha, so this comment will not wake them. Turn it on in Settings → Shared agent settings");
    await type("@gamma could you look?");
    expect(text(note())).toContain("switched off for alpha, gamma, so this comment will not wake them");
    await type("");
    expect(text(note())).toContain("switched off for alpha,");
    expect(text(note())).not.toContain("gamma");
  });
  it("says nothing for a card whose assignee has the board on, until an @name that has it off is typed", async () => {
    BOARD_OFF = ["gamma"];
    await mount("M-1");
    expect(note()).toBeNull();
    await type("@beta hello");
    expect(note()).toBeNull();
    await type("@gamma hello");
    expect(text(note())).toContain("switched off for gamma, so this comment will not wake them");
    await type("`@gamma` is only quoted");
    expect(note()).toBeNull();
  });
});
