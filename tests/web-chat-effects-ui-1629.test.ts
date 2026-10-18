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
  const publishRows = async (rows: any[]) => { opts().onChange({ error: null, rows, effects: [{ id: "a".repeat(32), by: "agent", manifest: { title: "Fixture effect", layer: "front" } }] }); await settle(); };
  return { host, observers, api, opts, publish, publishRows, open: async () => { open(true); await settle(); }, close: async () => { open(false); await settle(); },
    nextLease: async () => { currentLease.dispose(); currentLease = createLease(); await mount(); }, cleanup: () => currentLease.dispose() };
}
describe("#1629 actual Effects component", () => {
  it("refused admission installs no runtime observers and keeps an incomplete browser host harmless", async () => {
    const h = await fixture(true); expect(h.observers).toEqual([]); expect(h.api().sync).not.toHaveBeenCalled();
    expect(pg!.root.textContent).toContain("runtime_unavailable"); await h.open(); expect(pg!.root.textContent).toContain("Playback is off or unavailable here."); h.cleanup(); expect(h.api().dispose).toHaveBeenCalledOnce();
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
    const settings = [...pg!.root.querySelectorAll("button")].find(b => b.textContent === "Open Web appearance settings")!;
    expect(settings.closest("[data-trust=dialog]")).not.toBeNull(); settings.click(); await settle(); expect(globalThis.location.pathname).toBe("/settings/appearance"); h.cleanup();
  });

  // #2055: the dialog names why an effect is not playing.
  const ID = "a".repeat(32);
  it("the Effects dialog says it paused a running effect itself, in the past tense, never a cached Running", async () => {
    let clock = 1000; vi.spyOn(performance, "now").mockImplementation(() => clock);
    const h = await fixture(); await h.publish();                 // running at t=1000, then no update while it keeps playing
    clock = 20000;                                                 // the ⋯ menu: the first stopped update, long after the last running one
    await h.publishRows([{ id: ID, phase: null, reason: "stock_overlay", verdict: "off" }]); clock = 20800; await h.open();
    expect(pg!.root.textContent).toContain("Was running; paused while this dialog is open.");
    expect(pg!.root.textContent).not.toContain("Running");
    vi.restoreAllMocks(); h.cleanup();
  });
  it("an effect that stopped long before the dialog opened is not called running", async () => {
    let clock = 1000; vi.spyOn(performance, "now").mockImplementation(() => clock);
    const h = await fixture(); await h.publish();
    clock = 2000; await h.publishRows([{ id: ID, phase: null, reason: "stock_overlay", verdict: "off" }]);
    clock = 20000; await h.open();
    expect(pg!.root.textContent).toContain("Paused while this dialog is open."); expect(pg!.root.textContent).not.toContain("Was running");
    await h.close(); clock = 21000; await h.open();                 // reopening does not revive old evidence
    expect(pg!.root.textContent).not.toContain("Was running");
    vi.restoreAllMocks(); h.cleanup();
  });
  it("a new lease starts without the old evidence", async () => {
    let clock = 1000; vi.spyOn(performance, "now").mockImplementation(() => clock);
    const h = await fixture(); await h.publish(); await h.nextLease();
    await h.publishRows([{ id: ID, phase: null, reason: "stock_overlay", verdict: "off" }]); clock = 1500; await h.open();
    expect(pg!.root.textContent).not.toContain("Was running");
    vi.restoreAllMocks(); h.cleanup();
  });
  it("a queued row with an OFF or interrupted history says so, not waiting for a slot; an ordinary queue waits", async () => {
    const { effectRowText } = await import("/ui/js/chat-effects.js").then(async m => { await fixture(); return m; });
    expect(effectRowText({ id: ID, phase: null, verdict: "queued", reason: "safety_off" })).toContain("three automatic pauses");
    expect(effectRowText({ id: ID, phase: null, verdict: "queued", reason: "interrupted" })).toContain("page closed");
    expect(effectRowText({ id: ID, phase: null, verdict: "queued", reason: "frame_limit" })).toBe("Waiting for a slot");
  });
  it.each([["safety_off", "Turned off on this device after three automatic pauses."], ["paused", "Paused"], ["interrupted", "Stopped: the page closed while it was playing."],
    ["owner_css", "Off while your custom CSS is on."], ["reduced_motion", "Off: this device asks for reduced motion."], ["safety_unknown", "Stopped"]])("reason %s reads %s", async (reason, text) => {
    const h = await fixture(); await h.publish(); await h.publishRows([{ id: ID, phase: null, reason, verdict: "off" }]); await h.open();
    expect(pg!.root.querySelector("dialog section p")!.textContent).toContain(text); h.cleanup();
  });
  it("Resume on a durably-off effect says why it cannot restart", async () => {
    const h = await fixture(); await h.publish(); await h.publishRows([{ id: ID, phase: null, reason: "safety_off", verdict: "off" }]); await h.open();
    h.api().resume.mockReturnValue(false);
    [...pg!.root.querySelectorAll("button")].find(b => b.textContent === "Resume")!.click(); await settle();
    expect(pg!.document.body.textContent).toContain("Resume cannot restart it here."); expect(pg!.document.body.textContent).not.toContain("safety history is not ready");
    h.cleanup();
  });
  it("only a focused editable is called typing; any other protected UI is said generically", async () => {
    await fixture();
    const { effectRowText } = await import("/ui/js/chat-effects.js");
    const row = { id: ID, phase: null, reason: "stock_overlay", verdict: "off" };
    const doc = (active: any) => ({ body: {}, activeElement: active });
    expect(effectRowText(row, { doc: doc({ matches: (s: string) => s.includes("textarea"), isContentEditable: false }) })).toContain("while you type");
    expect(effectRowText(row, { doc: doc({ matches: () => false, isContentEditable: false }) })).toContain("menu or panel");
    expect(effectRowText(row, { doc: { body: 1, activeElement: 1 } as any })).toContain("menu or panel");
    expect(effectRowText({ ...row, reason: "modal" }, { doc: doc(null) })).toBe("Waiting while a dialog is open.");
    expect(effectRowText({ id: ID, phase: "running", reason: "paused" })).toBe("Paused");          // a pause outranks a stale phase
  });
});

describe("#2115 persistent named block notices", () => {
  it("names an absent row and unknown raw local reason, never generic Stopped", async () => {
    await fixture(); const { effectRowText } = await import("/ui/js/chat-effects.js");
    expect(effectRowText(null)).toContain("runtime_unavailable");
    for (const phase of [null, "running", "loading"]) expect(effectRowText({ reason: "future_failure_42", phase, verdict: "queued" })).toBe("Playback blocked: future_failure_42");
    for (const reason of ["constructor", "__proto__"]) expect(effectRowText({ reason })).toBe(`Playback blocked: ${reason}`);
    expect(effectRowText({ reason: "preview_not_consented" })).toContain("allow HTML previews");
    expect(effectRowText({ reason: "baseline_timeout" })).toContain("calibration failed");
  });
  it("stays visible outside the dialog, changes false→different-false, and links to the real consent switch", async () => {
    const h = await fixture(); await h.publishRows([{ id: "a".repeat(32), phase: null, reason: "preview_not_consented" }]);
    expect(pg!.root.querySelector("dialog")).toBeNull(); expect(pg!.root.querySelector(".chat-fx-notice")!.textContent).toContain("allow HTML previews");
    [...pg!.root.querySelectorAll("button")].find(b => b.textContent === "Open device preferences")!.click(); await settle(); expect(globalThis.location.pathname).toBe("/settings/device");
    await h.publishRows([{ id: "a".repeat(32), phase: null, reason: "reduced_motion" }]);
    expect(pg!.root.querySelector(".chat-fx-notice")!.textContent).toContain("reduced motion"); expect(pg!.root.textContent).not.toContain("allow HTML previews");
    await h.publish(); expect(pg!.root.querySelector(".chat-fx-notice")).toBeNull(); h.cleanup();
  });
});
