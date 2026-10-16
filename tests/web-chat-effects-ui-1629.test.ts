import { afterEach, describe, expect, it, vi } from "vitest";
import { page, settle, type AppPage } from "./helpers/app-harness.js";
const M = vi.hoisted(() => ({ apis: [] as any[], opts: [] as any[], unavailable: false, owner: null as any }));
vi.mock("/ui/js/app-effects.js", () => ({ getAppEffects: () => M.owner }));
let pg: AppPage | null = null;
afterEach(async () => { if (pg) { await pg.unmount(); pg.restore(); pg = null; } vi.unstubAllGlobals(); M.apis.length = 0; M.opts.length = 0; M.unavailable = false; M.owner = null; });
async function fixture(unavailable = false) {
  vi.resetModules(); M.unavailable = unavailable; pg = page(); const host = pg.window;
  Object.assign(host, { matchMedia: globalThis.matchMedia, navigator: globalThis.navigator, OffscreenCanvas: function () {}, Worker: function () {}, ResizeObserver: function () {},
    AgendAuth: { canWrite: async () => true }, AgendPreview: { availability: () => ({ ok: true }), optedIn: () => true, never: () => false } });
  if (unavailable) delete host.navigator;
  const observers: any[] = [];
  host.MutationObserver = class { fn: () => void; constructor(fn: () => void) { this.fn = fn; observers.push(this); } observe() {} disconnect = vi.fn(); };
  vi.stubGlobal("innerWidth", 1366);
  const nav = await import("/assets/app-nav.js");
  nav.startRouter(host);
  const { ChatEffects } = await import("/ui/js/chat-effects.js");
  const P = await import("/assets/app-html.js");
  const { createLease } = await import("/assets/app-ctx.js");
  let currentLease = createLease(), open: (v: boolean) => void = () => {};
  const store = { onAgentReply: () => () => {} }, element = { current: pg.document.body };
  function Parent({ lease }: any) {
    const [shown, setShown] = P.useState(false); open = setShown;
    return P.h(ChatEffects, { name: "own", lease, element, store, open: shown, onClose: () => setShown(false) });
  }
  const mount = async () => { P.render(P.h(Parent, { lease: currentLease }), pg!.root); await settle(); };
  const owner = { gates: () => ({ enabled: !M.unavailable, show: true, previewReady: true, optIn: true, reducedMotion: false, saveData: false }), onEnd: () => () => {}, attachChat(options: any) {
    const api = { ok: !M.unavailable, sync: vi.fn(), changed: vi.fn(), reply: vi.fn(), pause: vi.fn(), resume: vi.fn(), remove: vi.fn(async () => true), dispose: vi.fn() }; M.apis.push(api); M.opts.push(options); return api;
  } };
  M.owner = owner;
  await mount(); const api = () => M.apis.at(-1), opts = () => M.opts.at(-1);
  const publish = async () => { opts().onChange({ error: null, rows: [{ id: "a".repeat(32), phase: "running", reason: null }], effects: [{ id: "a".repeat(32), by: "agent", manifest: { title: "Fixture effect", layer: "front" } }] }); await settle(); };
  return { host, observers, api, opts, publish, open: async () => { open(true); await settle(); },
    nextLease: async () => { currentLease.dispose(); currentLease = createLease(); await mount(); }, cleanup: () => currentLease.dispose() };
}
describe("#1629 actual Effects component", () => {
  it("refused admission installs no runtime observers and keeps an incomplete browser host harmless", async () => {
    const h = await fixture(true); expect(h.observers).toEqual([]); expect(h.api().sync).not.toHaveBeenCalled();
    expect(pg!.root.textContent).toBe(""); await h.open(); expect(pg!.root.textContent).toContain("Playback is off or unavailable here."); h.cleanup(); expect(h.api().dispose).toHaveBeenCalledOnce();
  });
  it("a missing app owner leaves Chat mounted and offers unavailable without constructing a private pool", async () => {
    const h = await fixture(); h.cleanup(); M.owner = null; await h.nextLease(); await h.open();
    expect(pg!.root.textContent).toContain("Playback is off or unavailable here."); expect(M.apis).toHaveLength(1); h.cleanup();
  });
  it("a same-instance new lease clears stale busy/dialog state and ignores the old remove completion", async () => {
    const h = await fixture(); await h.publish(); await h.open(); let release: (v: boolean) => void = () => {};
    const old = h.api(); old.remove.mockImplementationOnce(() => new Promise(r => { release = r; }));
    const remove = [...pg!.root.querySelectorAll("button")].find(b => b.textContent === "Remove from chat")!;
    remove.click(); await settle(); expect(remove.disabled).toBe(true);
    await h.nextLease(); expect(old.dispose).toHaveBeenCalled(); expect(pg!.root.querySelector("dialog")).toBeNull();
    await h.publish(); await h.open(); release(true); await settle();
    expect([...pg!.root.querySelectorAll(".dlg-body button")].every(b => !b.disabled)).toBe(true); h.cleanup();
  });
  it("shows the plain custom CSS reason and the actual Appearance destination inside the protected Dialog", async () => {
    const h = await fixture(); await h.publish(); await h.open();
    expect(pg!.root.textContent).toContain("Agent foreground effects are paused while your custom CSS is on or cannot be verified.");
    const settings = [...pg!.root.querySelectorAll("button")].find(b => b.textContent === "Open Appearance settings")!;
    expect(settings.closest("[data-trust=dialog]")).not.toBeNull(); settings.click(); await settle(); expect(globalThis.location.pathname).toBe("/settings/appearance"); h.cleanup();
  });
});
