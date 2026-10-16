/**
 * Board 00ef2430: switching chats paints at once. A thread opens with only its newest THREAD_TAIL messages drawn; the
 * older ones follow a chunk at a time after the frame has painted, the reader's place kept. Pinned here:
 * - the first draw is the tail; the rest arrives in order, oldest first at the top, until every message is drawn;
 * - a remembered scroll position (not the bottom) draws everything at once, as before;
 * - a reader scrolled up keeps their place while older messages arrive above, and they never count as "new below";
 * - live messages, a reorder and the cap's trimming never drop what is drawn;
 * - showing a message that isn't drawn yet draws the rest first; a disposed thread draws nothing more;
 * - filling in never re-renders a message already drawn (Markdown is not run again).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
// @ts-expect-error — a JS module of the app, with no types (as web-preview-card-1306 imports it)
import { createThread, THREAD_CHUNK, THREAD_TAIL } from "../src/ui/chat-thread.js";

beforeAll(async () => {
  // @ts-expect-error — a JS module of the app, with no types: sets the page's AgendChatRender global
  await import("../src/ui/chat-render.js");
});
let pg: AppPage | null = null;
afterEach(() => { if (pg) { pg.restore(); pg = null; } });

const msg = (id: number, boot = "b") => ({ boot, id, instance: "w", sender: "w", role: "agent", text: `message **${id}**`, ts: new Date(1_800_000_000_000 + id * 60_000).toISOString() });
const many = (n: number, from = 1) => Array.from({ length: n }, (_, i) => msg(from + i));
const ids = (list: any) => [...list.children].map((n: any) => Number(/message (\d+)/.exec(n.textContent)?.[1]));
/** Run the queued frames and timers until the thread has nothing left to draw (or `max` rounds). */
async function flush(max = 50) { for (let i = 0; i < max; i++) await new Promise(r => setTimeout(r, 20)); }

function threadAt() {
  pg = page({ storage: { agend_tour_done: "1" } });
  const doc = pg.document as any;
  const scroller = doc.createElement("div"), list = doc.createElement("div");
  scroller.append(list); doc.body.append(scroller);
  // Geometry: 100 px a message, a 500 px view; the scroll position is clamped like a browser's.
  let top = 0;
  Object.defineProperty(scroller, "scrollHeight", { get: () => list.children.length * 100 });
  Object.defineProperty(scroller, "clientHeight", { get: () => 500 });
  Object.defineProperty(scroller, "scrollTop", { get: () => top, set: (v: number) => { top = Math.max(0, Math.min(v, list.children.length * 100 - 500)); } });
  const thread = createThread(list, scroller, {
    t: (k: string) => k, tf: (k: string) => k, isUser: (x: any) => x.role === "user", onJump() {}, onEmpty() {},
    setPreviewOptIn() {}, copyText: async () => true, download() {}, toggleWrap() {},
  });
  return { list, scroller, thread };
}

describe("a thread opens with its newest messages, the rest drawn after", () => {
  it("the first draw is the tail; the older ones arrive, in order, until all are drawn", async () => {
    const { list, thread } = threadAt();
    const all = many(200);
    thread.render(all, { restore: null });
    expect(ids(list)).toEqual(all.slice(-THREAD_TAIL).map(m => m.id));
    await flush();
    expect(ids(list)).toEqual(all.map(m => m.id));
    expect(THREAD_CHUNK).toBeGreaterThan(0);
  });
  it("a remembered position that isn't the bottom draws everything at once (and goes back to it)", () => {
    const { list, scroller, thread } = threadAt();
    thread.render(many(200), { restore: 3000 });
    expect([list.children.length, scroller.scrollTop]).toEqual([200, 3000]);
  });
  it("pinned to the bottom, it stays at the bottom while older messages arrive above", async () => {
    const { scroller, thread } = threadAt();
    thread.render(many(200), { restore: null });
    await flush();
    expect(scroller.scrollTop).toBe(200 * 100 - 500);
  });
  it("a reader scrolled up keeps their place as older messages arrive above; none counts as new below", async () => {
    const { list, scroller, thread } = threadAt();
    thread.render(many(200), { restore: null });
    scroller.scrollTop = 1000; thread.onScroll();                      // scrolled up, inside the tail
    const msgAtTop = () => ids(list)[Math.floor(scroller.scrollTop / 100)];
    const before = msgAtTop();
    await flush();
    expect([list.children.length, msgAtTop(), thread.unseen]).toEqual([200, before, 0]);
  });
  it("a live message while older ones are still to come: drawn below, and the window does not shrink", async () => {
    const { list, thread } = threadAt();
    const all = many(200);
    thread.render(all, { restore: null });
    const withNew = [...all, msg(201)];
    thread.render(withNew);
    expect(ids(list)).toEqual(withNew.slice(-THREAD_TAIL - 1).map(m => m.id));
    await flush();
    expect(ids(list)).toEqual(withNew.map(m => m.id));
  });
  it("the cap trims the oldest once all are drawn: the rest stays drawn (no collapse back to the tail)", async () => {
    const { list, thread } = threadAt();
    const all = many(200);
    thread.render(all, { restore: null });
    await flush();
    const trimmed = [...all.slice(1), msg(201)];
    thread.render(trimmed);
    expect(ids(list)).toEqual(trimmed.map(m => m.id));
  });
  it("showing a message not drawn yet draws the rest first, then shows it", () => {
    const { list, thread } = threadAt();
    thread.render(many(200), { restore: null });
    expect(thread.reveal("b-5")).toBe(true);
    expect(list.children.length).toBe(200);
    expect(thread.reveal("b-999"), "not a message of this thread").toBe(false);
  });
  it("a disposed thread draws nothing more", async () => {
    const { list, thread } = threadAt();
    thread.render(many(200), { restore: null });
    thread.dispose();
    await flush();
    expect(list.children.length).toBe(THREAD_TAIL);
  });
  it("filling in never draws a message again: Markdown runs once per message", async () => {
    const R = (globalThis as any).AgendChatRender;
    const real = R.renderMarkdown;
    let n = 0;
    R.renderMarkdown = function (...a: unknown[]) { n++; return real.apply(this, a); };
    try {
      const { thread } = threadAt();
      thread.render(many(200), { restore: null });
      await flush();
      expect(n).toBe(200);
    } finally { R.renderMarkdown = real; }
  });
});
