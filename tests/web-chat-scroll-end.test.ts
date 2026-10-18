/**
 * #2087 (user report, 2026-10-18): wheeling DOWN to the bottom of a web chat, the view "re-aligned with the latest" once more
 * instead of stopping where the reader stopped. Two causes, both seen frame by frame on the realistic fixture
 * (scripts/manual/smoke/smoke-scroll-end.mts, 1366 and 390):
 * - the "Latest" pill was a sticky box in the scroller's flow: 38 px at the end of the scroll, gone once the reader is
 *   48 px from the bottom — the scroll got 38 px shorter under a reader still scrolling (the last step cut short, or
 *   the view clamped back);
 * - within those 48 px the view counted as pinned, so the next resize (the dock growing, a picture, a card) pulled it
 *   the rest of the way down: a scrollTop the page wrote after the reader's last wheel.
 * Pinned here: the reader's own scroll is never followed by a write the page makes; a pinned view (the reader at the
 * exact bottom) still follows growth (#1269/#1584) and a new message near the bottom still follows (#1307); the pill
 * takes no room.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";
// @ts-expect-error — a JS module of the app, with no types (as web-chat-switch-window imports it)
import { createThread, READER_QUIET_MS } from "../src/ui/chat-thread.js";

beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types: sets the page's AgendChatRender global
  await import("../src/ui/chat-render.js");
});
let pg: AppPage | null = null;
let savedRO: unknown;
afterEach(() => { vi.restoreAllMocks(); if (pg) { pg.restore(); pg = null; } (globalThis as any).ResizeObserver = savedRO; });

const msg = (id: number) => ({ boot: "b", id, instance: "w", sender: "w", role: "agent", text: `message ${id}`, ts: new Date(1_800_000_000_000 + id * 60_000).toISOString() });
const many = (n: number, from = 1) => Array.from({ length: n }, (_, i) => msg(from + i));

/**
 * A thread in a scroller laid out like a browser's: 100 px a message, a view `view` px tall (the dock takes the rest),
 * scrollTop clamped. A wheel is what a browser makes of one: the position moves, then a scroll event. Every scrollTop
 * the PAGE writes is recorded, with whether the reader had wheeled since.
 */
function threadAt() {
  const observers: Array<() => void> = [];
  savedRO = (globalThis as any).ResizeObserver;
  (globalThis as any).ResizeObserver = class { constructor(cb: () => void) { observers.push(cb); } observe() {} disconnect() {} };
  if (pg) { pg.restore(); pg = null; }                        // a case may make a second thread: one page at a time
  vi.restoreAllMocks();
  pg = page({ storage: { agend_tour_done: "1" } });
  let now = 1_000;                                            // the page's clock (performance.now), moved by later(ms)
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const doc = pg.document as any;
  const scroller = doc.createElement("div"), list = doc.createElement("div");
  scroller.append(list); doc.body.append(scroller);
  let top = 0, view = 500, wheeling = false, extra = 0;
  const height = () => list.children.length * 100 + extra;
  const max = () => Math.max(0, height() - view);
  const writes: number[] = [];
  Object.defineProperty(scroller, "scrollHeight", { get: () => height() });
  Object.defineProperty(scroller, "clientHeight", { get: () => view });
  Object.defineProperty(scroller, "scrollTop", { get: () => top, set: (v: number) => { if (!wheeling) writes.push(v); top = Math.max(0, Math.min(v, max())); } });
  const thread = createThread(list, scroller, {
    t: (k: string) => k, tf: (k: string) => k, isUser: () => false, onJump() {}, onEmpty() {},
    setPreviewOptIn() {}, copyText: async () => true, download() {}, toggleWrap() {},
  });
  // A wheel is the reader's: its event on the scroller, the position moves, then a scroll event.
  const wheel = (dy: number) => { fire(scroller, "wheel"); wheeling = true; scroller.scrollTop = top + dy; wheeling = false; thread.onScroll(); };
  /** A scroll event the browser sends on its own (a clamp at the new end): no input. */
  const scrolled = () => thread.onScroll();
  const later = (ms: number) => { now += ms; };
  const resize = (dockGrowth: number) => { view -= dockGrowth; top = Math.min(top, max()); for (const cb of observers) cb(); };
  const fromBottom = () => height() - top - view;
  /**
   * #2158, as WebKit ordered it on a cold load: the thread gets `shrink` px shorter (its text settling) and the position
   * is clamped to the view as it was; the dock takes `dock` px; then the clamp's scroll event, with `wheelUp` px of the
   * reader's own in the same frame (0: none); and only then the ResizeObserver. `dockFirst`: the dock grows before the
   * thread shrinks, so the clamp is to the shorter view (review r1's order).
   */
  const settle = (shrink: number, dock: number, wheelUp = 0, dockFirst = false, subpixel = 0) => {
    if (dockFirst) view -= dock;
    if (wheelUp) fire(scroller, "wheel");                     // the reader's move: a wheel, as a browser makes one
    extra -= shrink; top = Math.max(0, Math.min(top, max()) - wheelUp - subpixel);
    if (!dockFirst) view -= dock;
    thread.onScroll();
    for (const cb of observers) cb();
  };
  return { thread, scroller, doc, writes, wheel, scrolled, later, resize, settle, fromBottom };
}

describe("wheeling down to the bottom: nothing moves the view after the reader's last wheel", () => {
  it("a reader who stops just short of the bottom stays there when the dock grows under the thread", () => {
    const t = threadAt();
    t.thread.render(many(60), { restore: null });            // opens at the bottom, pinned
    t.wheel(-1000);                                           // scrolls up to read
    for (const dy of [300, 300, 300, 95]) t.wheel(dy);        // and wheels back down, stopping 5 px short
    expect(t.fromBottom()).toBe(5);
    const after = t.writes.length;
    t.resize(40);                                             // the working line appears
    expect(t.writes.slice(after), "no scrollTop written after the reader's last wheel").toEqual([]);
    expect(t.fromBottom()).toBe(45);
  });
  it("…and when a picture or card in the thread grows (the list resizes)", () => {
    const t = threadAt();
    t.thread.render(many(60), { restore: null });
    t.wheel(-800);
    for (const dy of [200, 200, 200, 180]) t.wheel(dy);       // 20 px short
    const after = t.writes.length;
    t.resize(0);
    expect(t.writes.slice(after)).toEqual([]);
    expect(t.fromBottom()).toBe(20);
  });
  it("a reader who wheels all the way to the bottom is pinned: growth keeps the newest in view (#1269/#1584)", () => {
    const t = threadAt();
    t.thread.render(many(60), { restore: null });
    t.wheel(-1000);
    for (const dy of [400, 400, 400]) t.wheel(dy);            // presses past the bottom: clamped there
    expect(t.fromBottom()).toBe(0);
    t.resize(40);
    expect(t.fromBottom(), "still flush with the bottom").toBe(0);
  });
  it("near the bottom (48 px) a NEW message still pulls the view down to it (#1307)", () => {
    const t = threadAt();
    t.thread.render(many(60), { restore: null });
    t.wheel(-1000);
    for (const dy of [500, 470]) t.wheel(dy);                 // 30 px short
    t.thread.render(many(61));
    expect(t.fromBottom()).toBe(0);
  });
});

describe("#2158: a pinned thread that gets shorter stays at the bottom (WebKit's clamp comes before the resize)", () => {
  it("a cold load at the bottom: 168 px of text lost, 36 px of dock — still flush with the bottom, and older messages filling in keep it there", () => {
    const t = threadAt();
    t.thread.render(many(60), { restore: null });            // opens at the bottom, pinned
    t.settle(168, 36);
    expect(t.fromBottom(), "back at the bottom").toBe(0);
    t.resize(0);                                              // a later growth (older messages, a picture)
    t.thread.render(many(61));
    expect(t.fromBottom(), "still pinned").toBe(0);
  });
  it("the reader's own move up in that frame — any more than the thread lost — still leaves the bottom", () => {
    const t = threadAt();
    t.thread.render(many(60), { restore: null });
    const after = t.writes.length;
    t.settle(40, 0, 5);                                       // clamped 40 px, and 5 px of the reader's
    expect(t.fromBottom()).toBe(5);
    t.resize(20);
    expect(t.writes.slice(after), "nothing written after the reader's move").toEqual([]);
    expect(t.fromBottom()).toBe(25);
  });
  it("a high-DPI screen reports the clamped scrollTop half a pixel off: still the browser's, still re-pinned", () => {
    const t = threadAt();
    t.thread.render(many(60), { restore: null });
    t.settle(168, 36, 0, false, 0.5);
    expect(t.fromBottom()).toBe(0);
  });
  it("the view's height is re-read on every scroll: a taller view (the dock gave room back), then the cold-load clamp — re-pinned against the taller view", () => {
    const t = threadAt();
    t.thread.render(many(60), { restore: null });
    t.resize(-100);                                           // the dock shrinks: the browser clamps to the new end…
    t.scrolled();                                             // …and sends its scroll event (at the bottom)
    t.settle(168, 36);
    expect(t.fromBottom()).toBe(0);
  });
  it("review r1: the dock grows first, then the thread shrinks (clamped to the shorter view), and the reader moves 5 px up in that frame — theirs", () => {
    const t = threadAt();
    t.thread.render(many(60), { restore: null });
    const after = t.writes.length;
    t.settle(168, 36, 5, true);                               // 6000/500/5500 → view 464, 5832 tall, clamped 5368, the reader 5363
    expect(t.fromBottom(), "5 px up, as the reader left it").toBe(5);
    t.resize(20);                                             // later growth (the dock again): unpinned, not followed
    expect(t.writes.slice(after), "no scrollTop written after the reader's move").toEqual([]);
    expect(t.fromBottom()).toBe(25);
  });
  it("review r2: the dock first, then the thread shrinks, and the reader moves up by exactly the dock's 36 px — the same geometry as the cold-load clamp, but their wheel makes it theirs", () => {
    const t = threadAt();
    t.thread.render(many(60), { restore: null });
    const after = t.writes.length;
    t.settle(168, 36, 36, true);                              // 5332 on a 5832 thread: where the clamp-first case rests too
    expect(t.fromBottom()).toBe(36);
    t.resize(20);
    expect(t.writes.slice(after), "no scrollTop written").toEqual([]);
    expect(t.fromBottom(), "not followed").toBe(56);
  });
  it("the same rest with no input is the browser's (the cold-load positive), and so it is once the reader's scroll has been quiet for READER_QUIET_MS", () => {
    const t = threadAt();
    t.thread.render(many(60), { restore: null });
    t.wheel(-300); t.wheel(300);                              // read up, then back to the bottom (pinned again)
    t.later(READER_QUIET_MS - 1);
    t.settle(168, 36);
    expect(t.fromBottom(), "within the quiet time: still the reader's").toBe(36);
    const u = threadAt();
    u.thread.render(many(60), { restore: null });
    u.wheel(-300); u.wheel(300);
    u.later(READER_QUIET_MS);
    u.settle(168, 36);
    expect(u.fromBottom(), "quiet since: the browser's").toBe(0);
  });
  it("a finger on the thread (touch held, then momentum: scroll events keep it going) and a held scrollbar are the reader's", () => {
    const t = threadAt();
    t.thread.render(many(60), { restore: null });
    fire(t.scroller, "touchstart");
    t.later(5_000);                                           // held, however long
    t.settle(168, 36);
    expect(t.fromBottom(), "the finger is down").toBe(36);
    const u = threadAt();
    u.thread.render(many(60), { restore: null });
    fire(u.scroller, "touchstart"); fire(u.scroller, "touchend");
    for (let i = 0; i < 4; i++) { u.later(READER_QUIET_MS - 10); u.scrolled(); }   // momentum: a scroll every 240 ms
    u.later(READER_QUIET_MS - 10);
    u.settle(168, 36);
    expect(u.fromBottom(), "momentum after the finger left: still theirs").toBe(36);
    const v = threadAt();
    v.thread.render(many(60), { restore: null });
    fire(v.scroller, "pointerdown");                          // the scrollbar, held
    v.later(5_000);
    v.settle(168, 36);
    expect(v.fromBottom()).toBe(36);
    fire(v.doc.body, "pointerup");                            // let go anywhere on the page
    const w = threadAt();
    w.thread.render(many(60), { restore: null });
    fire(w.scroller, "pointerdown"); fire(w.doc.body, "pointerup");
    w.later(READER_QUIET_MS);
    w.settle(168, 36);
    expect(w.fromBottom(), "let go, and quiet since").toBe(0);
  });
  it("a scrolling key is the reader's; a space typed in a text field is not", () => {
    const t = threadAt();
    t.thread.render(many(60), { restore: null });
    fire(t.doc.body, "keydown", { key: "PageUp" });
    t.settle(168, 36);
    expect(t.fromBottom()).toBe(36);
    const u = threadAt();
    u.thread.render(many(60), { restore: null });
    const box = u.doc.createElement("textarea"); u.doc.body.append(box);
    fire(box, "keydown", { key: " " });
    u.settle(168, 36);
    expect(u.fromBottom()).toBe(0);
    const v = threadAt();
    v.thread.render(many(60), { restore: null });
    fire(v.doc.body, "keydown", { key: "a" });                 // a key that scrolls nothing
    v.settle(168, 36);
    expect(v.fromBottom()).toBe(0);
  });
  it("it listens only while it is shown: none left when parked or disposed, back when attached again", () => {
    const t = threadAt();
    const count = (el: any) => [...el._listeners.values()].reduce((n: number, l: unknown[]) => n + l.length, 0);
    const doc0 = count(t.doc) - 3, sc0 = count(t.scroller) - 5;   // the thread's own: 3 on the document, 5 on the scroller
    t.thread.park();
    expect([count(t.doc), count(t.scroller)], "parked").toEqual([doc0, sc0]);
    const sc2 = t.doc.createElement("div"); t.doc.body.append(sc2);
    t.thread.attach(sc2);
    expect([count(t.doc), count(sc2), count(t.scroller)], "attached to another view").toEqual([doc0 + 3, 5, sc0]);
    t.thread.dispose();
    expect([count(t.doc), count(sc2)], "disposed").toEqual([doc0, 0]);
    const u = threadAt();                                     // attached straight from the scroller it was made with
    const scU = count(u.scroller), sc3 = u.doc.createElement("div"); u.doc.body.append(sc3);
    u.thread.attach(sc3);
    expect([count(u.scroller), count(sc3)], "moved, not copied").toEqual([scU - 5, 5]);
  });
  it("a touch still down when the chat left is not held over when it is shown again", () => {
    const t = threadAt();
    t.thread.render(many(60), { restore: null });
    fire(t.scroller, "touchstart");
    t.thread.park();                                          // left mid-touch (its touchend went elsewhere)
    t.thread.attach(t.scroller);
    t.thread.render(many(60), { restore: null });
    t.later(READER_QUIET_MS);
    t.settle(168, 36);
    expect(t.fromBottom()).toBe(0);
  });
  it("…and the dock first with no reader: the clamp lands at the bottom — pinned, nothing written", () => {
    const t = threadAt();
    t.thread.render(many(60), { restore: null });
    const after = t.writes.length;
    t.settle(168, 36, 0, true);
    expect(t.fromBottom()).toBe(0);
    expect(t.writes.slice(after)).toEqual([]);
    t.resize(30);
    expect(t.fromBottom(), "still pinned: follows").toBe(0);
  });
  it("a reader who scrolled up — even just above the bottom, where the clamp moves them too — is not pulled down", () => {
    const t = threadAt();
    t.thread.render(many(60), { restore: null });
    t.wheel(-1000);
    t.wheel(900);                                             // 100 px short: not pinned
    t.later(READER_QUIET_MS);                                 // and quiet since: only `pinned` keeps it theirs now
    const after = t.writes.length;
    t.settle(168, 36);                                        // clamped 68 px up with the thread
    expect(t.writes.slice(after)).toEqual([]);
    expect(t.fromBottom()).toBe(36);
  });
  it("a clamp that leaves the view at the bottom writes nothing; and the reader's later move up is theirs", () => {
    const t = threadAt();
    t.thread.render(many(60), { restore: null });
    const after = t.writes.length;
    t.settle(168, 0);                                         // clamped to the new bottom, the view unchanged
    expect(t.fromBottom()).toBe(0);
    t.wheel(-100);                                            // the height lost before is not the reader's
    t.resize(0);
    expect(t.writes.slice(after)).toEqual([]);
    expect(t.fromBottom()).toBe(100);
  });
  it("a pinned reader's own small move up (a trackpad), with nothing lost, is theirs", () => {
    const t = threadAt();
    t.thread.render(many(60), { restore: null });
    const after = t.writes.length;
    t.wheel(-2);
    t.resize(0);
    expect(t.writes.slice(after)).toEqual([]);
    expect(t.fromBottom()).toBe(2);
  });
});

describe("the Latest pill takes no room in the thread", () => {
  const CSS = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8");
  const rule = (selector: string): Record<string, string> => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
    expect(m, `a rule for ${selector}`).not.toBeNull();
    return Object.fromEntries(m![1]!.split(";").map(d => d.split(":").map(x => x.trim())).filter(([k, v]) => k && v).map(([k, v]) => [k!, v!]));
  };
  it("its dock is sticky at the bottom and 0 px tall; the pill floats above it, out of the flow", () => {
    const dock = rule(".jump-dock");
    expect([dock.position, dock.bottom, dock.height]).toEqual(["sticky", "0", "0"]);
    expect(rule(".jump-latest").position).toBe("absolute");
  });
  it("the thread puts the pill in that dock, which stays when the pill goes", () => {
    const src = readFileSync(join(process.cwd(), "src", "ui", "panel-chat.js"), "utf8");
    expect(src).toMatch(/<div class="jump-dock">\$\{jump\.show \? html`<button data-trust="thread-control" type="button" class="jump-latest"/);
  });
});
