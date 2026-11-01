/**
 * #2910 D2 / #2925 review P3-1: the Notices panel marks what it shows as read — on open, as one arrives, and when its
 * tab is shown again after one arrived while hidden. The real panel in the mini DOM; the seen POST captured.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { MiniEvent } from "./helpers/mini-dom.js";

let p: AppPage, app: any, N: any;
const posted: number[] = [];
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/notices", storage: { agend_tour_done: "1" } });
  (globalThis as any).fetch = async (url: string, o: any = {}) => {
    if (url === "/ui/notices/seen") { const id = JSON.parse(o.body).id; posted.push(id); return { ok: true, json: async () => ({ seen: id, unread: 0 }) }; }
    return { ok: false, json: async () => ({}) };
  };
  app = await import("/assets/app-store.js" as string);
  N = await import("/ui/js/panel-notices.js" as string);
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => { await p.unmount(); posted.length = 0; (p.document as any).visibilityState = "visible"; });
const n = (id: number) => ({ id, at: Date.now(), kind: "fleet", text: `n${id}` });
const visibility = (state: string) => { (p.document as any).visibilityState = state; p.document.dispatchEvent(new MiniEvent("visibilitychange") as any); };

describe("#2925 review P3-1: shown → read, when the tab comes back too", () => {
  it("open: marks the newest; a hidden arrival waits, and is marked when the tab is shown again; after leaving, nothing", async () => {
    app.appStore.set({ notices: app.mergeNoticeList(null, { enabled: true, items: [n(2), n(1)], seen: 0 }), instances: [] });
    await p.mount(h(N.NoticesPanel, { navKey: "notices:|1|en" }));
    expect(posted).toEqual([2]);
    visibility("hidden");
    app.appStore.set({ notices: app.addNotice(app.appStore.get().notices, n(3)) });
    await settle();
    expect(posted).toEqual([2]);                                    // hidden: not read yet
    visibility("visible"); await settle();
    expect(posted).toEqual([2, 3]);
    await p.unmount();
    app.appStore.set({ notices: app.addNotice(app.appStore.get().notices, n(4)) });
    visibility("hidden"); visibility("visible"); await settle();
    expect(posted).toEqual([2, 3]);                                 // the panel is gone: its listener too
  });
});
