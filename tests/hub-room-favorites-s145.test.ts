/**
 * M-3092 S-145 (docs/design/hub-rooms-ux.md §2: 「釘選、收藏的行為與 Fleet 側欄相同」): the Hub list's favourites, the Fleet
 * sidebar's #1664 rules on the Hub's conversations (src/ui/hub-room-favorites.js, hub-room-list.js):
 * - starred from the row's menu (the Fleet's words: 加入最愛 / 移出最愛), shown in 「最愛」 above 「房間」 and 「Agent」, in
 *   the order starred, and taken out of their own group; at most MAX_FAVORITES; Edit moves them (not while filtered);
 * - kept per Hub sign-in in this browser (the leader's A, s145-scope), behind a source a Hub-side store replaces (S-149);
 *   a blocked or full storage still lists and stars, for this page;
 * - one gone from the list (left, removed) is not shown, and is dropped on the next change.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { createHubRoomsFixture, FIXTURE_ME } from "./support/hub-rooms-fixture.js";

let client: any, shell: any, store: any, router: any, i18n: any, hubPanel: any, list: any, fav: any;
const mounted: AppPage[] = [];
const g = globalThis as any;
const until = async (fn: () => unknown, n = 200) => { for (let i = 0; i < n && !fn(); i++) await settle(5); };
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  store = await import("/assets/app-store.js");
  router = await import("/assets/app-nav.js");
  shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js");
  client = await import("/ui/js/hub-client.js");
  hubPanel = await import("/ui/js/panel-hub.js");
  list = await import("/ui/js/hub-room-list.js");
  fav = await import("/ui/js/hub-room-favorites.js");
  pg.restore();
});
afterEach(async () => {
  for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
  client.setHubClient(null); i18n.setLang("en", { store: false });
  fav.setFavoritesSource(null); fav.loadFavorites(null);
});

/** A source in memory: what was written, per login. */
function memorySource(seed: Record<string, string[]> = {}) {
  const kept = new Map(Object.entries(seed));
  return { kept, read: (login: string) => [...(kept.get(login) || [])], write: (login: string, ids: string[]) => { kept.set(login, [...ids]); }, watch: () => () => {} };
}
const known = (...ids: string[]) => new Set(ids);

describe("the favourites' rules (pure, #1664's)", () => {
  it("star, unstar and move, in the order starred; a full list or an id not listed is refused; kept per sign-in", () => {
    const src = memorySource();
    fav.setFavoritesSource(src);
    fav.loadFavorites("wang");
    const k = known("a", "b", "c");
    expect([fav.toggleFavorite("b", k), fav.toggleFavorite("a", k), fav.toggleFavorite("x", k)]).toEqual([true, true, false]);
    expect(fav.favoritesStore.get().ids).toEqual(["b", "a"]);
    fav.moveFavorite("a", -1, k);
    expect(src.kept.get("wang")).toEqual(["a", "b"]);
    fav.moveFavorite("a", -1, k);                       // already first: nothing
    expect(src.kept.get("wang")).toEqual(["a", "b"]);
    expect(fav.toggleFavorite("a", k)).toBe(true);
    expect(src.kept.get("wang")).toEqual(["b"]);
    fav.loadFavorites("chen");                          // another person on this browser: their own (none)
    expect(fav.favoritesStore.get()).toEqual({ login: "chen", ids: [] });
    const many = known(...Array.from({ length: fav.MAX_FAVORITES + 1 }, (_, i) => `r${i}`));
    for (let i = 0; i < fav.MAX_FAVORITES; i++) expect(fav.toggleFavorite(`r${i}`, many)).toBe(true);
    expect(fav.toggleFavorite(`r${fav.MAX_FAVORITES}`, many)).toBe(false);
  });

  it("one gone from the list is not shown, and the next change drops it", () => {
    const src = memorySource({ wang: ["gone", "a"] });
    fav.setFavoritesSource(src);
    fav.loadFavorites("wang");
    expect(fav.liveFavorites(known("a", "b"))).toEqual(["a"]);
    fav.toggleFavorite("b", known("a", "b"));
    expect(src.kept.get("wang")).toEqual(["a", "b"]);
  });

  it("this browser's storage: one key per sign-in; anything malformed is ignored; blocked storage throws nothing", () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const box = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => box.get(k) ?? null, setItem: (k: string, v: string) => { box.set(k, v); } } });
    try {
      fav.localFavoritesSource.write("wang", ["a", "b"]);
      expect([...box.keys()]).toEqual(["agend_hub_favorites.wang"]);
      expect(fav.localFavoritesSource.read("wang")).toEqual(["a", "b"]);
      box.set("agend_hub_favorites.chen", '["a","a",3,"",null,"b"]');
      expect(fav.localFavoritesSource.read("chen")).toEqual(["a", "b"]);
      box.set("agend_hub_favorites.chen", "{not json");
      expect(fav.localFavoritesSource.read("chen")).toEqual([]);
      Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("SecurityError"); } });
      expect(fav.localFavoritesSource.read("wang")).toEqual([]);
      expect(() => fav.localFavoritesSource.write("wang", ["a"])).not.toThrow();
    } finally {
      if (real) Object.defineProperty(globalThis, "localStorage", real); else delete g.localStorage;
    }
  });

  it("another tab: a storage event for this sign-in's key reloads the favourites; another person's key does not; a new sign-in stops listening to the old one (Fable on #3877)", () => {
    const realLs = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const realAdd = g.addEventListener, realRemove = g.removeEventListener;
    const box = new Map<string, string>(), handlers = new Set<(e: any) => void>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => box.get(k) ?? null, setItem: (k: string, v: string) => { box.set(k, v); } } });
    g.addEventListener = (type: string, fn: any) => { if (type === "storage") handlers.add(fn); };
    g.removeEventListener = (type: string, fn: any) => { if (type === "storage") handlers.delete(fn); };
    const storage = (key: string) => { for (const fn of [...handlers]) fn({ key }); };
    try {
      box.set("agend_hub_favorites.wang", JSON.stringify(["a"]));
      fav.loadFavorites("wang");
      expect([fav.favoritesStore.get().ids, handlers.size]).toEqual([["a"], 1]);
      box.set("agend_hub_favorites.wang", JSON.stringify(["a", "b"]));        // another tab starred b
      box.set("agend_hub_favorites.chen", JSON.stringify(["x"]));
      storage("agend_hub_favorites.chen");
      expect(fav.favoritesStore.get().ids).toEqual(["a"]);                      // someone else's: not this list
      storage("agend_hub_favorites.wang");
      expect(fav.favoritesStore.get().ids).toEqual(["a", "b"]);
      fav.loadFavorites("chen");                                                // another sign-in on this page
      expect([fav.favoritesStore.get().ids, handlers.size]).toEqual([["x"], 1]);
      box.set("agend_hub_favorites.wang", JSON.stringify([]));
      storage("agend_hub_favorites.wang");
      expect(fav.favoritesStore.get()).toEqual({ login: "chen", ids: ["x"] });  // the old sign-in's listener is gone
    } finally {
      fav.loadFavorites(null);
      g.addEventListener = realAdd; g.removeEventListener = realRemove;
      if (realLs) Object.defineProperty(globalThis, "localStorage", realLs); else delete g.localStorage;
    }
  });

  it("the groups: 「最愛」 first in the order starred, each out of its own group; the filter applies to it too", async () => {
    const fx = createHubRoomsFixture();
    const answer = await (await fx.fetch("/hub/v1/rooms")).json();
    const helper = answer.rooms.find((r: any) => r.name === "project-helper"), rd = answer.rooms.find((r: any) => r.name === "研發例會");
    const groups = list.groupRooms(answer.rooms, "", [helper.id, rd.id, "gone"]);
    expect(groups.map((x: any) => [x.key, x.items.map((r: any) => r.name)])).toEqual([
      ["favorites", ["project-helper", "研發例會"]],
      ["rooms", ["研一主管週會", "去年專案"]],
      ["agents", ["report-bot", "Hub assistant"]],
    ]);
    expect(list.groupRooms(answer.rooms, "林小華", [helper.id, rd.id]).map((x: any) => [x.key, x.items.map((r: any) => r.name)]))
      .toEqual([["favorites", ["project-helper"]]]);
    expect(list.groupRooms(answer.rooms).map((x: any) => x.key)).toEqual(["rooms", "agents"]);   // no favourites: as before
  });
});

async function hubApp(fetchImpl: (url: string, init?: any) => Promise<any>, lang = "en", storage: Record<string, string> = {}) {
  const realFetch = g.fetch;
  g.fetch = fetchImpl;
  const pg = page({ url: "http://127.0.0.1:19280/ui/hub", storage: { agend_tour_done: "1", ...storage } });
  pg.document.body.setAttribute("data-hub", "hub"); pg.document.body.setAttribute("data-hub-name", "Team Hub");
  mounted.push(pg);
  i18n.setLang(lang, { store: false });
  client.setHubClient(client.createHubWebClient());
  hubPanel.resetHubSession();
  router.startRouter(pg.window);
  store.applyStatus({ instances: [] });
  const panels = new Map([["hub", { Component: () => h("div", { class: "stub-hub" }, "hub") }]]);
  await pg.mount(h(shell.Shell, { panels, onNewInstance() {} }));
  await settle(10);
  return { pg, restore: () => { g.fetch = realFetch; } };
}
const rows = (pg: AppPage) => [...pg.root.querySelectorAll("#sidebar .hub-side-rooms .v-inst")] as any[];
const names = (pg: AppPage) => rows(pg).map((a) => a.querySelector(".inst-name").textContent);
const heads = (pg: AppPage) => [...pg.root.querySelectorAll("#sidebar .hub-room-group .side-label")].map((x: any) => x.textContent);
async function rowMenu(pg: AppPage, name: string) {
  const li = [...pg.root.querySelectorAll("#sidebar .hub-side-rooms .v-li")].find((r: any) => r.querySelector(".inst-name")?.textContent === name) as any;
  const trigger = li?.querySelector(".inst-row-menu > button");
  expect(trigger, `actions for ${name}`).toBeTruthy();
  if (trigger.getAttribute("aria-expanded") !== "true") { fire(trigger, "pointerdown"); fire(trigger, "click"); await settle(); }
  return { li, trigger, items: [...li.querySelectorAll('[role="menuitem"]')] as any[] };
}
async function choose(pg: AppPage, name: string, label: string) {
  const { items } = await rowMenu(pg, name);
  const item = items.find((b) => b.textContent.trim() === label);
  expect(item, `${label} on ${name}: ${items.map((b) => b.textContent.trim()).join(" | ")}`).toBeTruthy();
  fire(item, "click");
  await settle(10);
  return item;
}

describe("the sidebar: the Fleet's favourites on the Hub list", () => {
  it("star from the row menu: 「最愛」 on top with its count, the row out of its group, its marks; kept for this sign-in", async () => {
    const fx = createHubRoomsFixture();
    const { pg, restore } = await hubApp((url: string, init?: any) => fx.fetch(url, init), "zh-TW");
    try {
      await until(() => rows(pg).length === 6);
      expect(heads(pg)).toEqual(["房間", "Agent"]);
      await choose(pg, "project-helper", "加入最愛");
      await choose(pg, "研發例會", "加入最愛");
      expect(heads(pg)).toEqual(["最愛", "房間", "Agent"]);
      expect([...pg.root.querySelectorAll("#sidebar .hub-room-group .inst-head .count")].map((x: any) => x.textContent)).toEqual(["2", "2", "2"]);
      expect(names(pg)).toEqual(["project-helper", "研發例會", "研一主管週會", "去年專案", "report-bot", "Hub 助理"]);
      const group = pg.root.querySelector('#sidebar [data-group="favorites"]') as any;
      expect([group.getAttribute("role"), group.getAttribute("aria-label"), !!group.querySelector(".fav-head .fav-mark")]).toEqual(["group", "最愛", true]);
      expect(rows(pg)[0].className).toContain("inst-favorite");
      expect(rows(pg)[2].className).not.toContain("inst-favorite");
      const { li, items } = await rowMenu(pg, "project-helper");
      expect(li.querySelector(".inst-row-menu").className).toContain("is-favorite");
      expect(items.map((b) => b.textContent.trim())).toEqual(["移出最愛"]);
      expect(JSON.parse(g.localStorage.getItem(`agend_hub_favorites.${FIXTURE_ME.login}`))).toEqual(["room-helper", "room-rd"]);
      // Unstarred: back in its own group, in its place there.
      await choose(pg, "project-helper", "移出最愛");
      expect(names(pg)).toEqual(["研發例會", "研一主管週會", "去年專案", "project-helper", "report-bot", "Hub 助理"]);
    } finally { restore(); }
  });

  it("Edit moves a favourite (the Fleet's ↑ ↓ items); not while the list is filtered; Done ends it", async () => {
    const fx = createHubRoomsFixture();
    const { pg, restore } = await hubApp((url: string, init?: any) => fx.fetch(url, init), "en");
    try {
      await until(() => rows(pg).length === 6);
      await choose(pg, "report-bot", "Add to favorites");
      expect(pg.root.querySelector("#sidebar .fav-edit")).toBeNull();          // one favourite: nothing to move
      await choose(pg, "研發例會", "Add to favorites");
      const edit = pg.root.querySelector("#sidebar .fav-edit") as any;
      expect([edit.textContent.trim(), edit.getAttribute("aria-pressed")]).toEqual(["Edit", "false"]);
      fire(edit, "click"); await settle(10);
      expect(pg.root.querySelector("#sidebar .fav-edit")?.textContent.trim()).toBe("Done");
      const first = await rowMenu(pg, "report-bot");
      expect(first.items.map((b) => [b.textContent.trim(), b.disabled])).toEqual([["Remove from favorites", false], ["Move report-bot up", true], ["Move report-bot down", false]]);
      await choose(pg, "report-bot", "Move report-bot down");
      expect(names(pg).slice(0, 2)).toEqual(["研發例會", "report-bot"]);
      expect(fav.favoritesStore.get().ids).toEqual(["room-rd", "room-report"]);
      // Filtered (Ctrl K's filter): the moves are there but off, and say why (the Fleet's favFiltered).
      fire(pg.root.querySelector("#sidebar .side-search") as any, "click"); await settle(10);
      const input = pg.root.querySelector("#sidebar .hub-side-filter input") as any;
      input.value = "週"; fire(input, "input"); await settle(10);   // both favourites still shown (their last lines)
      expect(names(pg).slice(0, 2)).toEqual(["研發例會", "report-bot"]);
      const filtered = await rowMenu(pg, "研發例會");
      expect(filtered.items.slice(1).map((b) => [b.disabled, b.getAttribute("title")])).toEqual([
        [true, "Clear the filter to reorder favorites"], [true, "Clear the filter to reorder favorites"]]);
      expect((await rowMenu(pg, "report-bot")).items[1].disabled).toBe(true);   // its up: off for the filter alone
      input.value = ""; fire(input, "input"); await settle(10);
      fire(pg.root.querySelector("#sidebar .fav-edit") as any, "click"); await settle(10);
      expect((await rowMenu(pg, "report-bot")).items.map((b) => b.textContent.trim())).toEqual(["Remove from favorites"]);
    } finally { restore(); }
  });

  it("favourites saved earlier in this browser are there on load; another person's are not", async () => {
    const fx = createHubRoomsFixture();
    const { pg, restore } = await hubApp((url: string, init?: any) => fx.fetch(url, init), "en",
      { [`agend_hub_favorites.${FIXTURE_ME.login}`]: JSON.stringify(["room-archived"]), "agend_hub_favorites.chen": JSON.stringify(["room-weekly"]) });
    try {
      await until(() => heads(pg)[0] === "Favorites");
      expect(names(pg)[0]).toBe("去年專案");
      expect(rows(pg)[0].className).toContain("hub-room-archived");
      expect(names(pg)).toContain("研一主管週會");
    } finally { restore(); }
  });
});
