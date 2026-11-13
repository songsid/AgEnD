/**
 * M-3092 PR 1b (Hub rooms, track U): the Hub's conversation list on the Fleet roster's rows (src/ui/hub-room-list.js),
 * docs/design/hub-rooms-ux.md §2, against tests/support/hub-rooms-fixture.ts:
 * - two groups — 「房間」 then 「Agent」 — unread first, then by the last message, archived last; 「Hub 助理」 last;
 * - the Fleet row (`li.v-li > a.inst.v-inst`, `.av` with `.av-dot`, `.inst-name`, `.inst-alt`, `.nav-count`): a square
 *   avatar for a room, the agent's presence dot for a chat, an unread count and an @ mark;
 * - today's chats (a Hub without rooms): no dot or count they don't have, waiting and closed still said;
 * - an open tab whose client is older than this page (no roomList()): the same list from rooms().
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { createHubRoomsFixture } from "./support/hub-rooms-fixture.js";

let client: any, shell: any, store: any, router: any, i18n: any, hubPanel: any, list: any;
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
  pg.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); i18n.setLang("en", { store: false }); });

async function hubApp(fetchImpl: (url: string, init?: any) => Promise<any>, lang = "en") {
  const realFetch = g.fetch;
  g.fetch = fetchImpl;
  const pg = page({ url: "http://127.0.0.1:19280/ui/hub", storage: { agend_tour_done: "1" } });
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

describe("the list's groups and rows (pure)", () => {
  it("rooms then agents; unread first, then by the last message; archived last; the Hub assistant last", async () => {
    const fx = createHubRoomsFixture();
    const answer = await (await fx.fetch("/hub/v1/rooms")).json();
    const groups = list.groupRooms(answer.rooms);
    expect(groups.map((x: any) => [x.key, x.items.map((r: any) => r.name)])).toEqual([
      ["rooms", ["研一主管週會", "研發例會", "去年專案"]],
      ["agents", ["project-helper", "report-bot", "Hub assistant"]],   // stored names; the rows name it by its flag
    ]);
    expect(list.groupRooms(answer.rooms, "林小華").map((x: any) => x.items.map((r: any) => r.name))).toEqual([["project-helper"]]);   // by owner
    i18n.setLang("zh-TW", { store: false });
    expect(list.rowView(answer.rooms.find((r: any) => r.name === "研一主管週會"))).toMatchObject({ line2: "3 人 · 12 個 Agent", avatar: { square: true, text: "研" }, dot: null, unread: 2 });
    expect(list.rowView(answer.rooms.find((r: any) => r.name === "report-bot"))).toMatchObject({ line2: "吳小安", avatar: { square: false }, dot: "off" });
    expect(list.rowView(answer.rooms.find((r: any) => r.assistant))).toMatchObject({ title: "Hub 助理", line2: "Hub 提供", dot: "ok" });
    expect(list.rowView(answer.rooms.find((r: any) => r.name === "去年專案"))).toMatchObject({ archived: true });
  });
  it("archived stays last and the Hub assistant stays last, whatever their time or unread (Fable via Muse)", () => {
    const at = (n: number) => 1_000_000 + n;
    const rows = [
      { id: "g-old", kind: "group", name: "Old", people: 2, agents: 1, unread: 0, lastAt: at(1) },
      { id: "g-arch", kind: "group", name: "Archived", people: 2, agents: 1, unread: 9, lastAt: at(99), archived: true },
      { id: "g-new", kind: "group", name: "New", people: 2, agents: 1, unread: 0, lastAt: at(5) },
      { id: "d-hub", kind: "direct", name: "Hub assistant", unread: 4, lastAt: at(100), assistant: true, presence: "idle" },
      { id: "d-a", kind: "direct", name: "agent-a", unread: 0, lastAt: at(2), agent: { owner: { name: "A" }, presence: "idle" } },
      { id: "d-b", kind: "direct", name: "agent-b", unread: 1, lastAt: at(3), agent: { owner: { name: "B" }, presence: "working" } },
    ];
    expect(list.groupRooms(rows).map((g: any) => g.items.map((r: any) => r.id))).toEqual([["g-new", "g-old", "g-arch"], ["d-b", "d-a", "d-hub"]]);
    expect(list.rowView(rows[3]).dot).toBe("ok");
    expect(list.rowView({ ...rows[3], presence: "paused" }).dot).toBe("warn");                       // 暫時無法回答
  });
  it("today's chats: no dot or count; waiting is the working dot and said; closed is said and set apart", () => {
    const base = { id: "r1", exposureId: "e1", grantId: "g1", state: "active", exposureName: "Sales numbers", ownerName: "Olivia", lastAt: 5, waiting: false, features: [] };
    expect(list.rowView(list.listRoomOf(base))).toMatchObject({ line2: "Olivia", dot: null, unread: 0, mentioned: false });
    expect(list.rowView(list.listRoomOf({ ...base, waiting: true }))).toMatchObject({ line2: "Waiting for an answer", dot: "busy" });
    expect(list.rowView(list.listRoomOf({ ...base, state: "closed", waiting: true }))).toMatchObject({ line2: "Closed", dot: null, archived: true });
    expect(list.listRoomOf(base)).toEqual(client.legacyRoom(base));                                      // the client's mapping, exactly
    expect(list.listRoomOf(null)).toBeNull();
  });
  it("presence as the Fleet sidebar's dots (spec §5's colours)", () => {
    expect(["online", "idle", "working", "paused", "offline", "later", undefined].map(list.presenceDot)).toEqual(["ok", "ok", "busy", "warn", "off", "off", null]);
  });
});

describe("the sidebar, drawn as the Fleet roster", () => {
  it("a Hub with rooms: both groups with their counts; the Fleet row's parts; square room avatars, presence dots, unread, @ mark", async () => {
    const fx = createHubRoomsFixture();
    const { pg, restore } = await hubApp((url: string, init?: any) => fx.fetch(url, init), "zh-TW");
    try {
      await until(() => rows(pg).length === 6);
      expect([...pg.root.querySelectorAll("#sidebar .hub-room-group .side-label")].map((x: any) => x.textContent)).toEqual(["房間", "Agent"]);
      expect([...pg.root.querySelectorAll("#sidebar .hub-room-group .inst-head .count")].map((x: any) => x.textContent)).toEqual(["3", "3"]);
      expect(rows(pg).map((a) => a.querySelector(".inst-name").textContent)).toEqual(["研一主管週會", "研發例會", "去年專案", "project-helper", "report-bot", "Hub 助理"]);
      const weekly = rows(pg)[0];
      expect([weekly.closest("li").className, !!weekly.querySelector(".av.av-square"), weekly.querySelector(".av-dot"), weekly.querySelector(".inst-alt").textContent,
        weekly.querySelector(".nav-count").textContent]).toEqual(["v-li two-line", true, null, "3 人 · 12 個 Agent", "2"]);
      expect(rows(pg).map((a) => a.querySelector(".av-dot")?.className.replace("av-dot dot ", "") ?? null)).toEqual([null, null, null, "busy", "off", "ok"]);
      expect(rows(pg)[2].className).toContain("hub-room-archived");
      expect(rows(pg)[0].getAttribute("href")).toBe("/ui/hub?room=room-weekly");
    } finally { restore(); }
  });
  it("「新房間」 for someone who may open rooms on a Hub with rooms; not on today's Hub", async () => {
    const fx = createHubRoomsFixture();
    const { pg, restore } = await hubApp((url: string, init?: any) => fx.fetch(url, init), "zh-TW");
    try {
      await until(() => rows(pg).length === 6);
      expect(pg.root.querySelector("#sidebar .side-nav .hub-new-room")!.textContent).toBe("新房間");
    } finally { restore(); }
  });
  it("no 「新房間」 on today's Hub (no rooms)", async () => {
    const legacy = [{ id: "11111111-2222-4333-8444-555555555555", exposureId: "e1", grantId: "g1", state: "active", exposureName: "Sales numbers", ownerName: "Olivia", lastAt: 1, waiting: false, features: [] }];
    const old = await hubApp(async (url: string) => ({ ok: true, status: 200, headers: { get: () => null },
      json: async () => url.startsWith("/hub/v1/session") ? { signedIn: true, displayName: "Alex", csrf: "c".repeat(64) } : url.startsWith("/hub/v1/rooms") ? { rooms: legacy } : {} }));
    try {
      await until(() => rows(old.pg).length === 1);
      expect(old.pg.root.querySelector("#sidebar .side-nav .hub-new-room")).toBeNull();
    } finally { old.restore(); }
  });
  it("Ctrl K filters by a name or an owner across both groups; an empty group is left out", async () => {
    const fx = createHubRoomsFixture();
    const { pg, restore } = await hubApp((url: string, init?: any) => fx.fetch(url, init));
    try {
      await until(() => rows(pg).length === 6);
      fire(pg.document as any, "keydown", { key: "k", ctrlKey: true }); await settle(10);
      const input = pg.root.querySelector("#sidebar .hub-side-filter input") as any;
      input.value = "吳小安"; fire(input, "input"); await settle(5);
      expect(rows(pg).map((a) => a.querySelector(".inst-name").textContent)).toEqual(["report-bot"]);
      expect([...pg.root.querySelectorAll("#sidebar .hub-room-group")].map((x: any) => x.dataset.group)).toEqual(["agents"]);
    } finally { restore(); }
  });
  it("an open tab whose client is older than this page (rooms() only): today's chats in the same rows", async () => {
    const legacy = [{ id: "11111111-2222-4333-8444-555555555555", exposureId: "e1", grantId: "g1", state: "active", exposureName: "Sales numbers", ownerName: "Olivia", lastAt: 1, waiting: true, features: [] }];
    const old = { rooms: async () => ({ ok: true, rooms: legacy }) };
    expect(await list.readRoomList(old)).toMatchObject({ ok: true, rooms: [{ id: legacy[0]!.id, kind: "direct", name: "Sales numbers", limited: true, legacy: legacy[0] }] });
    const fresh = { roomList: async () => ({ ok: true, rooms: [] }), rooms: async () => { throw Error("not called"); } };
    expect(await list.readRoomList(fresh)).toEqual({ ok: true, rooms: [] });
  });
});
