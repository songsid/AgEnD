import { afterEach, describe, expect, it, vi } from "vitest";
import { page, settle, type AppPage } from "./helpers/app-harness.js";
const M = vi.hoisted(() => ({ apis: [] as any[], opts: [] as any[], identity: true, shown: true, optIn: true, unavailable: false,
  theme: new Set<() => void>(), prefs: new Set<() => void>(), css: new Set<() => void>() }));
vi.mock("/assets/effect-chat-runtime.js", () => ({ chatEffectIdentity: () => M.identity }));
vi.mock("/assets/effect-posters.js", () => ({ createChatPosters(options: any) {
  const api = { ok: !M.unavailable, sync: vi.fn(), changed: vi.fn(), dispose: vi.fn() }; M.opts.push(options); M.apis.push(api); return api;
} }));
vi.mock("/assets/app-prefs.js", () => ({ prefInForce: () => ({ value: M.optIn }), onPrefsChanged(fn: () => void) { M.prefs.add(fn); return () => M.prefs.delete(fn); } }));
vi.mock("/assets/app-themes.js", () => ({ themesShown: () => M.shown, themesStore: { subscribe(fn: () => void) { M.theme.add(fn); return () => M.theme.delete(fn); } } }));
vi.mock("/assets/owner-css.js", () => ({ ownerCssLifecycle: { get: () => ({ state: "unknown" }), subscribe(fn: () => void) { M.css.add(fn); return () => M.css.delete(fn); } } }));
let pg: AppPage | null = null, end: (() => void) | null = null;
afterEach(async () => { end?.(); end = null; if (pg) { await pg.unmount(); pg.restore(); pg = null; } M.apis.length = M.opts.length = 0; M.identity = M.shown = M.optIn = true; M.unavailable = false; M.theme.clear(); M.prefs.clear(); M.css.clear(); });
async function fixture(prepare?: (h: any) => void) {
  vi.resetModules(); pg = page(); const host: any = pg.window;
  const motion = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }, connection = { saveData: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  let previewChanged: () => void = () => {}, previewOff = vi.fn();
  Object.assign(host, { Worker: function () {}, OffscreenCanvas: function () {}, navigator: { connection }, matchMedia: () => motion,
    AgendPreview: { availability: () => ({ ok: true }), optedIn: () => true, never: () => false, onChange(fn: () => void) { previewChanged = fn; return previewOff; } } });
  prepare?.({ host, motion, connection });
  const { ChatEffectPosters } = await import("/ui/js/chat-effect-posters.js"), P = await import("/assets/app-html.js"), { createLease } = await import("/assets/app-ctx.js"), { appStore } = await import("/assets/app-store.js");
  const lease = createLease(); end = () => lease.dispose();
  P.render(P.h(ChatEffectPosters, { name: "own", lease, element: { current: pg.root } }), pg.root); await settle();
  return { host, motion, connection, lease, appStore, previewOff, previewChanged: () => previewChanged(), api: M.apis.at(-1), opts: M.opts.at(-1) };
}
describe("#1629 actual static Chat poster adapter (controller mocked)", () => {
  it("opted-in local playback suppresses posters; static fallback never needs a private identity", async () => {
    const h = await fixture(); expect(h.opts.observe()).toEqual({ shown: true, fallback: false, ownerCss: "unknown" });
    M.identity = false; expect(h.opts.observe().fallback).toBe(true); M.shown = false; expect(h.opts.observe().shown).toBe(false);
  });
  it.each(["consent", "device-consent", "never", "preview", "preview-throws", "worker", "canvas", "motion", "save-data", "public"])("%s selects the static surface fallback", async reason => {
    const h = await fixture(({ host, motion, connection }) => {
      if (reason === "consent") M.optIn = false;
      if (reason === "device-consent") host.AgendPreview.optedIn = () => false;
      if (reason === "never") host.AgendPreview.never = () => true;
      if (reason === "preview") host.AgendPreview.availability = () => ({ ok: false });
      if (reason === "preview-throws") host.AgendPreview.availability = () => { throw Error("closed"); };
      if (reason === "worker") delete host.Worker; if (reason === "canvas") delete host.OffscreenCanvas;
      if (reason === "motion") motion.matches = true; if (reason === "save-data") connection.saveData = true;
      if (reason === "public") { host.document.body.dataset.publicLink = "1"; M.identity = false; }
    }); expect(h.opts.observe().fallback).toBe(true); expect(h.api.sync).toHaveBeenCalledOnce();
  });
  it("refreshes from the actual show store, prefs, CSS, preview and device events, and releases each subscription", async () => {
    const h = await fixture(); h.api.sync.mockClear();
    for (const listeners of [M.theme, M.prefs, M.css]) for (const fn of listeners) fn(); h.previewChanged();
    for (const target of [h.motion, h.connection]) target.addEventListener.mock.calls[0][1]();
    expect(h.api.sync).toHaveBeenCalledTimes(6); h.lease.dispose(); expect(h.api.dispose).toHaveBeenCalledOnce();
    expect(M.theme.size + M.prefs.size + M.css.size).toBe(0); expect(h.previewOff).toHaveBeenCalledOnce();
    expect(h.motion.removeEventListener).toHaveBeenCalledOnce(); expect(h.connection.removeEventListener).toHaveBeenCalledOnce();
    h.previewChanged(); expect(h.api.sync).toHaveBeenCalledTimes(6);
  });
  it("revision invalidates old poster ownership and an ended connection disposes immediately", async () => {
    const h = await fixture(); h.appStore.set({ themesRev: h.appStore.get().themesRev + 1 }); expect(h.api.changed).toHaveBeenCalledOnce();
    h.appStore.set({ connection: "ended" }); expect(h.api.dispose).toHaveBeenCalledOnce();
  });
  it("an incomplete browser host does not read bare global navigator or width", async () => {
    const h = await fixture(({ host }) => { delete host.navigator; delete host.innerWidth; delete host.matchMedia; }); expect(h.opts.observe().fallback).toBe(true); expect(h.api.sync).toHaveBeenCalledOnce();
  });
  it("a refused controller installs no subscriptions, and the lease still disposes it", async () => {
    M.unavailable = true; const h = await fixture(); expect(M.theme.size + M.prefs.size + M.css.size).toBe(0); expect(h.motion.addEventListener).not.toHaveBeenCalled(); expect(h.api.sync).not.toHaveBeenCalled();
    h.lease.dispose(); expect(h.api.dispose).toHaveBeenCalledOnce();
  });
  it("a partial listener failure releases previously acquired ownership without breaking Chat", async () => {
    const h = await fixture(({ motion }) => { motion.addEventListener.mockImplementation(() => { throw Error("unsupported"); }); });
    expect(h.api.dispose).toHaveBeenCalledOnce(); expect(M.theme.size + M.prefs.size + M.css.size).toBe(0); expect(h.previewOff).toHaveBeenCalledOnce();
    h.lease.dispose(); expect(h.api.dispose).toHaveBeenCalledOnce();
  });
});
