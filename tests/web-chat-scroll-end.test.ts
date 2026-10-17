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
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
// @ts-expect-error — a JS module of the app, with no types (as web-chat-switch-window imports it)
import { createThread } from "../src/ui/chat-thread.js";

beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types: sets the page's AgendChatRender global
  await import("../src/ui/chat-render.js");
});
let pg: AppPage | null = null;
let savedRO: unknown;
afterEach(() => { if (pg) { pg.restore(); pg = null; } (globalThis as any).ResizeObserver = savedRO; });

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
  pg = page({ storage: { agend_tour_done: "1" } });
  const doc = pg.document as any;
  const scroller = doc.createElement("div"), list = doc.createElement("div");
  scroller.append(list); doc.body.append(scroller);
  let top = 0, view = 500, wheeling = false;
  const max = () => Math.max(0, list.children.length * 100 - view);
  const writes: number[] = [];
  Object.defineProperty(scroller, "scrollHeight", { get: () => list.children.length * 100 });
  Object.defineProperty(scroller, "clientHeight", { get: () => view });
  Object.defineProperty(scroller, "scrollTop", { get: () => top, set: (v: number) => { if (!wheeling) writes.push(v); top = Math.max(0, Math.min(v, max())); } });
  const thread = createThread(list, scroller, {
    t: (k: string) => k, tf: (k: string) => k, isUser: () => false, onJump() {}, onEmpty() {},
    setPreviewOptIn() {}, copyText: async () => true, download() {}, toggleWrap() {},
  });
  const wheel = (dy: number) => { wheeling = true; scroller.scrollTop = top + dy; wheeling = false; thread.onScroll(); };
  const resize = (dockGrowth: number) => { view -= dockGrowth; top = Math.min(top, max()); for (const cb of observers) cb(); };
  const fromBottom = () => list.children.length * 100 - top - view;
  return { thread, scroller, writes, wheel, resize, fromBottom };
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
