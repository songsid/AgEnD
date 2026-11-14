/**
 * M-3127 B (UI): an agent's buttons and polls in a Hub group room, on the Fleet chat's own thread, against the rooms
 * fixture (`buttons: true`):
 * - my own question's buttons are open; someone else's are shut with whose they are (「只有 陳主任 能回答」);
 * - pressing mine posts my click (the label, replying to the answer) and marks the set chosen;
 * - a poll is everyone's: a vote marks mine and the counts move (reveal: live);
 * - the room line 「… 的投票已結束」 for a closed poll; the Fleet thread without `b.note` is unchanged.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { createHubRoomsFixture, FIXTURE_ME } from "./support/hub-rooms-fixture.js";

let client: any, shell: any, store: any, router: any, i18n: any, hubPanel: any, thread: any, chatThread: any;
const mounted: AppPage[] = [];
const g = globalThis as any;
const until = async (fn: () => unknown, n = 200) => { for (let i = 0; i < n && !fn(); i++) await settle(5); };
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  store = await import("/assets/app-store.js"); router = await import("/assets/app-nav.js"); shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js"); client = await import("/ui/js/hub-client.js"); hubPanel = await import("/ui/js/panel-hub.js");
  thread = await import("/ui/js/hub-room-thread.js"); chatThread = await import("/assets/chat-thread.js");
  pg.restore();
});
const realES = g.EventSource;
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); i18n.setLang("en", { store: false }); g.EventSource = realES; });

async function roomPage(lang = "zh-TW") {
  const fx = createHubRoomsFixture({ buttons: true });
  g.fetch = (url: string, init?: any) => fx.fetch(url, init); g.EventSource = fx.EventSource;
  const pg = page({ url: "http://127.0.0.1:19280/ui/hub?room=room-weekly", storage: { agend_tour_done: "1" } });
  pg.document.body.setAttribute("data-hub", "hub"); pg.document.body.setAttribute("data-hub-name", "Team Hub"); mounted.push(pg);
  i18n.setLang(lang, { store: false });
  client.setHubClient(client.createHubWebClient()); hubPanel.resetHubSession(); router.startRouter(pg.window); store.applyStatus({ instances: [] });
  await pg.mount(h(shell.Shell, { panels: new Map([["hub", { Component: hubPanel.HubPanel || (() => null) }]]), onNewInstance() {} }));
  await until(() => pg.root.querySelectorAll(".hub-room-page .thread .rb-row").length >= 3);
  return { pg, fx };
}
/** The answer (it has a button row) whose words include `text` — its question says them too. */
const rowOf = (pg: AppPage, text: string) => [...pg.root.querySelectorAll(".hub-room-page .thread .msg[data-key]")].find((n: any) => n.querySelector(".rb-row") && (n.querySelector(".md")?.textContent || "").includes(text)) as any;
const labels = (n: any) => [...n.querySelectorAll(".rb-row .rb-btn")].map((b: any) => `${b.textContent}${b.disabled ? "(off)" : ""}`);

describe("roomButtons (the thread's shape)", () => {
  const set = { id: "a".repeat(32), labels: ["A", "B"], state: "open", asker: { id: "me", name: "Me" } };
  it("my question's buttons stay open; someone else's are shut and say whose they are; a poll is everyone's", () => {
    i18n.setLang("en", { store: false });
    expect(thread.roomButtons(set, "me")).toEqual({ id: set.id, labels: ["A", "B"], state: "open" });
    expect(thread.roomButtons(set, "other")).toEqual({ id: set.id, labels: ["A", "B"], state: "locked", note: "Only Me can answer" });
    expect(thread.roomButtons({ ...set, state: "chosen", chosen: 1, by: "Me" }, "other")).toEqual({ id: set.id, labels: ["A", "B"], state: "chosen", chosen: 1, by: "Me" });
    const poll = { ...set, poll: { deadline: 1, answered: 0, multi: false, reveal: "live", rev: 1 } };
    expect(thread.roomButtons(poll, "other")).toMatchObject({ state: "open", poll: { reveal: "live" } });
    expect(thread.roomButtons(poll, "other")).not.toHaveProperty("asker");
    expect(thread.roomButtons(undefined)).toBeUndefined();
  });
  it("toThreadMessages gives an agent's answer its buttons, never a person's message or a direct chat's", () => {
    const m = (kind: string) => ({ id: `m-${kind}`, roomId: "g", at: 1, author: { kind, id: "x", name: "X" }, text: "t", mentions: [], buttons: set });
    expect(thread.toThreadMessages([m("agent")], { meId: "me", ids: new Map() })[0].buttons).toMatchObject({ state: "open" });
    expect(thread.toThreadMessages([m("person")], { meId: "me", ids: new Map() })[0]).not.toHaveProperty("buttons");
    expect(thread.toThreadMessages([m("agent")], { meId: "me", ids: new Map(), direct: true })[0]).not.toHaveProperty("buttons");
  });
  it("a closed poll's room line is in the viewer's words", () => {
    i18n.setLang("zh-TW", { store: false });
    expect(thread.systemText({ system: { kind: "poll-closed", name: "budget-check" }, text: "Poll closed · 2 voted" })).toBe("budget-check 的投票已結束");
    i18n.setLang("en", { store: false });
    expect(thread.systemText({ system: { kind: "poll-closed", name: "budget-check" }, text: "x" })).toBe("budget-check's poll closed");
  });
});

describe("in the room page", () => {
  it("my buttons are open; 陳主任's are shut and say so; pressing mine posts my click and marks it chosen", async () => {
    const { pg } = await roomPage();
    const mine = rowOf(pg, "要先送審"), theirs = rowOf(pg, "請選規格版本");
    expect(labels(mine)).toEqual(["先送審", "下週一起"]);
    expect(labels(theirs)).toEqual(["v2(off)", "v3(off)"]);
    expect(theirs.querySelector(".rb-note").textContent).toBe("只有 陳主任 能回答");
    fire(mine.querySelector(".rb-btn"), "click");
    await until(() => labels(rowOf(pg, "要先送審")).some((x) => x.startsWith("✓")));
    expect(labels(rowOf(pg, "要先送審"))).toEqual(["✓ 先送審(off)", "下週一起(off)"]);
    expect(rowOf(pg, "要先送審").querySelector(".rb-note").textContent).toContain(FIXTURE_ME.name);
    const click = [...pg.root.querySelectorAll(".hub-room-page .thread .msg.user")].at(-1) as any;
    expect(click.querySelector(".md").textContent).toBe("先送審");
    expect(click.querySelector(".msg-quote").textContent).toContain("要先送審");
  });
  it("a poll is everyone's: my vote is marked and the live counts move", async () => {
    const { pg } = await roomPage();
    const poll = () => rowOf(pg, "週會改哪天");
    expect(labels(poll())).toEqual(["週三 · 1", "週四 · 0", "週五 · 0"]);
    fire(poll().querySelectorAll(".rb-btn")[1], "click");
    await until(() => labels(poll()).some((x) => x.startsWith("✓")));
    expect(labels(poll())).toEqual(["週三 · 1", "✓ 週四 · 1", "週五 · 0"]);
    expect(poll().querySelector(".rb-btn[aria-pressed=\"true\"]").textContent).toContain("週四");
  });
});

describe("the Fleet chat's thread", () => {
  it("draws no note on reply buttons that carry none (#1266 unchanged)", () => {
    const pg = page({ url: "http://127.0.0.1:19280/ui", storage: {} }); mounted.push(pg);
    const list = pg.document.createElement("div"), sc = pg.document.createElement("div"); sc.append(list); pg.document.body.append(sc);
    const t = (k: string) => k;
    const th = chatThread.createThread(list, pg.document.createElement("div"), { t, tf: t, isUser: (x: any) => x.role === "user", onJump() {}, onEmpty() {} });
    th.attach(sc);
    th.render([{ boot: "b", id: 1, role: "agent", sender: "a", ts: "2026-11-15T00:00:00Z", text: "hi", buttons: { id: "d".repeat(32), labels: ["A"], state: "open" } }]);
    expect(list.querySelector(".rb-note")).toBeNull();
    expect((list.querySelector(".rb-btn") as any).disabled).toBe(false);
    th.dispose(true);
  });
});
