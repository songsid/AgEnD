/**
 * Fleet → Org chart → Office (src/ui/fleet-office*.js): the fleet as a pixel office, the third view beside Canvas and List.
 * - Poses come from the org chart's states (fleet-org.js ORG_STATES); coats from the identity colour a person chose,
 *   else the backend.
 * - The auto layout: the lobby (General, no team) then a room per team; desks inside their room; rows wrap at the
 *   stage's width (a phone's too); the same input gives the same picture; a corridor graph joins every desk.
 * - Walking: BFS on the waypoint graph, from the nearest waypoints of two seats; a straight line when there is no way.
 * - Traffic: an item per new message / delegation / report, flown once, from desk to desk; none for a stale one or with
 *   reduced motion; gone when it lands or its desks are not drawn.
 * - Who is shown: a team, the lobby or pinned people; the stored offices are checked defensively; the store keeps this
 *   browser's choices and reads the host's offices.
 * - The skin seam: the built-in pixel skin draws every pose; a skin pack's manifest is checked and drawn from its strips.
 * - On the page: an Office button beside Canvas and List (kept per device); desks open the chat; the filter is kept.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire, MiniElement } from "./helpers/mini-dom.js";

const INSTANCES = [
  { name: "atlas", display_name: "Atlas", status: "running", backend: "claude-code" },
  { name: "pixel", display_name: "Comet", status: "running", backend: "codex" },
  { name: "quill", status: "running", backend: "kiro-cli" },
  { name: "sage", status: "paused", backend: "grok" },
  { name: "orbit", status: "running", backend: "opencode" },
  { name: "nova", status: "stopped", backend: "codex" },
  { name: "tide", status: "crashed", backend: "claude-code" },
  { name: "loner", status: "running", backend: "codex" },
];
const ORG = {
  general: ["atlas"],
  teams: [{ name: "Platform", members: ["pixel", "quill", "sage", "orbit"] }, { name: "Web", members: ["nova", "tide"] }, { name: "Empty", members: [] }],
  instances: {},
};
const STORE = { ready: true, instances: INSTANCES, exec: { quill: "working", orbit: "stuck" }, awaiting: { pixel: "a prompt" }, needs: [] };

let p: AppPage;
let M: any, S: any, K: any, O: any, app: any, fleet: any, nav: any, TR: any, PK: any, Z: any;
let offices: unknown = { rev: 0, offices: [] };
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  (globalThis as any).fetch = async (url: string) => ({ ok: true, status: 200, json: async () => (url === "/ui/org" ? ORG : url === "/ui/offices" ? offices : {}) });
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  nav.startRouter(p.window);
  fleet = await import("/ui/js/panel-fleet.js");
  O = await import("/ui/js/fleet-org.js");
  M = await import("/ui/js/fleet-office-model.js");
  S = await import("/ui/js/fleet-office-store.js");
  K = await import("/ui/js/fleet-office-skin.js");
  PK = await import("/ui/js/fleet-office-pack.js");
  Z = await import("/ui/js/fleet-office-zones.js");
  TR = await import("/ui/js/fleet-traffic.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  p.storage.clear();
  offices = { rev: 0, offices: [] };
  nav.navigate("/ui/fleet/org");
  app.appStore.set(STORE);
});
const view = () => O.buildOrgView(ORG, app.appStore.get());
const id16 = (n: number) => n.toString(16).padStart(16, "0");

describe("poses and coats", () => {
  it("every org chart state has a pose: needs you, crashed and stuck call; paused and stopped sleep; starting sits, queued dozes; missing is an empty desk", async () => {
    expect(O.ORG_STATES.map((s: string) => [s, M.officePose(s)])).toEqual([["needs", "needs"], ["crashed", "needs"], ["stuck", "needs"], ["starting", "idle"], ["queued", "paused"], ["working", "working"],
      ["idle", "idle"], ["paused", "paused"], ["stopped", "paused"], ["missing", "away"]]);
    expect(O.ORG_STATES.map(M.lightOf)).toEqual(["warn", "danger", "warn", null, null, null, null, null, null, null]);
    expect(O.ORG_STATES.filter(M.signOf)).toEqual(["paused", "stopped"]);
    expect(O.ORG_STATES.filter(M.lampOf)).toEqual(["working"]);
    // #2398's startup states share a pose but say their own words (a queued instance is not asleep).
    const F = await import("/ui/js/fleet-office.js");
    expect(["starting", "queued", "paused", "idle"].map((s) => F.caption(M.officePose(s), s))).toEqual(["Just arriving", "Waiting to start", "Asleep", "Tea break"]);
    // From the app store, as the canvas reads it.
    const states = Object.fromEntries([...view().top, ...view().teams.flatMap((t: any) => t.nodes)].map((n: any) => [n.name, M.officePose(n.state)]));
    expect(states).toEqual({ atlas: "idle", pixel: "needs", quill: "working", sage: "paused", orbit: "needs", nova: "paused", tide: "needs" });
  });
  it("a frame strip loops at its fps; still (0 ms) is its first frame", () => {
    expect([0, 249, 250, 999, 1000].map((ms) => M.frameAt(ms, 4, 4))).toEqual([0, 0, 1, 3, 0]);
    expect(M.frameAt(5000, 1, 4)).toBe(0);
  });
  it("the coat: a person's identity colour, else the backend's (the automatic colour is everyone's)", () => {
    expect(M.coatOf({ backend: "codex" }, { source: "auto", dark: "#111111", light: "#222222" })).toBe(M.COATS.codex);
    expect(M.coatOf({ backend: "codex" }, { source: "person", dark: "#111111", light: "#222222" }, "light")).toBe("#222222");
    expect(M.coatOf({ backend: "codex" }, { source: "person", off: true, dark: "#111111" })).toBe(M.COATS.codex);
    expect([M.coatOf({ backend: "kiro-cli" }), M.coatOf({ backend: "grok" }), M.coatOf({ backend: "opencode" }), M.coatOf(null)])
      .toEqual([M.COATS["kiro-cli"], M.COATS.grok, M.COATS.other, M.COATS.other]);
  });
});

describe("the auto layout", () => {
  const L = (width = 960, filter?: unknown) => M.autoLayout(M.officeRooms(view(), filter), { width });
  it("the lobby (General, then no team) first, then the teams in order; a desk per member inside its room", () => {
    const l = L();
    expect(l.rooms.map((r: any) => [r.name, r.lobby, r.desks.map((d: any) => d.node.name)])).toEqual([[null, true, ["atlas", "loner"]],
      ["Platform", false, ["pixel", "quill", "sage", "orbit"]], ["Web", false, ["nova", "tide"]], ["Empty", false, []]]);
    for (const r of l.rooms) for (const d of r.desks) expect(d.x >= r.x && d.y >= r.y + M.OF.HEAD && d.x + d.w <= r.x + r.w && d.y + d.h <= r.y + r.h, d.key).toBe(true);
    expect(M.autoLayout(M.officeRooms(view()), { width: 960 })).toEqual(l);                       // the same input, the same picture
  });
  it("rows wrap at the width; a phone's width fits every room (no room wider than the stage)", () => {
    for (const w of [1400, 960, 360]) {
      const l = L(w);
      for (const r of l.rooms) expect(r.x + r.w, `${w}: ${r.name}`).toBeLessThanOrEqual(w - M.OF.M);
      // #2585 B: as wide as its rooms (its widest row and the margin), not the stage: a narrower scene is centred in it.
      expect(l.width).toBe(Math.max(...l.rooms.map((r: any) => r.x + r.w)) + M.OF.M);
      expect(l.width).toBeLessThanOrEqual(w);
    }
    expect(new Set(L(1400).rooms.map((r: any) => r.y)).size).toBeLessThan(new Set(L(360).rooms.map((r: any) => r.y)).size);
    // Rooms never overlap.
    const rs = L(700).rooms;
    for (const a of rs) for (const b of rs) if (a !== b) expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.name}/${b.name}`).toBe(true);
  });
  it("a big fleet: 70 instances in a few teams lay out in well under a frame", () => {
    const nodes = Array.from({ length: 70 }, (_, i) => ({ name: `m${i}`, state: "idle", i: { name: `m${i}` } }));
    const big = { top: [], rest: { nodes: [] }, teams: Array.from({ length: 7 }, (_, k) => ({ name: `T${k}`, nodes: nodes.slice(k * 10, k * 10 + 10) })) };
    const t0 = performance.now();
    const l = M.autoLayout(M.officeRooms(big), { width: 1280 });
    expect(performance.now() - t0).toBeLessThan(50);
    expect(M.desksOf(l)).toHaveLength(70);
  });
  it("deskAt finds the desk under a point, nothing between them", () => {
    const l = L(), d = l.rooms[1].desks[2];
    expect(M.deskAt(l, d.x + 5, d.y + 5).key).toBe(d.key);
    expect(M.deskAt(l, 1, 1)).toBeNull();
  });
});

describe("walking: the corridor graph", () => {
  it("every waypoint is joined to every other (one connected graph); every desk has its aisle", () => {
    const l = M.autoLayout(M.officeRooms(view()), { width: 600 });
    const ids = l.waypoints.map((w: any) => w.id);
    for (const id of ids) expect(M.bfsPath(l.edges, ids[0], id), id).not.toBeNull();
    for (const d of M.desksOf(l)) expect(ids).toContain(d.wp);
  });
  it("bfsPath: the fewest hops; null when there is no way", () => {
    const edges = [["a", "b"], ["b", "c"], ["c", "d"], ["a", "x"], ["x", "d"], ["p", "q"]];
    expect(M.bfsPath(edges, "a", "d")).toEqual(["a", "x", "d"]);
    expect(M.bfsPath(edges, "a", "a")).toEqual(["a"]);
    expect(M.bfsPath(edges, "a", "q")).toBeNull();
    expect(M.bfsPath(edges, "a", "nowhere")).toBeNull();
  });
  it("walkPath: seat → aisles and corridors → seat; out of the room by its door, never through another room", () => {
    const l = M.autoLayout(M.officeRooms(view()), { width: 960 });
    const pts = M.walkPath(l, "atlas", "tide");
    const atlas = M.desksOf(l).find((d: any) => d.node.name === "atlas"), tide = M.desksOf(l).find((d: any) => d.node.name === "tide");
    expect([pts[0], pts.at(-1)]).toEqual([atlas.seat, tide.seat]);
    expect(pts.length).toBeGreaterThan(4);
    // Every segment is horizontal or vertical (corridors), except the seat ↔ aisle ends.
    for (let i = 2; i < pts.length - 1; i++) expect(pts[i].x === pts[i - 1].x || pts[i].y === pts[i - 1].y, `${i}`).toBe(true);
    // The way between them stays out of the other rooms' desks.
    const others = M.desksOf(l).filter((d: any) => d !== atlas && d !== tide);
    for (const q of pts.slice(1, -1)) for (const d of others) expect(q.x > d.x && q.x < d.x + d.w && q.y > d.y && q.y < d.y + d.h - 2 * M.OF.AISLE, `${d.key}`).toBe(false);
    expect(M.walkPath(l, "atlas", "nobody")).toBeNull();
  });
  it("no way through the graph: a straight line; the nearest waypoint when a seat names none", () => {
    const l = { rooms: [{ desks: [{ node: { name: "a" }, seat: { x: 0, y: 0 }, wp: null, x: 0, y: 0, w: 1, h: 1 }, { node: { name: "b" }, seat: { x: 100, y: 0 }, wp: null, x: 0, y: 0, w: 1, h: 1 }] }],
      waypoints: [{ id: "w1", x: 1, y: 5 }, { id: "w2", x: 99, y: 5 }], edges: [] as string[][] };
    expect(M.walkPath(l, "a", "b")).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    l.edges.push(["w1", "w2"]);
    expect(M.walkPath(l, "a", "b")).toEqual([{ x: 0, y: 0 }, { id: "w1", x: 1, y: 5 }, { id: "w2", x: 99, y: 5 }, { x: 100, y: 0 }]);
    expect(M.along([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 0.75)).toEqual({ x: 10, y: 5 });
  });
});

describe("traffic: items carried desk to desk", () => {
  const L = () => M.autoLayout(M.officeRooms(view()), { width: 960 });
  const item = (n: number, o: Record<string, unknown> = {}) => ({ id: id16(n), from: "atlas", to: "quill", kind: "task", state: "delivering", fading: false, ...o });
  it("each new item flies once, in its kind's hue (the canvas's legend), staggered; it lands and goes", () => {
    const f = M.createFlights(), l = L();
    expect(f.sync([item(1), item(2, { kind: "report" }), item(3, { kind: "broadcast" }), item(4, { kind: "query" }), item(5, { kind: "update" })], 1000)).toBe(5);
    expect(f.sync([item(1)], 1100)).toBe(0);                                     // seen: never again
    const up = f.frame(1000, l);
    expect(up.map((x: any) => x.hue)).toEqual(["task"]);                         // the others start after it
    expect(f.frame(1000 + 4 * M.FLIGHT.STAGGER_MS, l).map((x: any) => x.hue)).toEqual(["task", "report", "broadcast", "send", "send"]);
    expect([TR.hue("task"), TR.hue("query"), TR.hue("update"), TR.hue("send")]).toEqual(["task", "send", "send", "send"]);
    expect(f.frame(1000 + M.FLIGHT.MAX_MS + 1000, l)).toEqual([]);
    expect(f.size()).toBe(0);
  });
  it("moves from the sender's seat toward the receiver's", () => {
    const f = M.createFlights(), l = L();
    f.sync([item(9)], 0);
    const a = f.frame(0, l)[0], b = f.frame(400, l)[0];
    const seat = (n: string) => M.desksOf(l).find((d: any) => d.node.name === n).seat;
    expect([a.x, a.y]).toEqual([seat("atlas").x, seat("atlas").y]);
    expect(b.t).toBeGreaterThan(a.t);
  });
  it("a delegation's work, its report back: each flies; a stale one (no report) and reduced motion fly nothing", () => {
    const f = M.createFlights(), l = L();
    expect(f.sync([{ id: `w${id16(1)}`, from: "atlas", to: "quill", kind: "task", phase: "work" }, { id: `r${id16(1)}`, from: "quill", to: "atlas", kind: "report", phase: "return" },
      { id: `w${id16(2)}`, from: "atlas", to: "quill", kind: "task", phase: "stale" }], 0)).toBe(2);
    const g = M.createFlights();
    expect(g.sync([item(1)], 0, true)).toBe(0);
    expect(g.frame(0, l)).toEqual([]);
    expect([...M.workOn([{ to: "quill", phase: "work" }, { to: "quill", phase: "work" }, { to: "sage", phase: "return" }])]).toEqual([["quill", 2]]);
  });
  it("a trip whose desks are not drawn (filtered away) goes; at most MAX are in the air", () => {
    const f = M.createFlights({ max: 3 }), shown = M.autoLayout(M.officeRooms(view(), { team: "Web" }), { width: 960 });
    f.sync([item(1)], 0);
    expect(f.frame(10, shown)).toEqual([]);
    expect(f.size()).toBe(0);
    f.sync([1, 2, 3, 4, 5].map((n) => item(10 + n)), 0);
    expect(f.size()).toBe(3);
  });
});

describe("who is shown: the auto office's filter", () => {
  const names = (f: unknown) => M.officeRooms(view(), f).map((r: any) => [r.key === M.LOBBY ? "lobby" : r.key, r.nodes.map((n: any) => n.name)]);
  it("all; one team; the lobby; a team no longer defined is all", () => {
    expect(names(undefined).map((r: any) => r[0])).toEqual(["lobby", "Platform", "Web", "Empty"]);
    expect(names({ team: "Web" })).toEqual([["Web", ["nova", "tide"]]]);
    expect(names({ team: M.LOBBY })).toEqual([["lobby", ["atlas", "loner"]]]);
    expect(names({ team: "Gone" }).map((r: any) => r[0])).toEqual(["lobby", "Platform", "Web", "Empty"]);
  });
  it("pinned people: only them, in their rooms; with a team, those of them in it", () => {
    expect(names({ pinned: ["tide", "atlas", "quill"] })).toEqual([["lobby", ["atlas"]], ["Platform", ["quill"]], ["Web", ["tide"]]]);
    expect(names({ team: "Platform", pinned: ["tide", "quill"] })).toEqual([["Platform", ["quill"]]]);
    expect(names({ team: "Web", pinned: ["quill"] })).toEqual([]);
  });
  it("filterOk: what was stored, checked (anything odd is dropped)", () => {
    expect(M.filterOk(null)).toEqual({ team: "", pinned: [] });
    expect(M.filterOk({ team: 3, pinned: ["a", "a", 7, "", "b"] })).toEqual({ team: "", pinned: ["a", "b"] });
    expect(M.filterOk({ team: "x".repeat(201) }).team).toBe("");
    expect(M.filterOk({ pinned: Array.from({ length: 900 }, (_, i) => `n${i}`) }).pinned).toHaveLength(500);
  });
});

describe("the offices model (the host's list, checked again on the page)", () => {
  const layout = { seats: [{ id: "s1", x: 100, y: 100, instance: "tide" }, { id: "s2", x: 220, y: 100 }, { id: "s3", x: 340, y: 100 }],
    waypoints: [{ id: "w1", x: 100, y: 160 }, { id: "w2", x: 340, y: 160 }], edges: [["w1", "w2"], ["w1", "zz"], ["w1", "w1"]] };
  it("backingScale: the device's ratio for an ordinary canvas; an accepted far-out layout gets a bitmap a browser paints (#2431 review)", () => {
    expect([M.backingScale(1366, 900, 3), M.backingScale(958, 539, 2), M.backingScale(1300, 8000, 1)]).toEqual([3, 2, 1]);
    const o = M.officesOk([{ id: "far", name: "Far", layout: { seats: [{ id: "s", x: 10000, y: 10000 }], waypoints: [], edges: [] } }])[0];
    const L = M.customLayout(o, []), W = Math.ceil(L.width), H = Math.ceil(L.height);
    expect(W).toBeGreaterThan(10000);                                                       // accepted, and huge
    for (const dpr of [1, 2, 3]) {
      const b = M.backingScale(W, H, dpr), bw = Math.floor(W * b), bh = Math.floor(H * b);
      expect(bw).toBeLessThanOrEqual(M.CANVAS_MAX.side); expect(bh).toBeLessThanOrEqual(M.CANVAS_MAX.side);
      expect(bw * bh).toBeLessThanOrEqual(M.CANVAS_MAX.area); expect(bw * bh).toBeGreaterThan(M.CANVAS_MAX.area * 0.9);   // drawn, as fine as allowed
    }
    const max = M.officesOk([{ id: "max", name: "Max", layout: { seats: [{ id: "s", x: 20000, y: 20000 }], waypoints: [], edges: [] } }])[0];
    const L2 = M.customLayout(max, []);
    const b2 = M.backingScale(Math.ceil(L2.width), Math.ceil(L2.height), 3);
    expect(Math.floor(Math.ceil(L2.width) * b2) * Math.floor(Math.ceil(L2.height) * b2)).toBeLessThanOrEqual(M.CANVAS_MAX.area);
  });
  it("officesOk: valid ones kept, ids unique, the auto office's id refused; odd fields dropped or defaulted", () => {
    const list = M.officesOk([{ id: "ops", name: "  Ops room ", members: ["tide", 3], layout, extra: 1 }, { id: "ops", name: "dup" }, { id: "auto", name: "x" },
      { id: "bad id", name: "x" }, null, "x", { id: "two", skin: "../evil" }]);
    expect(list.map((o: any) => [o.id, o.name, o.skin, o.members])).toEqual([["ops", "Ops room", "pixel", ["tide"]], ["two", "two", "pixel", []]]);
    expect(list[0].layout.edges).toEqual([["w1", "w2"]]);
    expect(M.layoutOk({ seats: [{ id: "a", x: -1, y: 0 }, { id: "b", x: 1e9, y: 0 }, { id: "c", x: NaN, y: 0 }] })).toBeNull();
    expect(M.officesOk({ not: "a list" })).toEqual([]);
    expect(M.officesOk(Array.from({ length: 30 }, (_, i) => ({ id: `o${i}`, name: "x" })))).toHaveLength(20);
  });
  it("membersOf: names and team:<name>, in order, once; none means everyone", () => {
    const v = view();
    expect(M.membersOf({ members: ["tide", "team:Platform", "quill", "ghost"] }, v).map((n: any) => n.name)).toEqual(["tide", "pixel", "quill", "sage", "orbit"]);
    expect(M.membersOf({ members: [] }, v)).toHaveLength(INSTANCES.length);
  });
  it("customLayout: an assigned seat holds its person; the rest take free seats in order; who found none is counted", () => {
    const o = M.officesOk([{ id: "ops", name: "Ops", members: ["quill", "tide", "sage", "nova"], layout }])[0];
    const l = M.customLayout(o, M.membersOf(o, view()));
    expect(l.rooms[0].desks.map((d: any) => [d.key, d.node && d.node.name])).toEqual([["ops/s1", "tide"], ["ops/s2", "quill"], ["ops/s3", "sage"]]);
    expect(l.unseated).toBe(1);
    expect(M.walkPath(l, "tide", "sage")).toHaveLength(4);                       // seat, w1, w2, seat (the nearest waypoints)
  });
});

describe("the store: this browser's choices, the host's offices", () => {
  it("choice and filter per browser; blocked storage keeps the page working", async () => {
    const m = new Map<string, string>(), storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
    const s = S.createOfficeStore({ storage, fetch: async () => ({ ok: false }) });
    expect([s.choice(), s.filter()]).toEqual(["auto", { team: "", pinned: [] }]);
    s.saveChoice("ops"); s.saveFilter({ team: "Web", pinned: ["tide", 4] });
    expect([m.get("agend_org_office"), JSON.parse(m.get("agend_org_office_filter")!)]).toEqual(["ops", { team: "Web", pinned: ["tide"] }]);
    const t = S.createOfficeStore({ storage });
    expect([t.choice(), t.filter()]).toEqual(["ops", { team: "Web", pinned: ["tide"] }]);
    m.set("agend_org_office_filter", "{not json");
    expect(t.filter()).toEqual({ team: "", pinned: [] });
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const b = S.createOfficeStore({ storage: blocked });
    expect(() => { b.saveChoice("x"); b.saveFilter({}); }).not.toThrow();
    expect([b.choice(), b.filter()]).toEqual(["auto", { team: "", pinned: [] }]);
  });
  it("offices(): GET /ui/offices, checked; a failed read is null; saveOffices PUTs the list and the rev", async () => {
    const calls: any[] = [];
    const answer = (status: number, body: unknown) => async (path: string, o: any) => { calls.push([path, o.method, o.body && JSON.parse(o.body)]); return { ok: status === 200, status, json: async () => body }; };
    expect(await S.createOfficeStore({ fetch: answer(200, { rev: 4, offices: [{ id: "ops", name: "Ops" }, { id: "auto" }] }) }).offices()).toEqual({ rev: 4, offices: [{ id: "ops", name: "Ops", skin: "pixel", members: [], layout: null }] });
    expect(await S.createOfficeStore({ fetch: answer(503, {}) }).offices()).toBeNull();
    expect(await S.createOfficeStore({ fetch: async () => { throw new Error("offline"); } }).offices()).toBeNull();
    expect(await S.createOfficeStore({ fetch: answer(409, { error: "offices_changed" }) }).saveOffices([{ id: "a", name: "A" }], 3)).toEqual({ ok: false, status: 409, error: "offices_changed" });
    expect(calls.at(-1)).toEqual(["/ui/offices", "PUT", { offices: [{ id: "a", name: "A" }], rev: 3 }]);
    // Office review: no save without the rev that was read — never sent.
    const before = calls.length;
    expect(await S.createOfficeStore({ fetch: answer(200, {}) }).saveOffices([{ id: "a", name: "A" }])).toEqual({ ok: false, status: 0, error: "offices_rev_required" });
    expect(calls.length).toBe(before);
  });
});

/** A 2D context that records what is drawn (the mini DOM has no canvas). */
function fakeCtx() {
  const calls: Array<[string, unknown[]]> = [];
  const t: any = { calls, measureText: (s: string) => ({ width: [...String(s)].length * 6 }), createPattern: () => ({ pattern: true }) };
  return new Proxy(t, { get(o, k) { if (k in o) return o[k]; return (...a: unknown[]) => { calls.push([String(k), a]); }; }, set(o, k, v) { o[k] = v; return true; } });
}
const env: any = { pal: null, mode: "dark", labels: { lobby: "Lobby", closed: "Closed" } };

describe("the skin seam", () => {
  const desk = { key: "T/a", node: { name: "a" }, x: 0, y: 0, w: 96, h: 104, seat: { x: 48, y: 40 } };
  const look = (o: Record<string, unknown> = {}) => ({ name: "a", label: "a", pose: "idle", light: null, lamp: false, sign: null, coat: "#123456", work: 0, dim: false, match: false, ...o });
  it("the pixel skin draws every pose and its props without throwing; away draws no one; the lamp and sign are drawn", () => {
    const e = { ...env, pal: K.DEFAULT_PAL };
    for (const pose of [...M.POSES, "away"]) for (const ms of [0, 300, 900]) {
      const c = fakeCtx();
      K.pixelSkin.drawCharacter(c, desk, look({ pose, light: pose === "needs" ? "danger" : null }), ms, e);
      expect(c.calls.length > 0, `${pose} ${ms}`).toBe(pose !== "away");
    }
    const lit = fakeCtx(); K.pixelSkin.drawDeskBack(lit, desk, look({ lamp: true }), e);
    const dark = fakeCtx(); K.pixelSkin.drawDeskBack(dark, desk, look(), e);
    expect(lit.calls.filter(([k]: any) => k === "fill").length).toBeGreaterThan(dark.calls.filter(([k]: any) => k === "fill").length);   // the light cone
    const front = fakeCtx(); K.pixelSkin.drawDeskFront(front, desk, look({ sign: "closed", label: "a very long name that cannot fit on the tag", work: 2 }), e);
    const texts = front.calls.filter(([k]: any) => k === "fillText").map(([, a]: any) => a[0]);
    expect(texts[0]).toMatch(/^Clos/);                                          // the sign (this fake measures every glyph 6 px wide)
    expect(texts[1].endsWith("…")).toBe(true);
    for (const hue of ["task", "send", "report", "broadcast"]) { const c = fakeCtx(); K.pixelSkin.drawProp(c, { hue, kind: hue, x: 50, y: 50, t: 0.5 }, 100, e); expect(c.calls.length).toBeGreaterThan(2); }
    // The same instance always looks the same; another one may not.
    expect(K.nameHash("atlas")).toBe(K.nameHash("atlas"));
  });
  it("spriteSkin: the strip's frame for the pose, the instance's own set; the built-in skin for what the pack lacks", () => {
    const strip = { src: "idle.png", frames: 4, w: 24, h: 32, fps: 4, ax: 12, ay: 30 };
    const pack = PK.skinPackOk({ format: 1, id: "cozy", characters: { default: { idle: strip }, fox: { idle: { ...strip, src: "fox.png" } } }, byInstance: { a: "fox" } });
    const img = (n: string) => ({ img: n });
    const skin = K.spriteSkin(pack, new Map([["idle.png", img("idle")], ["fox.png", img("fox")]]));
    const c = fakeCtx();
    skin.drawCharacter(c, desk, look({ pose: "working" }), 500, env);          // no working strip: its idle, frame 2
    expect(c.calls.find(([k]: any) => k === "drawImage")![1]).toEqual([img("fox"), 48, 0, 24, 32, 48 - 24, 40 - 60, 48, 64]);
    const d = fakeCtx();
    skin.drawCharacter(d, desk, look({ name: "b", pose: "idle" }), 0, env);
    expect(d.calls.find(([k]: any) => k === "drawImage")![1][0]).toEqual(img("idle"));
    const r = fakeCtx();
    skin.drawRoom(r, { x: 0, y: 0, w: 200, h: 100, name: "T", lobby: false, desks: [] }, { ...env, pal: K.DEFAULT_PAL });   // no floor: the built-in room
    expect(r.calls.some(([k]: any) => k === "strokeRect")).toBe(true);
    expect([K.skinFor("nope"), K.skinFor("studio").id]).toEqual([K.pixelSkin, "studio"]);
  });
  it("furniture: an active item plays its strip (or activeSprite); an idle one holds its first frame", () => {
    const rack = { src: "rack.png", frames: 2, w: 10, h: 10, fps: 2 };
    const pack = PK.skinPackOk(PACK({ furniture: [{ id: "rack", sprite: rack, x: 100, y: 100, depth: 2, activeWhen: "crashed", activeSprite: { ...rack, src: "rack-on.png" } }] }));
    const skin = K.spriteSkin(pack, new Map([["rack.png", { r: 1 }], ["rack-on.png", { r: 2 }]]));
    const f = pack.furniture[0];
    const off = fakeCtx(); skin.drawFurniture(off, f, false, 900, env);
    const on = fakeCtx(); skin.drawFurniture(on, f, true, 600, env);
    expect(off.calls.find(([k]: any) => k === "drawImage")![1].slice(0, 2)).toEqual([{ r: 1 }, 0]);
    expect(on.calls.find(([k]: any) => k === "drawImage")![1].slice(0, 2)).toEqual([{ r: 2 }, 10]);
    expect([...Z.activeFurniture(pack, new Set(["idle"]))]).toEqual([]);
    expect([...Z.activeFurniture(pack, new Set(["idle", "crashed"]))]).toEqual(["rack"]);
    // The studio's: the alert rack and the bug answer to calls; the work rack to work.
    expect([...Z.activeFurniture(K.STUDIO_PACK, new Set(["crashed"]))].sort()).toEqual(["bug", "rack-alert"]);
    expect([...Z.activeFurniture(K.STUDIO_PACK, new Set(["working"]))]).toEqual(["rack-work"]);
  });
});

/** A small valid zones pack (format v1), with `o` over it. */
const STRIP = { src: "idle.png", frames: 4, w: 32, h: 48, fps: 4, ax: 16, ay: 46 };
const PACK = (o: Record<string, unknown> = {}) => ({
  format: 1, id: "cozy", background: "office.png",
  areas: { desks: { rect: [0, 0, 600, 400], seats: [[100, 100], [200, 100]] }, lounge: { rect: [700, 0, 500, 400], seats: [[800, 200]] }, alert: { rect: [700, 420, 500, 280], seats: [[800, 500]] } },
  stateZones: { working: "desks", idle: "lounge", needs: "alert", crashed: "alert", default: "lounge" },
  waypoints: [{ id: "a", x: 150, y: 150 }, { id: "b", x: 650, y: 150 }, { id: "c", x: 800, y: 250 }], edges: [["a", "b"], ["b", "c"]],
  characters: { default: { idle: STRIP, walk: { ...STRIP, src: "walk.png", frames: 2 } } }, ...o,
});

describe("the skin pack format v1 (strict)", () => {
  it("a valid pack: areas with ordered seats, stateZones, furniture by depth, defaults filled; its images listed", () => {
    const r = PK.checkSkinPack(PACK({ furniture: [{ id: "front", sprite: STRIP, x: 10, y: 10, depth: 1200 }, { id: "rug", sprite: { ...STRIP, src: "rug.png" }, x: 10, y: 10 }],
      props: { task: { src: "task.png", frames: 2, w: 12, h: 12 } }, bubbles: { en: { working: [" On it "] } }, byInstance: { atlas: "default" } }));
    expect(r.ok).toBe(true);
    const pack = r.pack;
    expect([pack.scale, pack.areas.desks.seats, pack.areas.desks.rect, pack.door]).toEqual([2, [{ x: 100, y: 100 }, { x: 200, y: 100 }], { x: 0, y: 0, w: 600, h: 400 }, { x: 640, y: 710 }]);
    expect(pack.furniture.map((f: any) => [f.id, f.depth, f.activeWhen])).toEqual([["rug", 0, null], ["front", 1200, null]]);
    expect([pack.props.task.fps, pack.props.task.ax, pack.props.task.ay, pack.bubbles.en.working]).toEqual([4, 6, 12, ["On it"]]);
    expect(PK.packImages(pack).sort()).toEqual(["idle.png", "office.png", "rug.png", "task.png", "walk.png"]);
    expect([PK.LOGICAL, PK.CHAR_DEPTH]).toEqual([{ w: 1280, h: 720 }, 1000]);
    expect(PK.skinPackOk(PACK())).not.toBeNull();
  });
  it.each([
    ["no format", { format: undefined }, "format"],
    ["a built-in id", { id: "studio" }, "id"],
    ["an unknown key", { colour: "red" }, 'pack: unknown key "colour"'],
    ["a seat outside its area", { areas: { desks: { rect: [0, 0, 100, 100], seats: [[150, 50]] } }, stateZones: { working: "desks" } }, "areas.desks.seats[0]: outside"],
    ["an area past the canvas", { areas: { desks: { rect: [1200, 0, 200, 100], seats: [[1210, 50]] } }, stateZones: { working: "desks" } }, "areas.desks.rect[2]"],
    ["an area with no seats", { areas: { desks: { rect: [0, 0, 100, 100], seats: [] } }, stateZones: { working: "desks" } }, "areas.desks.seats"],
    ["a state that is not one", { stateZones: { busy: "desks" } }, "stateZones.busy"],
    ["a zone with no area", { stateZones: { working: "kitchen" } }, "stateZones.working"],
    ["stateZones with no background", { background: undefined }, "background"],
    ["an edge to nowhere", { edges: [["a", "zz"]] }, "edges[0]"],
    ["a strip's unknown key", { characters: { default: { idle: { ...STRIP, loop: true } } } }, 'characters.default.idle: unknown key "loop"'],
    ["a strip with no frames", { characters: { default: { idle: { ...STRIP, frames: 0 } } } }, "characters.default.idle.frames"],
    ["a path out of the pack", { characters: { default: { idle: { ...STRIP, src: "../x.png" } } } }, "characters.default.idle.src"],
    ["an unknown pose", { characters: { default: { idle: STRIP, dance: STRIP } } }, 'unknown key "dance"'],
    ["no default set", { characters: { fox: { idle: STRIP } } }, "characters.default"],
    ["a set with no idle", { characters: { default: { walk: STRIP } } }, "characters.default.idle"],
    ["a character map to nothing", { byInstance: { atlas: "wolf" } }, "byInstance.atlas"],
    ["activeWhen not a state", { furniture: [{ id: "r", sprite: STRIP, x: 1, y: 1, activeWhen: "busy" }] }, "furniture[0].activeWhen"],
    ["activeSprite alone", { furniture: [{ id: "r", sprite: STRIP, x: 1, y: 1, activeSprite: STRIP }] }, "furniture[0].activeSprite"],
    ["furniture off the canvas", { furniture: [{ id: "r", sprite: STRIP, x: 1281, y: 1 }] }, "furniture[0].x"],
    ["a long bubble line", { bubbles: { en: { idle: ["x".repeat(41)] } } }, "bubbles.en.idle[0]"],
    ["bubbles in another language", { bubbles: { fr: { idle: ["Salut"] } } }, "bubbles.fr"],
  ])("refuses %s", (_what, o, where) => {
    const r = PK.checkSkinPack(PACK(o));
    expect(r.ok).toBe(false);
    expect(r.error).toContain(where);
    expect(PK.skinPackOk(PACK(o))).toBeNull();
  });
});

describe("zones: seats, walking, bubbles", () => {
  const pack = () => PK.skinPackOk(PACK());
  const node = (name: string, state: string) => ({ name, state, i: { name } });
  it("each state's area (else default, else the first area)", () => {
    const p = pack();
    expect(["working", "idle", "crashed", "stuck", "paused"].map((s) => Z.zoneOf(p, s))).toEqual(["desks", "lounge", "alert", "lounge", "lounge"]);
    expect(Z.zoneOf({ ...p, stateZones: { working: "alert" } }, "idle")).toBe("desks");
    // The studio: work at the desks, idle in the lounge, calls at the help desk, asleep in the nap corner.
    expect(["working", "idle", "needs", "crashed", "stuck", "paused", "stopped"].map((s) => Z.zoneOf(K.STUDIO_PACK, s))).toEqual(["desks", "lounge", "alert", "alert", "alert", "nap", "nap"]);
  });
  it("seats: in order, never shared; kept across calls while the area stays; overflow spots, then a crowd count", () => {
    const p = pack();
    const a = Z.zonesLayout(p, [node("x", "working"), node("y", "working"), node("z", "working"), node("gone", "missing")]);
    const at = (L: any) => Object.fromEntries([...L.seats].map(([n, s]: any) => [n, [s.area, s.slot]]));
    expect(at(a)).toEqual({ x: ["desks", 0], y: ["desks", 1], z: ["desks", -1] });
    expect(M.desksOf(a).map((d: any) => d.node.name)).toEqual(["x", "y", "z"]);              // the missing are not drawn
    // x goes idle: y and z keep theirs (stable), x takes the lounge's seat; a newcomer takes the freed desk seat 0.
    const b = Z.zonesLayout(p, [node("w", "working"), node("x", "idle"), node("y", "working"), node("z", "working")], a.seats);
    expect(at(b)).toEqual({ w: ["desks", 0], x: ["lounge", 0], y: ["desks", 1], z: ["desks", -1] });
    // Positions never collide.
    const many = Z.zonesLayout(p, Array.from({ length: 40 }, (_, i) => node(`n${i}`, "idle")));
    const spots = [...many.seats.values()].map((s: any) => `${s.x},${s.y}`);
    expect(new Set(spots).size).toBe(spots.length);
    expect(spots.length + (many.crowd.get("lounge") || 0)).toBe(40);
    expect(Z.overflowSpots(p.areas.lounge).every((q: any) => Math.hypot(q.x - 800, q.y - 200) >= Z.OVERFLOW.CLEAR)).toBe(true);
    const tiny = { ...p, areas: { ...p.areas, alert: { name: "alert", rect: { x: 700, y: 420, w: 60, h: 60 }, seats: [{ x: 730, y: 450 }] } } };
    expect(Z.zonesLayout(tiny, [node("a", "crashed"), node("b", "crashed"), node("c", "needs")]).crowd.get("alert")).toBe(2);
  });
  it("personAt: each person's box where they are now, the nearest first (#2431 review)", () => {
    const d = (name: string, x: number, y: number) => ({ key: `zone/${name}`, node: { name }, x: x - 24, y: y - 52, w: 48, h: 66, seat: { x, y } });
    const a = d("a", 104, 170), b = d("b", 650, 400), c = d("c", 650, 205);
    const pos = (x: any) => (x.node.name === "a" ? { x: 650, y: 212, walking: true } : null);
    expect(Z.personAt([a, b], 650, 192, pos)?.node.name).toBe("a");          // its body, on the way
    expect(Z.personAt([a, b], 104, 150, pos)).toBeNull();                     // the seat it heads for, empty
    expect(Z.personAt([a, b], 650, 380, pos)?.node.name).toBe("b");          // sitting still
    expect(Z.personAt([a, b], 104, 150, () => null)?.node.name).toBe("a");   // there
    expect(Z.personAt([a, c], 650, 200, pos)?.node.name).toBe("a");          // overlapping: drawn last (lower), hit first
    expect(Z.personAt([c, a], 650, 200, pos)?.node.name).toBe("a");
  });
  it("placeBubbles (#2431): no two overlap — calling first, then the one typed out furthest; one row up when free; else it waits", () => {
    const box = (x: number, y = 100, w = 100) => ({ x, y, w, h: 19 });
    const placed = Z.placeBubbles([
      { key: "b", calling: false, shown: 3, box: box(60) },          // overlaps a: lifted
      { key: "a", calling: false, shown: 9, box: box(0) },           // typed out furthest: keeps its spot
      { key: "c", calling: false, shown: 1, box: box(30) },          // overlaps a and lifted b: waits
      { key: "d", calling: true, shown: 0, box: box(400) },          // calling: first, alone
      { key: "e", calling: false, shown: 5, box: box(250) },
    ]);
    expect(placed.map((p: any) => [p.key, p.dy])).toEqual([["d", 0], ["a", 0], ["e", 0], ["b", -22]]);
    // #2431 smoke: a tail is kept clear too — a bubble over another's tail is lifted (or waits).
    const tailed = Z.placeBubbles([
      { key: "low", calling: false, shown: 9, box: box(0, 100, 50), tail: { x: 45, y: 140 } },
      { key: "over", calling: false, shown: 1, box: box(51, 121, 100) },    // clear of low's box, on its tail
    ]);
    expect(tailed.map((p: any) => [p.key, p.dy])).toEqual([["low", 0], ["over", -22]]);
    // …and a bubble whose own tail would cross a placed one waits (lifted, its tail is only longer).
    const crossing = Z.placeBubbles([
      { key: "placed", calling: false, shown: 9, box: box(0, 120, 80) },
      { key: "above", calling: false, shown: 1, box: box(65, 90, 100), tail: { x: 75, y: 150 } },   // box clear; tail through "placed"
    ]);
    expect(crossing.map((p: any) => p.key)).toEqual(["placed"]);
    // A calling bubble takes its place before one that started earlier.
    expect(Z.placeBubbles([{ key: "x", calling: false, shown: 9, box: box(0) }, { key: "y", calling: true, shown: 1, box: box(10) }]).map((p: any) => [p.key, p.dy]))
      .toEqual([["y", 0], ["x", -22]]);
  });
  it("walking: someone new is already there; a new target walks along the waypoints; still jumps; the gone are forgotten", () => {
    const w = Z.createWalkers(), g = pack();
    w.sync(new Map([["x", { x: 100, y: 100 }]]), 0, g);
    expect(w.at("x", 0)).toEqual({ x: 100, y: 100, walking: false });
    w.sync(new Map([["x", { x: 800, y: 200 }]]), 1000, g);
    const mid = w.at("x", 1500);
    expect(mid.walking).toBe(true);
    expect(w.moving(1500)).toBe(true);
    // Along the graph: through a (150, 150) and b (650, 150) — never straight across.
    const route = M.routeVia(g, { x: 100, y: 100 }, { x: 800, y: 200 });
    expect(route.map((q: any) => [q.x, q.y])).toEqual([[100, 100], [150, 150], [650, 150], [800, 250], [800, 200]]);
    const end = 1000 + M.pathLength(route) / Z.WALK.SPEED + 1;
    expect(w.at("x", end)).toEqual({ x: 800, y: 200, walking: false });
    w.sync(new Map([["x", { x: 100, y: 100 }]]), end, g, true);
    expect(w.at("x", end)).toEqual({ x: 100, y: 100, walking: false });
    w.sync(new Map(), end, g);
    expect(w.at("x", end)).toBeNull();
  });
  it("bubbles: deterministic; a new line each round; typed out; still shows it whole; calls always speak; nothing without lines", () => {
    const lines = ["One", "Two", "Three"];
    const said = Array.from({ length: 40 }, (_, i) => Z.bubbleAt(`n${i}`, "idle", 0, lines));
    expect(said.filter(Boolean).length).toBeGreaterThan(0);
    expect(said.filter(Boolean).length).toBeLessThan(40);                   // one in SHARE at a time
    expect(Z.bubbleAt("n1", "idle", 0, lines)).toEqual(Z.bubbleAt("n1", "idle", 0, lines));
    for (const b of said.filter(Boolean)) expect(b.shown).toBe([...b.text].length);
    for (let i = 0; i < 20; i++) expect(Z.bubbleAt(`n${i}`, "crashed", 0, lines), `n${i}`).not.toBeNull();
    // Over time: typed a character at a time, then gone until its next turn; the line changes between rounds.
    const seen = new Set<string>(), shownAt: number[] = [];
    for (let ms = 1; ms < 20 * Z.BUBBLE.PERIOD_MS; ms += 50) { const b = Z.bubbleAt("atlas", "needs", ms, lines); if (b) { seen.add(b.text); shownAt.push(b.shown); } }
    expect(seen.size).toBeGreaterThan(1);
    expect(Math.min(...shownAt)).toBe(1);
    expect(Z.bubbleAt("atlas", "idle", 5, [])).toBeNull();
    // The skin's lines in the page's language win; else the page's own.
    const p = { bubbles: { en: { idle: ["Hi"] } } };
    expect([Z.linesFor("idle", "en", p, { idle: ["x"] }), Z.linesFor("idle", "zh-TW", p, { idle: ["x"] }), Z.linesFor("working", "en", null, {})]).toEqual([["Hi"], ["x"], []]);
  });
  it("the studio's own pack is a valid zones layout: seats inside their areas, every seat near a waypoint joined to the hall", () => {
    const S = K.STUDIO_PACK;
    for (const a of Object.values(S.areas) as any[]) for (const q of a.seats) expect(q.x >= a.rect.x && q.x <= a.rect.x + a.rect.w && q.y >= a.rect.y && q.y <= a.rect.y + a.rect.h, a.name).toBe(true);
    const ids = S.waypoints.map((w: any) => w.id);
    for (const id of ids) expect(M.bfsPath(S.edges, ids[0], id), id).not.toBeNull();
    for (const a of Object.values(S.areas) as any[]) for (const q of a.seats) expect(Math.hypot(M.nearestWaypoint(S.waypoints, q).x - q.x, M.nearestWaypoint(S.waypoints, q).y - q.y)).toBeLessThanOrEqual(30);
  });
});

describe("the Office view on the page", () => {
  const mount = async () => { await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: `fleet:org|${Math.random()}|en` })); await settle(6); };
  const office = async () => { await mount(); p.root.querySelectorAll(".oc-tools .seg-inline button")[2].click(); await settle(4); };
  const desks = () => p.root.querySelectorAll(".oo-desk").map((b: any) => b.getAttribute("data-name"));
  it("an Office button beside Canvas and List, kept per device; the desks in the lobby-then-teams order", async () => {
    await mount();
    const btns = p.root.querySelectorAll(".oc-tools .seg-inline button");
    expect(btns.map((b: any) => b.textContent.trim())).toEqual(["Canvas", "List", "Office"]);
    btns[2].click(); await settle(4);
    expect(localStorage.getItem("agend_org_mode")).toBe("office");
    expect(!!p.root.querySelector(".oc-svg")).toBe(false);
    expect(p.root.querySelector(".oo-canvas").getAttribute("aria-label")).toContain("each team is a room");
    expect(desks()).toEqual(["atlas", "loner", "pixel", "quill", "sage", "orbit", "nova", "tide"]);
    await p.unmount(); await mount();
    expect(!!p.root.querySelector(".oo")).toBe(true);
  });
  it("a desk says what the canvas's card says, with its caption; it opens that instance's chat", async () => {
    await office();
    const quill = p.root.querySelectorAll(".oo-desk").find((b: any) => b.getAttribute("data-name") === "quill");
    expect(quill.getAttribute("aria-label")).toBe("quill — Working · Kiro CLI · Typing away. Open chat");
    const sage = p.root.querySelectorAll(".oo-desk").find((b: any) => b.getAttribute("data-name") === "sage");
    expect(sage.getAttribute("aria-label")).toContain("Paused · Grok Build · Asleep");
    fire(quill, "focus"); await settle(2);
    expect(p.root.querySelector(".oo-tip").textContent).toContain("Typing away");
    quill.click(); await settle(2);
    expect(location.pathname).toBe("/ui/chat/quill");
  });
  it("who is shown: a team, then pinned people — kept per browser; the Find box dims the rest", async () => {
    await office();
    const [, , team] = p.root.querySelectorAll(".oo-bar select");
    team.value = "t1"; fire(team, "change"); await settle(3);
    expect(desks()).toEqual(["nova", "tide"]);
    expect(JSON.parse(localStorage.getItem("agend_org_office_filter")!)).toEqual({ team: "Web", pinned: [] });
    team.value = "all"; fire(team, "change"); await settle(3);
    p.root.querySelector(".oo-people > button").click(); await settle(2);
    const boxes = p.root.querySelectorAll(".oo-people-list input");
    expect(boxes).toHaveLength(INSTANCES.length);
    fire(boxes[0], "change"); await settle(2);                                     // atlas
    fire(p.root.querySelectorAll(".oo-people-list input")[6], "change"); await settle(2);   // tide
    expect(desks()).toEqual(["atlas", "tide"]);
    expect(p.root.querySelector(".oo-people > button").textContent.trim()).toBe("People (2)");
    const find = p.root.querySelector(".oo-people-pop input[type=search]");
    find.value = "come"; fire(find, "input"); await settle(2);
    expect(p.root.querySelectorAll(".oo-people-list li").map((li: any) => li.textContent.trim())).toEqual(["Comet"]);   // the canvas's Find rule (nicknames too)
    await p.unmount(); await mount();
    expect(desks()).toEqual(["atlas", "tide"]);
  });
  // #2399 carry: the write surface's minimal editor — an admin session only; add, rename, style, members, delete;
  // saved with the rev read; a change made meanwhile (409) re-reads and saves nothing; too many saves (429) says so.
  describe("the offices' editor", () => {
    const realFetch = () => (globalThis as any).fetch;
    let puts: any[] = [], answer: { status: number; body: unknown } = { status: 200, body: {} };
    const auth = (canWrite: boolean) => { (globalThis as any).AgendAuth = { canWrite: async () => canWrite }; (p.window as any).AgendAuth = (globalThis as any).AgendAuth; };
    let base: any;
    beforeEach(() => {
      puts = []; answer = { status: 200, body: {} }; base = realFetch();
      (globalThis as any).fetch = async (url: string, o: any = {}) => {
        if (url === "/ui/offices" && o.method === "PUT") { puts.push(JSON.parse(o.body)); return { ok: answer.status === 200, status: answer.status, json: async () => answer.body }; }
        return base(url, o);
      };
    });
    afterEach(() => { (globalThis as any).fetch = base; delete (globalThis as any).AgendAuth; delete (p.window as any).AgendAuth; delete document.body.dataset.tier; delete document.body.dataset.publicLink; });
    const editBtn = () => p.root.querySelector(".oo-edit");
    it("offered to an admin session only: not to a read-only one, a guest page or the public link", async () => {
      auth(false); await office(); expect(editBtn()).toBeNull();
      await p.unmount(); auth(true); document.body.dataset.tier = "guest"; await office(); expect(editBtn()).toBeNull();
      await p.unmount(); delete document.body.dataset.tier; document.body.dataset.publicLink = "1"; await office(); expect(editBtn()).toBeNull();
      await p.unmount(); delete document.body.dataset.publicLink; await office(); expect(editBtn()?.textContent.trim()).toBe("Edit offices");
    });
    it("#2636: Share… for an admin session, here or over the public link (the user's choice) — never a read-only one or a guest page", async () => {
      const share = () => p.root.querySelector(".oo-share");
      auth(false); await office(); expect(share()).toBeNull();
      await p.unmount(); auth(true); document.body.dataset.tier = "guest"; await office(); expect(share()).toBeNull();
      await p.unmount(); delete document.body.dataset.tier; document.body.dataset.publicLink = "1"; await office();
      expect(share()?.textContent.trim()).toBe("Share…");
      expect(editBtn()).toBeNull();                                            // editing the offices stays local
      await p.unmount(); delete document.body.dataset.publicLink; await office(); expect(share()?.textContent.trim()).toBe("Share…");
      share().click(); await settle(3);
      expect(p.root.querySelector(".os-form")).not.toBeNull();
    });
    it("add an office, name it, pick a team and one instance, choose Studio: saved with the rev read, and shown in the switcher", async () => {
      offices = { rev: 4, offices: [{ id: "ops", name: "Ops room", members: [], layout: { seats: [{ id: "s1", x: 10, y: 10 }], waypoints: [], edges: [] } }] };
      auth(true); await office();
      editBtn().click(); await settle(3);
      p.root.querySelector("#oeAdd").click(); await settle(2);
      const rows = p.root.querySelectorAll(".oe-row");
      expect(rows).toHaveLength(2);
      const name = rows[1].querySelector(".oe-name"); name.value = "Web crew"; fire(name, "input"); await settle(1);
      const style = rows[1].querySelector(".oe-style"); style.value = "studio"; fire(style, "change"); await settle(1);
      const picks = rows[1].querySelectorAll(".oe-members input");
      const labelOf = (i: any) => i.parentNode.textContent.trim();
      fire(picks.find((i: any) => labelOf(i) === "Web"), "change"); await settle(1);
      fire(p.root.querySelectorAll(".oe-row")[1].querySelectorAll(".oe-members input").find((i: any) => labelOf(i) === "quill"), "change"); await settle(1);
      answer = { status: 200, body: { rev: 5, offices: [] } };
      p.root.querySelector("#oeSave").click(); await settle(4);
      expect(puts).toHaveLength(1);
      expect(puts[0].rev).toBe(4);
      expect(puts[0].offices[0]).toEqual({ id: "ops", name: "Ops room", skin: "pixel", members: [], layout: { seats: [{ id: "s1", x: 10, y: 10 }], waypoints: [], edges: [] } });   // its layout kept
      expect(puts[0].offices[1]).toMatchObject({ name: "Web crew", skin: "studio", members: ["team:Web", "quill"] });
      expect(puts[0].offices[1].id).toMatch(/^office-[0-9a-z]{6}$/);
      expect(puts[0].offices[1]).not.toHaveProperty("layout");
    });
    // #2431 review r2 (Prism): the editor's answers are ordered by when their requests were sent, not when they answer.
    describe("a held editor answer and a newer list the stream read meanwhile", () => {
      let gets: Array<(a: { status: number; body: unknown }) => void>, puts: Array<{ body: any; answer: (a: { status: number; body: unknown }) => void }>;
      const handlers: Record<string, () => void> = {};
      beforeEach(() => {
        gets = []; puts = [];
        const inner = (globalThis as any).fetch;
        (globalThis as any).fetch = async (url: string, o: any = {}) => {
          if (url !== "/ui/offices") return inner(url, o);
          const a: { status: number; body: unknown } = await new Promise((r) => (o.method === "PUT" ? puts.push({ body: JSON.parse(o.body), answer: r }) : gets.push(r)));
          return { ok: a.status === 200, status: a.status, json: async () => a.body };
        };
        app.appStore.set({ ...STORE, streamOn: (name: string, fn: () => void) => { handlers[name] = fn; return () => {}; } });
      });
      const ok = (rev: number, name: string) => ({ status: 200, body: { rev, offices: [{ id: name.toLowerCase(), name, members: [] }] } });
      const names = () => p.root.querySelector(".oo-bar select").querySelectorAll("option").map((o: any) => o.textContent.trim());
      const open = async () => {
        auth(true); await office();
        gets[0](ok(4, "Opened")); await settle(3);
        editBtn().click(); await settle(3);
        p.root.querySelector("#oeSave").click(); await settle(2);
      };
      it("a save sent before the stream's rev 6 answers rev 5 after it: the page keeps rev 6", async () => {
        await open();
        handlers.offices(); await settle(2);
        gets[1](ok(6, "RemoteLatest")); await settle(3);
        puts[0].answer(ok(5, "OlderEditorAnswer")); await settle(4);
        expect([names(), p.root.querySelector("#oeSave")]).toEqual([["Whole fleet", "RemoteLatest"], null]);
      });
      it("control: with nothing in between, the save's answer is shown", async () => {
        await open();
        puts[0].answer(ok(5, "Saved")); await settle(4);
        expect(names()).toEqual(["Whole fleet", "Saved"]);
      });
      it("a 409 re-read sent before the stream's rev 6 answers rev 5 after it: the page and the editor's draft and rev stay on rev 6", async () => {
        await open();
        puts[0].answer({ status: 409, body: { error: "offices_changed" } }); await settle(2);
        handlers.offices(); await settle(2);
        expect(gets).toHaveLength(3);                                    // the editor's re-read (held), then the stream's
        gets[2](ok(6, "RemoteLatest")); await settle(3);
        gets[1](ok(5, "OlderReread")); await settle(4);
        expect(names()).toEqual(["Whole fleet", "RemoteLatest"]);
        expect(p.root.querySelector(".oe-msg").textContent).toContain("Someone changed the offices meanwhile");
        // #2431: the draft stays; loading theirs takes the snapshot in force (rev 6), not the older re-read.
        p.root.querySelector("#oeLoadTheirs").click(); await settle(2);
        expect(p.root.querySelectorAll(".oe-row .oe-name").map((i: any) => i.value)).toEqual(["RemoteLatest"]);
        p.root.querySelector("#oeSave").click(); await settle(2);
        expect(puts[1].body.rev).toBe(6);                                // the draft's rev is the snapshot's
      });
      // #2449 review (Prism): the choices shown (the 409's re-read at rev 5), THEN the stream reads rev 6: the choice made
      // takes rev 6 — the snapshot in force when it is made, never the one the 409 found.
      it("the stream reads a newer list while the choice waits: Load theirs takes it, and Keep my edits its rev", async () => {
        await open();
        puts[0].answer({ status: 409, body: { error: "offices_changed" } }); await settle(2);
        gets[1](ok(5, "Reread")); await settle(4);
        expect(p.root.querySelector("#oeLoadTheirs")).not.toBeNull();     // the choice is shown
        handlers.offices(); await settle(2);
        gets[2](ok(6, "RemoteLatest")); await settle(4);
        expect(names()).toEqual(["Whole fleet", "RemoteLatest"]);
        p.root.querySelector("#oeLoadTheirs").click(); await settle(2);
        expect(p.root.querySelectorAll(".oe-row .oe-name").map((i: any) => i.value)).toEqual(["RemoteLatest"]);
        p.root.querySelector("#oeSave").click(); await settle(2);
        expect(puts[1].body.rev).toBe(6);
      });
      it("…and Keep my edits, the same: the draft kept, on rev 6", async () => {
        await open();
        puts[0].answer({ status: 409, body: { error: "offices_changed" } }); await settle(2);
        gets[1](ok(5, "Reread")); await settle(4);
        handlers.offices(); await settle(2);
        gets[2](ok(6, "RemoteLatest")); await settle(4);
        p.root.querySelector("#oeKeepMine").click(); await settle(2);
        p.root.querySelector("#oeSave").click(); await settle(2);
        expect([puts[1].body.rev, puts[1].body.offices.map((o: any) => o.name)]).toEqual([6, ["Opened"]]);
      });
      it("control: with nothing in between, the 409 re-read is what loading theirs takes", async () => {
        await open();
        puts[0].answer({ status: 409, body: { error: "offices_changed" } }); await settle(2);
        gets[1](ok(5, "Reread")); await settle(4);
        p.root.querySelector("#oeLoadTheirs").click(); await settle(2);
        expect([names(), p.root.querySelectorAll(".oe-row .oe-name").map((i: any) => i.value)]).toEqual([["Whole fleet", "Reread"], ["Reread"]]);
        p.root.querySelector("#oeSave").click(); await settle(2);
        expect(puts[1].body.rev).toBe(5);
      });
      it("#2431: keeping my edits keeps the draft on the snapshot in force's rev (rev 6 here): Save then sends it, knowingly", async () => {
        await open();
        puts[0].answer({ status: 409, body: { error: "offices_changed" } }); await settle(2);
        handlers.offices(); await settle(2);
        gets[2](ok(6, "RemoteLatest")); await settle(3);
        gets[1](ok(5, "OlderReread")); await settle(4);
        p.root.querySelector("#oeKeepMine").click(); await settle(2);
        expect(p.root.querySelectorAll(".oe-row .oe-name").map((i: any) => i.value)).toEqual(["Opened"]);
        expect(p.root.querySelector(".oe-msg").textContent).toBe("Your edits are kept. Save replaces what was saved meanwhile.");
        p.root.querySelector("#oeSave").click(); await settle(2);
        expect([puts[1].body.rev, puts[1].body.offices.map((o: any) => o.name)]).toEqual([6, ["Opened"]]);
      });
    });
    it("#2431: an office's style this page does not know is shown as itself (not as Desks) and saved unchanged", async () => {
      offices = { rev: 4, offices: [{ id: "ops", name: "Ops room", skin: "neon-arcade", members: [] }] };
      auth(true); await office();
      editBtn().click(); await settle(3);
      const style = p.root.querySelector(".oe-row .oe-style");
      expect([style.value, style.querySelectorAll("option").map((o: any) => o.textContent.trim())])
        .toEqual(["neon-arcade", ["Desks", "Studio", "neon-arcade (not available here: drawn as Desks)"]]);
      answer = { status: 200, body: { rev: 5, offices: [] } };
      p.root.querySelector("#oeSave").click(); await settle(4);
      expect(puts[0].offices[0].skin).toBe("neon-arcade");
    });
    it("a change made meanwhile (409): nothing saved, the list read again, said so; 429 says to wait; a nameless office is not sent", async () => {
      offices = { rev: 4, offices: [{ id: "ops", name: "Ops room", members: [] }] };
      auth(true); await office();
      editBtn().click(); await settle(3);
      const name = p.root.querySelector(".oe-row .oe-name"); name.value = "  "; fire(name, "input"); await settle(1);
      p.root.querySelector("#oeSave").click(); await settle(3);
      expect([puts.length, p.root.querySelector(".oe-msg").textContent]).toEqual([0, "Each office needs a name."]);
      name.value = "Ops"; fire(name, "input"); await settle(1);
      offices = { rev: 6, offices: [{ id: "lab", name: "Lab", members: [] }] };
      answer = { status: 409, body: { error: "offices_changed" } };
      p.root.querySelector("#oeSave").click(); await settle(4);
      expect(p.root.querySelector(".oe-msg").textContent).toContain("Someone changed the offices meanwhile");
      // #2431: the draft is kept until they choose; Save waits for the choice.
      expect(p.root.querySelectorAll(".oe-row .oe-name").map((i: any) => i.value)).toEqual(["Ops"]);
      expect(p.root.querySelector("#oeSave").disabled).toBe(true);
      p.root.querySelector("#oeLoadTheirs").click(); await settle(2);
      expect(p.root.querySelectorAll(".oe-row .oe-name").map((i: any) => i.value)).toEqual(["Lab"]);   // the current list
      answer = { status: 429, body: { error: "offices_rate_limited" } };
      p.root.querySelector("#oeSave").click(); await settle(4);
      expect(puts.at(-1).rev).toBe(6);                                     // the rev read again
      expect(p.root.querySelector(".oe-msg").textContent).toBe("Too many saves. Try again in a minute.");
    });
  });
  // #2424 review (Prism): the draft and the rev it was read at go together; a save freezes the form until its answer
  // (and a 409's re-read) is in.
  describe("the editor's draft and its rev", () => {
    let E: any;
    beforeAll(async () => { E = await import("/ui/js/fleet-office-editor.js"); });
    const deferred = () => { let resolve!: (v: any) => void; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
    it("the parent's rev moving on (the stream read again) never moves the draft's: Save sends the rev the draft was read at", async () => {
      const puts: any[] = [];
      const store = S.createOfficeStore({ fetch: async (_u: string, o: any) => { puts.push(JSON.parse(o.body)); return { ok: false, status: 409, json: async () => ({ error: "offices_changed" }) }; } });
      const list = [{ id: "ops", name: "Ops", skin: "pixel", members: [], layout: null }];
      const props = { offices: list, view: view(), store, onSaved: () => {}, onClose: () => {} };
      await p.mount(h(E.OfficeEditor, { ...props, rev: 4 })); await settle(2);
      await p.mount(h(E.OfficeEditor, { ...props, rev: 5, offices: [...list, { id: "lab", name: "Lab", skin: "pixel", members: [], layout: null }] })); await settle(2);
      expect(p.root.querySelectorAll(".oe-row .oe-name").map((i: any) => i.value)).toEqual(["Ops"]);   // the draft is the one opened
      p.root.querySelector("#oeSave").click(); await settle(3);
      expect(puts.map((b) => b.rev)).toEqual([4]);
    });
    it("frozen while a save is on its way and through a 409's re-read: no edit, no second save; editable again after", async () => {
      const put = deferred(), reread = deferred();
      let puts = 0;
      const store = S.createOfficeStore({ fetch: async (_u: string, o: any) => {
        if (o.method === "PUT") { puts++; return put.promise; }
        return reread.promise;
      } });
      await p.mount(h(E.OfficeEditor, { offices: [{ id: "ops", name: "Ops", skin: "pixel", members: [], layout: null }], rev: 4, view: view(), store, onSaved: () => {}, onClose: () => {} })); await settle(2);
      p.root.querySelector("#oeSave").click(); await settle(2);
      const form = () => p.root.querySelector(".oe-form");
      expect(form().disabled).toBe(true);
      p.root.querySelector("#oeSave").click(); await settle(2);
      expect(puts).toBe(1);                                              // no second save on its way
      put.resolve({ ok: false, status: 409, json: async () => ({ error: "offices_changed" }) }); await settle(3);
      expect(form().disabled).toBe(true);                                // still frozen: the re-read is on its way
      reread.resolve({ ok: true, status: 200, json: async () => ({ rev: 6, offices: [{ id: "lab", name: "Lab" }] }) }); await settle(4);
      // Editable again, the draft as it was (#2431: kept until they choose).
      expect([form().disabled, p.root.querySelectorAll(".oe-row .oe-name").map((i: any) => i.value)]).toEqual([false, ["Ops"]]);
    });
  });
  // #2431 review (Prism): reads can answer out of order; an older answer never takes back the list shown.
  it("an answer asked for before the list shown never replaces it; one asked for after does, whatever its rev", async () => {
    const handlers: Record<string, () => void> = {}, held: Array<(v: unknown) => void> = [];
    const base = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, o: any = {}) => {
      if (url !== "/ui/offices" || (o.method ?? "GET") !== "GET") return base(url, o);
      const body = await new Promise((r) => held.push(r));
      return { ok: true, status: 200, json: async () => body };
    };
    const names = () => p.root.querySelector(".oo-bar select").querySelectorAll("option").map((o: any) => o.textContent.trim());
    try {
      app.appStore.set({ ...STORE, streamOn: (name: string, fn: () => void) => { handlers[name] = fn; return () => {}; } });
      await office();                                                     // the opening read, held
      handlers.offices(); await settle(2);                                // the stream: read again
      held[1]({ rev: 5, offices: [{ id: "new", name: "NewOffice" }] }); await settle(3);
      held[0]({ rev: 4, offices: [{ id: "old", name: "OldOffice" }] }); await settle(3);
      expect(names()).toEqual(["Whole fleet", "NewOffice"]);
      // A read asked for after that list arrived is newer even with a lower rev (the host's store was reset).
      handlers.offices(); await settle(2);
      held[2]({ rev: 0, offices: [{ id: "fresh", name: "Fresh" }] }); await settle(3);
      expect(names()).toEqual(["Whole fleet", "Fresh"]);
    } finally { (globalThis as any).fetch = base; }
  });
  // #2431 review (Prism): the Studio draws people where they walk; a click finds them there, not at their destination.
  it("Studio: a walking person is hit where drawn, its empty destination is not; one sitting still is hit at its seat", async () => {
    const proto = MiniElement.prototype as any;
    proto.getContext = function () { return (this._ctx ??= fakeCtx()); };
    try {
      localStorage.setItem("agend_org_office_skin", "studio");
      await office(); await settle(4);
      const pack = K.skinFor("studio").pack, v = (await import("/ui/js/fleet-office-view.js")).fitScene(1280, 720, { w: 960, h: 600 });   // #2540: the opening view
      const nodes = (v: any) => [...new Map(M.officeRooms(v).flatMap((r: any) => r.nodes).map((n: any) => [n.name, n])).values()];
      const before = Z.zonesLayout(pack, nodes(view()));
      app.appStore.set({ ...STORE, exec: { ...STORE.exec, atlas: "working" } }); await settle(2);   // atlas: idle → working, walks
      const after = Z.zonesLayout(pack, nodes(view()), before.seats);
      const seat = (L: any, n: string) => M.desksOf(L).find((d: any) => d.node.name === n).seat;
      const from = seat(before, "atlas"), to = seat(after, "atlas"), still = seat(after, "loner");
      expect(Math.hypot(to.x - from.x, to.y - from.y)).toBeGreaterThan(100);    // a walk, not a step
      const click = (pt: any) => { fire(p.root.querySelector(".oo-canvas"), "pointerdown", { pointerType: "mouse" }); fire(p.root.querySelector(".oo-canvas"), "click", { clientX: v.x + pt.x * v.k, clientY: v.y + (pt.y - 20) * v.k }); };
      click(to); await settle(1);
      expect(location.pathname).toBe("/ui/fleet/org");                   // its destination, still empty: nothing opens
      click(from); await settle(1);
      expect(location.pathname).toBe("/ui/chat/atlas");                   // where it is drawn, just set off
      nav.navigate("/ui/fleet/org"); await settle(3);
      click(still); await settle(1);
      expect(location.pathname).toBe("/ui/chat/loner");                   // sitting still: at its seat
    } finally { delete proto.getContext; }
  });
  it("an accepted far-out custom layout at DPR 3: the canvas and its layers stay within a paintable bitmap (#2431 review)", async () => {
    const proto = MiniElement.prototype as any, made: any[] = [];
    proto.getContext = function () { made.push(this); return (this._ctx ??= fakeCtx()); };
    const realDpr = (globalThis as any).devicePixelRatio;
    (globalThis as any).devicePixelRatio = 3;
    try {
      offices = { rev: 1, offices: [{ id: "far", name: "Far", members: ["quill"], layout: { seats: [{ id: "s", x: 10000, y: 10000 }], waypoints: [], edges: [] } }] };
      localStorage.setItem("agend_org_office", "far");
      await office(); await settle(4);
      const cv = p.root.querySelector(".oo-canvas");
      expect(cv.style.width).toBe("960px");                                       // #2540: the canvas is the stage; the layout is panned and zoomed in it
      for (const c of new Set(made)) {
        expect([c.width <= M.CANVAS_MAX.side, c.height <= M.CANVAS_MAX.side, c.width * c.height <= M.CANVAS_MAX.area]).toEqual([true, true, true]);
      }
      expect(made.length).toBeGreaterThanOrEqual(2);                              // the canvas and its layers
    } finally { delete proto.getContext; (globalThis as any).devicePixelRatio = realDpr; }
  });
  // #2431 (the from-defaults smoke, on a phone): neighbours' bubbles covered each other. Everyone calling (their bubbles
  // always show): every drawn bubble's box is clear of every other's.
  it("on the canvas, no two speech bubbles overlap, however many talk at once", async () => {
    const proto = MiniElement.prototype as any;
    proto.getContext = function () { return (this._ctx ??= fakeCtx()); };
    try {
      app.appStore.set({ ...STORE, awaiting: Object.fromEntries(INSTANCES.map((i) => [i.name, "a prompt"])) });
      await office(); await settle(4);
      const all = p.root.querySelector(".oo-canvas")._ctx.calls as Array<[string, any[]]>;
      const calls = all.slice(all.map(([k]) => k).lastIndexOf("clearRect"));     // the last frame drawn
      const lines = new Set(["Need you!", "A question for you", "Over here!"]);
      const boxes = calls.filter(([k, a]) => k === "fillText" && lines.has(a[0])).map(([, a]) => ({ x: a[1] - 7, y: a[2] - 10, w: a[0].length * 6 + 14, h: 19 }));
      expect(boxes.length).toBeGreaterThanOrEqual(4);
      const overlap = (r: any, t: any) => r.x < t.x + t.w && t.x < r.x + r.w && r.y < t.y + t.h && t.y < r.y + r.h;
      const bad = boxes.flatMap((r, i) => boxes.slice(i + 1).filter((t) => overlap(r, t)).map((t) => [r, t]));
      expect(bad).toEqual([]);
    } finally { delete proto.getContext; }
  });
  it("the host's offices in the switcher; a stored office shows its members", async () => {
    offices = { rev: 2, offices: [{ id: "ops", name: "Ops room", members: ["team:Web", "quill"] }, { id: "auto", name: "nope" }] };
    await office();
    const sw = p.root.querySelector(".oo-bar select");
    expect(sw.querySelectorAll("option").map((o: any) => o.textContent.trim())).toEqual(["Whole fleet", "Ops room"]);
    sw.value = "ops"; fire(sw, "change"); await settle(3);
    expect(desks()).toEqual(["nova", "tide", "quill"]);
    expect(p.root.querySelectorAll(".oo-bar select")).toHaveLength(1);           // the team filter is the auto office's
    expect(localStorage.getItem("agend_org_office")).toBe("ops");
  });
  it("#2431: an office whose stored style this page does not know says so (drawn as Desks), never pretends it is Desks", async () => {
    offices = { rev: 2, offices: [{ id: "ops", name: "Ops room", skin: "neon-arcade", members: [] }, { id: "lab", name: "Lab", skin: "studio", members: [] }] };
    localStorage.setItem("agend_org_office", "ops");
    await office();
    expect(p.root.querySelector(".oo-note")?.textContent).toBe("Its style “neon-arcade” is not available here: drawn as Desks.");
    const sw = p.root.querySelector(".oo-bar select");
    sw.value = "lab"; fire(sw, "change"); await settle(3);
    expect(p.root.querySelector(".oo-note")).toBeNull();                        // a style it knows: nothing to say
  });
  it("the Studio style (zones): kept per browser; everyone in their state's area, drawn with bubbles and active furniture; a desk opens its chat", async () => {
    const proto = MiniElement.prototype as any;
    proto.getContext = function () { return (this._ctx ??= fakeCtx()); };
    try {
      await office();
      const style = p.root.querySelectorAll(".oo-bar select")[1];
      expect(style.querySelectorAll("option").map((o: any) => o.textContent.trim())).toEqual(["Desks", "Studio"]);
      style.value = "studio"; fire(style, "change"); await settle(4);
      expect(localStorage.getItem("agend_org_office_skin")).toBe("studio");
      expect(desks()).toEqual(["atlas", "loner", "pixel", "quill", "sage", "orbit", "nova", "tide"]);
      const main = p.root.querySelector(".oo-canvas")._ctx;
      await settle(4);
      const texts = main.calls.filter(([k]: any) => k === "fillText").map(([, a]: any) => a[0]);
      expect(texts).toContain("quill");                                         // a name tag under feet
      expect(texts.some((x: string) => ["Need you!", "A question for you", "Over here!", "Ouch, crashed", "Help!", "Hmm, stuck?", "Still thinking…"].some((l) => l.startsWith(x) && x.length > 0))).toBe(true);
      // #2540: the canvas fills the stage (960 px here); the 1280×720 scene is fitted in it.
      expect(p.root.querySelector(".oo-canvas").style.width).toBe("960px");
      await p.unmount(); await mount();
      expect(p.root.querySelectorAll(".oo-bar select")[1].value).toBe("studio");
      const quill = p.root.querySelectorAll(".oo-desk").find((b: any) => b.getAttribute("data-name") === "quill");
      quill.click(); await settle(2);
      expect(location.pathname).toBe("/ui/chat/quill");
    } finally { delete proto.getContext; }
  });
  it("on a canvas: the layers are drawn once, the people each frame; the loop stops with the view", async () => {
    const proto = MiniElement.prototype as any;
    const made: any[] = [];
    proto.getContext = function () { return (this._ctx ??= (made.push(fakeCtx()), made[made.length - 1])); };
    try {
      await office();
      await settle(4);
      const main = p.root.querySelector(".oo-canvas")._ctx;
      expect(main.calls.filter(([k]: any) => k === "drawImage").length).toBeGreaterThanOrEqual(2);        // back and front layers
      expect(p.root.querySelector(".oo-canvas").style.width).toMatch(/^\d+px$/);
      // A click on a desk (measured from the canvas, through the view: the scene is centred where it is smaller) opens its chat.
      const l = M.autoLayout(M.officeRooms(view()), { width: 960 }), tide = M.desksOf(l).find((d: any) => d.node.name === "tide");
      const fr = p.root.querySelector(".oo-mini-view"), [k, vx, vy] = ["data-k", "data-x", "data-y"].map((a) => Number(fr.getAttribute(a)));
      fire(p.root.querySelector(".oo-canvas"), "pointerdown", { pointerType: "mouse" });
      fire(p.root.querySelector(".oo-canvas"), "click", { clientX: vx + (tide.x + 10) * k, clientY: vy + (tide.y + 10) * k });
      await settle(2);
      expect(location.pathname).toBe("/ui/chat/tide");
      const n = main.calls.length;
      await p.unmount(); await settle(4);
      expect(main.calls.length).toBe(n);
    } finally { delete proto.getContext; }
  });
  // Office review (#2399 carry): the poses change at most 12 times a second; with nothing walking or flying the loop must
  // not wake at the display's rate (60+ frames a second) only to find nothing to draw.
  it("idle (nothing in the air): the loop wakes about once per drawn frame, not at the display's rate", async () => {
    const proto = MiniElement.prototype as any;
    proto.getContext = function () { return (this._ctx ??= fakeCtx()); };
    const realRaf = (globalThis as any).requestAnimationFrame, realCancel = (globalThis as any).cancelAnimationFrame;
    let frames = 0;
    (globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => { frames++; return setTimeout(() => cb(performance.now()), 4) as unknown as number; };   // a 250 Hz display
    (globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);
    try {
      await office();
      await settle(4);
      frames = 0;
      await new Promise((r) => setTimeout(r, 1000));
      // 12 drawn frames a second, a few wakes to spare; at the display's rate it would be ~250.
      expect(frames).toBeGreaterThan(5);
      expect(frames).toBeLessThanOrEqual(20);
      await p.unmount(); await settle(4);
      const after = frames;
      await new Promise((r) => setTimeout(r, 300));
      expect(frames).toBe(after);                                       // gone with the view: no timer left behind
    } finally { delete proto.getContext; (globalThis as any).requestAnimationFrame = realRaf; (globalThis as any).cancelAnimationFrame = realCancel; }
  }, 15_000);
});
