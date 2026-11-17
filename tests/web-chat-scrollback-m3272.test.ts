/**
 * M-3272 (the user, 2026-11-17: web chat scroll-back), the page's store (chat-store.js), against the host's real history
 * and archive (WebChatHistory + WebChatArchive, a scratch home) through a fetch that answers /ui/history and
 * /ui/history/older | newer | around as web-api.ts does:
 * - older pages only when asked (the reader at the very top: loadOlder), 100 at a time, into the archive past the 500;
 * - at most 1,000 held: past it the newest end is unloaded (`detached`), live messages wait, and scrolling back down
 *   reads it again (loadNewer) — the oldest unloaded then; the live end reached, attached again with what waited;
 * - a jump to a message no longer held (search, pin): the page around it (findQuoted → loadAround);
 * - Jump to latest while detached: the live chat as a first visit reads it; a gap starts scroll-back over.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebChatHistory } from "../src/web-chat-history.js";
import { WebChatArchive } from "../src/web-chat-archive.js";
import { settle } from "./helpers/app-harness.js";
import { installDom, type MiniPage } from "./helpers/mini-dom.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);

async function world(count: number) {
  const home = mkdtempSync(join(tmpdir(), "scrollback-3272-")); dirs.push(home);
  const archive = new WebChatArchive({ home, ownerOf: () => "dir:/w", logger: { warn() {} }, now: () => T0 });
  const history = new WebChatHistory({ boot: "b0" });                  // the real 500-message window
  history.setArchive(archive);
  const say = (n: number) => history.record({ instance: "w", sender: "w", role: "agent", text: `m${n}`, ts: new Date(T0 + n).toISOString() } as never);
  for (let n = 1; n <= count; n++) say(n);
  await archive.flush();
  const reads: string[] = [];
  const fetch = vi.fn(async (path: string) => {
    reads.push(path);
    const u = new URL(path, "http://x"), p = u.searchParams, limit = Number(p.get("limit"));
    const body = u.pathname === "/ui/history" ? { messages: history.list("w", limit) }
      : u.pathname === "/ui/history/older" ? history.older("w", p.get("before")!, limit)
      : u.pathname === "/ui/history/newer" ? history.newer("w", p.get("after")!, limit)
      : u.pathname === "/ui/history/around" ? history.around("w", p.get("key")!, limit) : null;
    return { json: async () => body ?? { error: "not_found" } };
  });
  const { createChatStore } = await import("/ui/js/chat-store.js") as any;
  const st = createChatStore({ fetch, t: (k: string) => k, toast: vi.fn(), announce: vi.fn(), now: () => 1, setTimeout, confirm: vi.fn() });
  const kinds: string[] = [];
  st.subscribe((inst: string, kind: string) => { if (inst === "w") kinds.push(kind); });
  const ids = () => (st.state.msgs.w || []).map((m: any) => m.id);
  return { history, st, reads, ids, kinds, say };
}

describe("M-3272: the store pages back through the archive, holding at most 1,000", () => {
  it("first visit: the newest 200, nothing older read until asked; then 100 older a time, past the 500 into the archive", async () => {
    const w = await world(3000);
    await w.st.openHistory("w"); await settle(2);
    expect([w.ids().length, w.ids()[0], w.ids().at(-1), w.reads.length]).toEqual([200, 2801, 3000, 1]);   // no prefetch
    for (let i = 0; i < 5; i++) await w.st.loadOlder("w");
    expect([w.ids().length, w.ids()[0], w.ids().at(-1), w.st.pagingState("w")]).toEqual([700, 2301, 3000, { olderMore: true, detached: false }]);
    expect(w.reads.slice(1).every((r: string) => r.startsWith("/ui/history/older?instance=w&before=b0-") && r.endsWith("&limit=100"))).toBe(true);
    expect(w.kinds.filter(k => k === "page").length, "a page is drawn as one (the reader kept where they were)").toBe(5);
    expect((w.st.state.msgs.w as any[]).filter(m => m.archived).length, "the ones past the 500 came from the archive").toBe(200);
  });

  it("past 1,000 the newest end is unloaded (detached); a live message waits; scrolling back down reads it again, the oldest unloaded", async () => {
    const w = await world(3000);
    await w.st.openHistory("w");
    for (let i = 0; i < 12; i++) await w.st.loadOlder("w");
    expect([w.ids().length, w.ids()[0], w.ids().at(-1), w.st.pagingState("w").detached]).toEqual([1000, 1601, 2600, true]);
    const live = w.say(3001);                                            // arrives on the stream while scrolled back
    w.st.ingest({ ...live });
    expect(w.ids().includes(3001), "not drawn below the reader").toBe(false);
    let guard = 0;
    while (w.st.pagingState("w").detached && guard++ < 20) { await w.st.loadNewer("w"); expect(w.ids().length).toBeLessThanOrEqual(1000); }
    expect([w.ids().at(-1), w.ids().length, w.st.pagingState("w")]).toEqual([3001, 1000, { olderMore: true, detached: false }]);
    w.st.ingest({ ...w.say(3002) });
    expect(w.ids().at(-1), "attached again: live messages are drawn").toBe(3002);
  });

  it("a jump to a message no longer held (a search or pin hit deep in the archive): the page around it", async () => {
    const w = await world(3000);
    await w.st.openHistory("w");
    expect(await w.st.findQuoted("w", "b0-120")).toBe(true);
    expect([w.ids().includes(120), w.ids().length, w.st.pagingState("w")]).toEqual([true, 100, { olderMore: true, detached: true }]);
    expect(await w.st.findQuoted("w", "b0-999999")).toBe(false);
    // Jump to latest from there: the live chat again, as a first visit reads it.
    await w.st.backToLatest("w"); await settle(2);
    expect([w.ids()[0], w.ids().at(-1), w.st.pagingState("w").detached]).toEqual([2801, 3000, false]);
  });

  it("a gap (the stream came back after missing messages) starts scroll-back over from the newest", async () => {
    const w = await world(1200);
    await w.st.openHistory("w");
    await w.st.loadOlder("w");
    expect(w.st.state.paging.w).toBeTruthy();
    w.st.onGap();
    expect(w.st.state.paging).toEqual({});
  });

  it("the start of the chat: nothing older (more: false) — no read after that", async () => {
    const w = await world(250);
    await w.st.openHistory("w");
    await w.st.loadOlder("w");
    expect([w.ids()[0], w.st.pagingState("w").olderMore]).toEqual([1, false]);
    const before = w.reads.length;
    expect(await w.st.loadOlder("w")).toBe(false);
    expect(w.reads.length).toBe(before);
  });
});

describe("M-3272: the thread asks for a page only at the very top (all drawn) or, detached, the very bottom", () => {
  let dom: MiniPage | null = null;
  afterEach(() => { dom?.restore(); dom = null; });
  async function thread(count: number, detached: boolean) {
    dom = installDom({});
    const { t, setLang } = await import("/assets/app-i18n.js") as any;
    await import("/ui/js/chat-strings.js"); setLang("en", { store: false });
    const { createThread } = await import("/ui/js/chat-thread.js") as any;
    const doc = dom.document as any, list = doc.createElement("div"), scroller = doc.createElement("div"); scroller.append(list); doc.body.append(scroller);
    const onTop = vi.fn(), onBottom = vi.fn(), jumps: any[] = [];
    const th = createThread(list, scroller, { t, tf: t, isUser: () => false, serverNow: () => 0, onJump: (j: any) => jumps.push(j), onEmpty() {}, onTop, onBottom, detached: () => detached });
    th.render(Array.from({ length: count }, (_, i) => ({ boot: "b", id: i + 1, instance: "w", role: "agent", sender: "w", text: `m${i + 1}`, ts: new Date(T0 + i).toISOString() })));
    return { th, scroller, onTop, onBottom, jumps };
  }
  it("at the top with everything drawn: onTop; not while older held messages are still to be drawn (no prefetch)", async () => {
    const few = await thread(10, false);
    few.scroller.scrollTop = 0; few.th.onScroll();
    expect([few.onTop.mock.calls.length, few.onBottom.mock.calls.length]).toEqual([1, 0]);
    dom?.restore(); dom = null;
    const many = await thread(300, false);                                // only the newest 24 drawn so far (chunks follow)
    many.scroller.scrollTop = 0; many.th.onScroll();
    expect(many.onTop.mock.calls.length).toBe(0);
  });
  it("detached (the newest end unloaded): onBottom at the very bottom, and the Jump to latest pill stays", async () => {
    const d = await thread(10, true);
    d.th.onScroll();
    expect([d.onBottom.mock.calls.length, d.jumps.at(-1)?.show]).toEqual([1, true]);
  });
});
