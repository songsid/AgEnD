/**
 * #2554: the Office view's All offices — every stored office as a tile on one canvas, each drawn as its own view would be.
 * - The pure part (fleet-office-overview.js): offered with two or more offices; the lobby (whoever is in no office);
 *   the tiles' layout (cells of a zones scene's size under a label band, a tile keeping its scene's aspect and never
 *   scaled up, the column count that shows largest in the panel, rows as tall as their tallest tile, the stored
 *   order); a point → its tile, its label, the tile's own units and back; the tiles on screen (the rest not drawn);
 *   traffic between tiles: a straight flight between the two seats in overview units, none when one tile holds both.
 * - The store: the lobby tile on by default, kept per device.
 * - On the page: the switcher offers All offices only with two or more offices (kept as the office pick); each tile
 *   is drawn in its office's own style with its own members (a pack loaded once for every tile using it); a lobby
 *   tile (toggle); hover and click hit people across tiles; a tile's label (or a double-click on the tile) opens that
 *   office; tiles off screen are not drawn; reduced motion draws each change at once; the view is kept under its own
 *   key; Edit offices and Edit layout wait.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire, MiniElement } from "./helpers/mini-dom.js";

const FIXTURE = join(process.cwd(), "tests", "fixtures", "office-skin-clinic");
const MANIFEST = () => JSON.parse(readFileSync(join(FIXTURE, "manifest.json"), "utf8"));
const FILES = { "office_bg.png": "a".repeat(32), "fox_idle.png": "b".repeat(32) };
const INSTANCES = [
  { name: "atlas", display_name: "Atlas", status: "running", backend: "claude-code" },
  { name: "quill", status: "running", backend: "kiro-cli" },
  { name: "sage", status: "paused", backend: "grok" },
  { name: "loner", status: "running", backend: "codex" },
];
const ORG = { general: ["atlas"], teams: [{ name: "Web", members: ["quill", "sage"] }], instances: {} };
const STORE = { ready: true, instances: INSTANCES, exec: { quill: "working" }, awaiting: {}, needs: [] };
const STAGE = { w: 960, h: 600 };
const TWO = [{ id: "front", name: "Front desk", skin: "studio", members: ["atlas"] }, { id: "lab", name: "Lab", skin: "studio", members: ["quill"] }];

let p: AppPage;
let O: any, F: any, M: any, V: any, CV: any, Z: any, K: any, S: any, TR: any, app: any, nav: any, fleet: any, org: any;
let offices: any = { rev: 0, offices: [] }, skins: any = { rev: "", packs: [] }, manifestAnswer: any = null, trafficAnswer: any = null;
const fetched: string[] = [];
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  (globalThis as any).fetch = async (url: string, o: any = {}) => {
    fetched.push(url);
    if (url === "/ui/offices" && o.method === "PUT") return { ok: true, status: 200, json: async () => offices };
    if (url.startsWith("/ui/office-skins/")) return manifestAnswer ? { ok: true, status: 200, json: async () => manifestAnswer } : { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (url === "/ui/org" ? ORG : url === "/ui/offices" ? offices : url === "/ui/office-skins" ? skins : url === "/ui/traffic" && trafficAnswer ? trafficAnswer : {}) };
  };
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  nav.startRouter(p.window);
  fleet = await import("/ui/js/panel-fleet.js");
  org = await import("/ui/js/fleet-org.js");
  O = await import("/ui/js/fleet-office-overview.js");
  F = await import("/ui/js/fleet-office.js");
  M = await import("/ui/js/fleet-office-model.js");
  V = await import("/ui/js/fleet-office-view.js");
  CV = await import("/ui/js/fleet-canvas-view.js");
  Z = await import("/ui/js/fleet-office-zones.js");
  K = await import("/ui/js/fleet-office-skin.js");
  S = await import("/ui/js/fleet-office-store.js");
  TR = await import("/ui/js/fleet-traffic.js");
});
afterAll(async () => { await p.unmount(); p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  p.storage.clear();
  offices = { rev: 0, offices: [] }; skins = { rev: "", packs: [] }; manifestAnswer = null; trafficAnswer = null; fetched.length = 0;
  nav.navigate("/ui/fleet/org");
  app.appStore.set(STORE);
});
const view = () => org.buildOrgView(ORG, app.appStore.get());
const zone = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `z${i}`, w: 1280, h: 720 }));

describe("All offices: the pure part (fleet-office-overview.js)", () => {
  it("offered with two or more stored offices; its id is none an office can have; the lobby is whoever is in no office", () => {
    expect([O.overviewOk([]), O.overviewOk([TWO[0]]), O.overviewOk(TWO), O.overviewOk(null)]).toEqual([false, false, true, false]);
    expect(M.officeOk({ id: O.ALL_ID, name: "x" })).toBeNull();
    expect(O.lobbyNodes(TWO.map((o) => M.officeOk(o)), view()).map((n: any) => n.name)).toEqual(["sage", "loner"]);
    // A team counts; an office with no members holds everyone: nobody is left for the lobby.
    expect(O.lobbyNodes([M.officeOk({ id: "w", members: ["team:Web"] })], view()).map((n: any) => n.name)).toEqual(["atlas", "loner"]);
    expect(O.lobbyNodes([M.officeOk({ id: "all", members: [] }), M.officeOk(TWO[0])], view())).toEqual([]);
  });
  it("a desks office is as large as its rooms: cropped to them (no margins, no corridors outside), everything moved with it", () => {
    const L = M.autoLayout([{ key: "o", name: "O", lobby: false, nodes: view().teams[0].nodes }], { width: 1280 });
    expect(L.width).toBe(L.rooms[0].x + L.rooms[0].w + M.OF.M);           // as laid out: its room's width and the margin (#2585 B)
    const C = O.cropToRooms(L), r = L.rooms[0];
    expect([C.width, C.height, C.rooms[0].x, C.rooms[0].y]).toEqual([r.w, r.h, 0, 0]);
    expect(C.rooms[0].desks.map((d: any) => [d.x, d.y, d.seat.x, d.seat.y])).toEqual(r.desks.map((d: any) => [d.x - r.x, d.y - r.y, d.seat.x - r.x, d.seat.y - r.y]));
    // The corridors outside the room now lie outside the tile (its clip hides them); a walk inside it is the same walk.
    expect(C.waypoints.filter((w: any) => w.x < 0 || w.y > C.height).length).toBeGreaterThan(0);
    const xy = (pts: any[]) => pts.map((q: any) => [q.x, q.y]);
    expect(xy(M.walkPath(C, "quill", "sage"))).toEqual(xy(M.walkPath(L, "quill", "sage")).map(([x, y]) => [x - r.x, y - r.y]));
    expect(O.cropToRooms({ rooms: [], waypoints: [], width: 5, height: 5 })).toEqual({ rooms: [], waypoints: [], width: 5, height: 5 });
  });
  it("the tiles: shelves in stored order up to a row width; a tile scaled down to a 1280×720 cell (never up); rows as tall as their tallest, centred across", () => {
    const four = O.arrangeTiles(zone(4), 2584);
    expect([four.rows, four.width, four.height]).toEqual([2, 24 + 2584 + 24, 24 + 56 + 720 + 24 + 56 + 720 + 24]);
    expect(four.tiles.map((t: any) => [t.key, t.x, t.y, t.w, t.h, t.s])).toEqual([["z0", 24, 80, 1280, 720, 1], ["z1", 1328, 80, 1280, 720, 1],
      ["z2", 24, 880, 1280, 720, 1], ["z3", 1328, 880, 1280, 720, 1]]);
    expect(four.tiles[1].label).toEqual({ x: 1328, y: 24, w: 1280, h: 56 });
    // A tall office: half size (1280×1440 → 640×720); a small one its own size; the narrower row centred under the wider.
    const mixed = O.arrangeTiles([{ key: "tall", w: 1280, h: 1440 }, { key: "small", w: 640, h: 300 }, { key: "next", w: 1280, h: 720 }], 1304);
    expect(mixed.tiles.map((t: any) => [t.key, t.x, t.y, t.w, t.h, t.s])).toEqual([["tall", 24, 80, 640, 720, 0.5], ["small", 688, 80, 640, 300, 1], ["next", 36, 880, 1280, 720, 1]]);
    const short = O.arrangeTiles([{ key: "a", w: 1280, h: 200 }, { key: "b", w: 1280, h: 300 }, { key: "c", w: 1280, h: 720 }], 2584);
    expect(short.tiles[2].y).toBe(24 + 56 + 300 + 24 + 56);                // the first row is only as tall as its 300
    expect(O.arrangeTiles(zone(2), 100).rows).toBe(2);                     // wider than the row: a row of its own
    expect(O.arrangeTiles([], 0)).toEqual({ rows: 0, rowW: 0, tiles: [], width: 48, height: 48 });
  });
  it("the row width: the one that shows the whole overview largest in the panel (a tie: narrower); the stored order kept", () => {
    const rows = (sc: any[], size: any) => O.tileLayout(sc, size).rows;
    expect([rows(zone(4), STAGE), rows(zone(3), STAGE), rows(zone(2), { w: 1000, h: 1000 }), rows(zone(2), { w: 2000, h: 500 }), rows(zone(8), { w: 1920, h: 1080 }), rows(zone(1), STAGE)])
      .toEqual([2, 2, 2, 1, 3, 1]);
    expect(O.tileLayout(zone(5), STAGE).tiles.map((t: any) => t.key)).toEqual(["z0", "z1", "z2", "z3", "z4"]);
    expect(O.tileLayout(zone(5), STAGE)).toEqual(O.tileLayout(zone(5), STAGE));   // the same input, the same picture
    // Seven small desks offices (1–3 people) fill a desktop panel: several to a row, not one each.
    const desk = (n: number) => { const L = O.cropToRooms(M.autoLayout([{ key: "d", name: "d", lobby: false, nodes: view().top.concat(view().teams[0].nodes).slice(0, n) }], { width: 1280 })); return { w: L.width, h: L.height }; };
    const seven = [1, 2, 3, 1, 2, 3, 1].map((n, i) => ({ key: `d${i}`, ...desk(n) })), big = { w: 1240, h: 716 }, lay = O.tileLayout(seven, big);
    expect(lay.rows).toBeLessThanOrEqual(3);
    expect(Math.min(big.w / lay.width, big.h / lay.height)).toBeGreaterThan(1);   // shown larger than life, where 1280-wide tiles were ~0.5
    // The pick is the best fit: no other run width shows it larger.
    for (const size of [STAGE, { w: 390, h: 700 }, { w: 2560, h: 1000 }]) for (const sc of [zone(2), zone(5), zone(8), seven]) {
      const k = (a: any) => Math.min(size.w / a.width, size.h / a.height), best = O.tileLayout(sc, size);
      for (const rowW of [0, 500, 1280, 1304, 2000, 2584, 3888, 9999]) expect(k(O.arrangeTiles(sc, rowW))).toBeLessThanOrEqual(k(best) + 1e-9);
    }
  });
  it("a point → its tile (the scene, not the gap), its label band, the tile's own units and back", () => {
    const lay = O.arrangeTiles([{ key: "tall", w: 1280, h: 1440 }, { key: "z", w: 1280, h: 720 }], 1944), [tall, z] = lay.tiles;
    expect(O.tileAt(lay, 400, 200)?.key).toBe("tall");
    expect(O.tileAt(lay, 676, 200)).toBeNull();                            // the gap
    expect(O.tileAt(lay, 400, 820)).toBeNull();                            // under the tile
    expect(O.labelAt(lay, 700, 40)?.key).toBe("z");
    expect(O.labelAt(lay, 700, 200)).toBeNull();
    expect(O.inTile(tall, 24 + 100, 80 + 50)).toEqual({ x: 200, y: 100 });
    expect(O.fromTile(tall, { x: 200, y: 100 })).toEqual({ x: 124, y: 130 });
    expect(O.tileBox(z, { x: 10, y: 20, w: 30, h: 40 })).toEqual({ x: 698, y: 100, w: 30, h: 40 });
  });
  it("culling: only the tiles a view shows any of", () => {
    const lay = O.arrangeTiles(zone(4), 2584);
    const fit = V.fitScene(lay.width, lay.height, STAGE);
    expect(O.visibleTiles(lay, fit, STAGE).map((t: any) => t.key)).toEqual(["z0", "z1", "z2", "z3"]);
    const close = CV.centreOn({ k: 2, x: 0, y: 0 }, STAGE, 400, 400);    // 2× on the first tile's middle
    expect(O.visibleTiles(lay, close, STAGE).map((t: any) => t.key)).toEqual(["z0"]);
    const corner = CV.centreOn({ k: 1, x: 0, y: 0 }, STAGE, 1316, 840); // the gaps' crossing: a bit of each
    expect(O.visibleTiles(lay, corner, STAGE).map((t: any) => t.key)).toEqual(["z0", "z1", "z2", "z3"]);
    expect(O.visibleTiles(lay, { k: 1, x: -5000, y: 0 }, STAGE)).toEqual([]);
  });
  it("traffic between tiles: a straight flight between the two seats in overview units; one tile holding both carries it itself; reduced motion and stale ones fly nothing", () => {
    const nodes = (names: string[]) => names.map((name) => ({ name, state: "idle", i: { name } }));
    const zl = (names: string[]) => Z.zonesLayout(K.STUDIO_PACK, nodes(names));
    const lay = O.arrangeTiles(zone(3), 2584), parts = [{ tile: lay.tiles[0], L: zl(["atlas"]) }, { tile: lay.tiles[1], L: zl(["quill", "sage"]) }, { tile: lay.tiles[2], L: zl(["sage"]) }];
    const a = parts[0].L.seats.get("atlas"), q = parts[1].L.seats.get("quill");
    expect(O.crossPath(parts, "atlas", "quill")).toEqual([{ x: 24 + a.x, y: 80 + a.y }, { x: 1328 + q.x, y: 80 + q.y }]);
    expect(O.crossPath(parts, "quill", "sage")).toBeNull();                // the lab's own
    expect(O.crossPath(parts, "atlas", "nobody")).toBeNull();
    // sage is in two tiles: the first that holds them.
    expect(O.crossPath(parts, "atlas", "sage")?.[1]).toEqual({ x: 1328 + parts[1].L.seats.get("sage").x, y: 80 + parts[1].L.seats.get("sage").y });
    const f = O.createCrossFlights();
    const items = [{ id: "m1", kind: "send", from: "atlas", to: "quill", phase: "sent" }, { id: "m2", kind: "send", from: "quill", to: "sage", phase: "sent" },
      { id: "t1", kind: "task", from: "atlas", to: "quill", phase: "stale" }];
    expect(f.sync(items, 1000)).toBe(2);
    expect(f.sync(items, 1000)).toBe(0);                                   // each item once
    const mid = f.frame(1000 + 1, parts);
    expect(mid.map((x: any) => x.id)).toEqual(["m1"]);                     // m2 stays in its tile: dropped here
    expect(mid[0].hue).toBe(TR.hue("send"));
    expect(f.size()).toBe(1);
    const len = Math.hypot(1328 + q.x - 24 - a.x, q.y - a.y), ms = Math.min(M.FLIGHT.MAX_MS, Math.max(M.FLIGHT.MIN_MS, len / M.FLIGHT.SPEED));
    const half = f.frame(1000 + ms / 2, parts)[0];
    expect(half.x).toBeCloseTo((24 + a.x + 1328 + q.x) / 2, 6);
    expect(half.y).toBeCloseTo(80 + (a.y + q.y) / 2, 6);
    expect(f.frame(1000 + ms + 1, parts)).toEqual([]);
    expect(f.size()).toBe(0);
    const still = O.createCrossFlights();
    expect(still.sync([{ id: "m3", kind: "send", from: "atlas", to: "quill", phase: "sent" }], 0, true)).toBe(0);
  });
  it("the store: the lobby tile on by default, kept per device", () => {
    const s = S.createOfficeStore({});
    expect(s.lobbyTile()).toBe(true);
    s.saveLobbyTile(false);
    expect([s.lobbyTile(), localStorage.getItem("agend_org_office_lobby")]).toEqual([false, "0"]);
    s.saveLobbyTile(true);
    expect(s.lobbyTile()).toBe(true);
  });
  it("its words in both languages", async () => {
    const I = await import("/assets/app-i18n.js");
    I.setLang("zh-TW", { store: false });
    try { expect([I.t("orgo.allOffices"), I.t("orgo.tileLabel", "實驗室", 3)]).toEqual(["所有辦公室", "實驗室（3）"]); }
    finally { I.setLang("en", { store: false }); }
    expect([I.t("orgo.allOffices"), I.t("orgo.tileLabel", "Lab", 3), I.t("orgo.openOffice", "Lab")]).toEqual(["All offices", "Lab (3)", "Open the office Lab"]);
  });
});

function fakeCtx() {
  const calls: Array<[string, any[], any?]> = [];
  const t: any = { calls, measureText: (s: string) => ({ width: [...String(s)].length * 6 }), createPattern: () => ({ pattern: true }),
    getImageData: (_x: number, _y: number, w: number, hh: number) => ({ data: new Uint8ClampedArray(w * hh * 4) }) };
  return new Proxy(t, { get(o, k) { if (k in o) return o[k]; return (...a: unknown[]) => { calls.push([String(k), a, k === "fillRect" ? o.fillStyle : undefined]); }; }, set(o, k, v) { o[k] = v; return true; } });
}

describe("All offices on the page", () => {
  const proto = MiniElement.prototype as any;
  beforeEach(() => { proto.getContext = function () { return (this._ctx ??= fakeCtx()); }; });
  afterEach(() => { delete proto.getContext; delete (globalThis as any).AgendAuth; delete (p.window as any).AgendAuth; });
  const mount = async () => { await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: `fleet:org|${Math.random()}|en` })); await settle(6); };
  const office = async () => { await mount(); p.root.querySelectorAll(".oc-tools .seg-inline button")[2].click(); await settle(6); };
  const sw = () => p.root.querySelector(".oo-office");
  const options = () => sw().querySelectorAll("option").map((o: any) => [o.getAttribute("value") ?? o.value, o.textContent.trim()]);
  const shown = () => { const r = p.root.querySelector(".oo-mini-view"); const [k, x, y] = ["data-k", "data-x", "data-y"].map((a) => Number(r.getAttribute(a))); return { k, x, y }; };
  const labels = () => p.root.querySelectorAll(".oo-tile-label").map((b: any) => b.textContent.trim());
  const lastFrame = () => { const c = p.root.querySelector(".oo-canvas")._ctx.calls; return c.slice(c.map(([k]: any) => k).lastIndexOf("clearRect")); };
  const choose = async (v: string) => { const s = sw(); s.value = v; fire(s, "change"); await settle(6); };
  /** The overview's layout as the page makes it for `n` zones tiles (each 1280×720). */
  const zonesLay = (n: number) => O.tileLayout(zone(n), STAGE);

  it("the switcher: All offices only with two or more offices; picked, it is kept per device; with fewer it is the whole fleet", async () => {
    offices = { rev: 1, offices: [TWO[0]] };
    await office();
    expect(options().map(([, t]: any) => t)).toEqual(["Whole fleet", "Front desk"]);
    await p.unmount();
    offices = { rev: 2, offices: TWO };
    await office();
    expect(options()).toEqual([["auto", "Whole fleet"], ["*all", "All offices"], ["front", "Front desk"], ["lab", "Lab"]]);
    expect(p.root.querySelectorAll(".oo-tile-label")).toHaveLength(0);
    await choose("*all");
    expect([sw().value, localStorage.getItem("agend_org_office")]).toEqual(["*all", "*all"]);
    expect(labels()).toEqual(["Front desk (1)", "Lab (1)", "Lobby (2)"]);
    expect(p.root.querySelector(".oo-canvas").getAttribute("aria-label")).toContain("All offices");
    // The whole fleet's own pickers (style, team, people) are not there; the lobby toggle is.
    expect([p.root.querySelectorAll(".oo-bar select").length, p.root.querySelector(".oo-people"), !!p.root.querySelector(".oo-lobby-tile input")]).toEqual([1, null, true]);
    await p.unmount(); await office();
    expect([sw().value, labels().length]).toEqual(["*all", 3]);
    // An office deleted meanwhile, one left: the whole fleet (as an office gone is), All offices no longer offered.
    await p.unmount();
    offices = { rev: 3, offices: [TWO[1]] };
    await office();
    expect([sw().value, options().map(([, t]: any) => t), labels()]).toEqual(["auto", ["Whole fleet", "Lab"], []]);
  });
  it("each tile its office's own style and members: a pack's people in its tile only, the pack loaded once for every tile using it", async () => {
    const was = (globalThis as any).Image;
    (globalThis as any).Image = class { onload: any = null; onerror: any = null; u = ""; set src(u: string) { this.u = u; setTimeout(() => this.onload && this.onload(), 0); } };
    try {
      skins = { rev: "r", packs: [{ id: "clinic-sample", name: "Clinic", sha: "7".repeat(32) }] }; manifestAnswer = { manifest: MANIFEST(), files: FILES };
      offices = { rev: 2, offices: [{ id: "front", name: "Front desk", skin: "pixel", members: ["atlas"] }, { id: "lab", name: "Lab", skin: "clinic-sample", members: ["quill", "sage"] },
        { id: "ward", name: "Ward", skin: "clinic-sample", members: ["loner"] }] };
      localStorage.setItem("agend_org_office", "*all");
      await office(); await settle(6);
      expect(labels()).toEqual(["Front desk (1)", "Lab (2)", "Ward (1)"]);   // everyone is in an office: no lobby
      expect(fetched.filter((u) => u.startsWith("/ui/office-skins/clinic-sample"))).toHaveLength(1);
      const frame = lastFrame(), clips = frame.map((c: any, i: number) => (c[0] === "clip" ? i : -1)).filter((i: number) => i >= 0);
      expect(clips).toHaveLength(3);                                        // every tile on screen at the opening fit
      const fox = frame.map((c: any, i: number) => (c[0] === "drawImage" && String(c[1][0]?.u).endsWith(`/img/${"b".repeat(32)}.png`) ? i : -1)).filter((i: number) => i >= 0);
      // The clinic's fox strip draws its people — two in the Lab's tile, one in the Ward's — and nobody in the Desks tile.
      expect(fox.filter((i: number) => i > clips[0] && i < clips[1])).toHaveLength(0);
      expect(fox.filter((i: number) => i > clips[1] && i < clips[2])).toHaveLength(2);
      expect(fox.filter((i: number) => i > clips[2])).toHaveLength(1);
      // The Desks tile is the office as its own view lays it out (one room, its desks at a cell's width), scaled to fit.
      const desksL = O.cropToRooms(M.autoLayout([{ key: "front", name: "Front desk", lobby: false, nodes: view().top }], { width: 1280 }));
      const lay = O.tileLayout([{ key: "front", w: desksL.width, h: desksL.height }, ...zone(2)], STAGE), v = shown();
      expect(p.root.querySelector(".oo-mini").getAttribute("viewBox")).toBe(`0 0 ${lay.width} ${lay.height}`);
      const r0 = frame[clips[0] - 1];                                        // the clip's rect: the tile on screen
      expect(r0[0]).toBe("rect");
      expect(r0[1][0]).toBe(Math.round(v.x + lay.tiles[0].x * v.k));
      expect(r0[1][2]).toBeCloseTo(lay.tiles[0].w * v.k, 6);
      expect(p.root.querySelectorAll(".oo-desk").map((d: any) => d.getAttribute("data-key"))).toEqual(["front\u0001front/atlas", "lab\u0001zone/quill", "lab\u0001zone/sage", "ward\u0001zone/loner"]);
    } finally { (globalThis as any).Image = was; }
  });
  it("#2564: mail is its office's own — a letter waiting in one office is not carried to another when the page switches", async () => {
    const was = (globalThis as any).Image;
    (globalThis as any).Image = class { onload: any = null; onerror: any = null; u = ""; set src(u: string) { this.u = u; setTimeout(() => this.onload && this.onload(), 0); } };
    const on: Record<string, (x: any) => void> = {};
    try {
      const m = MANIFEST();
      m.props = { send: { src: "env.png", frames: 1, w: 16, h: 16 } };
      skins = { rev: "r", packs: [{ id: "clinic-sample", name: "Clinic", sha: "a".repeat(32) }] };   // its own sha: packs are kept per id and sha
      manifestAnswer = { manifest: m, files: { ...FILES, "env.png": "d".repeat(32) } };
      offices = { rev: 2, offices: [{ id: "front", name: "Front desk", skin: "clinic-sample", members: ["atlas"] }, { id: "lab", name: "Lab", skin: "clinic-sample", members: ["atlas", "quill"] }] };
      app.appStore.set({ ...STORE, streamOn: (name: string, cb: (x: any) => void) => { on[name] = cb; return () => {}; } });
      localStorage.setItem("agend_org_office", "front");
      await office(); await settle(8);
      const envelope = () => lastFrame().some((c: any) => c[0] === "drawImage" && String(c[1][0]?.u).endsWith(`/img/${"d".repeat(32)}.png`));
      on.traffic({ id: "e".repeat(16), from: "sage", to: "atlas", kind: "send", state: "delivering" });   // sage is in no office
      await settle(4); await new Promise((r) => setTimeout(r, 1300)); await settle(4);
      expect(envelope()).toBe(true);                                          // landed in the Front desk, waiting for atlas
      await choose("lab"); await settle(4); await new Promise((r) => setTimeout(r, 300)); await settle(4);
      expect(envelope()).toBe(false);                                         // the Lab (atlas there too) has none of it
    } finally { (globalThis as any).Image = was; }
  });
  it("#2562: an item flying between tiles is its sender's own (their set's prop, from their tile's pack), at that tile's scale", async () => {
    const was = (globalThis as any).Image;
    (globalThis as any).Image = class { onload: any = null; onerror: any = null; u = ""; set src(u: string) { this.u = u; setTimeout(() => this.onload && this.onload(), 0); } };
    try {
      const m = MANIFEST();
      m.characters.fox = { ...m.characters.fox, prop: { src: "scissors.png", frames: 1, w: 16, h: 16 } };
      m.byInstance = { atlas: "fox" };
      skins = { rev: "r", packs: [{ id: "clinic-sample", name: "Clinic", sha: "8".repeat(32) }] };   // its own sha: packs are kept per id and sha
      manifestAnswer = { manifest: m, files: { ...FILES, "scissors.png": "c".repeat(32) } };
      offices = { rev: 2, offices: [{ id: "front", name: "Front desk", skin: "clinic-sample", members: ["atlas"] }, { id: "lab", name: "Lab", skin: "clinic-sample", members: ["quill"] }] };
      trafficAnswer = { now: new Date().toISOString(), items: [{ id: "a".repeat(16), from: "atlas", to: "quill", kind: "send", state: "delivering" }], delegations: [] };
      localStorage.setItem("agend_org_office", "*all"); localStorage.setItem("agend_org_office_lobby", "0");
      await office(); await settle(8);
      const calls = p.root.querySelector(".oo-canvas")._ctx.calls;
      const scissors = calls.map((c: any, i: number) => (c[0] === "drawImage" && String(c[1][0]?.u).endsWith(`/img/${"c".repeat(32)}.png`) ? i : -1)).filter((i: number) => i >= 0);
      expect(scissors.length).toBeGreaterThan(0);                           // atlas's scissors, not the built-in envelope
      // Drawn under the sender's tile's scale (the overview's × the tile's), after the last tile's frame.
      const set = calls.slice(0, scissors[0]).reverse().find((c: any) => c[0] === "setTransform");
      const v = shown(), lay = zonesLay(2);
      expect(set[1][0]).toBeCloseTo(v.k * lay.tiles[0].s, 6);
    } finally { (globalThis as any).Image = was; }
  });
  it("#2574: a furniture item's label is a name tag under it, like a person's; one without a label gets none", async () => {
    const was = (globalThis as any).Image;
    (globalThis as any).Image = class { onload: any = null; onerror: any = null; u = ""; set src(u: string) { this.u = u; setTimeout(() => this.onload && this.onload(), 0); } };
    try {
      const m = MANIFEST();
      m.furniture = [{ id: "keeper", sprite: { src: "fox_idle.png", frames: 1, w: 32, h: 48 }, x: 900, y: 400, depth: "y", label: "Shopkeeper" },
        { id: "lamp", sprite: { src: "fox_idle.png", frames: 1, w: 32, h: 48 }, x: 1100, y: 200 }];
      skins = { rev: "r", packs: [{ id: "clinic-sample", name: "Clinic", sha: "9".repeat(32) }] };   // its own sha: packs are kept per id and sha
      manifestAnswer = { manifest: m, files: FILES };
      offices = { rev: 2, offices: [{ id: "front", name: "Front desk", skin: "clinic-sample", members: ["atlas"] }, { id: "lab", name: "Lab", skin: "pixel", members: ["quill"] }] };
      localStorage.setItem("agend_org_office", "front");
      await office(); await settle(8);
      const texts = lastFrame().filter(([k]: any) => k === "fillText").map(([, a]: any) => a);
      expect(texts.filter((a: any) => a[0] === "Shopkeeper").map((a: any) => [a[1], a[2]])).toEqual([[900, 410.5]]);   // at its anchor, as a person's tag
      expect(texts.some((a: any) => a[0] === "lamp")).toBe(false);
    } finally { (globalThis as any).Image = was; }
  });
  it("the lobby tile: whoever is in no office, in the whole fleet's style; off by its toggle (kept)", async () => {
    offices = { rev: 2, offices: TWO };
    localStorage.setItem("agend_org_office", "*all");
    await office();
    expect(labels()).toEqual(["Front desk (1)", "Lab (1)", "Lobby (2)"]);
    const lobby = p.root.querySelectorAll(".oo-tile-label")[2];
    expect([lobby.tagName.toLowerCase(), lobby.className]).toEqual(["span", "oo-tile-label lobby"]);   // no office to open
    expect(p.root.querySelectorAll(".oo-desk").map((d: any) => d.getAttribute("data-name"))).toEqual(["atlas", "quill", "sage", "loner"]);
    expect(p.root.querySelectorAll(".oo-mini-room")).toHaveLength(3);
    fire(p.root.querySelector(".oo-lobby-tile input"), "change"); await settle(4);
    expect([labels(), localStorage.getItem("agend_org_office_lobby")]).toEqual([["Front desk (1)", "Lab (1)"], "0"]);
    expect(p.root.querySelectorAll(".oo-desk").map((d: any) => d.getAttribute("data-name"))).toEqual(["atlas", "quill"]);
    await p.unmount(); await office();
    expect(labels()).toHaveLength(2);
  });
  it("hover and click hit people across tiles, through the view: the card names the office; a click opens the chat", async () => {
    offices = { rev: 2, offices: TWO };
    localStorage.setItem("agend_org_office", "*all"); localStorage.setItem("agend_org_office_lobby", "0");
    await office();
    const lay = zonesLay(2), v = shown(), cv = p.root.querySelector(".oo-canvas");
    expect(v.k).toBeCloseTo(V.fitScene(lay.width, lay.height, STAGE, "contain", 60).k, 9);   // it opens whole, clear of the controls
    const at = (tile: any, name: string, state: string) => {
      const seat = Z.zonesLayout(K.STUDIO_PACK, [{ name, state, i: { name } }]).seats.get(name);
      return CV.toScreen(v, ...Object.values(O.fromTile(tile, { x: seat.x, y: seat.y - 20 })) as [number, number]);
    };
    const q = at(lay.tiles[1], "quill", "working"), a = at(lay.tiles[0], "atlas", "idle");
    fire(cv, "pointermove", { clientX: q.x, clientY: q.y, pointerType: "mouse" }); await settle(2);
    expect([p.root.querySelector(".oo-tip strong")?.textContent, p.root.querySelector(".oo-tip-office")?.textContent]).toEqual(["quill", "Lab"]);
    fire(cv, "pointermove", { clientX: a.x, clientY: a.y, pointerType: "mouse" }); await settle(2);
    expect([p.root.querySelector(".oo-tip strong")?.textContent, p.root.querySelector(".oo-tip-office")?.textContent]).toEqual(["Atlas", "Front desk"]);
    // The same point in the other tile's units is nobody here: a tile's people are hit in their own tile only.
    const gap = CV.toScreen(v, lay.tiles[1].x - 24, lay.tiles[1].y + 100);
    fire(cv, "pointermove", { clientX: gap.x, clientY: gap.y, pointerType: "mouse" }); await settle(2);
    expect(p.root.querySelector(".oo-tip")).toBeNull();
    fire(cv, "click", { clientX: q.x, clientY: q.y }); await settle(2);
    expect(location.pathname).toBe("/ui/chat/quill");
  });
  it("a tile's label opens that office (kept as the pick); a double-click on a tile's empty floor too; the lobby opens nothing", async () => {
    offices = { rev: 2, offices: TWO };
    localStorage.setItem("agend_org_office", "*all");
    await office();
    const lab = p.root.querySelector('.oo-tile-label[data-office="lab"]');
    expect([lab.tagName.toLowerCase(), lab.getAttribute("aria-label")]).toEqual(["button", "Open the office Lab"]);
    // Placed just above its tile, wherever the view puts it.
    // The lobby tile (sage, loner) is Desks here, the whole fleet's default style: one room wrapping at a cell's width.
    const v = shown(), lobbyL = O.cropToRooms(M.autoLayout([{ key: O.LOBBY_TILE, name: null, lobby: true, nodes: O.lobbyNodes(TWO.map((o) => M.officeOk(o)), view()) }], { width: 1280 }));
    const lay = O.tileLayout([...zone(2), { key: "lobby", w: lobbyL.width, h: lobbyL.height }], STAGE);
    expect(parseFloat(lab.style.left)).toBeCloseTo(v.x + lay.tiles[1].x * v.k, 6);
    expect(parseFloat(lab.style.top)).toBeCloseTo(v.y + lay.tiles[1].y * v.k, 6);
    lab.click(); await settle(6);
    expect([sw().value, localStorage.getItem("agend_org_office"), labels()]).toEqual(["lab", "lab", []]);
    await choose("*all");
    const v2 = shown(), floor = CV.toScreen(v2, lay.tiles[0].x + 6, lay.tiles[0].y + 6);
    fire(p.root.querySelector(".oo-canvas"), "dblclick", { clientX: floor.x, clientY: floor.y }); await settle(6);
    expect(sw().value).toBe("front");
    await choose("*all");
    const v3 = shown(), lob = CV.toScreen(v3, lay.tiles[2].x + 6, lay.tiles[2].y + 6);
    fire(p.root.querySelector(".oo-canvas"), "dblclick", { clientX: lob.x, clientY: lob.y }); await settle(6);
    expect(sw().value).toBe("*all");
  });
  it("tiles off screen are not drawn: zoomed onto one tile, one is; the view is kept under All offices' own key", async () => {
    offices = { rev: 2, offices: TWO };
    localStorage.setItem("agend_org_office", "*all"); localStorage.setItem("agend_org_office_lobby", "0");
    localStorage.setItem("agend_org_office_view", JSON.stringify({ "*all@tiles": [2, 400, 400] }));
    await office();
    const lay = zonesLay(2), v = shown();
    expect([v.k, v.x, v.y]).toEqual([2, 480 - 800, 300 - 800]);
    expect(O.visibleTiles(lay, v, STAGE).map((t: any) => t.key)).toEqual(["z0"]);
    const frame = lastFrame();
    expect(frame.filter(([k]: any) => k === "clip")).toHaveLength(1);
    // Fit: both again; kept (as a fit) under its key.
    fire(p.root.querySelector(".oo-canvas"), "keydown", { key: "0" }); await settle(4);
    expect(lastFrame().filter(([k]: any) => k === "clip")).toHaveLength(2);
    await p.unmount();
    expect(JSON.parse(localStorage.getItem("agend_org_office_view")!)["*all@tiles"][3]).toBe(1);
  });
  it("too small to read (under TAG_MIN_K): a tile's name tags are left out, the hovered one's drawn; bubbles after every tile, whole", async () => {
    const made: any[] = [];
    proto.getContext = function () { return (this._ctx ??= (made.push(fakeCtx()), made[made.length - 1])); };
    app.appStore.set({ ...STORE, awaiting: { atlas: "a prompt" } });          // atlas calls: always a bubble
    const desks = [{ id: "front", name: "Front desk", skin: "pixel", members: ["atlas"] }, { id: "lab", name: "Lab", skin: "pixel", members: ["quill"] }];
    offices = { rev: 2, offices: desks };
    const L = (o: any) => O.cropToRooms(M.autoLayout([{ key: o.id, name: o.name, lobby: false, nodes: M.membersOf(M.officeOk(o), view()) }], { width: 1280 }));
    const lay = O.tileLayout(desks.map((o) => ({ key: o.id, w: L(o).width, h: L(o).height })), STAGE);
    localStorage.setItem("agend_org_office", "*all"); localStorage.setItem("agend_org_office_lobby", "0");
    localStorage.setItem("agend_org_office_view", JSON.stringify({ "*all@tiles": [0.5, lay.width / 2, lay.height / 2] }));
    await office();
    const v = shown();
    expect(v.k).toBe(0.5);
    expect(v.k * lay.tiles[0].s).toBeLessThan(F.TAG_MIN_K);
    const words = (c: any) => c.calls.filter(([k]: any) => k === "fillText").map(([, a]: any) => a[0]);
    expect(made.flatMap(words)).not.toContain("Atlas");                    // no tag in any layer, nor on the canvas
    const main = p.root.querySelector(".oo-canvas")._ctx, frame = lastFrame();
    // The calling bubble: after the last tile is drawn (its clip restored), so a tile's edge never cuts it.
    const said = frame.map((c: any, i: number) => (c[0] === "fillText" && ["Need you!", "A question for you", "Over here!"].some((l) => l.startsWith(c[1][0]) && c[1][0]) ? i : -1)).filter((i: number) => i >= 0);
    expect(said.length).toBeGreaterThan(0);
    const lastTile = lay.tiles[lay.tiles.length - 1], fx = Math.round(v.x + lastTile.x * v.k) - 0.5;
    const framed = frame.findIndex((c: any) => c[0] === "strokeRect" && c[1][0] === fx);   // the last tile's frame: drawn after it
    expect(framed).toBeGreaterThan(0);
    expect(Math.min(...said)).toBeGreaterThan(framed);
    const d = M.desksOf(L(desks[0]))[0], at = CV.toScreen(v, ...Object.values(O.fromTile(lay.tiles[0], { x: d.x + 40, y: d.y + 40 })) as [number, number]);
    fire(p.root.querySelector(".oo-canvas"), "pointermove", { clientX: at.x, clientY: at.y, pointerType: "mouse" }); await settle(4);
    expect(p.root.querySelector(".oo-tip strong")?.textContent).toBe("Atlas");
    expect(words({ calls: lastFrame() })).toContain("Atlas");               // hovered: its tag
    expect(main).toBe(p.root.querySelector(".oo-canvas")._ctx);
    // Zoomed in past it: the tags are in the layers again.
    made.length = 0;
    for (let i = 0; i < 2; i++) { fire(p.root.querySelector(".oo-canvas"), "keydown", { key: "+" }); await settle(3); }
    expect(shown().k * lay.tiles[0].s).toBeGreaterThanOrEqual(F.TAG_MIN_K);
    expect(made.flatMap(words)).toContain("quill");
  });
  it("a tile's label is hidden while its tile is off screen; the lobby toggle waits, saying why, when everyone is in an office", async () => {
    offices = { rev: 2, offices: TWO };
    localStorage.setItem("agend_org_office", "*all"); localStorage.setItem("agend_org_office_lobby", "0");
    localStorage.setItem("agend_org_office_view", JSON.stringify({ "*all@tiles": [2, 400, 400] }));
    await office();
    const vis = (id: string) => p.root.querySelector(`.oo-tile-label[data-office="${id}"]`).style.visibility;
    expect([vis("front"), vis("lab")]).toEqual(["visible", "hidden"]);
    expect(p.root.querySelector(".oo-lobby-tile input").disabled).toBe(false);
    await p.unmount();
    offices = { rev: 3, offices: [...TWO, { id: "rest", name: "Rest", members: ["sage", "loner"] }] };
    await office();
    const box = p.root.querySelector(".oo-lobby-tile input");
    expect([box.disabled, box.checked, p.root.querySelector(".oo-lobby-none")?.textContent, p.root.querySelector(".oo-lobby-tile").getAttribute("title")])
      .toEqual([true, false, "Everyone is in an office", "Everyone is in an office"]);
    expect(labels()).toEqual(["Front desk (1)", "Lab (1)", "Rest (2)"]);
  });
  it("reduced motion: the tiles are drawn at once on a change (no loop), nothing in the air", async () => {
    const real = (globalThis as any).matchMedia;
    (globalThis as any).matchMedia = (q: string) => ({ matches: /reduce/.test(q), addEventListener() {}, removeEventListener() {} });
    try {
      offices = { rev: 2, offices: TWO };
      localStorage.setItem("agend_org_office", "*all"); localStorage.setItem("agend_org_office_lobby", "0");
      await office();
      const ctx = p.root.querySelector(".oo-canvas")._ctx, before = ctx.calls.length;
      fire(p.root.querySelector(".oo-canvas"), "keydown", { key: "+" });   // drawn in the handler, before any frame
      expect(ctx.calls.length).toBeGreaterThan(before);
      expect(lastFrame().filter(([k]: any) => k === "clip").length).toBeGreaterThan(0);
    } finally { (globalThis as any).matchMedia = real; }
  });
  it("Edit offices and Edit layout wait for a single office (disabled, with why)", async () => {
    const auth = { canWrite: async () => true }; (globalThis as any).AgendAuth = auth; (p.window as any).AgendAuth = auth;
    offices = { rev: 2, offices: TWO };
    localStorage.setItem("agend_org_office", "*all");
    await office(); await settle(4);
    const edit = p.root.querySelector(".oo-edit");
    expect([edit.disabled, edit.getAttribute("title"), p.root.querySelector(".oo-layout")]).toEqual([true, "Pick one office to edit offices or a layout", null]);
    edit.click(); await settle(2);
    expect(p.root.querySelector(".oe-form")).toBeNull();
    await choose("lab");
    expect([p.root.querySelector(".oo-edit").disabled, !!p.root.querySelector(".oo-layout")]).toEqual([false, true]);
  });
  it("the stylesheet: a tile's label floats above its tile, placed by the page; the stage clips (never scrolls its controls away)", () => {
    const css = readFileSync(join(process.cwd(), "src/ui/shared/app.css"), "utf8");
    expect(css).toContain(".oo-stage { overflow: clip; }");
    const rule = css.slice(css.indexOf(".oo-tile-label {"), css.indexOf("}", css.indexOf(".oo-tile-label {")));
    expect(rule).toContain("position: absolute");
    expect(rule).toContain("translateY(calc(-100% - 4px))");
  });
});
