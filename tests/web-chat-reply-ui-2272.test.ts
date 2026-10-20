/**
 * #2272: reply to a message in the web chat — the page. The real modules on the mini DOM:
 * - the thread: every message has a Reply action (hover strip) and its key; a reply shows its quote (escaped; "an earlier
 *   message" when hidden; [Photo]/[File] for files) as a button that shows the quoted message — drawn, read back from
 *   the server's history, or said to be gone;
 * - the store: a reply sends its row only ({ boot, id }), is cleared by a sent message and by "reply_gone", kept on any
 *   other failure;
 * - the gestures: right-click → Reply / Copy text / Copy link (Shift or selected text: the browser's menu); a long press
 *   → the same menu; a swipe right ≥ 56 px → reply, a vertical move → nothing; R on a focused message → reply;
 * - the phone drawer's swipe leaves a message alone (its swipe is a reply) and still opens from the thread around it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDom, MiniEvent, type MiniPage } from "./helpers/mini-dom.js";

let dom: MiniPage | null = null;
const offs: Array<() => void> = [];
afterEach(() => { for (const f of offs.splice(0)) f(); dom?.restore(); dom = null; vi.useRealTimers(); });

async function i18n(lang: "en" | "zh-TW" = "en") {
  const { t, setLang } = await import("/assets/app-i18n.js") as any;
  await import("/ui/js/chat-strings.js");
  setLang(lang, { store: false });
  return t;
}
const row = (over: Record<string, unknown> = {}) => ({ boot: "ab12", id: 1, instance: "a", role: "agent", sender: "atlas", text: "the plan", ts: "2026-10-20T10:00:00Z", ...over });

async function threadWith(rows: any[], opts: Record<string, unknown> = {}, lang: "en" | "zh-TW" = "en") {
  dom = installDom({});
  const t = await i18n(lang);
  const { createThread } = await import("/ui/js/chat-thread.js") as any;
  const doc = dom.document as any;
  const list = doc.createElement("div"), scroller = doc.createElement("div"); scroller.append(list); doc.body.append(scroller);
  const thread = createThread(list, scroller, { t, tf: t, isUser: (x: any) => x.role === "user", serverNow: () => 0, onJump() {}, onEmpty() {}, ...opts });
  thread.render(rows);
  offs.push(() => thread.dispose());
  return { doc, list, thread, t };
}

describe("the thread", () => {
  it("every message has its key and a Reply action; a reply shows its quote, escaped, as a button", async () => {
    const quote = { boot: "ab12", id: 1, sender: "<b>atlas</b>", text: "say <i>hi</i>" };
    const { list } = await threadWith([row(), row({ id: 2, role: "user", sender: "Ops", text: "yes", replyTo: quote })]);
    const msgs = list.querySelectorAll(".msg");
    expect(msgs.map((m: any) => [m.getAttribute("data-key"), m.getAttribute("tabindex"), !!m.querySelector('.msg-actions button[data-act="reply"]')]))
      .toEqual([["ab12-1", "0", true], ["ab12-2", "0", true]]);
    const q = msgs[1].querySelector(".msg-quote");
    expect([q.getAttribute("data-act"), q.getAttribute("data-arg"), q.querySelector(".quote-sender").textContent, q.querySelector(".quote-text").textContent])
      .toEqual(["jumpQuote", "ab12-1", "<b>atlas</b>", "say <i>hi</i>"]);
    expect(q.innerHTML).not.toContain("<b>");
    expect(msgs[0].querySelector(".msg-quote"), "no quote on a message that is not a reply").toBeNull();
  });
  it("hidden: 'an earlier message'; files only: [Photo] / [File] (zh-TW: [圖片] / [檔案])", async () => {
    const { list } = await threadWith([row({ id: 2, role: "user", replyTo: { boot: "ab12", id: 1, hidden: true } }), row({ id: 3, role: "user", replyTo: { boot: "ab12", id: 1, sender: "atlas", text: "", media: "photo" } }),
      row({ id: 4, role: "user", replyTo: { boot: "ab12", id: 1, sender: "atlas", text: "", media: "document" } })]);
    expect(list.querySelectorAll(".msg-quote").map((q: any) => q.querySelector(".quote-text").textContent)).toEqual(["an earlier message", "[Photo]", "[File]"]);
    expect(list.querySelectorAll(".msg-quote")[0].querySelector(".quote-sender"), "hidden: no sender").toBeNull();
    dom?.restore(); dom = null;
    const leaky = await threadWith([row({ id: 2, role: "user", replyTo: { boot: "ab12", id: 1, hidden: true, sender: "who", text: "what" } })]);
    expect([leaky.list.querySelector(".quote-sender"), leaky.list.querySelector(".quote-text").textContent], "hidden wins over any sender or text").toEqual([null, "an earlier message"]);
    dom?.restore(); dom = null;
    const zh = await threadWith([row({ id: 3, role: "user", replyTo: { boot: "ab12", id: 1, sender: "atlas", text: "", media: "photo" } }), row({ id: 4, role: "user", replyTo: { boot: "ab12", id: 1, sender: "atlas", text: "", media: "document" } })], {}, "zh-TW");
    expect(zh.list.querySelectorAll(".quote-text").map((q: any) => q.textContent)).toEqual(["[圖片]", "[檔案]"]);
  });
  it("Reply starts a reply with the row; the quote shows the message — drawn, read back, or said to be gone", async () => {
    const startReply = vi.fn(), notice = vi.fn(), findQuoted = vi.fn(async () => false);
    const { list, thread } = await threadWith([row(), row({ id: 2, role: "user", replyTo: { boot: "ab12", id: 1, sender: "atlas", text: "the plan" } }),
      row({ id: 3, role: "user", replyTo: { boot: "ab12", id: 999, sender: "atlas", text: "old" } })], { startReply, notice, findQuoted });
    const fire = (el: any) => thread.onClick({ target: el, preventDefault() {}, defaultPrevented: false, button: 0 });
    fire(list.querySelectorAll('button[data-act="reply"]')[0]);
    expect(startReply.mock.calls.map(c => [c[0].boot, c[0].id])).toEqual([["ab12", 1]]);
    const [, toDrawn, toGone] = list.querySelectorAll(".msg");
    fire(toDrawn.querySelector(".msg-quote")); await Promise.resolve();
    expect([list.querySelector('[data-key="ab12-1"]').classList.contains("flash"), findQuoted.mock.calls.length]).toEqual([true, 0]);
    fire(toGone.querySelector(".msg-quote")); await new Promise(r => setTimeout(r, 0));
    expect([findQuoted.mock.calls.map(c => c[0]), notice.mock.calls.map(c => c[0])]).toEqual([["ab12-999"], ["That message is no longer in this chat."]]);
  });
});

describe("the store", () => {
  async function store(answer: (body: any) => any) {
    dom = installDom({});
    const t = await i18n();
    const { createChatStore } = await import("/ui/js/chat-store.js") as any;
    const bodies: any[] = [];
    const fetch = vi.fn(async (_path: string, init: any) => { const b = JSON.parse(init.body); bodies.push(b); const a = answer(b); return { ok: !a.error, status: a.status ?? 200, json: async () => a }; });
    const toast = vi.fn();
    const s = createChatStore({ fetch, t, toast, announce: vi.fn(), now: () => 1, setTimeout });
    return { s, bodies, toast };
  }
  it("a reply sends its row only; a sent message clears it", async () => {
    const { s, bodies } = await store(() => ({ sent: true }));
    s.startReply("a", row({ attachments: [{ kind: "photo" }], text: "  multi\nline  " }));
    expect(s.state.replies.a).toEqual({ boot: "ab12", id: 1, sender: "atlas", text: "multi line", media: "photo" });
    s.setDraft("a", "yes"); await s.send("a");
    expect(bodies).toEqual([{ instance: "a", message: "yes", replyTo: { boot: "ab12", id: 1 } }]);
    expect(s.state.replies.a).toBeUndefined();
    s.setDraft("a", "plain"); await s.send("a");
    expect(bodies[1]).toEqual({ instance: "a", message: "plain" });
  });
  it("'reply_gone' clears it (the text kept); any other failure keeps it; ✕ clears it", async () => {
    let reason = "reply_gone";
    const { s } = await store(() => ({ error: "x", reason, status: 409 }));
    s.setCurrent("a");                                                          // the chat shown: its draft comes back
    s.startReply("a", row()); s.setDraft("a", "yes"); await s.send("a");
    expect([s.state.replies.a, s.state.drafts.a]).toEqual([undefined, "yes"]);
    reason = "delivery_changed";
    s.startReply("a", row()); await s.send("a");
    expect(s.state.replies.a?.id).toBe(1);
    s.clearReply("a");
    expect(s.state.replies.a).toBeUndefined();
  });
});

describe("the gestures", () => {
  async function gestures() {
    const reply = vi.fn(), copyText = vi.fn(async () => true), notice = vi.fn();
    const { doc, list, thread, t } = await threadWith([row(), row({ id: 2, role: "user", sender: "Ops", text: "mine" })]);
    const { installMessageActions } = await import("/ui/js/chat-msg-actions.js") as any;
    offs.push(installMessageActions(list, { t, messageOf: thread.messageOf, reply, copyText, notice, linkOf: (x: any) => `L:${x.boot}-${x.id}` }));
    const msg = list.querySelector('[data-key="ab12-1"]');
    const body = msg.querySelector(".body");
    const menu = () => doc.body.querySelector(".msg-menu");
    return { doc, list, msg, body, menu, reply, copyText, notice };
  }
  const ev = (type: string, init: Record<string, unknown> = {}) => new MiniEvent(type, { bubbles: true, cancelable: true, ...init });
  it("right-click: Reply / Copy text / Copy link; Shift keeps the browser's menu; Escape closes", async () => {
    const g = await gestures();
    const e = ev("contextmenu", { clientX: 40, clientY: 50 });
    g.body.dispatchEvent(e);
    expect([e.defaultPrevented, g.menu()?.querySelectorAll("button").map((b: any) => [b.dataset.item, b.textContent])])
      .toEqual([true, [["reply", "Reply"], ["copyText", "Copy text"], ["copyLink", "Copy link"]]]);
    g.menu().querySelector('[data-item="copyLink"]').dispatchEvent(ev("click"));
    await Promise.resolve(); await Promise.resolve();
    expect([g.copyText.mock.calls[0]?.[0], g.menu()]).toEqual(["L:ab12-1", null]);
    g.body.dispatchEvent(ev("contextmenu")); g.menu().querySelector('[data-item="reply"]').dispatchEvent(ev("click"));
    expect(g.reply.mock.calls.map(c => c[0].id)).toEqual([1]);
    const shift = ev("contextmenu", { shiftKey: true }); g.body.dispatchEvent(shift);
    expect([shift.defaultPrevented, g.menu()]).toEqual([false, null]);
    g.body.dispatchEvent(ev("contextmenu")); g.doc.dispatchEvent(ev("keydown", { key: "Escape" }));
    expect(g.menu()).toBeNull();
  });
  it("R on a focused message replies; not with a modifier, not from inside it", async () => {
    const g = await gestures();
    g.msg.dispatchEvent(ev("keydown", { key: "r" }));
    g.msg.dispatchEvent(ev("keydown", { key: "R", ctrlKey: true }));
    g.body.dispatchEvent(ev("keydown", { key: "r" }));
    expect(g.reply.mock.calls.map(c => c[0].id)).toEqual([1]);
  });
  it("a swipe right past 56 px replies; a short one, a vertical one or a leftward one does not; a long press opens the menu", async () => {
    const g = await gestures();
    const swipe = (x1: number, y1: number) => {
      g.body.dispatchEvent(ev("touchstart", { touches: [{ clientX: 100, clientY: 300 }] }));
      g.body.dispatchEvent(ev("touchmove", { touches: [{ clientX: x1, clientY: y1 }] }));
      g.body.dispatchEvent(ev("touchend", { touches: [] }));
    };
    swipe(170, 305); swipe(140, 300); swipe(130, 380); swipe(20, 300);
    expect(g.reply.mock.calls.map(c => c[0].id)).toEqual([1]);
    expect(g.msg.style.transform, "the bubble goes back").toBe("");
    vi.useFakeTimers();
    g.body.dispatchEvent(ev("touchstart", { touches: [{ clientX: 100, clientY: 300 }] }));
    vi.advanceTimersByTime(520);
    expect(g.menu()?.querySelectorAll("button").length).toBe(3);
    const click = ev("click"); g.body.dispatchEvent(click);
    expect(click.defaultPrevented, "the click the long press would also cause is swallowed").toBe(true);
  });
  it("Android: its long press also fires contextmenu — one menu, and the press's own timer never fires after it", async () => {
    const g = await gestures();
    vi.useFakeTimers();
    g.body.dispatchEvent(ev("touchstart", { touches: [{ clientX: 100, clientY: 300 }] }));
    vi.advanceTimersByTime(450);
    g.body.dispatchEvent(ev("contextmenu", { clientX: 100, clientY: 300 }));
    const first = g.menu();
    vi.advanceTimersByTime(300);
    expect(g.menu(), "the same menu, not opened again").toBe(first);
    const click = ev("click"); g.body.dispatchEvent(click);
    expect(click.defaultPrevented, "nothing swallowed: the press never completed").toBe(false);
  });
});

describe("the phone drawer's swipe", () => {
  it("leaves a message alone (its swipe is a reply) and still opens from the thread around it", async () => {
    dom = installDom({ matchNarrow: true });
    const doc = dom.document as any;
    const main = doc.createElement("main"); main.id = "main"; doc.body.append(main);
    const thread = doc.createElement("div"); thread.className = "thread"; main.append(thread);
    const msg = doc.createElement("div"); msg.className = "msg agent"; msg.setAttribute("data-key", "ab12-1"); thread.append(msg);
    const inside = doc.createElement("p"); msg.append(inside);
    (globalThis as any).getComputedStyle = () => ({ overflowX: "visible" });
    const state = { open: false, opens: 0 };
    const { installSwipe } = await import("/assets/app-swipe.js") as any;
    offs.push(installSwipe({ doc, win: globalThis, isDrawer: () => true, isOpen: () => state.open, open: () => { state.open = true; state.opens++; }, close: () => { state.open = false; } }));
    const swipe = (target: any) => {
      target.dispatchEvent(new MiniEvent("touchstart", { bubbles: true, touches: [{ clientX: 60, clientY: 400 }] }));
      target.dispatchEvent(new MiniEvent("touchmove", { bubbles: true, touches: [{ clientX: 110, clientY: 405 }] }));
      target.dispatchEvent(new MiniEvent("touchend", { bubbles: true, touches: [], changedTouches: [{ clientX: 160, clientY: 410 }] }));
    };
    swipe(inside);
    expect(state.opens).toBe(0);
    swipe(thread);
    expect(state.opens).toBe(1);
  });
});
