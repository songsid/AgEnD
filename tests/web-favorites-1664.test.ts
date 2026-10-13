/**
 * #1664 (design: the comment on #1665, which covers #1664): favorites — starred instances pinned at the top of the
 * sidebar, kept on the host as the `nav.favorites` preference. Host: only instances of this fleet (own keys; never
 * "__proto__"), at most 50, in their order; a deleted one dropped on read and when it is removed; never written over the
 * public link; another session sees the change. Page: the Favorites group, the star (aria-pressed), Edit's ↑ ↓, the
 * public link read-only, zh-TW. Real store, router handler, FleetManager wiring and the real Shell in a mini DOM.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSessionStore, tokenEpoch, csrfTokenFor } from "../src/web-session.js";
import { bindGatewayRequest } from "../src/web-request-context.js";
import { handleWebRequest } from "../src/web-api.js";
import { MAX_FAVORITES, OPERATOR, WebPrefsStore } from "../src/web-prefs.js";
import { fire } from "./helpers/mini-dom.js";
import { h, page, settle, type AppPage } from "./helpers/app-harness.js";

const token = "c".repeat(48), local = "http://127.0.0.1:19280", pub = "https://sample.trycloudflare.com", exposureId = "a".repeat(32);
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "fav-1664-")); dirs.push(d); return d; };
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("the host: nav.favorites", () => {
  const fleet = (names: string[]) => Object.fromEntries(names.map((n) => [n, { working_directory: "/tmp" }]));
  /** The fleet's own wiring (FleetManager.webPrefs): fleet.yaml's instances by own key, or a ClassicBot room. */
  async function fleetPrefs(names: string[], rooms: string[] = []) {
    const { FleetManager } = await import("../src/fleet-manager.js");
    const fm = Object.create(FleetManager.prototype) as InstanceType<typeof FleetManager>;
    Object.assign(fm, { dataDir: tmp(), fleetConfig: { instances: fleet(names) }, classicChannels: { getAll: () => rooms.map((instanceName) => ({ instanceName })) } });
    return fm.webPrefs;
  }
  it("only instances of this fleet — a fleet.yaml instance or a ClassicBot room; never an unknown name, __proto__ or constructor", async () => {
    const prefs = await fleetPrefs(["alpha", "beta"], ["room-1"]);
    const outcome = (list: string[]) => { const p = prefs.parsePatch({ "nav.favorites": list }); return p.ok ? "ok" : p.error; };
    expect([outcome(["beta", "room-1", "alpha"]), outcome(["alpha", "ghost"]), outcome(["__proto__"]), outcome(["constructor"]), outcome(["toString"])])
      .toEqual(["ok", "unknown_instance: ghost", "unknown_instance: __proto__", "unknown_instance: constructor", "unknown_instance: toString"]);
  });
  it("with no way to know the fleet's instances, no favorite is accepted (nor served)", () => {
    const prefs = new WebPrefsStore(tmp());
    expect(prefs.parsePatch({ "nav.favorites": ["alpha"] })).toEqual({ ok: false, error: "unknown_instance: alpha" });
  });
  it(`at most ${MAX_FAVORITES}, no repeats, names only`, async () => {
    const names = Array.from({ length: MAX_FAVORITES + 1 }, (_, i) => `i${i}`);
    const prefs = await fleetPrefs(names);
    const ok = (list: unknown) => prefs.parsePatch({ "nav.favorites": list }).ok;
    expect([ok(names.slice(0, MAX_FAVORITES)), ok(names), ok(["i1", "i1"]), ok("i1"), ok([""]), ok([1])]).toEqual([true, false, false, false, false, false]);
  });
  it("the order is kept exactly as written", async () => {
    const prefs = await fleetPrefs(["a", "b", "c"]);
    prefs.write(OPERATOR, new Map([["nav.favorites", ["c", "a", "b"]]]));
    expect(prefs.read().values["nav.favorites"]).toEqual(["c", "a", "b"]);
  });
  it("a deleted instance is dropped on read; a paused or stopped one (still in the fleet) stays", async () => {
    const dir = tmp();
    const live = new Set(["a", "paused", "c"]);
    const prefs = new WebPrefsStore(dir, { exists: (n) => live.has(n) });
    prefs.write(OPERATOR, new Map([["nav.favorites", ["a", "paused", "c"]]]));
    live.delete("c");
    expect(prefs.read().values["nav.favorites"]).toEqual(["a", "paused"]);
  });
  it("forgetInstance prunes every list that has it (a new rev); one that does not is left alone", () => {
    const prefs = new WebPrefsStore(tmp(), { exists: () => true });
    prefs.write(OPERATOR, new Map([["nav.favorites", ["a", "b"]]]));
    prefs.forgetInstance("zzz");
    const before = prefs.rev();
    prefs.forgetInstance("a");
    expect([before, prefs.rev(), prefs.read().values["nav.favorites"]]).toEqual([1, 2, ["b"]]);
  });
  it("removing an instance drops it from the favorites — only once the removal succeeded", async () => {
    const dir = tmp();
    vi.stubEnv("AGEND_HOME", dir);
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { authorizeExplicitInstanceRemoval } = await import("../src/instance-removal.js");
    const fm = new FleetManager(dir);
    const any = fm as unknown as Record<string, any>;
    fm.fleetConfig = { instances: { w: { working_directory: dir }, x: { working_directory: dir } } } as never;
    fm.webPrefs.write(OPERATOR, new Map([["nav.favorites", ["w", "x"]]]));
    any.lifecycle = { daemons: new Map(), remove: async () => { throw new Error("refused"); } };
    await expect(fm.removeInstance("w", authorizeExplicitInstanceRemoval("dashboard-confirmed"))).rejects.toThrow();
    const kept = fm.webPrefs.read().values["nav.favorites"];
    any.lifecycle = { daemons: new Map(), remove: async () => { delete (fm.fleetConfig as any).instances.w; } };
    any.statuslineWatcher = { unwatch() {} };
    await fm.removeInstance("w", authorizeExplicitInstanceRemoval("dashboard-confirmed"));
    // Read straight from the file: what every device gets from now on (not just this read's filter).
    expect([kept, new WebPrefsStore(dir, { exists: () => true }).read().values["nav.favorites"]]).toEqual([["w", "x"], ["x"]]);
  });

  it("#1677 r1: an instance named \"constructor\" is removed like any other — its favorite goes (own key, not the inherited one)", async () => {
    const dir = tmp();
    vi.stubEnv("AGEND_HOME", dir);
    const { FleetManager } = await import("../src/fleet-manager.js");
    const { authorizeExplicitInstanceRemoval } = await import("../src/instance-removal.js");
    const fm = new FleetManager(dir);
    const any = fm as unknown as Record<string, any>;
    const instances: Record<string, unknown> = Object.create(null);
    Object.defineProperty(instances, "constructor", { value: { working_directory: dir }, enumerable: true, writable: true, configurable: true });
    instances.x = { working_directory: dir };
    fm.fleetConfig = { instances } as never;
    const w = fm.webPrefs.write(OPERATOR, fm.webPrefs.parsePatch({ "nav.favorites": ["constructor", "x"] }).ok ? new Map([["nav.favorites", ["constructor", "x"]]]) : new Map());
    any.lifecycle = { daemons: new Map(), remove: async () => { fm.fleetConfig = { instances: { x: { working_directory: dir } } } as never; } };
    any.statuslineWatcher = { unwatch() {} };
    await fm.removeInstance("constructor", authorizeExplicitInstanceRemoval("dashboard-confirmed"));
    expect([w.ok, new WebPrefsStore(dir, { exists: () => true }).read().values["nav.favorites"]]).toEqual([true, ["x"]]);
  });
  it("#1677 r1: a ClassicBot room stopped (unregistered) is nobody's favorite any more; one whose name is still an instance keeps it", async () => {
    const outcomes: unknown[] = [];
    for (const stillThere of [false, true]) {
      const dir = tmp();
      vi.stubEnv("AGEND_HOME", dir);
      const { FleetManager } = await import("../src/fleet-manager.js");
      const fm = new FleetManager(dir);
      const any = fm as unknown as Record<string, any>;
      let rooms = [{ instanceName: "classic-ops", channelId: "c1" }, ...(stillThere ? [{ instanceName: "classic-ops", channelId: "c2" }] : [])];
      fm.fleetConfig = { instances: {} } as never;
      any.classicChannels = { getAll: () => rooms, unregister: (id: string) => { const ch = rooms.find((r) => r.channelId === id) ?? null; rooms = rooms.filter((r) => r.channelId !== id); return ch; } };
      any.stopInstance = async () => ({ backgroundWorkEnded: false }); any.reregisterClassicChannels = () => {};
      fm.webPrefs.write(OPERATOR, new Map([["nav.favorites", ["classic-ops"]]]));
      await fm.handleClassicStop("c1");
      const file = new WebPrefsStore(dir, { exists: () => true }).read();
      outcomes.push([stillThere, file.values["nav.favorites"], file.rev]);
    }
    expect(outcomes).toEqual([[false, [], 2], [true, ["classic-ops"], 1]]);
  });

  function route(prefs: WebPrefsStore) {
    const sessions = new WebSessionStore();
    const ctx = { webToken: token, webSessions: sessions, webPrefs: prefs, logger: { info() {}, debug() {}, error() {}, warn() {} },
      sseClients: new Set(), getUiStatus: () => ({ instances: [], prefs_rev: prefs.rev() }), emitSseEvent: vi.fn() } as any;
    const session = (publicLink = false) => {
      const s = sessions.create({ tier: "admin", surface: publicLink ? "gateway" : "local", label: "t", tokenEpoch: tokenEpoch(token), ...(publicLink ? { exposureId } : {}) });
      const call = (method: string, body?: unknown) => new Promise<{ status: number; body: any }>((resolve) => {
        const headers: Record<string, string> = { host: publicLink ? "sample.trycloudflare.com" : "127.0.0.1:19280", cookie: `${publicLink ? "__Host-" : ""}agend_session=${s.sessionId}` };
        if (method === "POST") Object.assign(headers, { origin: publicLink ? pub : local, "sec-fetch-site": "same-origin", "x-agend-csrf": csrfTokenFor(s.sessionId) });
        const req = Object.assign(new EventEmitter(), { method, url: "/ui/prefs", headers, destroy: vi.fn(), socket: { destroy: vi.fn() } });
        if (publicLink) bindGatewayRequest(req as never, { surface: "gateway", exposureId, expectedOrigin: pub, isCurrent: () => true });
        let status = 0;
        const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, setHeader() {}, writeHead: (c: number) => { status = c; }, end: (t = "") => resolve({ status, body: JSON.parse(String(t)) }), destroy: vi.fn() });
        handleWebRequest(req as never, res as never, new URL("/ui/prefs", publicLink ? pub : local), ctx);
        if (body !== undefined) { req.emit("data", Buffer.from(JSON.stringify(body))); req.emit("end"); }
      });
      return { get: () => call("GET"), post: (body: unknown) => call("POST", body) };
    };
    return { session, ctx };
  }
  it("a star made in one session is what another session reads (and the status frame announces it)", async () => {
    const prefs = new WebPrefsStore(tmp(), { exists: (n) => ["alpha", "beta"].includes(n) });
    const r = route(prefs);
    const phone = r.session(), desktop = r.session();
    const w = await phone.post({ set: { "nav.favorites": ["beta", "alpha"] } });
    const seen = await desktop.get();
    expect([w.status, seen.body.values["nav.favorites"], r.ctx.emitSseEvent.mock.calls]).toEqual([200, ["beta", "alpha"], [["status", { instances: [], prefs_rev: 1 }]]]);
  });
  it("the public link reads the favorites but cannot change them; an unknown or __proto__ name is a 400 with nothing written", async () => {
    const prefs = new WebPrefsStore(tmp(), { exists: (n) => Object.hasOwn({ alpha: 1 }, n) });
    prefs.write(OPERATOR, new Map([["nav.favorites", ["alpha"]]]));
    const r = route(prefs);
    const link = r.session(true), signedIn = r.session();
    const out = [
      await link.post({ set: { "nav.favorites": [] } }), await signedIn.post({ set: { "nav.favorites": ["alpha", "ghost"] } }),
      await signedIn.post({ set: { "nav.favorites": ["__proto__"] } }),
    ].map((x) => [x.status, x.body.error]);
    expect([out, (await link.get()).body.values["nav.favorites"], prefs.rev()])
      .toEqual([[[403, "prefs_not_over_public_link"], [400, "unknown_instance: ghost"], [400, "unknown_instance: __proto__"]], ["alpha"], 1]);
  });
});

describe("the sidebar's Favorites", () => {
  const mounted: AppPage[] = [];
  const realFetch = (globalThis as { fetch?: unknown }).fetch;
  let posts: any[] = [];
  let host: Record<string, unknown> = {}, rev = 1;
  let era = 0;   // each test's host view is newer than the last test's (the page module lives for the whole file)
  /** A test's own answer for a write (held, refused); null: the fake host takes it. */
  let postGate: ((body: any) => Promise<any>) | null = null;
  afterEach(async () => {
    for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); }
    (globalThis as { fetch?: unknown }).fetch = realFetch;
    const { setLang } = await import("/assets/app-i18n.js");
    setLang("en");
  });
  const I = (name: string, tags: string[] = ["AgEnD"]) => ({ name, status: "running", backend: "claude-code", tags });
  async function sidebar(instances: Array<Record<string, unknown>>, opts: { favorites?: string[]; publicLink?: boolean } = {}) {
    posts = []; host = opts.favorites ? { "nav.favorites": opts.favorites } : {}; rev = ++era * 1000; postGate = null;
    // Not yet in step with the host (no agend_prefs_synced): the favorites this browser has are the list shown — on a
    // device in step, a key the host does not have would be cleared at load (#1665 r1 P2-4).
    const pg = page({ url: "http://127.0.0.1:19280/ui", storage: { agend_tour_done: "1", ...(opts.favorites ? { agend_favorites: JSON.stringify(opts.favorites) } : {}) } });
    mounted.push(pg);
    // A signed-in page (the server's <html data-prefs>); the module reads it once, on its first import in this file.
    pg.document.documentElement.setAttribute("data-prefs", JSON.stringify({ rev: 1, values: {} }));
    if (opts.publicLink) pg.document.body.setAttribute("data-public-link", "1");
    (globalThis as { fetch?: unknown }).fetch = async (_url: string, init: any = {}) => {
      if (init.method === "POST") {
        const b = JSON.parse(init.body); posts.push(b);
        if (postGate) return postGate(b);
        Object.assign(host, b.set); rev++;
      }
      return { ok: true, status: 200, json: async () => ({ values: { ...host }, rev }) };
    };
    const { startRouter } = await import("/assets/app-nav.js");
    const { applyStatus } = await import("/assets/app-store.js");
    const { Shell } = await import("/assets/app-shell.js");
    const nav = await import("/assets/instance-nav.js");
    // The favorites as the host has them (the real read: the page module takes this test's newer view).
    const prefs = await import("/assets/app-prefs.js");
    await prefs.refresh();
    nav.loadNavPrefs();
    startRouter(pg.window);
    applyStatus({ instances });
    await pg.mount(h(Shell, { panels: new Map(), onNewInstance() {} }));
    return pg;
  }
  const groups = (pg: AppPage) => [...pg.root.querySelectorAll("#instanceList .v-group")].map((g: any) =>
    [g.querySelector(".v-group-head .grow").textContent, [...g.querySelectorAll(".inst-name")].map((n: any) => n.textContent)]);
  // By label (the mini DOM's selectors split on spaces, so not as an attribute selector).
  const byLabel = (pg: AppPage, sel: string, label: string) => ([...pg.root.querySelectorAll(sel)] as any[]).find((b) => b.getAttribute("aria-label") === label) ?? null;
  const star = (pg: AppPage, label: string) => byLabel(pg, "button.inst-star", label);
  const sent = async () => { await new Promise((r) => setTimeout(r, 450)); return posts; };

  it("a Favorites group on top, in starred order; a starred row leaves its group; a deleted favorite is not shown", async () => {
    const pg = await sidebar([I("alpha"), I("beta"), I("gamma", [])], { favorites: ["gamma", "gone", "alpha"] });
    expect(groups(pg)).toEqual([["Favorites", ["gamma", "alpha"]], ["AgEnD", ["beta"]]]);
    expect([star(pg, "Remove gamma from favorites")?.getAttribute("aria-pressed"), star(pg, "Add beta to favorites")?.getAttribute("aria-pressed")]).toEqual(["true", "false"]);
  });
  it("the star adds a row at the end (sent as nav.favorites, without the deleted one) and moves it up; again removes it", async () => {
    const pg = await sidebar([I("alpha"), I("beta"), I("gamma", [])], { favorites: ["gamma", "gone"] });
    fire(star(pg, "Add beta to favorites"), "click"); await settle();
    expect(groups(pg)).toEqual([["Favorites", ["gamma", "beta"]], ["AgEnD", ["alpha"]]]);
    fire(star(pg, "Remove gamma from favorites"), "click"); await settle();
    expect(groups(pg)).toEqual([["Favorites", ["beta"]], ["AgEnD", ["alpha"]], ["Other", ["gamma"]]]);
    // The last write is the list (a burst is usually one write; a slow machine may make it two).
    expect((await sent()).at(-1)).toEqual({ set: { "nav.favorites": ["beta"] } });
  });
  it("Edit: ↑ ↓ reorder the favorites (the ends disabled) and send the order", async () => {
    const pg = await sidebar([I("alpha"), I("beta"), I("gamma")], { favorites: ["alpha", "beta", "gamma"] });
    expect(pg.root.querySelector("button.inst-move")).toBeNull();
    // Its own header class: the sidebar's brand row (.side-head) keeps its layout.
    expect([!!pg.root.querySelector("#instanceList .inst-head > button.fav-edit"), pg.root.querySelectorAll("#instanceList .side-head").length]).toEqual([true, 0]);
    const edit = pg.root.querySelector("button.fav-edit") as any;
    fire(edit, "click"); await settle();
    const move = (label: string) => byLabel(pg, "button.inst-move", label);
    expect([edit.getAttribute("aria-pressed"), move("Move alpha up").disabled, move("Move gamma down").disabled, move("Move beta up").disabled]).toEqual(["true", true, true, false]);
    fire(move("Move gamma up"), "click"); await settle();
    expect(groups(pg)[0]).toEqual(["Favorites", ["alpha", "gamma", "beta"]]);
    expect((await sent()).at(-1)).toEqual({ set: { "nav.favorites": ["alpha", "gamma", "beta"] } });
  });
  it(`full at ${MAX_FAVORITES}: another star is disabled and says why`, async () => {
    const names = Array.from({ length: MAX_FAVORITES + 1 }, (_, i) => `i${String(i).padStart(2, "0")}`);
    const pg = await sidebar(names.map((n) => I(n)), { favorites: names.slice(0, MAX_FAVORITES) });
    const last = star(pg, `Add ${names[MAX_FAVORITES]} to favorites`);
    expect([last.disabled, last.getAttribute("title")]).toEqual([true, `Favorites are full (${MAX_FAVORITES})`]);
    // And the list itself refuses a 51st, whatever calls it (nothing is sent the host would refuse).
    const nav = await import("/assets/instance-nav.js");
    expect([nav.toggleFavorite(names[MAX_FAVORITES], new Set(names)), nav.navStore.get().favorites.length, (await sent()).length]).toEqual([false, MAX_FAVORITES, 0]);
  });
  it(`deleted favorites do not count toward the ${MAX_FAVORITES}`, async () => {
    const gone = Array.from({ length: MAX_FAVORITES }, (_, i) => `gone${i}`);
    const pg = await sidebar([I("alpha")], { favorites: gone });
    expect([groups(pg), star(pg, "Add alpha to favorites").disabled]).toEqual([[["AgEnD", ["alpha"]]], false]);
  });
  it("#1677 r1: in a filtered list Edit's ↑ ↓ are off (as drag is) and say why — the row above may not be the one above", async () => {
    const pg = await sidebar([{ ...I("alpha"), display_name: "Visible A" }, { ...I("hidden"), display_name: "Other" }, { ...I("charlie"), display_name: "Visible C" }],
      { favorites: ["alpha", "hidden", "charlie"] });
    const nav = await import("/assets/instance-nav.js");
    fire(pg.root.querySelector("button.fav-edit") as any, "click");
    nav.setNavFilter({ q: "visible" }); await settle();
    const move = (label: string) => byLabel(pg, "button.inst-move", label);
    const filtered = [groups(pg)[0], move("Move Visible C up").disabled, move("Move Visible C up").getAttribute("title"), move("Move Visible A down").disabled];
    fire(move("Move Visible C up"), "click"); await settle();
    const unchanged = nav.navStore.get().favorites;
    nav.setNavFilter({ q: "" }); await settle();
    expect([filtered, unchanged, move("Move Visible C up").disabled]).toEqual([
      [["Favorites", ["Visible A", "Visible C"]], true, "Clear the filter to reorder favorites", true], ["alpha", "hidden", "charlie"], false]);
    await sent();
  });
  it("#1677 r1: another device's favorites are shown even when this browser's storage refuses to keep them", async () => {
    const pg = await sidebar([I("alpha"), I("charlie")], { favorites: ["alpha"] });
    const ls = (globalThis as any).localStorage;
    const quota = () => { throw Object.assign(new Error("full"), { name: "QuotaExceededError" }); };
    const saved = { set: ls.setItem, remove: ls.removeItem };
    ls.setItem = quota; ls.removeItem = quota;
    try {
      host = { "nav.favorites": ["charlie"] }; rev += 1;
      const prefs = await import("/assets/app-prefs.js");
      expect(await prefs.refresh()).toBe(true);
      await settle();
      expect([groups(pg)[0], pg.storage.get("agend_favorites")]).toEqual([["Favorites", ["charlie"]], '["alpha"]']);
    } finally { ls.setItem = saved.set; ls.removeItem = saved.remove; }
  });
  it("#1677 r2: when this page's write ends, the sidebar shows the host's newest list — even when storage refused the change and its old copy equals the host", async () => {
    const outcomes: unknown[] = [];
    for (const [ending, blocked] of [["held", true], ["held", false], ["refused", true], ["refused", false]] as const) {
      const pg = await sidebar([I("alpha"), I("charlie")], { favorites: ["alpha"] });
      const ls = (globalThis as any).localStorage;
      const saved = { set: ls.setItem, remove: ls.removeItem };
      const quota = () => { throw Object.assign(new Error("full"), { name: "QuotaExceededError" }); };
      if (blocked) { ls.setItem = quota; ls.removeItem = quota; }
      try {
        let release!: (r: unknown) => void;
        const committedRev = rev + 1;
        postGate = ending === "held"
          ? () => new Promise((r) => { release = r; })     // committed on the host (rev+1), its answer held
          : () => Promise.resolve({ ok: false, status: 403, json: async () => ({ error: "prefs_read_only" }) });
        fire(star(pg, "Remove alpha from favorites"), "click"); await settle();
        await new Promise((r) => setTimeout(r, 450));       // the write is out
        const during = groups(pg)[0]?.[0] === "Favorites" ? groups(pg)[0][1] : [];
        if (ending === "held") {
          host = { "nav.favorites": ["alpha"] }; rev = committedRev + 5;   // another device put alpha back, newer
          const prefs = await import("/assets/app-prefs.js");
          await prefs.refresh(); await settle();
          const whileOut = groups(pg)[0]?.[0] === "Favorites" ? groups(pg)[0][1] : [];
          release({ ok: true, status: 200, json: async () => ({ values: { "nav.favorites": [] }, rev: committedRev }) });
          for (let i = 0; i < 30; i++) await Promise.resolve();
          await settle();
          outcomes.push([ending, blocked, during, whileOut, groups(pg)[0]]);
        } else {
          for (let i = 0; i < 30; i++) await Promise.resolve();
          await settle();
          outcomes.push([ending, blocked, during, groups(pg)[0]]);
        }
      } finally { ls.setItem = saved.set; ls.removeItem = saved.remove; postGate = null; }
      const p = mounted.pop()!; await p.unmount(); p.restore();
    }
    expect(outcomes).toEqual([
      ["held", true, [], [], ["Favorites", ["alpha"]]], ["held", false, [], [], ["Favorites", ["alpha"]]],
      // Refused: by the end of the burst the refusal and the read back are done — alpha is shown again.
      ["refused", true, ["alpha"], ["Favorites", ["alpha"]]], ["refused", false, ["alpha"], ["Favorites", ["alpha"]]],
    ]);
  });
  it("#1677 r2: with storage refusing, another device's change back to what the old copy holds is still shown", async () => {
    const pg = await sidebar([I("alpha"), I("charlie")], { favorites: ["alpha"] });
    const ls = (globalThis as any).localStorage;
    const saved = { set: ls.setItem, remove: ls.removeItem };
    const quota = () => { throw Object.assign(new Error("full"), { name: "QuotaExceededError" }); };
    ls.setItem = quota; ls.removeItem = quota;
    try {
      const prefs = await import("/assets/app-prefs.js");
      host = { "nav.favorites": ["charlie"] }; rev += 1;
      await prefs.refresh(); await settle();
      const first = groups(pg)[0];
      host = { "nav.favorites": ["alpha"] }; rev += 1;       // back to what this browser's (stuck) copy still holds
      await prefs.refresh(); await settle();
      expect([first, groups(pg)[0], pg.storage.get("agend_favorites")]).toEqual([["Favorites", ["charlie"]], ["Favorites", ["alpha"]], '["alpha"]']);
    } finally { ls.setItem = saved.set; ls.removeItem = saved.remove; }
  });
  it("the public link sees the favorites but has no star and no Edit", async () => {
    const pg = await sidebar([I("alpha"), I("beta")], { favorites: ["beta"], publicLink: true });
    expect([groups(pg), pg.root.querySelectorAll("button.inst-star").length, pg.root.querySelector("button.fav-edit")]).toEqual([[["Favorites", ["beta"]], ["AgEnD", ["alpha"]]], 0, null]);
  });
  it("zh-TW: the heading and the star's label", async () => {
    const pg = await sidebar([I("alpha"), I("beta")], { favorites: ["beta"] });
    const { setLang } = await import("/assets/app-i18n.js");
    setLang("zh-TW"); await settle();
    expect([groups(pg)[0][0], !!star(pg, "把 alpha 加入最愛"), !!star(pg, "把 beta 從最愛移除")]).toEqual(["最愛", true, true]);
  });
  it("another device's star shows up here at its next status frame", async () => {
    const pg = await sidebar([I("alpha"), I("beta")], { favorites: [] });
    host = { "nav.favorites": ["alpha"] }; rev += 1;
    const prefs = await import("/assets/app-prefs.js");
    await prefs.refresh(); await settle();
    expect(groups(pg)).toEqual([["Favorites", ["alpha"]], ["AgEnD", ["beta"]]]);
  });
});
