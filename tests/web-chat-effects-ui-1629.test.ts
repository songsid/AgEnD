import { afterEach, describe, expect, it, vi } from "vitest";
import { fire } from "./helpers/mini-dom.js";
import { page, settle, type AppPage } from "./helpers/app-harness.js";
const M = vi.hoisted(() => ({ apis: [] as any[], opts: [] as any[], unavailable: false, owner: null as any, active: true }));
vi.mock("/ui/js/app-effects.js", () => ({ getAppEffects: () => M.owner }));
let pg: AppPage | null = null;
afterEach(async () => { if (pg) { await pg.unmount(); pg.restore(); pg = null; } vi.unstubAllGlobals(); M.apis.length = 0; M.opts.length = 0; M.unavailable = false; M.owner = null; M.active = true; });
async function fixture(unavailable = false) {
  vi.resetModules(); M.unavailable = unavailable; pg = page(); pg.document.body.dataset.mode = "full"; pg.document.documentElement.setAttribute("data-prefs", JSON.stringify({ ownerScope: "operator", ownerEpoch: "e".repeat(16) })); const host = pg.window;
  Object.assign(host, { matchMedia: globalThis.matchMedia, navigator: globalThis.navigator, OffscreenCanvas: function () {}, Worker: function () {}, ResizeObserver: function () {},
    AgendAuth: { canWrite: async () => true }, AgendPreview: { availability: () => ({ ok: true }), optedIn: () => true, never: () => false } });
  if (unavailable) delete host.navigator;
  const observers: any[] = [];
  host.MutationObserver = class { fn: () => void; constructor(fn: () => void) { this.fn = fn; observers.push(this); } observe() {} disconnect = vi.fn(); };
  vi.stubGlobal("innerWidth", 1366);
  const nav = await import("/assets/app-nav.js");
  nav.startRouter(host);
  (await import("/assets/app-store.js")).appStore.set({ canvasWorker: true });
  const { ChatEffects } = await import("/ui/js/chat-effects.js");
  const P = await import("/assets/app-html.js");
  const { createLease } = await import("/assets/app-ctx.js");
  let currentLease = createLease(), open: (v: boolean) => void = () => {};
  const store = { onAgentReply: () => () => {} }, element = { current: pg.document.body }, playback = vi.fn();
  function Parent({ lease }: any) {
    const [shown, setShown] = P.useState(false); open = setShown;
    return P.h(ChatEffects, { name: "own", lease, element, store, open: shown, onPlayback: playback, onClose: () => setShown(false), active: M.active });
  }
  const mount = async () => { P.render(P.h(Parent, { lease: currentLease }), pg!.root); await settle(); };
  const owner = { gates: () => ({ enabled: !M.unavailable, show: true, transportReady: true, optIn: true, reducedMotion: false, saveData: false }), onEnd: () => () => {}, attachChat(options: any) {
    const api = { ok: !M.unavailable, sync: vi.fn(), changed: vi.fn(), reply: vi.fn(), pause: vi.fn(), resume: vi.fn(), remove: vi.fn(async () => true), dispose: vi.fn() }; M.apis.push(api); M.opts.push(options); return api;
  } };
  M.owner = owner;
  await mount(); const api = () => M.apis.at(-1), opts = () => M.opts.at(-1);
  const publish = async () => { opts().onChange({ error: null, rows: [{ id: "a".repeat(32), phase: "running", reason: null }], effects: [{ id: "a".repeat(32), by: "agent", manifest: { title: "Fixture effect", layer: "front" } }] }); await settle(); };
  const publishRows = async (rows: any[]) => { opts().onChange({ error: null, rows, effects: [{ id: "a".repeat(32), by: "agent", manifest: { title: "Fixture effect", layer: "front" } }] }); await settle(); };
  return { host, observers, api, opts, playback, publish, publishRows, open: async () => { open(true); await settle(); }, close: async () => { open(false); await settle(); },
    nextLease: async () => { currentLease.dispose(); currentLease = createLease(); await mount(); }, cleanup: () => currentLease.dispose() };
}
describe("#1629 actual Effects component", () => {
  it("publishes actual Chat playback for the one shared motion note, and clears it on pause/unmount", async () => {
    const h = await fixture(); await h.publish(); expect(h.playback).toHaveBeenLastCalledWith({ name: "own", playing: true });
    await h.publishRows([{ id: "a".repeat(32), phase: null, reason: "paused" }]);
    expect(h.playback).toHaveBeenLastCalledWith({ name: "own", playing: false });
    await h.publish(); h.cleanup(); await pg!.unmount(); expect(h.playback).toHaveBeenLastCalledWith({ name: "own", playing: false });
  });
  it("keeps layout and unexpected raw codes visible locally, including the dialog", async () => {
    const h = await fixture(); await h.publishRows([{ id: "a".repeat(32), reason: "stock_marker_limit", phase: null }]);
    expect(pg!.root.textContent).toContain("page layout could not be verified (stock_marker_limit)"); await h.open(); expect(pg!.root.textContent).toContain("stock_marker_limit");
    const { effectRowText } = await import("/ui/js/chat-effects.js"); expect(effectRowText({ reason: "future_host_code" })).toContain("future_host_code"); expect(effectRowText({ reason: false })).toContain("invalid_reason_type"); h.cleanup();
  });
  it("a manual pause never claims a performance intervention; actual budget and OFF reasons still explain it", async () => {
    const h = await fixture();
    await h.publishRows([{ id: "a".repeat(32), phase: null, reason: "paused" }]);
    expect(pg!.root.textContent).not.toContain("protect page responsiveness"); expect(pg!.root.textContent).toContain("automatic-pause history");
    await h.open(); expect(pg!.root.textContent).not.toContain("protect page responsiveness");
    await h.publishRows([{ id: "a".repeat(32), phase: null, reason: "host_budget" }]); expect(pg!.root.textContent).toContain("protect page responsiveness");
    await h.publishRows([{ id: "a".repeat(32), phase: null, reason: "safety_off" }]); expect(pg!.root.textContent).toContain("after three automatic pauses"); h.cleanup();
  });
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
    ["owner_css", "Off while your custom CSS is on."], ["reduced_motion", "Off: you chose to follow the system's reduced motion setting."], ["safety_unknown", "Stopped"]])("reason %s reads %s", async (reason, text) => {
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
    expect(effectRowText(row, { doc: doc({ matches: (s: string) => s.includes("textarea"), isContentEditable: false }) })).toContain("menu or panel");
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
    expect(effectRowText({ reason: "preview_not_consented" })).toContain("older playback information");
    expect(effectRowText({ reason: "baseline_timeout" })).toContain("older playback information");
  });
  it.each(["guest","public"])("%s has an always-visible local off/on control, no management and no host write",async kind=>{
    const h=await fixture();if(kind==="guest")pg!.document.body.dataset.tier="guest";else pg!.document.body.dataset.publicLink="1";
    await h.nextLease();await h.publish();const requests=vi.fn();vi.stubGlobal("fetch",requests);h.host.fetch=requests;
    const themes=await import("/assets/app-themes.js");const control=()=>pg!.root.querySelector('.chat-fx-notice input[type=checkbox]') as any;
    expect(control()).toBeTruthy();expect(pg!.root.querySelector("dialog")).toBeNull();control().checked=false;fire(control(),"change");await settle();expect(themes.themesShown()).toBe(false);
    control().checked=true;fire(control(),"change");await settle();expect(themes.themesShown()).toBe(true);expect(requests).not.toHaveBeenCalled();expect(pg!.root.textContent).not.toContain("Remove from chat");h.cleanup();
  });
  it("a public disabled notice turns effects on in this browser without a host preference POST", async () => {
    const h = await fixture(); pg!.document.body.dataset.publicLink = "1";
    const requests: string[] = []; const post = vi.fn(async (url: string) => { requests.push(String(url)); throw Error("no request expected"); });
    vi.stubGlobal("fetch", post); h.host.fetch = post;
    const themes = await import("/assets/app-themes.js"); themes.setThemesShown(false);
    await h.publishRows([{ id: "a".repeat(32), phase: null, reason: "disabled" }]);
    const action = [...pg!.root.querySelectorAll("button")].find(b => b.textContent === "Turn effects on here")!;
    expect(action).toBeTruthy(); action.click(); await settle();
    expect(themes.themesShown()).toBe(true); expect(requests).toEqual([]); h.cleanup();
  });
  it.each(["guest", "public"])("%s motion recovery only changes the device choice", async kind => {
    const h = await fixture(); if (kind === "guest") pg!.document.body.dataset.tier = "guest"; else pg!.document.body.dataset.publicLink = "1";
    const motion = await import("/assets/fx-motion.js"), requests = vi.fn(); vi.stubGlobal("fetch", requests); h.host.fetch = requests;
    motion.setFollowsReducedMotion(true); await h.publishRows([{ id: "a".repeat(32), reason: "reduced_motion", phase: null }]);
    const action = [...pg!.root.querySelectorAll("button")].find(b => b.textContent === "Play effects anyway")!;
    expect(action).toBeTruthy(); action.click(); await settle(); expect(motion.followsReducedMotion()).toBe(false);
    expect(requests).not.toHaveBeenCalled(); expect(pg!.root.textContent).not.toContain("Remove from chat"); h.cleanup();
  });
  it("safe mode exits through the same-origin current URL while preserving other parameters", async () => {
    const h = await fixture(); const assign = vi.fn();
    vi.stubGlobal("location", { href: "http://localhost/ui/chat/own?safe=1&x=2#test", assign });
    await h.publishRows([{ id: "a".repeat(32), reason: "safe_mode", phase: null }]);
    [...pg!.root.querySelectorAll("button")].find(b => b.textContent === "Leave safe mode")!.click();
    expect(assign).toHaveBeenCalledExactlyOnceWith("http://localhost/ui/chat/own?x=2#test"); h.cleanup();
  });
  it("stays visible outside the dialog, changes false→different-false, and links to the current viewer switch", async () => {
    const h = await fixture(); await h.publishRows([{ id: "a".repeat(32), phase: null, reason: "disabled" }]);
    expect(pg!.root.querySelector("dialog")).toBeNull(); expect(pg!.root.querySelector(".chat-fx-notice")!.textContent).toContain("switched off");
    [...pg!.root.querySelectorAll("button")].find(b => b.textContent === "Open Web appearance settings")!.click(); await settle(); expect(globalThis.location.pathname).toBe("/settings/appearance");
    await h.publishRows([{ id: "a".repeat(32), phase: null, reason: "reduced_motion" }]);
    expect(pg!.root.querySelector(".chat-fx-notice")!.textContent).toContain("reduced motion"); expect(pg!.root.textContent).not.toContain("older playback information");
    await h.publish(); expect(pg!.root.querySelector(".chat-fx-notice")).toBeNull(); h.cleanup();
  });
});
// #2193 — last in the file: the harness unmounts with its own Preact, which matches the fixture's only for the first test.
describe("#2193 a chat with no placements", () => {
  it("#2193: a chat with no placements attaches nothing and wakes nothing; its dialog says there are none", async () => {
    M.active = false;
    const h = await fixture();
    expect(M.apis).toHaveLength(0);
    expect((await import("/ui/js/effects-waker.js")).effectsLoaded()).toBe(false);
    await h.open();
    expect(pg!.root.textContent).toContain("No effects in this chat.");
    expect(pg!.root.textContent).not.toContain("runtime_unavailable");
    h.cleanup();
  });
  it("#2193: once the runtime is awake (woken by anything — a Try card needs its chat attached), a chat with none attaches", async () => {
    M.active = false;
    const h = await fixture();
    expect(M.apis).toHaveLength(0);
    await (await import("/ui/js/effects-waker.js")).wakeEffects(); await settle(); await settle();
    expect(M.apis).toHaveLength(1);
    h.cleanup();
  });
});
