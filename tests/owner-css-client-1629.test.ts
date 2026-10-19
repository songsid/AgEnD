/**
 * #1629 r4 §3 / §7.4, the page side: the owner-CSS link (last in <head>, ?v=<sha>) is there on /ui and /view for the
 * signed-in person, absent on Settings (removed and put back), on the public link, for the anonymous reader, with this
 * device's switch off, and with ?safe=1; keep-or-revert reverts after 15 s with no answer, and Keep stops it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, settle, type AppPage } from "./helpers/app-harness.js";

const S1 = "1".repeat(32), S2 = "2".repeat(32), T1 = "a".repeat(32), T2 = "b".repeat(32);
let p: AppPage | null = null;
let shownAnswer: () => unknown = () => ({ ok: true, status: 200, json: async () => ({ remaining_ms: 20_000 }) });
const g = globalThis as any;
afterEach(async () => { vi.useRealTimers(); if (p) { try { const { render } = await import("/assets/app-html.js"); render(null, p.root); } catch { /* none */ } p.restore(); p = null; } delete g.fetch; vi.resetModules(); });

async function boot(opts: { url?: string; owner?: string | null; mode?: string; publicLink?: boolean; storage?: Record<string, string>; route?: unknown; pending?: unknown } = {}) {
  vi.resetModules();
  p = page({ url: opts.url ?? "http://127.0.0.1:19280/ui/fleet", storage: opts.storage ?? {} });
  const body = p.document.body;
  body.dataset.mode = opts.mode ?? "full";
  if (opts.owner !== null) body.dataset.ownerCss = opts.owner ?? S1;
  if (opts.publicLink) body.dataset.publicLink = "1";
  const calls: Array<{ url: string; body?: unknown }> = [];
  g.fetch = vi.fn(async (url: string, init: any = {}) => {
    calls.push({ url, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
    if (url === "/ui/owner-css/state") return { ok: true, status: 200, json: async () => ({ active: state.active, pending: state.pending }) };
    if (url === "/ui/owner-css/shown") return shownAnswer();
    return { ok: true, status: 200, json: async () => ({}) };
  });
  const state: { active: string | null; pending: unknown } = { active: opts.owner === null ? null : opts.owner ?? S1, pending: opts.pending ?? null };
  const nav = await import("/assets/app-nav.js");
  nav.navStore.set({ route: opts.route ?? { panel: "fleet" }, seq: 1 });
  const oc = await import("/assets/owner-css.js");
  const store = await import("/assets/app-store.js");
  oc.installOwnerCss();
  await settle();
  const link = () => p!.document.getElementById("owner-css");
  return { oc, nav, store, calls, state, link };
}

describe("the link", () => {
  it("the signed-in person's page: a stylesheet link, last in <head>, to /ui/owner-css.css?v=<sha>", async () => {
    const { link } = await boot();
    const head = p!.document.head;
    const last = head.childNodes[head.childNodes.length - 1];
    expect([link()?.getAttribute("rel"), link()?.getAttribute("href"), last === link()]).toEqual(["stylesheet", `/ui/owner-css.css?v=${S1}`, true]);
    expect(link()?.getAttribute("style") ?? null).toBeNull();
  });
  it("Settings: removed while it is open, put back on leaving", async () => {
    const { nav, link } = await boot();
    nav.navStore.set({ route: { panel: "settings", section: "appearance" }, seq: 2 });
    expect(link()).toBeNull();
    nav.navStore.set({ route: { panel: "chat", instance: "a" }, seq: 3 });
    expect(link()?.getAttribute("href")).toBe(`/ui/owner-css.css?v=${S1}`);
  });
  it("opened on Settings: never linked until it is left", async () => {
    const { nav, link } = await boot({ route: { panel: "settings", section: "device" } });
    expect(link()).toBeNull();
    nav.navStore.set({ route: { panel: "fleet" }, seq: 2 });
    expect(link()).not.toBeNull();
  });
  it.each([
    ["the public link", { publicLink: true }],
    ["the anonymous View reader", { mode: "view-only", url: "http://127.0.0.1:19280/view/a" }],
    ["no version named by the host", { owner: null }],
    ["this device turned it off", { storage: { agend_owner_css_off: "1" } }],
    ["safe mode (?safe=1)", { url: "http://127.0.0.1:19280/ui/fleet?safe=1" }],
  ])("%s: no link", async (_n, opts) => {
    const { link } = await boot(opts as never);
    expect(link()).toBeNull();
  });
  it("the per-device switch: off removes it at once (only this browser), on puts it back", async () => {
    const { oc, link } = await boot();
    oc.setOwnerCssOffHere(true);
    expect([link(), p!.storage.get("agend_owner_css_off")]).toEqual([null, "1"]);
    oc.setOwnerCssOffHere(false);
    expect([link() !== null, p!.storage.has("agend_owner_css_off")]).toEqual([true, false]);
  });
  it("safe mode is this load's: safeMode() says so", async () => {
    const { oc } = await boot({ url: "http://127.0.0.1:19280/ui/fleet?safe=1" });
    expect(oc.safeMode()).toBe(true);
  });
  it("another device changed it (the prefs rev moved): the version in force is asked for and linked", async () => {
    const { store, state, link, calls } = await boot();
    store.appStore.set((s: any) => ({ ...s, prefsRev: 1 }));
    await settle();
    calls.length = 0;                                                    // the load's own look (a trial in progress?) aside
    state.active = S2;
    store.appStore.set((s: any) => ({ ...s, prefsRev: 2 }));
    await settle(); await settle();
    expect(calls.filter(c => c.url === "/ui/owner-css/state").length).toBe(1);
    expect(link()?.getAttribute("href")).toBe(`/ui/owner-css.css?v=${S2}`);
  });
});

describe("keep or revert", () => {
  it("no answer within 15 s: reverted to the version before — at once on the page, and on the host", async () => {
    const { oc, link, calls } = await boot();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    oc.startOwnerCssTrial(T1, S2, S1);
    expect(link()?.getAttribute("href")).toBe(`/ui/owner-css.css?v=${S2}`);
    await vi.advanceTimersByTimeAsync(14_900);
    expect(calls.some(c => c.url === "/ui/owner-css/revert")).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls.find(c => c.url === "/ui/owner-css/revert")?.body, "the trial by its id, never a history restore").toEqual({ trial: T1 });
    expect(link()?.getAttribute("href")).toBe(`/ui/owner-css.css?v=${S1}`);
  });
  it("Keep: kept on the host, and nothing reverts afterwards", async () => {
    const { oc, link, calls } = await boot();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    oc.startOwnerCssTrial(T1, S2, S1);
    await oc.keepOwnerCss();
    await vi.advanceTimersByTimeAsync(30_000);
    expect([calls.find(c => c.url === "/ui/owner-css/keep")?.body, calls.some(c => c.url === "/ui/owner-css/revert")]).toEqual([{ trial: T1 }, false]);
    expect(link()?.getAttribute("href")).toBe(`/ui/owner-css.css?v=${S2}`);
  });
  it("the bar: on any page, a trust area, with the seconds left, Keep and Revert", async () => {
    const { oc } = await boot();
    const { html, render } = await import("/assets/app-html.js");   // the same Preact as the module under test (modules were reset)
    render(html`<${oc.OwnerCssKeepBar} />`, p!.root);
    await settle();
    expect(p!.root.querySelector(".oc-keep")).toBeNull();
    oc.startOwnerCssTrial(T1, S2, null);
    await settle();
    const bar = p!.root.querySelector(".oc-keep");
    expect([bar?.getAttribute("data-trust"), bar?.getAttribute("role"), bar?.querySelectorAll("button").map((b: any) => b.textContent)])
      .toEqual(["keep", "alertdialog", ["Keep", "Revert"]]);
    expect(bar.textContent).toContain("Reverts in 15 s");
    bar.querySelectorAll("button")[1].click();
    await settle(); await settle();
    expect(oc.ownerCssTrial.get(), "Revert ends the trial").toBeNull();
    expect(p!.root.querySelector(".oc-keep")).toBeNull();
  });

  // #1883 review r1 (P2-2): another device's trial, and a page loaded during one.
  it("a page loaded during a trial (another device's, or a reload) shows the bar — and never reverts it itself", async () => {
    // The host's deadline is near (real time: the page counts to it, plus a second, then asks again).
    const { oc, calls, state, store } = await boot({ owner: S2, pending: { id: T1, sha: S2, previous: S1, remaining_ms: 300 } });
    await settle(); await settle();
    expect(oc.ownerCssTrial.get()).toMatchObject({ sha: S2, previous: S1, local: false });
    state.pending = null;                                               // kept on the device that saved it
    await new Promise(r => setTimeout(r, 1_600));
    await settle();
    expect(calls.some(c => c.url === "/ui/owner-css/revert"), "no revert from here").toBe(false);
    expect(calls.filter(c => c.url === "/ui/owner-css/state").length, "it asked the host again").toBeGreaterThanOrEqual(2);
    expect([oc.ownerCssTrial.get(), p!.document.getElementById("owner-css")?.getAttribute("href")]).toEqual([null, `/ui/owner-css.css?v=${S2}`]);
    void store;
  });
  it("another device saves (the prefs rev moves): the bar appears here; it kept it: the bar goes", async () => {
    const { oc, state, store } = await boot();
    store.appStore.set((s: any) => ({ ...s, prefsRev: 1 }));
    await settle();
    state.active = S2; state.pending = { id: T2, sha: S2, previous: S1, remaining_ms: 15_000 };
    store.appStore.set((s: any) => ({ ...s, prefsRev: 2 }));
    await settle(); await settle();
    expect(oc.ownerCssTrial.get()).toMatchObject({ sha: S2, local: false });
    state.pending = null;
    store.appStore.set((s: any) => ({ ...s, prefsRev: 3 }));
    await settle(); await settle();
    expect(oc.ownerCssTrial.get()).toBeNull();
  });

  // #1883 review r2 (P2-2 b, c).
  it("(b) an older /state answer never overwrites a newer one (or a local change)", async () => {
    const { oc, link } = await boot();
    const held: Array<(v: unknown) => void> = [];
    g.fetch = vi.fn(async (url: string) => {
      if (url !== "/ui/owner-css/state") return { ok: true, status: 200, json: async () => ({}) };
      const n = held.length;
      return { ok: true, status: 200, json: () => new Promise(r => held.push(r)).then(v => v) , n };
    });
    const store = await import("/assets/app-store.js");
    store.appStore.set((s: any) => ({ ...s, prefsRev: 10 })); await settle();
    store.appStore.set((s: any) => ({ ...s, prefsRev: 11 })); await settle();   // read A asked
    store.appStore.set((s: any) => ({ ...s, prefsRev: 12 })); await settle();   // read B asked
    await vi.waitFor(() => expect(held.length).toBe(2));
    held[1]!({ active: S2, pending: null });                                     // the newer answer: B kept
    await settle(); await settle();
    held[0]!({ active: S1, pending: { id: T1, sha: S1, previous: null, remaining_ms: 5_000 } });   // the older one, late
    await settle(); await settle();
    expect([link()?.getAttribute("href"), oc.ownerCssTrial.get()]).toEqual([`/ui/owner-css.css?v=${S2}`, null]);
  });
  it("(c) another device's trial is timed by the host's remaining time — a device clock an hour behind changes nothing", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() - 3_600_000);
    const { oc } = await boot({ owner: S2, pending: { id: T1, sha: S2, previous: S1, remaining_ms: 5_000 } });
    await settle(); await settle();
    const trial = oc.ownerCssTrial.get();
    expect(trial).toMatchObject({ id: T1, local: false });
    const left = trial.deadline - performance.now();
    expect(left).toBeGreaterThan(5_000);
    expect(left).toBeLessThanOrEqual(6_100);
  });
  it("(c) however much the host says is left, a non-local page asks again within the trial's whole budget (21 s)", async () => {
    const { oc } = await boot({ owner: S2, pending: { id: T1, sha: S2, previous: S1, remaining_ms: 3_600_000 } });
    await settle(); await settle();
    expect(oc.ownerCssTrial.get().deadline - performance.now()).toBeLessThanOrEqual(21_000);
  });
});

describe("#2198: an agent's trial waits for a page that shows it", () => {
  const loaded = (el: any) => {
    Object.assign(el, { disabled: false, sheet: { ownerNode: el, href: new URL(el.getAttribute("href"), g.location.href).href, disabled: false } });
    el.dispatchEvent(new g.Event("load"));
  };
  afterEach(() => { shownAnswer = () => ({ ok: true, status: 200, json: async () => ({ remaining_ms: 20_000 }) }); });
  it("the page puts it in, and once its stylesheet loaded says so — then the bar runs on the host's window", async () => {
    const { calls, link, oc } = await boot({ owner: S2, pending: { id: T2, sha: S2, previous: S1, remaining_ms: 540_000, waiting: true } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    expect(link()?.getAttribute("href")).toBe(`/ui/owner-css.css?v=${S2}`);
    expect(calls.some((c) => c.url === "/ui/owner-css/shown"), "not before it is on screen").toBe(false);
    loaded(link());
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((c) => c.url === "/ui/owner-css/shown").map((c) => c.body)).toEqual([{ trial: T2 }]);
    expect(oc.ownerCssTrial.get()).toMatchObject({ id: T2, local: false });
    expect(calls.some((c) => c.url === "/ui/owner-css/revert")).toBe(false);
  });
  it("the host cannot be told: this page reverts it itself after 15 s (the dead-man switch holds)", async () => {
    shownAnswer = () => ({ ok: false, status: 503, json: async () => ({ error: "prefs_unwritable" }) });
    const { calls, link, oc } = await boot({ owner: S2, pending: { id: T2, sha: S2, previous: S1, remaining_ms: 540_000, waiting: true } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    loaded(link()); await vi.advanceTimersByTimeAsync(0);
    expect(oc.ownerCssTrial.get()).toMatchObject({ id: T2, local: true });
    await vi.advanceTimersByTimeAsync(15_100);
    expect(calls.find((c) => c.url === "/ui/owner-css/revert")?.body).toEqual({ trial: T2 });
  });
  it("on Settings it is not linked, so not reported shown", async () => {
    const { calls } = await boot({ owner: S2, pending: { id: T2, sha: S2, previous: S1, remaining_ms: 540_000, waiting: true }, route: { panel: "settings", section: "appearance" } });
    await settle();
    expect(calls.some((c) => c.url === "/ui/owner-css/shown")).toBe(false);
  });
});
