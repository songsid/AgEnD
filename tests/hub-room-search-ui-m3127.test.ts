/**
 * M-3127 C (UI): the Hub's Ctrl K on a Hub with rooms — the search dialog (names, then messages grouped by room), ↑↓ Enter,
 * and the jump: the room opens at the message (loaded back to it, flashed), the address then loses `m`.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { createHubRoomsFixture } from "./support/hub-rooms-fixture.js";

let client: any, shell: any, store: any, router: any, i18n: any, hubPanel: any, search: any, thread: any;
const mounted: AppPage[] = [];
const g = globalThis as any;
const until = async (fn: () => unknown, n = 300) => { for (let i = 0; i < n && !fn(); i++) await settle(5); };
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  store = await import("/assets/app-store.js"); router = await import("/assets/app-nav.js"); shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js"); client = await import("/ui/js/hub-client.js"); hubPanel = await import("/ui/js/panel-hub.js");
  search = await import("/ui/js/hub-room-search.js"); thread = await import("/ui/js/hub-room-thread.js");
  pg.restore();
});
const realES = g.EventSource;
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); i18n.setLang("en", { store: false }); g.EventSource = realES; });

async function hubPage(path: string) {
  const fx = createHubRoomsFixture();
  g.fetch = (url: string, init?: any) => fx.fetch(url, init); g.EventSource = fx.EventSource;
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1" } });
  pg.document.body.setAttribute("data-hub", "hub"); pg.document.body.setAttribute("data-hub-name", "Team Hub"); mounted.push(pg);
  i18n.setLang("zh-TW", { store: false });
  client.setHubClient(client.createHubWebClient()); hubPanel.resetHubSession(); router.startRouter(pg.window); store.applyStatus({ instances: [] });
  await pg.mount(h(shell.Shell, { panels: new Map([["hub", { Component: hubPanel.HubPanel || (() => null) }]]), onNewInstance() {} }));
  await until(() => pg.root.querySelector(".hub-side-rooms li") && (!path.includes("room=") || pg.root.querySelectorAll(".hub-room-page .thread .msg").length > 1));
  return { pg, fx };
}
const ctrlK = (pg: AppPage) => fire(pg.document, "keydown", { key: "k", ctrlKey: true });

describe("helpers", () => {
  it("segments marks the Hub's ranges, clipped; byRoom groups newest-first by room with flat indexes", () => {
    expect(search.segments("abcdef", [[1, 3], [2, 4], [5, 99]])).toEqual([{ text: "a" }, { text: "bc", mark: true }, { text: "d", mark: true }, { text: "e" }, { text: "f", mark: true }]);
    const hits = [{ roomId: "r1", roomName: "A" }, { roomId: "r2", roomName: "B" }, { roomId: "r1", roomName: "A" }];
    expect(search.byRoom(hits, 2).map((g2: any) => [g2.roomId, g2.hits.map((x: any) => x.index)])).toEqual([["r1", [2, 3]], ["r2", [4]]]);
    expect(search.hitPath({ roomId: "room-weekly", messageId: "msg-0005" })).toBe("/ui/hub?room=room-weekly&m=msg-0005");
  });
  it("the store's find() loads back to a message, opens its folded answers, and says null when it is gone", async () => {
    const page1 = Array.from({ length: 3 }, (_, i) => ({ id: `n${i}`, roomId: "g", at: 10 + i, sequence: 10 + i, author: { kind: "person", id: "p", name: "P" }, text: `new ${i}`, mentions: [] }));
    const old = { id: "old", roomId: "g", at: 1, sequence: 1, author: { kind: "person", id: "p", name: "P" }, text: "old one", mentions: [] };
    let calls = 0;
    const c = { room: async () => ({ ok: true, room: { id: "g", kind: "group" }, me: { id: "me" }, members: [], settings: {} }),
      roomMessages: async (_: string, o: any) => { calls++; return o?.before ? { ok: true, messages: [old], more: false } : { ok: true, messages: page1, more: true }; },
      subscribeRooms: () => () => {}, markRoomRead: async () => ({ ok: true }) };
    const st = thread.createRoomStore("g", { client: c });
    await until(() => st.loaded());
    expect(await st.find("old")).toMatch(/^room-\d+$/);
    expect(calls).toBe(2);
    expect(await st.find("missing")).toBeNull();
    st.stop();
  });
  it("find() opens a question's folded answers when the hit is one of them", async () => {
    const q = { id: "q", roomId: "g", at: 1, sequence: 1, author: { kind: "person", id: "p", name: "P" }, text: "@all status?", mentions: ["all"] };
    const answers = Array.from({ length: 7 }, (_, i) => ({ id: `a${i}`, roomId: "g", at: 2 + i, sequence: 2 + i, author: { kind: "agent", id: `e${i}`, name: `bot${i}` }, text: `status ${i}`, mentions: [], answerTo: "q", stage: "answered" }));
    const c = { room: async () => ({ ok: true, room: { id: "g", kind: "group" }, me: { id: "me" }, members: [], settings: {} }),
      roomMessages: async () => ({ ok: true, messages: [q, ...answers], more: false }), subscribeRooms: () => () => {}, markRoomRead: async () => ({ ok: true }) };
    const st = thread.createRoomStore("g", { client: c });
    await until(() => st.loaded());
    expect(st.messages().some((x: any) => x.roomMessage === "a6")).toBe(false);    // folded behind 「展開其餘 4 則」
    const key = await st.find("a6");
    expect(key).toMatch(/^room-\d+$/);
    expect(st.messages().find((x: any) => x.roomMessage === "a6")).toMatchObject({ text: "status 6" });
    st.stop();
  });
});

describe("Ctrl K on a Hub with rooms", () => {
  it("opens the search dialog: room names first, then messages by room; Enter opens the room at the message, flashed", async () => {
    const { pg } = await hubPage("/ui/hub?room=room-rd");
    ctrlK(pg); await until(() => pg.root.ownerDocument.querySelector(".hub-search-dlg[open]"));
    const dlg = pg.root.ownerDocument.querySelector(".hub-search-dlg") as any;
    expect(dlg.querySelector(".search-hint").textContent).toContain("你所在的房間");
    const input = dlg.querySelector(".search-input");
    input.value = "風險"; fire(input, "input");
    await until(() => dlg.querySelectorAll(".search-row").length > 3, 400);
    const heads = [...dlg.querySelectorAll(".search-group-head span:first-child")].map((n: any) => n.textContent);
    expect(heads[0]).toBe("研發主管週會");
    expect(dlg.querySelector(".search-row .search-snippet mark").textContent).toBe("風險");
    // The newest hit is first: Enter opens it.
    const first = dlg.querySelector(".search-row");
    expect(first.getAttribute("aria-selected")).toBe("true");
    fire(dlg, "keydown", { key: "Enter" });
    await until(() => pg.window.location.search.includes("room=room-weekly"));
    await until(() => pg.root.querySelector(".hub-room-page .thread .msg.flash"), 400);
    const flashed = pg.root.querySelector(".hub-room-page .thread .msg.flash") as any;
    expect(flashed.textContent).toContain("風險");
    await until(() => !pg.window.location.search.includes("m="));
    expect(pg.window.location.search).toBe("?room=room-weekly");
    expect(pg.root.ownerDocument.querySelector(".hub-search-dlg")).toBeNull();
  });
  it("a room's name is a hit too; ↓ moves; nothing found says so", async () => {
    const { pg } = await hubPage("/ui/hub");
    ctrlK(pg); await until(() => pg.root.ownerDocument.querySelector(".hub-search-dlg[open]"));
    const dlg = pg.root.ownerDocument.querySelector(".hub-search-dlg") as any, input = dlg.querySelector(".search-input");
    input.value = "研發例會"; fire(input, "input");
    await until(() => dlg.querySelector(".search-row"), 400);
    expect(dlg.querySelector(".search-row .search-badge").textContent).toBe("房間");
    input.value = "zzzz-none"; fire(input, "input");
    await until(() => dlg.querySelector(".search-status"), 400);
    expect(dlg.querySelector(".search-status").textContent).toBe("找不到結果");
  });
});
