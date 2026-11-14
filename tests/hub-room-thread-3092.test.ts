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
    expect(out.filter((x: any) => x.role === "agent" && !x.text)).toEqual([]);                           // queued/working answers: no empty bubble
    // Past three answers, one 「展開其餘 N 則」 line (an action the page answers); progress lines carry no time of their own.
    const more = out.filter((x: any) => x.action);
    expect(more.map((x: any) => x.action.label)).toEqual(["展開其餘 3 則"]);
    expect(out.find((x: any) => x.progressOf)!.ts).toBeUndefined();
    const all2 = thread.toThreadMessages(page1.messages, { meId: FIXTURE_ME.id, ids: new Map(), expanded: new Set([all.roomMessage]) });
    expect(all2.filter((x: any) => x.action)).toEqual([]);
    expect(all2.filter((x: any) => x.replyTo?.id === all.id)).toHaveLength(6);                            // every answer quotes its question
    // An answer that names its question only by answerTo still quotes it (the Fleet's reply reference).
    const q = { id: "q1", roomId: "r", at: 1, author: { kind: "person", id: "p2", name: "陳主任" }, text: "@Notes 好嗎", mentions: ["n"] };
    const a = { id: "a1", roomId: "r", at: 2, author: { kind: "agent", id: "n", name: "Notes", owner: { name: "林小華" } }, text: "好", mentions: [], answerTo: "q1", stage: "answered" };
    const w = { id: "a2", roomId: "r", at: 3, author: { kind: "agent", id: "n2", name: "Planner" }, text: "", mentions: [], answerTo: "q1", stage: "working" };
    const small = thread.toThreadMessages([q, a, w], { meId: FIXTURE_ME.id, ids: new Map() });
    expect(small.map((x: any) => x.sender)).toEqual(["陳主任", "Notes · 林小華的 Agent"]);
    // A Latin owner name keeps a space before 的 (Lumen); a CJK one doesn't.
    expect(thread.authorLine({ kind: "agent", name: "Notes", owner: { name: "Alex" } })).toBe("Notes · Alex 的 Agent");
    // Up to five answers all show; from six, three and one link right under the third.
    const ask = { id: "qq", roomId: "r", at: 1, author: { kind: "person", id: "p2", name: "陳主任" }, text: "@所有 Agent ?", mentions: ["all"] };
    const ans = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `x${i}`, roomId: "r", at: 2 + i, author: { kind: "agent", id: `e${i}`, name: `bot${i}` }, text: `ok ${i}`, mentions: [], answerTo: "qq", stage: "answered" }));
    const five = thread.toThreadMessages([ask, ...ans(5)], { meId: FIXTURE_ME.id, ids: new Map() });
    expect([five.filter((x: any) => x.role === "agent").length, five.some((x: any) => x.action)]).toEqual([5, false]);
    const six = thread.toThreadMessages([ask, ...ans(6)], { meId: FIXTURE_ME.id, ids: new Map() });
    const third = six.findIndex((x: any) => x.text === "ok 2");
    expect([six.filter((x: any) => x.role === "agent").length, six[third + 1].action.label]).toEqual([3, "展開其餘 3 則"]);
    // A final "not answered" with no text still shows, in words (Ridge: only queued and working wait unseen).
    const gone = { ...w, id: "a3", stage: "not-answered" };
    const withGone = thread.toThreadMessages([q, a, gone], { meId: FIXTURE_ME.id, ids: new Map() });
    expect(withGone.map((x: any) => x.text)).toEqual(["@Notes 好嗎", "好", "沒有回答"]);
    expect(small[1].replyTo).toMatchObject({ boot: "room", id: small[0].id, text: "@Notes 好嗎" });
    expect(out.find((x: any) => x.sender === "房間助理 · Hub 提供")).toBeTruthy();
    expect(out[0]).toMatchObject({ role: "status", text: "王經理 建立了這個房間。" });
    expect(new Set(out.filter((x: any) => x.role !== "status").map((x: any) => x.id)).size).toBe(out.filter((x: any) => x.role !== "status").length);
    expect(thread.authorLine({ kind: "assistant", name: "Hub assistant" }, false, true)).toBe("Hub 助理");          // its own 1:1
    expect(thread.authorLine({ kind: "assistant", name: "Hub assistant" })).toBe("房間助理 · Hub 提供");             // in a room
    // A room's own lines in the viewer's words from `system` (Ridge); older rows keep their text; no tools on them (Lumen).
    expect(thread.systemText({ text: "Wang created this room.", system: { kind: "room-created", name: "王經理" } })).toBe("王經理 建立了這個房間。");
    expect(thread.systemText({ text: "kept as is", system: { kind: "something-new", name: "x" } })).toBe("kept as is");
    expect(thread.systemText({ text: "older row" })).toBe("older row");
    expect(out.filter((x: any) => x.role === "status").every((x: any) => x.bare === true)).toBe(true);
    expect(thread.askState({ total: 1, answered: 0, working: 1, later: 0 })).toEqual({ delivery: "processing" });
    expect(thread.askState({ total: 12, answered: 12, working: 0, later: 0 })).toEqual({ delivery: "delivered" });   // all answered: the tick, no line
    expect(thread.askState({ total: 3, answered: 1, working: 1, later: 0 }).line).toBe("已回答 1 · 處理中 1");           // a 0 is left out
    i18n.setLang("en", { store: false });
    expect(thread.askState({ total: 3, answered: 1, working: 0, later: 2 }).line).toBe("Answered 1 · Reply later 2");
    i18n.setLang("zh-TW", { store: false });
  });
  it("presence.changed keeps a member's note and reason only while the event carries them (Ridge)", async () => {
    const fx = createHubRoomsFixture();
    const prev = g.fetch; g.fetch = (url: string, init?: any) => fx.fetch(url, init); g.EventSource = fx.EventSource;
    try {
      const c = client.createHubWebClient(); await c.session();
      const st = thread.createRoomStore("room-weekly", { client: c });
      await until(() => st.loaded());
      const who = () => st.detail().members.find((m: any) => m.id === "exp-02");
      fx.emit("presence.changed", { roomId: "room-weekly", memberId: "exp-02", presence: "paused", presenceReason: "quota" });
      expect([who().presence, who().presenceReason, who().presenceNote]).toEqual(["paused", "quota", undefined]);   // reason alone
      fx.emit("presence.changed", { roomId: "room-weekly", memberId: "exp-02", presence: "idle" });
      expect([who().presence, "presenceReason" in who()]).toEqual(["idle", false]);                                  // omitted: cleared
      st.stop();
    } finally { g.fetch = prev; }
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
  it("a stopped agent reads grey in the @ menu, not yellow", async () => {
    const detail: any = {
      members: [
        { kind: "agent", id: "e9", name: "stuck-bot", owner: { name: "Ann" }, presence: "paused", presenceReason: "stopped" },
        { kind: "agent", id: "e10", name: "ok-bot", owner: { name: "Ann" }, presence: "idle" },
      ],
      settings: {},
    };
    const dots = Object.fromEntries(composer.mentionOptions(detail, "").filter((o: any) => o.kind === "agent").map((o: any) => [o.label, o.dot]));
    expect(dots).toEqual({ "@stuck-bot": "off", "@ok-bot": "ok" });
  });
});

describe("a send answered with the bare message, before any stream (Ridge's server)", () => {
  it("is drawn at once; the same message from the stream later is not drawn twice", async () => {
    const fx = createHubRoomsFixture();
    const real = client.createHubWebClient({ fetchImpl: (u: string, i?: any) => fx.fetch(u, i) as any }); await real.session();
    const bare = Object.create(real);
    bare.subscribeRooms = () => () => {};                                                                // no stream yet
    bare.sendRoomMessage = async (id: string, body: any) => { const r = await real.sendRoomMessage(id, body); return r.ok ? { ok: true, ...r.message } : r; };
    const st = thread.createRoomStore("room-weekly", { client: bare });
    await until(() => st.loaded());
    const before = st.raw().length;
    const r = await st.send("bare answer please", { mentions: [] });
    expect(r.ok && typeof r.id).toBe("string");
    expect(st.raw().length).toBe(before + 1);
    expect(st.messages().some((x: any) => x.text === "bare answer please")).toBe(true);
    st.stop();
  });
});

describe("a room's committed order (Ridge's `sequence`)", () => {
  const room = { id: "g1", kind: "group", name: "Order", people: 2, agents: 2 };
  const msg = (id: string, sequence: number | undefined, extra: any = {}) => ({ id, roomId: "g1", at: 1, author: { kind: "person", id: "p1", name: "Sam" }, text: id, mentions: [], ...(sequence === undefined ? {} : { sequence }), ...extra });
  function fake(history: any[]) {
    const h: Record<string, (d: any) => void> = {};
    const client = { room: async () => ({ ok: true, room, me: { id: "me", role: "member" }, members: [], settings: {} }),
      roomMessages: async () => ({ ok: true, messages: history, more: false }), subscribeRooms: (handlers: any) => { Object.assign(h, handlers); return () => {}; },
      markRoomRead: async () => ({ ok: true }) };
    return { client, h };
  }
  it("placeholders that arrive out of order, a person between answers, answers in place: drawn by sequence", async () => {
    const q = msg("q", 1, { mentions: ["all"], ask: { total: 3, answered: 0, working: 3, later: 0 } });
    const ph = (id: string, seq: number, name: string) => msg(id, seq, { author: { kind: "agent", id: `e-${id}`, name }, text: "", answerTo: "q", stage: "working" });
    const { client, h } = fake([q]);
    const st = thread.createRoomStore("g1", { client });
    await until(() => st.loaded());
    h["message.added"]({ roomId: "g1", message: ph("a3", 4, "C") });                       // events out of order
    h["message.added"]({ roomId: "g1", message: ph("a1", 2, "A") });
    h["message.added"]({ roomId: "g1", message: msg("human", 5, { text: "between" }) });
    h["message.added"]({ roomId: "g1", message: ph("a2", 3, "B") });
    for (const [id, seq, name] of [["a2", 3, "B"], ["a3", 4, "C"], ["a1", 2, "A"]] as const)   // answered in place, in another order
      h["message.updated"]({ roomId: "g1", message: { ...ph(id, seq, name), text: `${name} done`, stage: "answered" } });
    expect(st.raw().map((m: any) => m.id)).toEqual(["q", "a1", "a2", "a3", "human"]);
    expect(st.messages().filter((x: any) => x.role !== "status" && !x.action).map((x: any) => x.text)).toEqual(["q", "A done", "B done", "C done", "between"]);
    st.stop();
  });
  it("who is working on an answer: the answers still being worked on, as members (an agent, the room assistant by its kind)", async () => {
    const q = msg("q", 1, { mentions: ["all", "assistant"] });
    const { client, h } = fake([q]);
    const st = thread.createRoomStore("g1", { client });
    await until(() => st.loaded());
    h["message.added"]({ roomId: "g1", message: msg("a1", 2, { author: { kind: "agent", id: "e-a", name: "budget-check" }, text: "", answerTo: "q", stage: "working" }) });
    h["message.added"]({ roomId: "g1", message: msg("a2", 3, { author: { kind: "assistant", id: "asst", name: "房間助理" }, text: "", answerTo: "q", stage: "working" }) });
    h["message.added"]({ roomId: "g1", message: msg("a3", 4, { author: { kind: "agent", id: "e-b", name: "later-bot" }, text: "", answerTo: "q", stage: "queued" }) });
    expect(st.workers()).toEqual([{ kind: "agent", name: "budget-check" }, { kind: "assistant", name: "房間助理" }]);
    expect(st.working()).toEqual(["budget-check", "房間助理"]);
    h["message.updated"]({ roomId: "g1", message: msg("a1", 2, { author: { kind: "agent", id: "e-a", name: "budget-check" }, text: "done", answerTo: "q", stage: "answered" }) });
    expect(st.workers()).toEqual([{ kind: "assistant", name: "房間助理" }]);
    st.stop();
  });
  it("without a sequence (a direct chat, an older Hub) the arrival order stays", async () => {
    const { client, h } = fake([msg("a", undefined), msg("b", undefined)]);
    const st = thread.createRoomStore("g1", { client });
    await until(() => st.loaded());
    h["message.added"]({ roomId: "g1", message: msg("c", undefined) });
    expect(st.raw().map((m: any) => m.id)).toEqual(["a", "b", "c"]);
    st.stop();
  });
});

describe("the shared renderer's mention labels (Hub-only opt-in)", () => {
  it("accents exact labels with a space, CJK or a hyphen as it accents @Notes; without labels nothing changes", async () => {
    const R = (globalThis as any).AgendChatRender || (await import("/assets/chat-render.js"), (globalThis as any).AgendChatRender);
    const html = R.renderMarkdown("@所有 Agent 和 @project-helper，@Notes", { mentionLabels: ["@所有 Agent", "@project-helper"] });
    expect(html).toContain('<span class="mention tg">@所有 Agent</span>');
    expect(html).toContain('<span class="mention tg">@project-helper</span>');
    expect(html).toContain('<span class="mention tg">@Notes</span>');
    const plain = R.renderMarkdown("@所有 Agent 和 @project-helper", {});
    expect(plain).not.toContain("@所有 Agent</span>");
  });
  it("a label inside an address or another word is not a mention (bounded on both sides, S-148); at a sentence's end it is", async () => {
    const R = (globalThis as any).AgendChatRender || (await import("/assets/chat-render.js"), (globalThis as any).AgendChatRender);
    const labels = { mentionLabels: ["@project-helper"] };
    for (const text of ["寄到 x@project-helper.com", "see a.@project-helper", "a-@project-helper", "@@project-helper", "@project-helpers", "@project-helper-2"])
      expect(R.renderMarkdown(text, labels), text).not.toContain('<span class="mention tg">@project-helper</span>');
    for (const text of ["@project-helper 看一下", "請 @project-helper。", "(@project-helper)", "@project-helper."])
      expect(R.renderMarkdown(text, labels), text).toContain('<span class="mention tg">@project-helper</span>');
  });
});

describe("the working bar's words come from workingLine (#3857, S-148)", () => {
  it("one agent by its name, several by their count, the room assistant by its own name; none: no bar", async () => {
    const W = await import("/ui/js/hub-room-working.js");
    const line = (ws: Array<{ kind: string; name: string }>) => W.workingLine({ members: ws.map((w) => ({ ...w, presence: "working" })) })?.text ?? null;
    expect(line([])).toBeNull();
    expect(line([{ kind: "agent", name: "budget-check" }])).toMatch(/budget-check/);
    expect(line([{ kind: "agent", name: "a" }, { kind: "agent", name: "b" }])).toMatch(/2/);
    expect(line([{ kind: "assistant", name: "Hub assistant" }])).not.toMatch(/Hub assistant/);
  });
});

describe("a room on the page", () => {
  it("the header, the shared thread with authors and progress; send an @all: its bar, then the message and its line arrive", async () => {
    const W = await import("/ui/js/hub-room-working.js");
    const { pg, fx, restore } = await roomPage("room-weekly");
    try {
      expect(pg.root.querySelector(".hub-room-page .hub-chat-head strong")!.textContent).toBe("研一主管週會");
      // Another person's @ of an agent is accented once the room's members are known (the labels are read live).
      const chen = msgs(pg).find((m) => (m.textContent || "").includes("剛剛那一點再說清楚")) as any;
      expect(chen.querySelector(".mention")?.textContent).toBe("@project-helper");
      // A room's own line (created …): no message tools, Copy included (Lumen).
      expect([...pg.root.querySelectorAll(".hub-room-page .thread .status-line")].every((el: any) => !el.querySelector(".msg-tools"))).toBe(true);
      expect(msgs(pg).filter((m) => m.classList.contains("user") && m.querySelector(".sender").textContent === "")).not.toHaveLength(0);
      expect(pg.root.querySelector(".hub-room-page .hub-room-hint")!.textContent).toContain("seen only by people in the room");
      // The working bar: who is on an answer now (project-helper's answer row arrives, still being worked on), worded by
      // workingLine() (S-148); none before it.
      expect(pg.root.querySelector(".hub-room-page .work-bar.working")).toBeNull();
      const asked = fx.rooms.find((r: any) => r.id === "room-weekly")!.messages.find((m: any) => m.mentions?.includes("all"))!;
      fx.emit("message.added", { roomId: "room-weekly", message: { id: "ans-ph", roomId: "room-weekly", at: asked.at + 1, author: { kind: "agent", id: "exp-01", name: "project-helper" },
        text: "", mentions: [], replyTo: asked.id, answerTo: asked.id, stage: "working" } });
      await until(() => pg.root.querySelector(".hub-room-page .work-bar.working"));
      expect(pg.root.querySelector(".hub-room-page .work-bar.working .lbl")?.textContent).toBe(W.workingLine({ members: [{ kind: "agent", name: "project-helper", presence: "working" }] }).text);
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
  // Lumen (spec §3, S-150): the header's menu holds Room settings (managers) and Leave room (everyone).
  const headerMenu = async (pg: AppPage) => {
    await until(() => pg.root.querySelector(".hub-room-page .hub-room-menu > button"));
    const trigger = pg.root.querySelector(".hub-room-page .hub-room-menu > button") as any;
    fire(trigger, "pointerdown"); fire(trigger, "click"); await settle(5);
    return [...pg.root.querySelectorAll(".hub-room-page .hub-room-menu [role=menuitem]")].map((b: any) => b.textContent.trim());
  };
  it("a room manager's header menu: Room settings, Leave room; the members toggle is the team icon", async () => {
    const mgr = await roomPage("room-weekly");
    try {
      expect(await headerMenu(mgr.pg)).toEqual(["Room settings", "Leave room"]);
      expect(mgr.pg.root.querySelector(".hub-room-page .hub-room-menu > button")!.getAttribute("aria-label")).toBe("Menu");
      expect(mgr.pg.root.querySelector(".hub-room-page .hub-chat-head")!.textContent).not.toContain("\u{1F465}");
    } finally { mgr.restore(); }
  });
  it("a room member's header menu has Leave room only (no Room settings)", async () => {
    const member = await roomPage("room-rd");
    try {
      expect(await headerMenu(member.pg)).toEqual(["Leave room"]);
    } finally { member.restore(); }
  });
  it("「Show the other N」 opens a question's remaining answers in place (the thread's own click)", async () => {
    const { pg, restore } = await roomPage("room-weekly");
    try {
      const answers = () => msgs(pg).filter((m) => /'s agent$/.test(m.querySelector(".sender")?.textContent || "") && /進度/.test(m.textContent)).length;
      expect(answers()).toBe(3);
      const btn = pg.root.querySelector(".hub-room-page .thread .st-action") as any;
      expect(btn.textContent).toBe("Show 3 more");
      fire(btn, "click"); await until(() => answers() === 6);
      // The fold link is gone; what stays under the last answer is 「請房間助理整理」 (spec §10, S-150).
      expect([answers(), [...pg.root.querySelectorAll(".hub-room-page .thread .st-action")].map((b: any) => b.textContent)]).toEqual([6, ["Ask the room assistant to summarise"]]);
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
      expect(pg.root.querySelector(".hub-room-page .hub-assistant-empty")!.textContent).toContain("這是 Hub 提供的 AI 助理。它讀不到你的電腦，也讀不到其他房間。");
      expect(pg.root.querySelector(".hub-room-page .hub-assistant-empty")!.textContent).toContain("Hub 助理");   // the shared Empty: its title
      expect(pg.root.querySelector(".hub-room-page .hub-room-hint")).toBeNull();                       // a 1:1: no @ needed
      // Named by its flag in the viewer's words, never by its stored English name (Ridge on #3864).
      expect(pg.root.querySelector(".hub-room-page .hub-chat-head strong")!.textContent).toBe("Hub 助理");
      expect(pg.root.querySelector(".hub-room-page .composer-ph")!.textContent).toBe("問 Hub 助理");          // not the room prompt (Lumen)
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
