/**
 * A card's page says who hears about it — its watchers (added and removed from the property column) and its
 * leader (read-only: the project's lead, or the board's default).
 *  - what the Add menu lists and why a leader would hear nothing (pure);
 *  - the page: the two rows, a watcher added and removed through POST /ui/tasks/cards/<id>/watchers, the card read again,
 *    a refusal shown in the page's words, ten watchers (the board's limit) disabling Add, a board-off instance greyed;
 *  - a sub task shows its main task's watchers as inherited; a read-only reader gets the lists only;
 *  - the page's words exist in both languages, and an older board's read (no `watchers`, no `leader`) still opens.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

let p: AppPage;
let app: any, nav: any, fleet: any, follow: any, i18n: any, toasts: any, preact: any;
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
const M1 = card({ id: "M-1", title: "Serve the weekly leaderboard", status: "claimed", assignee: "alpha" });
const S1 = card({ id: "S-1", kind: "sub", parentId: "M-1", title: "Price list", status: "open", assignee: "beta" });
const CARDS = [M1, S1];

/** The board's read of one card; each test says what is different about its followers. */
let follow301: Record<string, unknown> = {};
const detailOf = (id: string) => {
  const c: any = CARDS.find((x: any) => x.id === id) ?? card({ id });
  return { card: c, parent: c.parentId ? { id: "M-1", title: M1.title, status: "claimed" } : null, children: c.id === "M-1" ? [S1] : [],
    comments: [], logs: [], history: [], watchers: [], inheritedWatchers: [], leader: null, followsProgress: true, ...follow301 };
};

beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = fetchFake;
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  i18n = await import("/assets/app-i18n.js");
  toasts = await import("/assets/ui-toast.js");
  preact = await import("/assets/app-html.js");
  fleet = await import("/ui/js/panel-fleet.js");
  follow = await import("/ui/js/fleet-task-follow.js");
  await import("/ui/js/fleet-task-card.js");
  nav.startRouter(p.window);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
let boardOff: string[] = [];
let onWatch: (body: any) => Reply = () => ({});
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
  boardOff = [];
  follow301 = {};
  onWatch = () => ({});
  handler = (path, method, body) => {
    if (path.startsWith("/ui/tasks/board")) return { rev: 1, projects: [PROJECT], cards: CARDS, boardOff };
    const w = /^\/ui\/tasks\/cards\/([^/]+)\/watchers$/.exec(path);
    if (w && method === "POST") return onWatch(body);
    const m = /^\/ui\/tasks\/cards\/([^/]+)(\/move)?$/.exec(path);
    if (m && method === "POST") return { card: M1, notes: [] };
    if (m) return detailOf(decodeURIComponent(m[1]!));
    return {};
  };
  app.applyStatus({ uptime: 1, instances: ["alpha", "beta", "gamma", "delta"].map((name) => ({ name, status: "running", state: "idle", execution_state: "idle" })) });
});

let mounts = 0;
async function mount() {
  await p.unmount();
  (globalThis as any).localStorage.setItem("agend_tasks_project", "1");
  await p.mount(h(preact.Fragment, null, h(fleet.FleetPanel, { route: { panel: "fleet", tab: "tasks" }, navKey: `fleet:tasks|w301-${++mounts}|en` }), h(toasts.Toasts, null)));
  await settle(8);
}
const q = (sel: string) => p.root.querySelector(sel);
const qa = (sel: string) => [...p.root.querySelectorAll(sel)] as any[];
const text = (el: any): string | null => (el ? el.childNodes.map((n: any) => (n.nodeType === 3 ? n.textContent : text(n)) ?? "").map((s: string) => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ") : null);
const flat = (el: any) => (text(el) ?? "").replace(/\s+/g, "");
const posts = () => calls.filter((c) => c.method === "POST");
async function openCard(id: string) { fire(q(`[data-tile="${id}"] .tb-tile-title`) ?? q(`[data-row="${id}"] .tb-row-title`), "click"); await settle(10); }
const rows = () => ({ watchers: q('[data-follow="watchers"]'), leader: q('[data-follow="leader"]') });
const watching = () => qa("[data-watcher]").map((li) => li.getAttribute("data-watcher"));
async function openAdd() { fire(q(".tp-watch-add > button"), "click"); await settle(4); }
const addChoices = () => qa(".tp-watch-add .menu-list button");

describe("what the Add menu lists, and why a leader would hear nothing", () => {
  const act = () => {};
  it("the fleet's instances that do not watch yet, in order; one with the task board off is disabled and says why", () => {
    const items = follow.watchItems({ names: ["gamma", "alpha", "beta", "alpha"], watchers: ["beta"], boardOff: ["gamma"], act });
    expect(items.map((i: any) => i.key)).toEqual(["n:alpha", "n:gamma"]);
    expect(items.map((i: any) => i.disabled)).toEqual([false, true]);
    expect(items[1].label).toBe("gamma (task board off)");
    expect(items[1].title).toMatch(/task board/i);
    expect(follow.watchItems({ names: ["alpha"], watchers: ["alpha"], act })).toEqual([]);
  });
  it("a choice adds that instance", () => {
    const got: string[] = [];
    follow.watchItems({ names: ["alpha"], watchers: [], act: (n: string) => got.push(n) })[0].onSelect();
    expect(got).toEqual(["alpha"]);
  });
  it("the limit is the board's", () => { expect(follow.WATCH_MAX).toBe(10); });
  it("the leader hears it unless the notices are off, it left the fleet, its board is off, or it has the card itself", () => {
    const leader = { name: "gamma", via: "project" };
    const base = { leader, assignee: "alpha", names: ["alpha", "gamma"], boardOff: [] as string[], followsProgress: true };
    expect(follow.leaderCaveat(base)).toBeNull();
    expect(follow.leaderCaveat({ ...base, leader: null })).toBeNull();
    expect(follow.leaderCaveat({ ...base, followsProgress: false })).toMatch(/notices are switched off/);
    expect(follow.leaderCaveat({ ...base, names: ["alpha"] })).toMatch(/Not in the fleet/);
    expect(follow.leaderCaveat({ ...base, boardOff: ["gamma"] })).toMatch(/task board is off/);
    expect(follow.leaderCaveat({ ...base, assignee: "gamma" })).toMatch(/has the card/);
    // The switch is the first thing said: nobody is told whoever the leader is.
    expect(follow.leaderCaveat({ ...base, followsProgress: false, names: [] })).toMatch(/notices are switched off/);
  });
});

describe("a card's page: Watchers and Leader in the property column", () => {
  it("lists the watchers (each with a remove button) and names the leader with where it comes from", async () => {
    follow301 = { watchers: ["beta", "gamma"], leader: { name: "delta", via: "project" } };
    await mount(); await openCard("M-1");
    const { watchers, leader } = rows();
    expect(watchers).toBeTruthy();
    expect(text(watchers.querySelector("dt"))).toContain("Watchers");
    expect(flat(watchers.querySelector("dt"))).toContain("(2/10)");
    expect(watching()).toEqual(["beta", "gamma"]);
    expect(qa("[data-watcher] .tp-watch-x").map((b) => b.getAttribute("aria-label"))).toEqual(["Stop beta watching this card", "Stop gamma watching this card"]);
    expect(text(leader.querySelector("dt"))).toBe("Leader");
    expect(text(leader.querySelector(".tb-who"))).toBe("delta");
    expect(text(leader.querySelector(".tp-leader-via"))).toBe("project lead");
    expect(q('[data-follow="leader"] .tp-leader-note')).toBeNull();
    expect(qa(".tp-watch-add")).toHaveLength(1);
  });

  it("nobody watching and no leader: it says so, and Add is there", async () => {
    await mount(); await openCard("M-1");
    expect(text(rows().watchers.querySelector("dd"))).toContain("Nobody");
    expect(text(rows().leader.querySelector("dd"))).toBe("None");
    // The hint is neutral: a read-only reader whose leader is kept out of sight reads the same "none" — it neither says there is one nor sends them to set one.
    const hint = rows().leader.querySelector("dd span").getAttribute("title");
    expect(hint).toBe("Nobody is named as this card's leader");
    expect(hint).not.toMatch(/set|lead on|defaults|project/i);
    i18n.setLang("zh-TW", { store: false });
    expect(i18n.t("taskfollow.leaderNoneHint")).toBe("這張卡沒有指定 leader");
    expect(i18n.t("taskfollow.leaderNoneHint")).not.toMatch(/設定|設/);
    i18n.setLang("en", { store: false });
    expect(q("[data-watcher]")).toBeNull();
    expect(q(".tp-watch-add")).toBeTruthy();
  });

  it("the board's default leader reads as `board default`; one that has the card itself, or hears no notices, says why it is told nothing", async () => {
    follow301 = { leader: { name: "alpha", via: "board" } };
    await mount(); await openCard("M-1");
    expect(text(rows().leader.querySelector(".tp-leader-via"))).toBe("board default");
    expect(text(q('[data-follow="leader"] .tp-leader-note'))).toMatch(/has the card/);
    follow301 = { leader: { name: "delta", via: "board" }, followsProgress: false };
    (globalThis as any).history.replaceState(null, "", "/ui/fleet");
    await mount(); await openCard("M-1");
    expect(text(q('[data-follow="leader"] .tp-leader-note'))).toMatch(/notices are switched off/);
  });

  it("Add: an instance picked from the menu is sent as `add`, the card is read again, and the menu lists only those not watching", async () => {
    follow301 = { watchers: ["beta"] };
    onWatch = (body) => { follow301 = { ...follow301, watchers: ["beta", ...body.add] }; return { card: M1, watchers: ["beta", ...body.add], notes: [] }; };
    await mount(); await openCard("M-1");
    await openAdd();
    expect(addChoices().map((b) => text(b))).toEqual(["alpha", "delta", "gamma"]);
    const before = calls.filter((c) => c.method === "GET" && c.path === "/ui/tasks/cards/M-1").length;
    fire(addChoices().find((b) => text(b) === "gamma"), "click"); await settle(12);
    expect(posts().map((c) => [c.path, c.body])).toEqual([["/ui/tasks/cards/M-1/watchers", { add: ["gamma"] }]]);
    expect(calls.filter((c) => c.method === "GET" && c.path === "/ui/tasks/cards/M-1").length).toBeGreaterThan(before);
    expect(watching()).toEqual(["beta", "gamma"]);
    expect(flat(rows().watchers.querySelector("dt"))).toContain("(2/10)");
  });

  it("Remove: the ✕ sends `remove` for that instance, and the row follows the card read again", async () => {
    follow301 = { watchers: ["beta", "gamma"] };
    onWatch = (body) => { follow301 = { ...follow301, watchers: (follow301.watchers as string[]).filter((n) => !body.remove.includes(n)) }; return { card: M1, watchers: follow301.watchers, notes: [] }; };
    await mount(); await openCard("M-1");
    fire(q('[data-watcher="beta"] .tp-watch-x'), "click"); await settle(12);
    expect(posts().map((c) => [c.path, c.body])).toEqual([["/ui/tasks/cards/M-1/watchers", { remove: ["beta"] }]]);
    expect(watching()).toEqual(["gamma"]);
  });

  it("a refusal is shown in the page's words, and the row is as it was: an instance with the task board off, a full card", async () => {
    await mount(); await openCard("M-1");
    onWatch = () => ({ __status: 403, error: "gamma has the task board switched off", code: "forbidden", key: "watcher_board_off", args: ["gamma"] });
    await openAdd();
    fire(addChoices().find((b) => text(b) === "gamma"), "click"); await settle(12);
    expect(qa(".toast.err").map((el) => text(el))).toEqual(["gamma has the task board switched off: it cannot read or move cards, so a notice would reach nothing it can act on"]);
    expect(watching()).toEqual([]);
    onWatch = () => ({ __status: 400, error: "M-1 can have at most 10 watchers", code: "invalid", key: "watchers_max", args: ["M-1", 10] });
    await openAdd();
    fire(addChoices().find((b) => text(b) === "alpha"), "click"); await settle(12);
    expect(qa(".toast.err").map((el) => text(el))).toContain("M-1 can have at most 10 watchers");
    expect(watching()).toEqual([]);
  });

  it("an instance with the task board off is listed but cannot be picked", async () => {
    boardOff = ["delta"];
    await mount(); await openCard("M-1");
    await openAdd();
    const delta = addChoices().find((b) => /delta/.test(text(b) ?? ""));
    expect(text(delta)).toBe("delta (task board off)");
    expect(delta.disabled).toBe(true);
    fire(delta, "click"); await settle(6);
    expect(posts()).toEqual([]);
  });

  it("ten watchers is the most: Add gives way to the reason, and every one can still be removed", async () => {
    const ten = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "a10"];
    follow301 = { watchers: ten };
    await mount(); await openCard("M-1");
    expect(watching()).toEqual(ten);
    expect(q(".tp-watch-add")).toBeNull();
    expect(text(rows().watchers.querySelector("dd"))).toContain("at most 10 watchers");
    expect(qa("[data-watcher] .tp-watch-x")).toHaveLength(10);
    // One of them is gone from the fleet: its chip says so, and it can still be removed.
    expect(q('[data-watcher="a1"] .tb-person').getAttribute("title")).toBe("a1 is no longer in the fleet");
  });

  it("a sub task also hears its main task's watchers: shown as inherited, apart from its own", async () => {
    follow301 = { watchers: ["gamma"], inheritedWatchers: ["beta", "gamma"] };
    await mount(); await openCard("M-1");
    // The main task has none inherited; the sub task (opened from the board's list of sub tasks) shows its main task's.
    follow301 = { watchers: ["gamma"], inheritedWatchers: ["beta", "gamma"] };
    (globalThis as any).history.pushState(null, "", "/ui/fleet?card=S-1");
    await mount();
    const dd = text(rows().watchers.querySelector("dd")) ?? "";
    expect(dd).toContain("Also from M-1: beta");
    expect(dd).not.toContain("Also from M-1: beta, gamma");           // gamma watches the sub task itself: said once
    expect(watching()).toEqual(["gamma"]);
  });

  it("an older board's read (no watchers, no leader, nothing of the notices) still opens", async () => {
    handler = ((old) => (path: string, method: string, body: any) => {
      const d: any = old(path, method, body);
      if (d && d.card && !path.endsWith("/move")) { delete d.watchers; delete d.inheritedWatchers; delete d.leader; delete d.followsProgress; }
      return d;
    })(handler);
    await mount(); await openCard("M-1");
    expect(rows().watchers).toBeTruthy();
    expect(watching()).toEqual([]);
    expect(text(rows().leader.querySelector("dd"))).toBe("None");
  });
});

describe("the rows read-only, and in Traditional Chinese", () => {
  it("a read-only reader sees the lists and nothing to change", async () => {
    follow301 = { watchers: ["beta"], leader: { name: "gamma", via: "board" } };
    const detail: any = { ...detailOf("M-1"), ...follow301 };
    await p.unmount();
    await p.mount(h("dl", null, h(follow.FollowRows, { detail, names: ["alpha", "beta", "gamma"], boardOff: [], can: false, follow: () => { throw new Error("read-only: nothing is written"); } })));
    expect(qa("[data-watcher]").map((li) => li.getAttribute("data-watcher"))).toEqual(["beta"]);
    expect(q(".tp-watch-x")).toBeNull();
    expect(q(".tp-watch-add")).toBeNull();
    expect(text(q('[data-follow="leader"] .tb-who'))).toBe("gamma");
    expect(text(q('[data-follow="leader"] .tp-leader-via'))).toBe("board default");
  });

  it("every word of the rows and every refusal the watchers route can make is in both languages", () => {
    const keys = ["watchers", "watchersHint", "noWatchers", "add", "addTitle", "full", "noneToAdd", "remove", "gone", "fromMain", "leader", "leaderNone", "leaderHint", "viaProject", "viaBoard",
      "leaderAssignee", "leaderGone", "leaderBoardOff", "leaderNoNotices", "leaderNoneHint"].map((k) => `taskfollow.${k}`)
      .concat(["watcher_unknown", "watcher_board_off", "watchers_max", "watch_not_board"].map((k) => `tasks.err.${k}`));
    for (const key of keys) {
      const en = i18n.tIn("en", key), zh = i18n.tIn("zh-TW", key);
      expect(en, key).not.toBe(key);
      expect(zh, key).not.toBe(key);
      if (key !== "taskfollow.leader") expect(zh, `${key} is translated`).not.toBe(en);       // "Leader" is the word in both
      // The values a sentence takes are the same in both languages.
      const holes = (s: string) => [...new Set(s.match(/\{\d\}/g) ?? [])].sort().join();
      expect(holes(zh), `${key} placeholders`).toBe(holes(en));
    }
  });

  it("in Traditional Chinese the rows say 關注者 and Leader, with the source", async () => {
    follow301 = { watchers: ["beta"], leader: { name: "delta", via: "project" } };
    i18n.setLang("zh-TW", { store: false });
    await mount(); await openCard("M-1");
    expect(text(rows().watchers.querySelector("dt"))).toContain("關注者");
    expect(text(rows().leader.querySelector(".tb-who"))).toBe("delta");
    expect(text(rows().leader.querySelector(".tp-leader-via"))).toBe("專案負責人");
    expect(q('[data-watcher="beta"] .tp-watch-x').getAttribute("aria-label")).toBe("讓 beta 不再關注這張卡");
    expect(text(q(".tp-watch-add > button"))).toBe("新增");
  });
});
