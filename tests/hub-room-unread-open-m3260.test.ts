/**
 * M-3260 (the user, beta.9, a group room of 1 person and 2 agents): the agent's answer was the newest message on screen,
 * yet the room's row in the list kept a red 「1」. The Hub counts unread per member (rooms/service.ts summary: rows past
 * the member's read_sequence); an agent's answer is its waiting row answered in place and MOVED to the room's newest
 * sequence (rooms/agents.ts), which reaches the page as message.updated — the same number of messages. The open room
 * marked read only when the count changed, so the read position stayed before the answer.
 * Now: the open, visible room marks read whenever its newest row changes, and again when a hidden tab is shown; a hidden
 * tab marks nothing. The list takes unread.changed at once (the open room's read clears its badge, another room's message
 * raises its badge). The Hub's answer flow is written here by hand: the shared fixture's reads are by position.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
import { createHubRoomsFixture } from "./support/hub-rooms-fixture.js";

let client: any, shell: any, store: any, router: any, i18n: any, hubPanel: any;
const mounted: AppPage[] = [];
const g = globalThis as any;
const until = async (fn: () => unknown, n = 200) => { for (let i = 0; i < n && !fn(); i++) await settle(5); };
beforeAll(async () => {
  const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1" } });
  g.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" });
  store = await import("/assets/app-store.js"); router = await import("/assets/app-nav.js"); shell = await import("/assets/app-shell.js");
  i18n = await import("/assets/app-i18n.js"); client = await import("/ui/js/hub-client.js"); hubPanel = await import("/ui/js/panel-hub.js");
  pg.restore();
});
const realES = g.EventSource, realFetch = g.fetch;
afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } client.setHubClient(null); g.EventSource = realES; g.fetch = realFetch; });

/** room-weekly open; `reads` the read positions the page sends (upTo), in order. */
async function openRoom() {
  const fx = createHubRoomsFixture(), reads: string[] = [];
  g.fetch = (url: string, init?: any) => {
    if (/\/hub\/v1\/rooms\/room-weekly\/read$/.test(String(url)) && init?.method === "POST") reads.push(JSON.parse(init.body).upTo);
    return fx.fetch(url, init);
  };
  g.EventSource = fx.EventSource;
  const pg = page({ url: "http://127.0.0.1:19280/ui/hub?room=room-weekly", storage: { agend_tour_done: "1" } });
  pg.document.body.setAttribute("data-hub", "hub"); pg.document.body.setAttribute("data-hub-name", "Team Hub"); mounted.push(pg);
  i18n.setLang("en", { store: false });
  client.setHubClient(client.createHubWebClient()); hubPanel.resetHubSession(); router.startRouter(pg.window); store.applyStatus({ instances: [] });
  await pg.mount(h(shell.Shell, { panels: new Map([["hub", { Component: hubPanel.HubPanel }]]), onNewInstance() {} }));
  await until(() => pg.root.querySelectorAll(".hub-room-page .thread .msg").length > 5 && reads.length > 0);
  return { pg, fx, reads };
}
const room = (fx: any) => fx.rooms.find((r: any) => r.id === "room-weekly");
const badge = (pg: AppPage, id: string) => pg.root.querySelector(`[data-room="${id}"] .nav-count`)?.textContent ?? null;
let hidden = false;
const setHidden = (pg: AppPage, v: boolean) => {
  hidden = v;
  Object.defineProperty(pg.document, "hidden", { configurable: true, get: () => hidden });
  fire(pg.document as any, "visibilitychange", { bubbles: false });   // once (the helper's bubbling passes the document twice)
};

describe("M-3260: an open room reads the agent's answer that lands while it is on screen", () => {
  it("the answer (message.updated, moved to the newest sequence) is marked read; the list's 1 clears at once", async () => {
    const { pg, fx, reads } = await openRoom();
    const r = room(fx), base = r.messages.length;
    const asked = r.messages.at(-1);
    // The Hub's answer flow: the agent's waiting row (no text yet: not counted), then the same row answered and moved.
    const waiting = { id: "ans-3260", roomId: r.id, sequence: base + 1, at: asked.at + 1, author: { kind: "agent", id: "exp-01", name: "general" },
      text: "", mentions: [], replyTo: asked.id, answerTo: asked.id, stage: "working" };
    r.messages.push(waiting);
    fx.emit("message.added", { roomId: r.id, message: waiting });
    await until(() => reads.at(-1) === "ans-3260");
    const before = reads.length;
    const answered = { ...waiting, sequence: base + 2, text: "Done — the report is attached.", stage: "answered" };
    r.messages[r.messages.length - 1] = answered;
    r.readUpTo = asked.id;                                        // the Hub's read position: before the answer's new sequence
    fx.emit("message.updated", { roomId: r.id, message: answered });
    fx.emit("unread.changed", { roomId: r.id, unread: 1 });      // what the Hub sends for the answer
    await until(() => reads.length > before);
    expect(reads.slice(before), "the open room reads the answer").toEqual(["ans-3260"]);
    await until(() => badge(pg, "room-weekly") === null);
    expect(badge(pg, "room-weekly"), "the list's badge clears without waiting for its next read").toBeNull();
    expect(pg.root.querySelector(".hub-room-page .thread")!.textContent).toContain("the report is attached");
    // control: another room's message raises that room's badge at once (it is not open: it stays unread)
    fx.emit("unread.changed", { roomId: "room-rd", unread: 3 });
    await until(() => badge(pg, "room-rd") === "3");
    expect(badge(pg, "room-rd")).toBe("3");
  });

  it("a hidden tab marks nothing (the answer stays unread); shown again, the room is read", async () => {
    const { pg, fx, reads } = await openRoom();
    const r = room(fx), asked = r.messages.at(-1);
    setHidden(pg, true);
    try {
      const before = reads.length;
      const answer = { id: "ans-hidden", roomId: r.id, sequence: r.messages.length + 1, at: asked.at + 1, author: { kind: "agent", id: "exp-01", name: "general" },
        text: "Here it is.", mentions: [], replyTo: asked.id, answerTo: asked.id, stage: "answered" };
      r.messages.push(answer);
      fx.emit("message.added", { roomId: r.id, message: answer });
      await until(() => pg.root.querySelector(".hub-room-page .thread")!.textContent!.includes("Here it is."));
      await settle(20);
      expect(reads.length, "hidden: no read").toBe(before);
      setHidden(pg, false);
      await until(() => reads.length > before);
      expect(reads.slice(before)).toEqual(["ans-hidden"]);
    } finally { setHidden(pg, false); }
  });
});
