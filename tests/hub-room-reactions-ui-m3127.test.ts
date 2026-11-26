/**
 * M-3127 A (UI): people's reactions in a Hub group room, on the Fleet chat's own thread — against the rooms fixture:
 * - the chips under a message: emoji + count, mine pressed, the label naming who; pressing mine takes it back;
 * - Add reaction (the hover strip) opens the quick picker; a pick adds mine and closes it; Escape closes it;
 * - the store keeps a message's reactions from the server (an update without them has none left);
 * - a refusal is a toast; an archived room shows the chips but takes none;
 * - the Fleet chat's thread without opts.react is unchanged (no Add reaction, the agent's #2305 reactions as before);
 * - the message menu's React item exists only when the page gives one.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { createHubRoomsFixture } from "./support/hub-rooms-fixture.js";

let client: any, shell: any, store: any, router: any, i18n: any, hubPanel: any, thread: any, chatThread: any, msgActions: any;
const mounted: AppPage[] = [];
const g = globalThis as any;
const until = async (fn: () => unknown, n = 200) => { for (let i = 0; i < n && !fn(); i++) await settle(5); };
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  store = await import("/assets/app-store.js"); router = await import("/assets/app-nav.js"); shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js"); client = await import("/ui/js/hub-client.js"); hubPanel = await import("/ui/js/panel-hub.js");
  thread = await import("/ui/js/hub-room-thread.js"); chatThread = await import("/assets/chat-thread.js"); msgActions = await import("/assets/chat-msg-actions.js");
  pg.restore();
});
const realES = g.EventSource;
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); i18n.setLang("en", { store: false }); g.EventSource = realES; });

async function roomPage(roomId: string, lang = "en") {
  const fx = createHubRoomsFixture();
  g.fetch = (url: string, init?: any) => fx.fetch(url, init); g.EventSource = fx.EventSource;
  const pg = page({ url: `http://127.0.0.1:19280/ui/hub?room=${roomId}`, storage: { agend_tour_done: "1" } });
  pg.document.body.setAttribute("data-hub", "hub"); pg.document.body.setAttribute("data-hub-name", "Team Hub"); mounted.push(pg);
  i18n.setLang(lang, { store: false });
  client.setHubClient(client.createHubWebClient()); hubPanel.resetHubSession(); router.startRouter(pg.window); store.applyStatus({ instances: [] });
  await pg.mount(h(shell.Shell, { panels: new Map([["hub", { Component: hubPanel.HubPanel || (() => null) }]]), onNewInstance() {} }));
  await until(() => pg.root.querySelectorAll(".hub-room-page .thread .msg").length > 5);
  return { pg, fx };
}
const msgs = (pg: AppPage) => [...pg.root.querySelectorAll(".hub-room-page .thread .msg[data-key]")] as any[];
const withText = (pg: AppPage, text: string) => msgs(pg).find((n) => (n.textContent || "").includes(text));
const chips = (node: any) => [...node.querySelectorAll(".react-bar .react-chip")].map((c: any) => `${c.querySelector(".e").textContent}${c.querySelector(".n").textContent}${c.getAttribute("aria-pressed") === "true" ? "*" : ""}`);

describe("reactionBar (the chips' data)", () => {
  it("mine, counts and who: me first as You, then known names, the rest as others", () => {
    i18n.setLang("en", { store: false });
    const names = new Map([["a", "Alex"], ["b", "Bob"], ["c", "Cara"], ["d", "Dan"]]);
    const bar = thread.reactionBar([{ emoji: "👍", count: 5, members: ["b", "me", "a", "gone", "c"] }, { emoji: "🎉", count: 1, members: ["d"] }, { emoji: "x", count: 0, members: [] }], { meId: "me", names });
    expect(bar).toEqual([
      { emoji: "👍", count: 5, mine: true, label: "You, Bob, Alex and 2 others reacted with 👍" },
      { emoji: "🎉", count: 1, mine: false, label: "Dan reacted with 🎉" },
    ]);
    i18n.setLang("zh-TW", { store: false });
    expect(thread.reactionBar([{ emoji: "👍", count: 2, members: ["me", "a"] }], { meId: "me", names })[0].label).toBe("你、Alex 回應了 👍");
    expect(thread.reactionBar(undefined)).toBeUndefined();
  });
  it("toThreadMessages gives a group room's messages their chips, never a direct chat's", () => {
    const m = { id: "m1", roomId: "g", at: 1, author: { kind: "person", id: "p1", name: "Alex" }, text: "hi", mentions: [], reactions: [{ emoji: "👍", count: 1, members: ["me"] }] };
    expect(thread.toThreadMessages([m], { meId: "me", ids: new Map() })[0].reactionBar).toMatchObject([{ emoji: "👍", mine: true }]);
    expect(thread.toThreadMessages([m], { meId: "me", ids: new Map(), direct: true })[0]).not.toHaveProperty("reactionBar");
    expect(thread.toThreadMessages([{ ...m, reactions: undefined }], { meId: "me", ids: new Map() })[0]).not.toHaveProperty("reactionBar");
  });
});

describe("the room store", () => {
  const room = { id: "g1", kind: "group", name: "G" };
  const msg = (extra = {}) => ({ id: "m1", roomId: "g1", at: 1, sequence: 2, author: { kind: "person", id: "p1", name: "Alex" }, text: "hi", mentions: [], ...extra });
  it("react() sends my reaction and draws the answer; message.updated without reactions clears them", async () => {
    const h: Record<string, (d: any) => void> = {}, sent: any[] = [];
    const c = { room: async () => ({ ok: true, room, me: { id: "me", role: "member" }, members: [], settings: {} }),
      roomMessages: async () => ({ ok: true, messages: [msg({ reactions: [{ emoji: "🎉", count: 1, members: ["p1"] }] })], more: false }),
      subscribeRooms: (handlers: any) => { Object.assign(h, handlers); return () => {}; }, markRoomRead: async () => ({ ok: true }),
      reactRoomMessage: async (...a: any[]) => { sent.push(a); return { ok: true, reactions: [{ emoji: "🎉", count: 2, members: ["p1", "me"] }] }; } };
    const st = thread.createRoomStore("g1", { client: c });
    await until(() => st.loaded() && st.detail());
    expect((await st.react("m1", "🎉", true)).ok).toBe(true);
    expect(sent).toEqual([["g1", "m1", "🎉", true]]);
    expect(st.messages().find((x: any) => x.roomMessage === "m1").reactionBar).toMatchObject([{ emoji: "🎉", count: 2, mine: true }]);
    h["message.updated"]({ roomId: "g1", message: msg() });                    // the whole message, none left
    expect(st.raw()[0]).not.toHaveProperty("reactions");
    expect(st.messages().find((x: any) => x.roomMessage === "m1")).not.toHaveProperty("reactionBar");
    st.stop();
  });
  it("a direct chat, or a closed room, does not send", async () => {
    let calls = 0;
    const c = { room: async () => ({ ok: true, room: { ...room, kind: "direct" }, me: { id: "me" }, members: [], settings: {} }),
      roomMessages: async () => ({ ok: true, messages: [msg()], more: false }), subscribeRooms: () => () => {}, markRoomRead: async () => ({ ok: true }),
      reactRoomMessage: async () => { calls++; return { ok: true, reactions: [] }; } };
    const st = thread.createRoomStore("g1", { client: c });
    await until(() => st.loaded() && st.detail());
    expect((await st.react("m1", "👍", true)).code).toBe("closed");
    expect(calls).toBe(0);
    st.stop();
  });
});

describe("in the room page", () => {
  it("Add reaction opens the quick picker; a pick adds mine; pressing my chip takes it back", async () => {
    const { pg } = await roomPage("room-weekly");
    const target = msgs(pg).find((n) => n.classList.contains("msg-person")) ?? msgs(pg)[1];
    const text = (target.querySelector(".md")?.textContent || "").slice(0, 12);
    const add = target.querySelector('[data-act="reactPick"]');
    expect(add.getAttribute("aria-label")).toBe("Add reaction");
    fire(add, "click"); await settle(5);
    const pick = target.querySelector(".react-pick");
    expect([...pick.querySelectorAll(".react-opt")].map((b: any) => b.textContent)).toEqual(chatThread.QUICK_REACTIONS);
    expect(add.getAttribute("aria-expanded")).toBe("true");
    fire(pick.querySelector('[data-emoji="🎉"]'), "click");
    await until(() => chips(withText(pg, text) || target).length > 0);
    const node = withText(pg, text);
    expect(chips(node)).toEqual(["🎉1*"]);
    expect(node.querySelector(".react-pick")).toBeNull();
    expect(node.querySelector(".react-chip").getAttribute("aria-label")).toBe("You reacted with 🎉");
    fire(node.querySelector(".react-chip"), "click");
    await until(() => chips(withText(pg, text)).length === 0);
    expect(withText(pg, text).querySelector(".react-bar")).toBeNull();
  });
  it("Escape closes the picker; a refusal is a toast; clicking Add again closes it", async () => {
    const { pg } = await roomPage("room-weekly");
    const target = msgs(pg)[1], add = target.querySelector('[data-act="reactPick"]');
    fire(add, "click"); await settle(5);
    const pick = target.querySelector(".react-pick");
    fire(pick, "keydown", { key: "Escape" }); await settle(5);
    expect(target.querySelector(".react-pick")).toBeNull();
    expect(add.getAttribute("aria-expanded")).toBe("false");
    fire(add, "click"); await settle(5); fire(add, "click"); await settle(5);
    expect(target.querySelector(".react-pick")).toBeNull();
    // the fixture refuses 💥 (limit): not in the picker, so straight through the thread's option
    fire(add, "click"); await settle(5);
    const opt = target.querySelector(".react-opt"); opt.dataset.emoji = "💥"; fire(opt, "click");
    await until(() => pg.root.ownerDocument.body.textContent?.includes("Couldn't add the reaction"));
    expect(pg.root.ownerDocument.body.textContent).toContain("Couldn't add the reaction. Try again.");
  });
  it("the room's status lines take no reaction", async () => {
    const { pg } = await roomPage("room-weekly");
    for (const n of [...pg.root.querySelectorAll(".hub-room-page .thread .msg.status-line")] as any[]) expect(n.querySelector('[data-act="reactPick"]')).toBeNull();
  });
});

describe("the Fleet chat's thread without opts.react", () => {
  it("draws no Add reaction and keeps the agent's reactions as before (#2305)", () => {
    const pg = page({ url: "http://127.0.0.1:19280/ui", storage: {} }); mounted.push(pg);
    const list = pg.document.createElement("div"), sc = pg.document.createElement("div"); sc.append(list); pg.document.body.append(sc);
    const t = (k: string) => k;
    const th = chatThread.createThread(list, pg.document.createElement("div"), { t, tf: t, isUser: (x: any) => x.role === "user", onJump() {}, onEmpty() {} });
    th.attach(sc);
    th.render([{ boot: "b", id: 1, role: "agent", sender: "a", ts: "2026-11-15T00:00:00Z", text: "hi", reactions: ["👍"], instance: "a", roomMessage: "m1" }]);
    expect(list.querySelector('[data-act="reactPick"]')).toBeNull();
    expect(list.querySelector(".react-bar")).toBeNull();
    expect([...list.querySelectorAll(".msg-reactions .reaction")].map((n: any) => n.textContent)).toEqual(["👍"]);
    expect(th.pickReaction("b-1")).toBe(false);
    th.dispose(true);
  });
});

describe("the message menu's React", () => {
  it("is listed only when the page gives react (and canReact allows)", () => {
    const pg = page({ url: "http://127.0.0.1:19280/ui", storage: {} }); mounted.push(pg);
    const list = pg.document.createElement("div"); pg.document.body.append(list);
    const row = { boot: "b", id: 1, role: "agent", text: "hi" };
    list.innerHTML = '<div class="msg agent" data-key="b-1"><div class="body"><div class="md">hi</div></div></div>';
    const base = { t: (k: string) => k, messageOf: () => row, rove() {}, reply() {}, copyText: async () => true, notice() {}, linkOf: () => "" };
    const items = (deps: any) => { const off = msgActions.installMessageActions(list, deps);
      fire(list.querySelector(".msg")!, "contextmenu", { clientX: 5, clientY: 5 });
      const got = [...pg.document.querySelectorAll(".msg-menu [data-item]")].map((b: any) => b.dataset.item); off(); return got; };
    expect(items(base)).not.toContain("react");
    let picked: any = null;
    expect(items({ ...base, react: (x: any) => { picked = x; }, reactLabel: "React" })).toContain("react");
    expect(items({ ...base, react() {}, canReact: () => false })).not.toContain("react");
    void picked;
  });
});

it("S254 reaction acknowledgement uses the existing empty agent placeholder behavior and keeps the original reaction", () => {
  const question={id:"q",roomId:"r",at:1,author:{kind:"person",id:"p",name:"Reader"},text:"Thanks",mentions:[],reactions:[{emoji:"👍",count:1,members:["agent"]}],ask:{total:1,answered:1,working:0,later:0}};
  const placeholder={id:"reply",roomId:"r",at:2,author:{kind:"agent",id:"agent",name:"Notes"},text:"",mentions:[],answerTo:"q",stage:"working"};
  const rows=thread.toThreadMessages([question,placeholder],{meId:"p",ids:new Map()});
  expect(rows).toHaveLength(1);expect(rows[0].reactionBar).toMatchObject([{emoji:"👍",count:1}]);
  expect(thread.toThreadMessages([question,{...placeholder,stage:"not-answered"}],{meId:"p",ids:new Map()})).toHaveLength(2);
});
