/**
 * #1266: an agent reply's buttons in the web chat — the thread draws them as text (labels escaped, never Markdown),
 * a click names only the set and the index, an ended set is shown ended, and the store keeps the furthest state
 * whichever way it arrives (the stream's reply_buttons event, the history, the public link's poll).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { installDom } from "./helpers/mini-dom.js";

type Served = any;
let R: any, createThread: any, createChatStore: any, t: any;
beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types
  await import("../src/ui/chat-render.js");
  R = (globalThis as any).AgendChatRender;
  ({ createThread } = await (import("/ui/js/chat-thread.js") as Promise<Served>));
  ({ createChatStore } = await (import("/ui/js/chat-store.js") as Promise<Served>));
  await (import("/ui/js/chat-strings.js") as Promise<Served>);
  ({ t } = await (import("/assets/app-i18n.js") as Promise<Served>));
});

const SET = "b".repeat(32);
const agent = (id: number, buttons?: unknown) => ({ boot: "x", id, instance: "w", sender: "w", role: "agent", text: `reply ${id}`, ts: "2026-01-01T00:00:00Z", ...(buttons ? { buttons } : {}) });

function thread(over: Record<string, unknown> = {}) {
  const dom = installDom({});
  const doc = (globalThis as any).document;
  const scroller = doc.createElement("div"); const list = doc.createElement("div");
  scroller.append(list); doc.body.append(scroller);
  const clicks: Array<[string, number]> = [];
  const th = createThread(list, scroller, {
    t: (k: string) => t(k), tf: (k: string, ...a: unknown[]) => t(k, ...a), isUser: (x: any) => x.role === "user", onJump() {}, onEmpty() {},
    setPreviewOptIn() {}, copyText: async () => true, download() {}, toggleWrap() {},
    clickReplyButton: (id: string, i: number) => clicks.push([id, i]), ...over,
  });
  return { dom, list, th, clicks };
}
const buttonsIn = (list: any) => [...list.querySelectorAll(".rb-btn")] as any[];

describe("the thread draws a reply's buttons", () => {
  it("open: one button per label, as text; a click names the set and the index", () => {
    const { dom, list, th, clicks } = thread();
    try {
      th.render([agent(1, { id: SET, labels: ["Deploy", "<b>raw</b> & \"quoted\""], state: "open" })]);
      const btns = buttonsIn(list);
      expect(btns.map(b => b.textContent)).toEqual(["Deploy", "<b>raw</b> & \"quoted\""]);
      expect(!!list.querySelector(".rb-row b"), "a label is never markup").toBe(false);
      expect(btns.map(b => [b.getAttribute("data-arg"), b.disabled])).toEqual([[`${SET}:0`, false], [`${SET}:1`, false]]);
      th.onClick({ target: btns[1] });
      expect(clicks).toEqual([[SET, 1]]);
    } finally { dom.restore(); }
  });
  it("chosen: every button off, the chosen one marked, and who chose it; expired: off, with the note", () => {
    const { dom, list, th } = thread();
    try {
      th.render([agent(1, { id: SET, labels: ["Deploy", "Wait"], state: "chosen", chosen: 1, by: "alice" })]);
      expect(buttonsIn(list).map(b => [b.textContent, b.disabled, b.classList.contains("chosen")])).toEqual([["Deploy", true, false], ["✓ Wait", true, true]]);
      expect(list.querySelector(".rb-note").textContent).toBe("Chosen by alice");
      th.render([agent(1, { id: SET, labels: ["Deploy"], state: "expired" })]);
      expect([buttonsIn(list)[0].disabled, list.querySelector(".rb-note").textContent]).toEqual([true, "Expired — reply in text"]);
    } finally { dom.restore(); }
  });
  it("a click in flight turns them off; a person's message never shows buttons", () => {
    const { dom, list, th } = thread({ replyButtonBusy: (id: string) => id === SET });
    try {
      th.render([agent(1, { id: SET, labels: ["Deploy"], state: "open" }), { ...agent(2, { id: "c".repeat(32), labels: ["X"], state: "open" }), role: "user" }]);
      expect(buttonsIn(list).map(b => b.disabled)).toEqual([true]);
    } finally { dom.restore(); }
  });
});

describe("the furthest state wins, however it arrives", () => {
  const open = { id: SET, labels: ["A", "B"], state: "open" };
  const chosen = { ...open, state: "chosen", chosen: 0, by: "alice" };
  it("mergeMessages: the same message again with ended buttons replaces open ones, never the other way", () => {
    expect(R.mergeMessages([agent(1, open)], [agent(1, chosen)], 500)[0].buttons).toEqual(chosen);
    expect(R.mergeMessages([agent(1, chosen)], [agent(1, open)], 500)[0].buttons).toEqual(chosen);
  });
  it("applyReplyButtons: by set id; an older state does not undo a newer one; an unknown set changes nothing", () => {
    const list = [agent(1), agent(2, open)];
    const next = R.applyReplyButtons(list, chosen);
    expect(next[1].buttons).toEqual(chosen);
    expect(R.applyReplyButtons(next, open)).toBe(next);
    expect(R.applyReplyButtons(list, { ...chosen, id: "d".repeat(32) })).toBe(list);
  });
  it("the store: a reply_buttons event updates the message; a click posts only instance, id and index", async () => {
    const calls: any[] = [];
    const store = createChatStore({
      fetch: async (path: string, o: any = {}) => { calls.push({ path, body: o.body ? JSON.parse(o.body) : undefined }); return { ok: true, status: 200, json: async () => ({ answered: true }) }; },
      toast: () => {}, announce: () => {}, t, setTimeout: () => 0,
    });
    const handlers: Record<string, (d: unknown) => void> = {};
    store.attach({ on: (ev: string, fn: (d: unknown) => void) => { handlers[ev] = fn; } });
    store.ingest(agent(1, open));
    const seen: string[] = [];
    store.subscribe((_i: string, kind: string) => seen.push(kind));
    handlers.reply_buttons!({ instance: "w", buttons: chosen });
    expect(store.state.msgs.w[0].buttons).toEqual(chosen);
    expect(seen).toContain("msgs");
    await store.clickReplyButton("w", SET, 1);
    expect(calls.at(-1)).toEqual({ path: "/ui/reply-button", body: { instance: "w", id: SET, index: 1 } });
  });
});
