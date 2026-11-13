/**
 * M-3092 PR 2 (Hub rooms, track U): a room on the Fleet chat's own thread (src/ui/hub-room-thread.js, hub-room-composer.js),
 * docs/design/hub-rooms-ux.md §3–§4, against tests/support/hub-rooms-fixture.ts:
 * - who wrote each message (a person, 「name · owner 的 Agent」, 「房間助理 · Hub 提供」; mine on the right with no name);
 * - an answer quotes what asked for it; under the @all, its progress line, live from the stream;
 * - the composer: the @ menu in the spec's order, the @all bar, the fixed hint; a refusal worded; a soft warning drawn;
 * - an archived room says so instead of a box.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { createHubRoomsFixture, FIXTURE_ME } from "./support/hub-rooms-fixture.js";

let client: any, shell: any, store: any, router: any, i18n: any, hubPanel: any, thread: any, composer: any;
const mounted: AppPage[] = [];
const g = globalThis as any;
const until = async (fn: () => unknown, n = 200) => { for (let i = 0; i < n && !fn(); i++) await settle(5); };
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  store = await import("/assets/app-store.js"); router = await import("/assets/app-nav.js"); shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js"); client = await import("/ui/js/hub-client.js"); hubPanel = await import("/ui/js/panel-hub.js");
  thread = await import("/ui/js/hub-room-thread.js"); composer = await import("/ui/js/hub-room-composer.js");
  pg.restore();
});
const realES = g.EventSource;
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); i18n.setLang("en", { store: false }); g.EventSource = realES; });

async function roomPage(roomId: string, lang = "en") {
  const fx = createHubRoomsFixture(), realFetch = g.fetch;
  g.fetch = (url: string, init?: any) => fx.fetch(url, init); g.EventSource = fx.EventSource;
  const pg = page({ url: `http://127.0.0.1:19280/ui/hub?room=${roomId}`, storage: { agend_tour_done: "1" } });
  pg.document.body.setAttribute("data-hub", "hub"); pg.document.body.setAttribute("data-hub-name", "Team Hub"); mounted.push(pg);
  i18n.setLang(lang, { store: false });
  client.setHubClient(client.createHubWebClient()); hubPanel.resetHubSession(); router.startRouter(pg.window); store.applyStatus({ instances: [] });
  await pg.mount(h(shell.Shell, { panels: new Map([["hub", { Component: hubPanel.HubPanel || (() => null) }]]), onNewInstance() {} }));
  await until(() => roomId === "room-assistant" ? pg.root.querySelector(".hub-room-page") : pg.root.querySelectorAll(".hub-room-page .thread .msg").length > 5);
  return { pg, fx, restore: () => { g.fetch = realFetch; } };
}
const msgs = (pg: AppPage) => [...pg.root.querySelectorAll(".hub-room-page .thread .msg")] as any[];

describe("the thread's mapping (pure)", () => {
  it("authors, mine, quotes, progress lines; an answer still to come is not a row; a soft warning drawn", async () => {
    const fx = createHubRoomsFixture();
    const page1 = await (await fx.fetch("/hub/v1/rooms/room-weekly/messages?limit=100")).json();
    i18n.setLang("zh-TW", { store: false });
    const out = thread.toThreadMessages(page1.messages, { meId: FIXTURE_ME.id, ids: new Map() });
    const all = out.find((x: any) => x.text.startsWith("@所有 Agent"));
    expect(all).toMatchObject({ role: "user", mine: true, sender: "" });
    expect(out[out.indexOf(all) + 1]).toMatchObject({ role: "status", text: "已回答 6 · 處理中 1 · 稍後回覆 5" });
    const answer = out.find((x: any) => x.sender.startsWith("spec-writer"));
    expect(answer).toMatchObject({ role: "agent", sender: "spec-writer · 陳主任的 Agent", replyTo: { boot: "room", id: all.id, text: all.text.slice(0, 120) } });
    expect(out.filter((x: any) => x.role === "agent" && !x.text)).toEqual([]);                           // queued answers are counted, not drawn
    expect(out.find((x: any) => x.sender === "房間助理 · Hub 提供")).toBeTruthy();
    expect(out[0]).toMatchObject({ role: "status", text: "王經理 建立了這個房間。" });
    expect(new Set(out.filter((x: any) => x.role !== "status").map((x: any) => x.id)).size).toBe(out.filter((x: any) => x.role !== "status").length);
    expect(thread.authorLine({ kind: "assistant", name: "Hub assistant" }, false, true)).toBe("Hub 助理");          // its own 1:1
    expect(thread.authorLine({ kind: "assistant", name: "Hub assistant" })).toBe("房間助理 · Hub 提供");             // in a room
    expect(thread.askState({ total: 1, answered: 0, working: 1, later: 0 })).toEqual({ delivery: "processing" });
    expect(thread.askState({ total: 12, answered: 12, working: 0, later: 0 }).line).toBe("12 個都回答了");
  });
  it("the @ menu: @All agents (if allowed), the assistant, agents by name or owner, then people; mentions read from the text", async () => {
    const fx = createHubRoomsFixture();
    const weekly = await (await fx.fetch("/hub/v1/rooms/room-weekly")).json(), rd = await (await fx.fetch("/hub/v1/rooms/room-rd")).json();
    const opts = composer.mentionOptions(weekly, "");
    expect(opts.slice(0, 2).map((o: any) => o.kind)).toEqual(["all", "assistant"]);
    expect(opts.filter((o: any) => o.kind === "agent")).toHaveLength(12);
    expect(opts.filter((o: any) => o.kind === "person").map((o: any) => o.label)).toEqual(["@陳主任", "@吳小安"]);
    expect(composer.mentionOptions(weekly, "林小華").map((o: any) => o.label)).toEqual(["@project-helper", "@test-runner", "@design-review", "@old-helper"]);
    expect(composer.mentionOptions(rd, "").some((o: any) => o.kind === "all")).toBe(false);              // members may not @all here
    expect(composer.mentionsIn("@All agents and @project-helper, @房間助理?", weekly)).toEqual(["all", "exp-01"]);
    expect(composer.mentionAt("hi @proj", 8)).toEqual({ start: 3, query: "proj" });
    expect(composer.mentionAt("mail@proj", 9)).toBeNull();
    i18n.setLang("zh-TW", { store: false });
    expect(composer.allBar(weekly)).toBe("12 個 Agent 中 7 個在線上，5 個上線後回答");
    expect(composer.refusalText({ ok: false, code: "all-mention-off" })).toBe("這個房間只有房間管理可以 @所有 Agent。");
  });
});

describe("a room on the page", () => {
  it("the header, the shared thread with authors and progress; send an @all: its bar, then the message and its line arrive", async () => {
    const { pg, restore } = await roomPage("room-weekly");
    try {
      expect(pg.root.querySelector(".hub-room-page .hub-chat-head strong")!.textContent).toBe("研一主管週會");
      expect(msgs(pg).filter((m) => m.classList.contains("user") && m.querySelector(".sender").textContent === "")).not.toHaveLength(0);
      expect(pg.root.querySelector(".hub-room-page .hub-room-hint")!.textContent).toContain("seen only by people in the room");
      const box = pg.root.querySelector(".hub-room-page #msgIn, .hub-room-page textarea") as any;
      box.value = "@"; box.selectionStart = 1; fire(box, "input"); await settle(5);
      expect([...pg.root.querySelectorAll(".hub-room-page .cmd-palette .cmd-name")].slice(0, 2).map((x: any) => x.textContent.trim())).toEqual(["@All agents", "@Room assistant"]);
      fire(box, "keydown", { key: "Enter" }); await settle(5);
      expect(box.value).toBe("@All agents ");
      expect(pg.root.querySelector(".hub-room-page .hub-room-allbar")!.textContent).toBe("12 agents, 7 online, 5 will answer after they come online");
      box.value = "@All agents please report"; fire(box, "input"); await settle(5);
      fire(pg.root.querySelector(".hub-room-page #sendBtn") as any, "click");
      await until(() => msgs(pg).some((m) => m.textContent.includes("please report")));
      expect(msgs(pg).some((m) => m.textContent.includes("please report"))).toBe(true);
    } finally { restore(); }
  });
  it("members may not @all here: the refusal is worded, no resend offered", async () => {
    const { pg, restore } = await roomPage("room-rd");
    try {
      const st = await thread.createRoomStore("room-rd", { client: client.hubClient() });
      await until(() => st.loaded());
      const r = await st.send("@All agents", { mentions: ["all"] });
      expect(composer.refusalText(r)).toBe("Only a room manager can @All agents in this room.");
      st.stop();
    } finally { restore(); }
  });
  it("the members panel's 「在這裡 @ 它」 puts the mention into the box, after what is there", async () => {
    const fx = createHubRoomsFixture(), detail = { ok: true, ...(await (await fx.fetch("/hub/v1/rooms/room-weekly")).json()) };
    const pg = page({ url: "http://127.0.0.1:19280/ui/hub", storage: { agend_tour_done: "1" } }); mounted.push(pg);
    const insert: { current: any } = { current: null };
    await pg.mount(h(composer.RoomComposer, { store: { send: async () => ({ ok: true }) }, detail, insertRef: insert })); await settle(5);
    const box = pg.root.querySelector("#msgIn") as any;
    box.value = "Thanks"; fire(box, "input"); await settle(5);
    insert.current("@project-helper"); await settle(5);
    expect(box.value).toBe("Thanks @project-helper ");
    insert.current("@test-runner"); await settle(5);
    expect(box.value).toBe("Thanks @project-helper @test-runner ");
  });
  it("the Hub assistant's 1:1, first opened: what it is, in its own words (spec §10)", async () => {
    const { pg, restore } = await roomPage("room-assistant", "zh-TW");
    try {
      await until(() => pg.root.querySelector(".hub-room-page .hub-assistant-empty"));
      expect(pg.root.querySelector(".hub-room-page .hub-assistant-empty")!.textContent).toBe("這是 Hub 提供的 AI 助理。它讀不到你的電腦，也讀不到其他房間。");
      expect(pg.root.querySelector(".hub-room-page .hub-room-hint")).toBeNull();                       // a 1:1: no @ needed
      // Named by its flag in the viewer's words, never by its stored English name (Ridge on #3864).
      expect(pg.root.querySelector(".hub-room-page .hub-chat-head strong")!.textContent).toBe("Hub 助理");
      expect(pg.root.querySelector(".hub-room-page .composer-ph")!.textContent).toContain("Hub 助理");
      expect(pg.root.querySelector(".hub-room-page")!.textContent).not.toContain("Hub assistant");
    } finally { restore(); }
  });
  it("an archived room: the box says so, nothing to send", async () => {
    const { pg, restore } = await roomPage("room-archived");
    try {
      await until(() => pg.root.querySelector(".hub-room-page .composer-box .note"));
      expect(pg.root.querySelector(".hub-room-page .composer-box .note")!.textContent).toBe("This room is archived; you can't send messages.");
      expect(pg.root.querySelector(".hub-room-page textarea")).toBeNull();
    } finally { restore(); }
  });
});
