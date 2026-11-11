/**
 * M-2789 (the user, 11-09): answer a long, multi-part message passage by passage — select text in one message → 「引用」 →
 * the passage goes into the composer as a Markdown quote at the caret; repeatable. chat-quote.js on the mini DOM:
 * - the quote's text: "> " lines, trimmed, one block; put in at the caret on its own lines, the caret after it;
 * - what counts as a passage: inside ONE message's words (not its header, not across messages, not elsewhere);
 * - the pill: shown for a passage (「引用」 on a desktop, 「引用選取的文字」 on a phone), gone when the selection is, on
 *   Escape, while the pointer is down, and on a page that can't send; its click quotes the passage and clears the
 *   selection; desktop pill anchored to the passage's end (its pointer), phone pill above the composer in the gutter;
 * - the composer: its own scroller shows the caret (the newest quote) without focusing it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDom, MiniEvent, type MiniPage } from "./helpers/mini-dom.js";

let dom: MiniPage | null = null;
const offs: Array<() => void> = [];
afterEach(() => { for (const f of offs.splice(0)) f(); dom?.restore(); dom = null; vi.useRealTimers(); });

async function load(lang: "en" | "zh-TW" = "en") {
  dom = installDom({});
  const { setLang } = await import("/assets/app-i18n.js") as any;
  const q = await import("/ui/js/chat-quote.js") as any;
  setLang(lang, { store: false });
  return q;
}

describe("the quote's text and where it goes", () => {
  it("each line becomes '> line'; ends trimmed; a run of empty lines inside stays one quoted empty line", async () => {
    const q = await load();
    expect(q.quoteBlock("  部署前要不要先跑 rehearsal？  ")).toBe(">   部署前要不要先跑 rehearsal？");
    expect(q.quoteBlock("\n\nfirst\r\nsecond  \n\n\n\nthird\n\n")).toBe("> first\n> second\n>\n> third");
    expect(q.quoteBlock("a b")).toBe("> a b");
    expect([q.quoteBlock(""), q.quoteBlock(" \n \n"), q.insertQuote("x", 1, "  \n")]).toEqual(["", "", null]);
  });
  it("into an empty composer: the quote, then the caret on the next line", async () => {
    const q = await load();
    expect(q.insertQuote("", 0, "part one")).toEqual({ value: "> part one\n", caret: 11 });
  });
  it("after text: a blank line first; text after the caret moves to its own line below", async () => {
    const q = await load();
    expect(q.insertQuote("my answer", 9, "next part")).toEqual({ value: "my answer\n\n> next part\n", caret: 23 });
    expect(q.insertQuote("my answer\n", 10, "p")).toEqual({ value: "my answer\n\n> p\n", caret: 15 });
    expect(q.insertQuote("my answer\n\n", 11, "p")).toEqual({ value: "my answer\n\n> p\n", caret: 15 });
    // Text after the caret: on its own line below, the caret on the empty line between (for the answer).
    expect(q.insertQuote("before after", 6, "p")).toEqual({ value: "before\n\n> p\n\nafter", caret: 12 });
  });
  it("repeatable: quote, answer, quote the next passage, answer — the composer the user asked for", async () => {
    const q = await load();
    let r = q.insertQuote("", 0, "部署前要不要先跑一次完整的 rehearsal？");
    let v = r.value.slice(0, r.caret) + "要，跑 b3 那套就好。" + r.value.slice(r.caret);
    r = q.insertQuote(v, v.length, "Hub 的名稱要不要顯示在登入頁？");
    v = r.value.slice(0, r.caret) + "要。" + r.value.slice(r.caret);
    expect(v).toBe("> 部署前要不要先跑一次完整的 rehearsal？\n要，跑 b3 那套就好。\n\n> Hub 的名稱要不要顯示在登入頁？\n要。");
  });
  it("a caret out of range is the end; an unknown one too", async () => {
    const q = await load();
    expect([q.insertQuote("ab", 99, "p").value, q.insertQuote("ab", undefined, "p").value, q.insertQuote("ab", -3, "p").value])
      .toEqual(["ab\n\n> p\n", "ab\n\n> p\n", "> p\n\nab"]);
  });
});

/** A thread of two messages (the markup chat-thread.js draws: .msg > .meta + .body > .md). */
function thread(doc: any) {
  const list = doc.createElement("div");
  const msg = (key: string, words: string) => {
    const m = doc.createElement("div"); m.className = "msg agent"; m.setAttribute("data-key", key);
    const meta = doc.createElement("div"); meta.className = "meta"; meta.textContent = "atlas 10:00";
    const body = doc.createElement("div"); body.className = "body";
    const md = doc.createElement("div"); md.className = "md"; md.textContent = words;
    body.append(md); m.append(meta, body); list.append(m);
    return { m, meta, md, text: md.firstChild };
  };
  const a = msg("k1", "三個問題要你決定：部署前要不要先跑 rehearsal？"), b = msg("k2", "another message");
  doc.body.append(list);
  return { list, a, b };
}
/** A selection over `start`..`end` nodes whose text is `text` (what the browser's Selection says). */
const selection = (start: any, end: any, text: string, rect = { left: 100, right: 300, top: 200, bottom: 220, width: 200, height: 20 }) => ({
  isCollapsed: !text, rangeCount: text ? 1 : 0, toString: () => text,
  getRangeAt: () => ({ startContainer: start, endContainer: end, getClientRects: () => [rect] }),
  removeAllRanges: vi.fn(),
});

describe("what counts as a passage", () => {
  it("inside one message's words: yes — its header, across messages, or nothing selected: no", async () => {
    const q = await load(); const doc = dom!.document as any;
    const { list, a, b } = thread(doc);
    expect(q.selectedPassage(list, selection(a.text, a.text, "部署前要不要先跑 rehearsal？"))?.text).toBe("部署前要不要先跑 rehearsal？");
    expect(q.selectedPassage(list, selection(a.meta.firstChild, a.text, "atlas 10:00 三個"))).toBe(null);
    expect(q.selectedPassage(list, selection(a.text, b.text, "rehearsal？ another"))).toBe(null);
    expect(q.selectedPassage(list, selection(a.text, a.text, "   "))).toBe(null);
    expect(q.selectedPassage(list, selection(a.text, a.text, ""))).toBe(null);
    // #3555 review P3: every range of a multi-range selection counts — one outside the message: no passage.
    const two = (r2s: any, r2e: any, text: string) => ({ ...selection(a.text, a.text, text), rangeCount: 2,
      getRangeAt: (i: number) => (i === 0 ? { startContainer: a.text, endContainer: a.text } : { startContainer: r2s, endContainer: r2e }) });
    expect(q.selectedPassage(list, two(b.text, b.text, "rehearsal another"))).toBe(null);
    expect(q.selectedPassage(list, two(a.text, a.text, "三個 rehearsal"))?.text).toBe("三個 rehearsal");
    const outside = doc.createElement("p"); outside.textContent = "elsewhere"; doc.body.append(outside);
    expect(q.selectedPassage(list, selection(outside.firstChild, outside.firstChild, "elsewhere"))).toBe(null);
  });
});

describe("the pill", () => {
  async function mounted(o: { lang?: "en" | "zh-TW"; phone?: boolean; canQuote?: boolean; thread?: any } = {}) {
    vi.useFakeTimers();
    const q = await load(o.lang ?? "en"); const doc = dom!.document as any;
    const { list, a } = thread(doc);
    let sel: any = selection(null, null, "");
    doc.getSelection = () => sel;
    const box = doc.createElement("div"); box.getBoundingClientRect = () => ({ top: 700, left: 8, right: 382, bottom: 840, width: 374, height: 140 });
    doc.body.append(box);
    const insert = vi.fn();
    // The thread's visible box (the chat scroller): 0..680 unless a test gives its own.
    list.getBoundingClientRect = () => o.thread ?? { top: 0, left: 0, right: 1024, bottom: 680, width: 1024, height: 680 };
    offs.push(q.installQuoteSelection(list, { insert, canQuote: () => o.canQuote !== false, phone: () => !!o.phone, composerBox: () => box, threadBox: () => list, field: () => null }));
    const select = (text: string, rect?: any) => { sel = selection(a.text, a.text, text, rect); doc.dispatchEvent(new MiniEvent("selectionchange")); vi.advanceTimersByTime(200); };
    const pill = () => doc.querySelector(".quote-pop");
    return { doc, list, a, insert, select, pill, getSel: () => sel };
  }
  it("a passage shows 「引用」 (zh-TW) / Quote, labelled for screen readers; its click quotes the passage and clears the selection", async () => {
    const zh = await mounted({ lang: "zh-TW" });
    zh.select("部署前要不要先跑 rehearsal？");
    expect([zh.pill()?.textContent, zh.pill()?.getAttribute("aria-label"), zh.pill()?.getAttribute("role")]).toEqual(["引用", "把選取的文字引用到你的訊息裡", "toolbar"]);
    const s = zh.getSel();
    // A press on the pill keeps the selection it is about: both the pointer's and the mouse's default are stopped
    // (Chrome collapses a selection on mousedown even when pointerdown is prevented — the real-browser smoke caught it).
    const pd = new MiniEvent("pointerdown", { bubbles: true, cancelable: true }), md = new MiniEvent("mousedown", { bubbles: true, cancelable: true });
    zh.pill().querySelector("button").dispatchEvent(pd); zh.pill().querySelector("button").dispatchEvent(md);
    expect([pd.defaultPrevented, md.defaultPrevented]).toEqual([true, true]);
    zh.pill().querySelector("button").click();
    expect([zh.insert.mock.calls, s.removeAllRanges.mock.calls.length, zh.pill()]).toEqual([[["部署前要不要先跑 rehearsal？"]], 1, null]);
    for (const f of offs.splice(0)) f(); dom?.restore(); dom = null; vi.useRealTimers();
    const en = await mounted({ lang: "en" });
    en.select("rehearsal");
    expect(en.pill()?.textContent).toBe("Quote");
  });
  it("gone when the selection is, on Escape, and while the pointer is still down (dragging a selection)", async () => {
    const p = await mounted();
    p.select("rehearsal"); expect(!!p.pill()).toBe(true);
    p.select(""); expect(p.pill()).toBe(null);
    p.select("rehearsal"); p.doc.dispatchEvent(Object.assign(new MiniEvent("keydown"), { key: "Escape" })); expect(p.pill()).toBe(null);
    p.list.dispatchEvent(new MiniEvent("pointerdown", { bubbles: true }));
    p.select("rehearsal"); expect(p.pill()).toBe(null);                 // still dragging: no pill yet
    p.doc.dispatchEvent(new MiniEvent("pointerup")); vi.advanceTimersByTime(200);
    expect(!!p.pill()).toBe(true);                                       // let go: the pill
  });
  it("#3555 review P2-1: a gesture the browser took over (a touch scroll: pointercancel, no pointerup) ends the press — the next selection has its pill", async () => {
    const p = await mounted();
    p.list.dispatchEvent(new MiniEvent("pointerdown", { bubbles: true }));
    p.doc.dispatchEvent(new MiniEvent("pointercancel"));
    p.select("rehearsal");
    expect(!!p.pill()).toBe(true);
  });
  it("no pill on a page that can't send", async () => {
    const p = await mounted({ canQuote: false });
    p.select("rehearsal");
    expect(p.pill()).toBe(null);
  });
  it("desktop: anchored to the passage's end with its pointer; phone: 「引用選取的文字」 above the composer, in the 16-px gutter, no pointer", async () => {
    const d = await mounted({ lang: "zh-TW" });
    d.select("rehearsal", { left: 100, right: 300, top: 200, bottom: 220, width: 200, height: 20 });
    const pd = d.pill();
    // M-2872: below the passage's end by default (its pointer up) — Edge draws its own selection menu above it.
    expect([pd.classList.contains("is-phone"), !!pd.querySelector(".quote-tip.up"), parseFloat(pd.style.top) >= 220]).toEqual([false, true, true]);
    for (const f of offs.splice(0)) f(); dom?.restore(); dom = null; vi.useRealTimers();
    const ph = await mounted({ lang: "zh-TW", phone: true });
    ph.select("rehearsal");
    const pp = ph.pill();
    expect([pp.textContent, pp.classList.contains("is-phone"), pp.querySelector(".quote-tip"), parseFloat(pp.style.top) < 700,
      parseFloat(pp.style.left) >= 16]).toEqual(["引用選取的文字", true, null, true, true]);
  });
  it("M-2872: desktop is below the passage's end — clear of the browser's own menu above a selection (Edge) — and flips above only when there is no room below", async () => {
    // Edge's selection mini menu (hide / … / copy / search) sits above the selection's end; a page can't turn it off.
    const edgeMenu = (r: any) => ({ left: r.right - 120, right: r.right + 40, top: r.top - 44, bottom: r.top - 8 });
    const hits = (a: any, z: any) => Math.min(a.right, z.right) > Math.max(a.left, z.left) && Math.min(a.bottom, z.bottom) > Math.max(a.top, z.top);
    const box = (p: any) => { const top = parseFloat(p.style.top), left = parseFloat(p.style.left); const r = p.getBoundingClientRect(); return { left, top, right: left + (r.width || 90), bottom: top + (r.height || 32) }; };
    const sel = { left: 100, right: 300, top: 200, bottom: 220, width: 200, height: 20 };
    const reset = () => { for (const f of offs.splice(0)) f(); dom?.restore(); dom = null; vi.useRealTimers(); };
    const d = await mounted();
    d.select("rehearsal", sel);
    expect([parseFloat(d.pill().style.top) >= sel.bottom, !!d.pill().querySelector(".quote-tip.up"), hits(box(d.pill()), edgeMenu(sel))]).toEqual([true, true, false]);
    reset();
    // Its last line at the thread's visible bottom: no room below, so above (pointer down).
    const low = { left: 100, right: 300, top: 650, bottom: 670, width: 200, height: 20 };
    const e = await mounted();
    e.select("rehearsal", low);
    expect([parseFloat(e.pill().style.top) < low.top, !!e.pill().querySelector(".quote-tip.down")]).toEqual([true, true]);
    reset();
    // No room either side (a thread barely taller than the line): it stays below rather than off the top.
    const g = await mounted({ thread: { top: 195, left: 0, right: 1024, bottom: 225, width: 1024, height: 30 } });
    g.select("rehearsal", sel);
    expect([parseFloat(g.pill().style.top) >= sel.bottom, !!g.pill().querySelector(".quote-tip.up")]).toEqual([true, true]);
  });
});

describe("where in the composer a quote goes", () => {
  it("the caret as the person left it (kept on input/keys/blur) — not the field's own, which Chrome resets when the page's selection moves into the thread", async () => {
    const q = await load(); const doc = dom!.document as any;
    const field: any = doc.createElement("textarea"); field.id = "msgIn"; doc.body.append(field);
    const list = doc.createElement("div"); doc.body.append(list);
    offs.push(q.installQuoteSelection(list, { insert() {}, field: () => field }));
    field.value = "first answer\nsecond line"; field.selectionStart = 12;            // after "first answer"
    field.dispatchEvent(new MiniEvent("keyup", { bubbles: true }));
    field.selectionStart = 0;                                                        // the reset
    expect(q.composerCaret(field, field.value)).toBe(12);
    // A caret for other text is no caret: the end.
    expect(q.composerCaret(field, "something else")).toBe("something else".length);
    expect(q.composerCaret(null, "abc")).toBe(3);
  });
});

describe("the composer shows the newest quote", () => {
  it("scrolls its own box to the caret (no focus); without a layout it goes to the end", async () => {
    const q = await load(); const doc = dom!.document as any;
    const field: any = doc.createElement("textarea");
    field.value = "> a\n".repeat(30); Object.assign(field, { clientHeight: 240, scrollHeight: 900, scrollTop: 0 });
    doc.body.append(field);
    q.showCaret(field, field.value.length);
    expect(field.scrollTop).toBe(900);
  });
});

// ── M-2813 (Fable's note on #3556): the chat panel's own wiring, mounted — the module's install, its field, its composer
//    box, its input path into the draft, and its removal with the thread. Each line of that wiring goes red here alone.
describe("the chat panel's 「引用」 wiring (panel-chat.js, mounted)", () => {
  it("a passage in a mounted chat: the pill; its click goes through the composer's own input path; a phone's pill sits above the composer box; gone with the thread", async () => {
    const { page, h, settle } = await import("./helpers/app-harness.js");
    const p = page({ storage: { agend_tour_done: "1" } });
    const g = globalThis as any;
    try {
      const chat = await import("/ui/js/panel-chat.js") as any;
      const { createStream } = await import("/assets/app-stream.js") as any;
      const { applyStatus } = await import("/assets/app-store.js") as any;
      const real = createStream({ mode: "view" });
      const on: Record<string, Array<(d: any) => void>> = {};
      const stream = { ...real, on(n: string, f: any) { (on[n] ||= []).push(f); return real.on(n, f); } };
      const fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
      const store = chat.boot({ stream, deps: { fetch, toast() {} } });
      applyStatus({ instances: [{ name: "wq", status: "running", state: "idle", execution_state: "idle" }], uptime: 1 });
      await p.mount(h(chat.ChatPanel, { route: { instance: "wq" }, navKey: "wq" }));
      await settle();
      for (const f of on.message ?? []) f({ instance: "wq", boot: "ab12", id: 1, role: "agent", sender: "wq", text: "first part. second part", ts: "2026-11-10T10:00:00Z" });
      await settle(); await settle();
      const doc = p.document as any;
      let words: any = doc.querySelector('.msg[data-key] .md'); while (words && words.nodeType !== 3) words = words.firstChild;
      expect(!!words, "the message's words are drawn").toBe(true);
      let sel: any = { isCollapsed: true, rangeCount: 0, toString: () => "" };
      doc.getSelection = () => sel;
      const choose = async (text: string) => {
        sel = { isCollapsed: false, rangeCount: 1, toString: () => text, removeAllRanges() { sel = { isCollapsed: true, rangeCount: 0, toString: () => "" }; },
          getRangeAt: () => ({ startContainer: words, endContainer: words, getClientRects: () => [{ left: 100, right: 200, top: 300, bottom: 320, width: 100, height: 20 }] }) };
        doc.dispatchEvent(new MiniEvent("selectionchange"));
        await new Promise((r) => setTimeout(r, 200));
      };
      // A phone: the pill docks above the composer's whole box (its own rect here), in the gutter.
      const mm = g.matchMedia; g.matchMedia = (q: string) => ({ matches: /pointer:\s*coarse/.test(q), addEventListener() {}, removeEventListener() {} });
      doc.querySelector(".composer-box").getBoundingClientRect = () => ({ top: 700, left: 8, right: 382, bottom: 840, width: 374, height: 140 });
      await choose("second part");
      const pill = doc.querySelector(".quote-pop");
      expect([!!pill, pill?.classList.contains("is-phone"), parseFloat(pill?.style.top)]).toEqual([true, true, 700 - 0 - 12]);
      pill.querySelector("button").click();
      await settle();
      const field = doc.getElementById("msgIn");
      // Through the composer's input path: the field and the store's draft both hold the quote.
      expect([field.value, store.state.drafts.wq]).toEqual(["> second part\n", "> second part\n"]);
      g.matchMedia = mm;
      // Gone with the thread: no listener left behind — even with a composer on the page again (another chat's), the
      // old thread's selection would otherwise still draw its pill.
      await p.unmount(); await settle();
      const again = doc.createElement("textarea"); again.id = "msgIn"; doc.body.append(again);
      await choose("first part");
      expect(doc.querySelector(".quote-pop")).toBe(null);
    } finally { p.restore(); }
  });
});
