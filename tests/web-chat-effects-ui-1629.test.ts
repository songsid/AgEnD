import { afterEach, describe, expect, it, vi } from "vitest";
import { page, settle, type AppPage } from "./helpers/app-harness.js";
const M = vi.hoisted(() => ({ apis: [] as any[], opts: [] as any[], unavailable: false }));
vi.mock("/assets/effect-chat-runtime.js", () => ({ chatEffectState: () => "idle", createChatEffectRuntime(options: any) {
  const api = { ok: !M.unavailable, sync: vi.fn(), changed: vi.fn(), reply: vi.fn(), pause: vi.fn(), resume: vi.fn(), remove: vi.fn(async () => true), dispose: vi.fn() };
  M.apis.push(api); M.opts.push(options);
  return api;
} }));
let pg: AppPage | null = null;
afterEach(async () => { if (pg) { await pg.unmount(); pg.restore(); pg = null; } vi.unstubAllGlobals(); M.apis.length = 0; M.opts.length = 0; M.unavailable = false; });
async function fixture(unavailable = false, failure: "media" | "observer" | null = null) {
  vi.resetModules(); M.unavailable = unavailable; pg = page(); const host = pg.window;
  Object.assign(host, { matchMedia: globalThis.matchMedia, navigator: globalThis.navigator, OffscreenCanvas: function () {}, Worker: function () {}, ResizeObserver: function () {},
    AgendAuth: { canWrite: async () => true }, AgendPreview: { availability: () => ({ ok: true }), optedIn: () => true, never: () => false } });
  if (unavailable) delete host.navigator;
  if (failure === "media") host.matchMedia = () => { throw new Error("media unavailable"); };
  const observers: any[] = [];
  host.MutationObserver = class { fn: () => void; constructor(fn: () => void) { this.fn = fn; observers.push(this); } observe() { if (failure === "observer") throw new Error("observer unavailable"); } disconnect = vi.fn(); };
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
  it("an admitted pool reads optional device signals only from its host", async () => {
    const h = await fixture(); delete h.host.navigator; vi.stubGlobal("navigator", undefined);
    expect(h.opts().observe().context).toMatchObject({ saveData: false, constrained: false });
    h.host.navigator = { hardwareConcurrency: 2 };
    expect(h.opts().observe().context.constrained).toBe(true); h.cleanup();
  });
  it.each(["media", "observer"] as const)("%s setup failure leaves Chat mounted and releases partial ownership", async failure => {
    const h = await fixture(false, failure); await h.open();
    expect(pg!.root.textContent).toContain("Effects stopped because their resources could not be verified.");
    if (failure === "media") expect(M.apis).toHaveLength(0);
    else { expect(h.api().dispose).toHaveBeenCalledOnce(); expect(h.observers[0].disconnect).toHaveBeenCalledOnce(); }
    h.cleanup();
    if (failure === "observer") expect(h.api().dispose).toHaveBeenCalledOnce();
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
  it("the real barrier observer refreshes cached modal context once per actual open/close", async () => {
    const h = await fixture(), api = h.api(); api.sync.mockClear(); await h.open();
    for (const observer of h.observers) observer.fn(); expect(api.sync).toHaveBeenCalledOnce(); expect(h.opts().observe().context.modal).toBe(true);
    for (const observer of h.observers) observer.fn(); expect(api.sync).toHaveBeenCalledOnce();
    const dialog = pg!.root.querySelector("dialog")!; dialog.close();
    for (const observer of h.observers) observer.fn(); expect(api.sync).toHaveBeenCalledTimes(2); expect(h.opts().observe().context.modal).toBe(false); h.cleanup();
  });
  it("shows the plain custom CSS reason and the actual Appearance destination inside the protected Dialog", async () => {
    const h = await fixture(); await h.publish(); await h.open();
    expect(pg!.root.textContent).toContain("Agent foreground effects are paused while your custom CSS is on or cannot be verified.");
    const settings = [...pg!.root.querySelectorAll("button")].find(b => b.textContent === "Open Appearance settings")!;
    expect(settings.closest("[data-trust=dialog]")).not.toBeNull(); settings.click(); await settle(); expect(globalThis.location.pathname).toBe("/settings/appearance"); h.cleanup();
  });
});
