/**
 * Board 00ef2430: switching chats paints at once. A thread opens with only its newest THREAD_TAIL messages drawn; the
 * older ones follow a chunk at a time after the frame has painted, the reader's place kept. Pinned here:
 * - the first draw is the tail; the rest arrives in order, oldest first at the top, until every message is drawn;
 * - a remembered scroll position (not the bottom) draws everything at once, as before;
 * - a reader scrolled up keeps their place while older messages arrive above, and they never count as "new below";
 * - live messages, a reorder and the cap's trimming never drop what is drawn;
 * - showing a message that isn't drawn yet draws the rest first; a disposed thread draws nothing more;
 * - filling in never re-renders a message already drawn (Markdown is not run again);
 * - #1908 review (Board 38f25eca): a frame draws exactly one chunk more (never everything in the first fill-in), and
 *   asking for the next chunk twice before a frame still queues one frame and draws one chunk; #2222 review (Board
 *   4bbbb4a6): so does asking again after the frame ran and before its timer did.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";
// @ts-expect-error — a JS module of the app, with no types (as web-preview-card-1306 imports it)
import { clearRenderedMarkdown, createThread, renderedMarkdown, MD_CACHE_MAX, THREAD_CHUNK, THREAD_TAIL } from "../src/ui/chat-thread.js";

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
    clearRenderedMarkdown();
    const R = (globalThis as any).AgendChatRender;
    const real = R.renderMarkdown;
    let n = 0;
    R.renderMarkdown = function (...a: unknown[]) { n++; return real.apply(this, a); };
    try {
      const { thread } = threadAt();
      thread.render(many(200), { restore: null });
      await flush();
      expect(n).toBe(200);
      // #2053: another render of the same messages (a status frame, the emoji list arriving), or another thread of
      // them (the chat shown again), renders no Markdown again.
      thread.render(many(200).map((x: any) => ({ ...x })));
      await flush();
      threadAt().thread.render(many(200), { restore: null });
      await flush();
      expect(n, "nothing rendered twice").toBe(200);
    } finally { R.renderMarkdown = real; }
  });
});

describe("#2053: rendered Markdown is kept, and always what renderMarkdown would give now", () => {
  const R = () => (globalThis as any).AgendChatRender;
  const ID = "123456789012345678", UID = "223456789012345678";
  it("the same text renders once; cards (an agent's) and not are kept apart", () => {
    clearRenderedMarkdown();
    let n = 0; const real = R().renderMarkdown; R().renderMarkdown = function (...a: unknown[]) { n++; return real.apply(this, a); };
    try {
      const fence = "```html\n<p>x</p>\n```";
      const a1 = renderedMarkdown(fence, true), a2 = renderedMarkdown(fence, true), u = renderedMarkdown(fence, false);
      expect([n, a1 === a2, a1 === real(fence, { htmlCards: true }), u === real(fence, { htmlCards: false }), a1 === u]).toEqual([2, true, true, true, false]);
    } finally { R().renderMarkdown = real; }
  });
  it("an emoji the page comes to know, or a mention's name that arrives, renders again — exactly as renderMarkdown would", () => {
    clearRenderedMarkdown();
    const text = `hi <:blob:${ID}> <@${UID}>`;
    let known = false, name: string | null = null;
    const emojis = (id: string) => known && id === ID, mentions = (_k: string, id: string) => (id === UID ? name : null);
    const fresh = () => R().renderMarkdown(text, { htmlCards: false, emojis, mentions });
    expect(renderedMarkdown(text, false, emojis, mentions)).toBe(fresh());
    known = true;
    expect(renderedMarkdown(text, false, emojis, mentions), "the emoji is known now").toBe(fresh());
    name = "Ann";
    expect(renderedMarkdown(text, false, emojis, mentions), "the name arrived").toBe(fresh());
    name = "Bob";
    expect(renderedMarkdown(text, false, emojis, mentions), "and changed").toBe(fresh());
  });
  it("review P3: a NUL inside the tag (renderMarkdown drops NUL first, so it is still an emoji / mention there) counts the same", () => {
    clearRenderedMarkdown();
    const text = `hi <:blob:\u0000${ID}> <@\u0000${UID}>`;
    let known = false, name: string | null = null;
    const emojis = (id: string) => known && id === ID, mentions = (_k: string, id: string) => (id === UID ? name : null);
    const fresh = () => R().renderMarkdown(text, { htmlCards: false, emojis, mentions });
    expect(renderedMarkdown(text, false, emojis, mentions)).toBe(fresh());
    known = true; name = "Ann";
    expect(fresh(), "the renderer does read them").toContain("Ann");
    expect(renderedMarkdown(text, false, emojis, mentions), "known, named").toBe(fresh());
    name = "Bob";
    expect(renderedMarkdown(text, false, emojis, mentions), "renamed").toBe(fresh());
  });
  it("bounded: past MD_CACHE_MAX the least recently used goes", () => {
    clearRenderedMarkdown();
    let n = 0; const real = R().renderMarkdown; R().renderMarkdown = function (...a: unknown[]) { n++; return real.apply(this, a); };
    try {
      renderedMarkdown("first", false);
      for (let i = 0; i < MD_CACHE_MAX; i++) renderedMarkdown(`m${i}`, false);
      const before = n;
      renderedMarkdown("first", false);
      expect(n, "it had gone").toBe(before + 1);
      renderedMarkdown(`m${MD_CACHE_MAX - 1}`, false);
      expect(n, "a recent one is kept").toBe(before + 1);
      // Least recently USED: one read again stays, though it went in first.
      clearRenderedMarkdown();
      renderedMarkdown("early", false);
      for (let i = 0; i < MD_CACHE_MAX - 1; i++) { renderedMarkdown(`k${i}`, false); if (i === MD_CACHE_MAX / 2) renderedMarkdown("early", false); }
      renderedMarkdown("one more", false);                                    // past the cap: the least recently used goes
      const at = n;
      renderedMarkdown("early", false);
      expect(n, "read again, so kept").toBe(at);
      renderedMarkdown("k0", false);
      expect(n, "k0, least recently used, went").toBe(at + 1);
    } finally { R().renderMarkdown = real; }
  });
});

describe("#1908 review: one chunk per frame", () => {
  /** requestAnimationFrame held in a queue, so a test runs exactly one frame (and the timer it sets) at a time. Installed
   *  after the page is made (the page sets its own). */
  function frames() {
    const queued: Array<() => void> = [];
    const g = globalThis as any, saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame };
    g.requestAnimationFrame = (cb: () => void) => { queued.push(cb); return queued.length; };
    g.cancelAnimationFrame = (id: number) => { queued[id - 1] = () => {}; };
    return {
      queued: () => queued.length,
      /** Run the queued frames only (each sets the timer that draws). */
      frame() { const run = queued.splice(0); for (const cb of run) cb(); },
      /** Let the timers the frames set run. */
      async timers() { await new Promise(r => setTimeout(r, 0)); },
      async step() { this.frame(); await this.timers(); },
      restore() { g.requestAnimationFrame = saved.raf; g.cancelAnimationFrame = saved.caf; },
    };
  }
  it("a frame draws the tail plus exactly one chunk — not everything at the first fill-in", async () => {
    const { list, thread } = threadAt();
    const f = frames();                                                    // after the page: it brings its own
    try {
      const all = many(200);
      thread.render(all, { restore: null });
      expect([list.children.length, f.queued()]).toEqual([THREAD_TAIL, 1]);
      await f.step();
      expect(ids(list)).toEqual(all.slice(-(THREAD_TAIL + THREAD_CHUNK)).map(m => m.id));
      await f.step();
      expect(list.children.length).toBe(THREAD_TAIL + 2 * THREAD_CHUNK);
    } finally { f.restore(); }
  });
  it("asked twice before a frame (a second render): one frame queued, one chunk drawn", async () => {
    const { list, thread } = threadAt();
    const f = frames();                                                    // after the page: it brings its own
    try {
      const all = many(200);
      thread.render(all, { restore: null });
      thread.render([...all, msg(201)], {});                              // a live message before the frame ran
      expect(f.queued()).toBe(1);
      await f.step();
      expect(list.children.length).toBe(THREAD_TAIL + 1 + THREAD_CHUNK);
    } finally { f.restore(); }
  });
  it("asked again after the frame ran, before its timer drew: still one chunk, and one frame queued after it", async () => {
    const { list, thread } = threadAt();
    const f = frames();
    try {
      const all = many(200);
      thread.render(all, { restore: null });
      f.frame();                                                           // the frame ran; its timer has not
      thread.render([...all, msg(201)], {});                              // a live message in between
      expect(f.queued()).toBe(0);                                         // the timer already owns the next chunk
      await f.timers();
      expect([list.children.length, f.queued()]).toEqual([THREAD_TAIL + 1 + THREAD_CHUNK, 1]);
      await f.step();
      expect(list.children.length).toBe(THREAD_TAIL + 1 + 2 * THREAD_CHUNK);
    } finally { f.restore(); }
  });
});
