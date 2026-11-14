/**
 * M-3092 S-150: Lumen's first-time-user findings on the rooms UI (docs/design/hub-rooms-ux.md @07cb25501; Ridge's
 * hub-rooms-seam1 forward), against tests/support/hub-rooms-fixture.ts:
 * 1. another person's message is a bubble on the left (`msg-person`); mine stays right, an agent's answer unbubbled;
 * 2. on a phone, a room's (and the Hub assistant's) header starts with the Fleet chat's back to the list;
 * 3. the phone's chats list has 「＋ 新房間」 beside 「＋ 新對話」 for someone who may open rooms;
 * 4. a phone's room composer has the short placeholder;
 * 5. the header menu: Room settings (managers) and Leave room (everyone; the last manager is told why not);
 * 6. under an @所有 Agent's last shown answer, 「請房間助理整理」 — it sends 「@房間助理 整理上面的回答」.
 * (7, the Hub assistant's first-open words, was already there: tests/hub-room-thread-3092's assistant page.)
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { createHubRoomsFixture, FIXTURE_ME } from "./support/hub-rooms-fixture.js";

let client: any, shell: any, store: any, router: any, i18n: any, hubPanel: any, thread: any;
const mounted: AppPage[] = [];
const g = globalThis as any;
const realES = g.EventSource;
const until = async (fn: () => unknown, n = 200) => { for (let i = 0; i < n && !fn(); i++) await settle(5); };
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  store = await import("/assets/app-store.js"); router = await import("/assets/app-nav.js"); shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js"); client = await import("/ui/js/hub-client.js"); hubPanel = await import("/ui/js/panel-hub.js");
  thread = await import("/ui/js/hub-room-thread.js");
  pg.restore();
});
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); i18n.setLang("en", { store: false }); g.EventSource = realES; });

/** The Hub app at `path` on the fixture; `narrow`: a phone's width (every max-width query matches). */
async function hubAt(path: string, { lang = "en", narrow = false, fx = createHubRoomsFixture() } = {}) {
  const realFetch = g.fetch;
  g.fetch = (url: string, init?: any) => fx.fetch(url, init); g.EventSource = fx.EventSource;
  const pg = page({ url: `http://127.0.0.1:19280${path}`, storage: { agend_tour_done: "1" }, matchNarrow: narrow });
  pg.document.body.setAttribute("data-hub", "hub"); pg.document.body.setAttribute("data-hub-name", "Team Hub"); mounted.push(pg);
  i18n.setLang(lang, { store: false });
  client.setHubClient(client.createHubWebClient()); hubPanel.resetHubSession(); router.startRouter(pg.window); store.applyStatus({ instances: [] });
  await pg.mount(h(shell.Shell, { panels: new Map([["hub", { Component: hubPanel.HubPanel || (() => null) }]]), onNewInstance() {} }));
  // One page at a time: this one is unmounted (and its globals put back) before the next is made.
  const restore = async () => { g.fetch = realFetch; const i = mounted.indexOf(pg); if (i >= 0) { mounted.splice(i, 1); await pg.unmount(); pg.restore(); } };
  return { pg, fx, restore };
}
const roomOpen = (pg: AppPage) => until(() => pg.root.querySelectorAll(".hub-room-page .thread .msg").length > 5);
const msgs = (pg: AppPage) => [...pg.root.querySelectorAll(".hub-room-page .thread .msg")] as any[];
async function menuItems(pg: AppPage) {
  await until(() => pg.root.querySelector(".hub-room-page .hub-room-menu > button"));
  const trigger = pg.root.querySelector(".hub-room-page .hub-room-menu > button") as any;
  fire(trigger, "pointerdown"); fire(trigger, "click"); await settle(5);
  return [...pg.root.querySelectorAll(".hub-room-page .hub-room-menu [role=menuitem]")] as any[];
}

describe("1. another person's words are a bubble on the left", () => {
  it("someone else's message carries msg-person; mine and an agent's answer do not (the mapping, and the page)", async () => {
    const fx = createHubRoomsFixture();
    const page1 = await (await fx.fetch("/hub/v1/rooms/room-weekly/messages?limit=100")).json();
    const out = thread.toThreadMessages(page1.messages, { meId: FIXTURE_ME.id, ids: new Map() });
    const chen = out.find((x: any) => x.sender === "陳主任"), mine = out.find((x: any) => x.mine), agent = out.find((x: any) => x.role === "agent" && x.sender);
    expect([chen.person, mine.person, agent.person]).toEqual([true, undefined, undefined]);
    const { pg, restore } = await hubAt("/ui/hub?room=room-weekly");
    try {
      await roomOpen(pg);
      const of = (re: RegExp) => msgs(pg).find((m) => re.test(m.querySelector(".sender")?.textContent || "") || re.test(m.textContent));
      expect(of(/^陳主任$/).className).toContain("msg-person");
      expect(of(/^陳主任$/).className).toContain("agent");                 // left, as the thread draws others
      expect(msgs(pg).filter((m) => m.classList.contains("user")).every((m) => !m.classList.contains("msg-person"))).toBe(true);
      expect(msgs(pg).filter((m) => /'s agent$/.test(m.querySelector(".sender")?.textContent || "")).every((m) => !m.classList.contains("msg-person"))).toBe(true);
    } finally { await restore(); }
  });
});

describe("2. a phone's header goes back to the list", () => {
  it("a room and the Hub assistant: the back link first in the header; it opens the list", async () => {
    for (const room of ["room-weekly", "room-assistant"]) {
      const { pg, restore } = await hubAt(`/ui/hub?room=${room}`, { narrow: true });
      try {
        await until(() => pg.root.querySelector(".hub-room-page .hub-chat-head .hub-back"));
        const back = pg.root.querySelector(".hub-room-page .hub-chat-head .hub-back") as any;
        expect([back.className, back.getAttribute("href"), back.getAttribute("aria-label"), back === pg.root.querySelector(".hub-room-page .hub-chat-head")!.firstElementChild])
          .toEqual(["icon-btn hub-back only-narrow", "/ui/hub", "Back", true]);
        fire(back, "click"); await settle(10);
        expect(pg.window.location.search).toBe("");
        expect(pg.root.querySelector(".hub-room-page")).toBeNull();
      } finally { await restore(); }
    }
  });
});

describe("3. New room on the phone's list", () => {
  it("beside New chat for someone who may open rooms; not on a Hub without rooms", async () => {
    const { pg, restore } = await hubAt("/ui/hub", { narrow: true });
    try {
      await until(() => pg.root.querySelector(".hub-home-list .hub-new-room"));
      const rows = [...pg.root.querySelectorAll(".hub-home-list .side-new")].map((b: any) => b.textContent.trim());
      expect(rows).toEqual(["New chat", "New room"]);
      fire(pg.root.querySelector(".hub-home-list .hub-new-room") as any, "click");
      await until(() => pg.root.querySelector("dialog[open]"));
      expect(pg.root.querySelector("dialog[open]")).toBeTruthy();
    } finally { await restore(); }
    const today = await hubAt("/ui/hub", { narrow: true, fx: createHubRoomsFixture({ features: [] }) });
    try {
      await until(() => today.pg.root.querySelector(".hub-home-list .side-new"));
      await settle(20);
      expect(today.pg.root.querySelector(".hub-home-list .hub-new-room")).toBeNull();
    } finally { await today.restore(); }
  });
});

describe("4. a phone's room composer: the short placeholder", () => {
  it("narrow: 「說話，或 @ Agent 請它回答」; wide: the room's own; a one-to-one keeps 「問 …」", async () => {
    for (const [narrow, want] of [[true, "說話，或 @ Agent 請它回答"], [false, "在「研一主管週會」說話；@ 一個 Agent 請它回答"]] as const) {
      const { pg, restore } = await hubAt("/ui/hub?room=room-weekly", { lang: "zh-TW", narrow });
      try {
        await roomOpen(pg);
        expect(pg.root.querySelector(".hub-room-page .composer-ph")?.textContent).toBe(want);
      } finally { await restore(); }
    }
    i18n.setLang("en", { store: false });
  });
});

describe("5. the header menu: Leave room", () => {
  it("a member leaves: back to the list, the room gone from it", async () => {
    const { pg, restore } = await hubAt("/ui/hub?room=room-rd");
    try {
      const items = await menuItems(pg);
      expect(items.map((b) => b.textContent.trim())).toEqual(["Leave room"]);
      fire(items[0], "click");
      await until(() => !pg.root.querySelector(".hub-room-page"));
      expect(pg.window.location.search).toBe("");
      await until(() => ![...pg.root.querySelectorAll("#sidebar .inst-name")].some((n: any) => n.textContent === "研發例會"));
      expect([...pg.root.querySelectorAll("#sidebar .inst-name")].map((n: any) => n.textContent)).not.toContain("研發例會");
    } finally { await restore(); }
  });
  it("the last manager is told to hand the role on first, and stays", async () => {
    const { pg, restore } = await hubAt("/ui/hub?room=room-weekly");
    try {
      const items = await menuItems(pg);
      fire(items.find((b) => b.textContent.trim() === "Leave room"), "click");
      await until(() => pg.root.querySelector(".hub-room-page .hub-room-leave-err"));
      expect(pg.root.querySelector(".hub-room-page .hub-room-leave-err")!.textContent).toBe("Make someone else a room manager first.");
      expect(pg.window.location.search).toBe("?room=room-weekly");
    } finally { await restore(); }
  });
});

describe("6. 「請房間助理整理」 under an @所有 Agent's answers", () => {
  it("the mapping: under the last shown answer (after the fold link when folded), only when the room has an assistant", async () => {
    const fx = createHubRoomsFixture();
    const page1 = await (await fx.fetch("/hub/v1/rooms/room-weekly/messages?limit=100")).json();
    const acts = (opts: any) => thread.toThreadMessages(page1.messages, { meId: FIXTURE_ME.id, ids: new Map(), ...opts })
      .filter((x: any) => x.action).map((x: any) => x.action.label);
    expect(acts({ summarise: true })).toEqual(["Show 3 more", "Ask the room assistant to summarise"]);
    expect(acts({ summarise: false })).toEqual(["Show 3 more"]);
    const all = page1.messages.find((m: any) => m.mentions?.includes("all"));
    expect(acts({ summarise: true, expanded: new Set([all.id]) })).toEqual(["Ask the room assistant to summarise"]);
    const out = thread.toThreadMessages(page1.messages, { meId: FIXTURE_ME.id, ids: new Map(), summarise: true });
    const at = out.findIndex((x: any) => x.action?.arg === `summarise:${all.id}`);
    expect(out[at - 1].action?.arg).toBe(all.id);                         // right after the fold link
    // No answers yet: no link.
    const asked = page1.messages.filter((m: any) => !m.answerTo || m.answerTo !== all.id);
    expect(thread.toThreadMessages(asked, { meId: FIXTURE_ME.id, ids: new Map(), summarise: true }).some((x: any) => x.action?.arg === `summarise:${all.id}`)).toBe(false);
  });
  it("the store offers it only in a group room with an assistant, still open", async () => {
    const fx = createHubRoomsFixture();
    const page1 = await (await fx.fetch("/hub/v1/rooms/room-weekly/messages?limit=100")).json();
    const offered = async (members: any[], room: any = { id: "g1", kind: "group", name: "g" }) => {
      const client = { room: async () => ({ ok: true, room, me: { id: FIXTURE_ME.id, role: "member" }, members, settings: {} }),
        roomMessages: async () => ({ ok: true, messages: page1.messages.map((m: any) => ({ ...m, roomId: "g1" })), more: false }),
        subscribeRooms: () => () => {}, markRoomRead: async () => ({ ok: true }) };
      const st = thread.createRoomStore("g1", { client });
      await until(() => st.loaded());
      const has = st.messages().some((x: any) => String(x.action?.arg || "").startsWith("summarise:"));
      st.stop();
      return has;
    };
    const assistant = { kind: "assistant", id: "asst", name: "房間助理", presence: "idle" };
    expect(await offered([assistant])).toBe(true);
    expect(await offered([])).toBe(false);                                                             // no assistant here
    expect(await offered([assistant], { id: "g1", kind: "group", name: "g", archived: true })).toBe(false);   // archived
  });
  it("clicking it sends 「@Room assistant summarise the answers above」 to the assistant", async () => {
    const { pg, fx, restore } = await hubAt("/ui/hub?room=room-weekly");
    try {
      await roomOpen(pg);
      const link = [...pg.root.querySelectorAll(".hub-room-page .thread .st-action")].find((b: any) => b.textContent === "Ask the room assistant to summarise") as any;
      expect(link).toBeTruthy();
      const before = fx.rooms.find((r: any) => r.id === "room-weekly")!.messages.length;
      fire(link, "click");
      await until(() => fx.rooms.find((r: any) => r.id === "room-weekly")!.messages.length > before);
      const sent = fx.rooms.find((r: any) => r.id === "room-weekly")!.messages.at(-1)!;
      expect([sent.text, sent.mentions, sent.author?.id]).toEqual(["@Room assistant summarise the answers above", ["assistant"], FIXTURE_ME.id]);
    } finally { await restore(); }
  });
});
