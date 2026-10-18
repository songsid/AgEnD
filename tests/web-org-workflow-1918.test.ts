/**
 * #1918 review (the user's two org-canvas issues, 2026-10-18):
 * 1. The work, not just the message: a task's delegator → worker line stays "in progress" until its report comes back
 *    (the server's `delegation` events and the snapshot's `delegations`), then one return pulse worker → delegator, and
 *    it goes; one that waits too long fades as "no report yet". A delivered message lingers FADE_MS (12 s), ×N.
 * 2. No free-floating line: every edge ends on something drawn (a card, or a folded team's box) and runs through lanes
 *    of the boxes it joins. The user's case — two cards in the third column of the ungrouped grid — was routed up to the
 *    bus above the box and back down, a lone vertical line from under General to past the bottom of the view.
 * On the user's shape: two General cards over a 3-column ungrouped grid, a team, paused and folded instances.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const hex = (n: number) => n.toString(16).padStart(16, "0");
const msg = (n: number, from: string, to: string, state = "delivering", kind = "send") => ({ id: hex(n), from, to, kind, state, at: "2026-10-18T10:00:00.000Z" });
const del = (n: number, from: string, to: string, state = "open", age_ms = 0) => ({ id: hex(n), from, to, state, age_ms });

const REST = ["ember", "quill", "sage", "orbit", "nova", "kite", "lark", "moss", "juno"];      // 9 → 3 columns, 3 rows
const INSTANCES = [{ name: "atlas", status: "running", backend: "claude-code" }, { name: "beacon", status: "running", backend: "codex" },
  ...REST.map((name) => ({ name, status: name === "moss" ? "paused" : "running", backend: "codex" })),
  ...["pixel", "flint", "wren", "cedar"].map((name) => ({ name, status: "running", backend: "kiro-cli" }))];
const ORG = { general: ["atlas", "beacon"], teams: [{ name: "Web", members: ["pixel", "flint", "wren", "cedar"] }], instances: {} };

let p: AppPage, T: any, C: any, O: any, app: any, fleet: any, nav: any;
let snapshot: any = { now: "", items: [], delegations: [] };
/** When set, the next /ui/traffic answer waits for it (a slow read the stream overtakes). */
let hold: Promise<void> | null = null;
const subs = new Map<string, Set<(d: unknown) => void>>();
const emit = (name: string, d: unknown) => { for (const fn of subs.get(name) ?? []) fn(d); };
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  (globalThis as any).fetch = async (url: string) => {
    const body = url === "/ui/org" ? ORG : url === "/ui/traffic" ? snapshot : {};      // what the server said when asked
    if (url === "/ui/traffic" && hold) { const h = hold; hold = null; await h; }
    return { ok: true, status: 200, json: async () => body };
  };
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  nav.startRouter(p.window);
  fleet = await import("/ui/js/panel-fleet.js");
  T = await import("/ui/js/fleet-traffic.js");
  C = await import("/ui/js/fleet-canvas.js");
  O = await import("/ui/js/fleet-org.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  vi.useRealTimers();
  await p.unmount();
  p.storage.clear(); subs.clear(); snapshot = { now: "", items: [], delegations: [] }; hold = null;
  app.appStore.set({ ready: true, instances: INSTANCES, exec: {}, awaiting: {}, needs: [], connection: "live",
    streamOn: (name: string, fn: (d: unknown) => void) => { const s = subs.get(name) ?? new Set(); s.add(fn); subs.set(name, s); return () => s.delete(fn); } });
});
const mount = async () => { await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: `fleet:org|${Math.random()}|en` })); await settle(6); };
const layout = (folded = new Set<string>(), view = O.buildOrgView(ORG, app.appStore.get())) => C.canvasLayout(view, folded);
const flows = () => p.root.querySelectorAll(".oc-flow").map((e: any) => e.getAttribute("class").replace("oc-flow ", ""));

// ── geometry ──
const cardsOf = (L: any) => [...L.tops, ...L.boxes.flatMap((b: any) => b.cells)];
const onCardBorder = (pt: any, c: any) => (Math.abs(pt.x - c.x) < 0.01 || Math.abs(pt.x - (c.x + c.w)) < 0.01) && pt.y >= c.y - 0.01 && pt.y <= c.y + c.h + 0.01
  || (Math.abs(pt.y - c.y) < 0.01 || Math.abs(pt.y - (c.y + c.h)) < 0.01) && pt.x >= c.x - 0.01 && pt.x <= c.x + c.w + 0.01;
const onBoxTop = (pt: any, b: any) => Math.abs(pt.y - b.y) < 0.01 && pt.x >= b.x && pt.x <= b.x + b.w;
/** What a name's line must end on: its card, or its folded team's box top; null when it is not on the canvas. */
function endShape(L: any, name: string) {
  const c = cardsOf(L).find((x: any) => x.node.name === name);
  if (c) return (pt: any) => onCardBorder(pt, c);
  const b = L.boxes.find((x: any) => x.folded && x.nodes.some((n: any) => n.name === name));
  return b ? (pt: any) => onBoxTop(pt, b) : null;
}
const inside = (pt: any, b: any) => pt.x >= b.x && pt.x <= b.x + b.w && pt.y >= b.y && pt.y <= b.y + b.h;

describe("every line ends on something drawn, through lanes of the boxes it joins", () => {
  const NAMES = ["atlas", "beacon", ...REST, "pixel", "flint", "wren", "cedar"];
  for (const folded of [new Set<string>(), new Set(["Web"]), new Set(["\u0000rest"])]) {
    it(`every pair (${folded.size ? `folded: ${[...folded].map((k) => k.replace("\u0000", "")).join()}` : "nothing folded"}): finite, both ends on their card or box, never across a card, inside the box when both are in it`, () => {
      const L = layout(folded), cards = cardsOf(L);
      let drawn = 0;
      for (const a of NAMES) for (const z of NAMES) {
        if (a === z) continue;
        const edges = T.trafficEdges([msg(1, a, z)], L);
        const ea = endShape(L, a), ez = endShape(L, z);
        const sameFolded = L.boxes.some((b: any) => b.folded && b.nodes.some((n: any) => n.name === a) && b.nodes.some((n: any) => n.name === z));
        if (!ea || !ez || sameFolded) { expect(edges, `${a}→${z}: nothing to end on`).toEqual([]); continue; }
        expect(edges, `${a}→${z}`).toHaveLength(1);
        const pts = edges[0].pts;
        drawn++;
        for (const pt of pts) expect(Number.isFinite(pt.x) && Number.isFinite(pt.y), `${a}→${z}: ${JSON.stringify(pt)}`).toBe(true);
        expect(ea(pts[0]), `${a}→${z} starts on ${a}`).toBe(true);
        expect(ez(pts[pts.length - 1]), `${a}→${z} ends on ${z}`).toBe(true);
        for (let i = 1; i < pts.length; i++) {
          const x0 = Math.min(pts[i - 1].x, pts[i].x), x1 = Math.max(pts[i - 1].x, pts[i].x), y0 = Math.min(pts[i - 1].y, pts[i].y), y1 = Math.max(pts[i - 1].y, pts[i].y);
          for (const c of cards) expect(x1 > c.x + 1 && x0 < c.x + c.w - 1 && y1 > c.y + 1 && y0 < c.y + c.h - 1, `${a}→${z} segment ${i} crosses ${c.node.name}`).toBe(false);
        }
        // A lane in a box's padding keeps at least 6 px from the box's border (a line along the border looked attached to it).
        for (const b of L.boxes) for (const pt of pts) if (!b.folded && pt.x > b.x && pt.x < b.x + b.w && pt.y > b.y && pt.y <= b.y + b.h)
          expect(Math.min(pt.x - b.x, b.x + b.w - pt.x), `${a}→${z} runs along ${b.key}'s border at ${JSON.stringify(pt)}`).toBeGreaterThanOrEqual(6);
        const box = L.boxes.find((b: any) => !b.folded && b.cells.some((c: any) => c.node.name === a) && b.cells.some((c: any) => c.node.name === z));
        if (box) for (const pt of pts) expect(inside(pt, box), `${a}→${z} leaves its box at ${JSON.stringify(pt)}`).toBe(true);
      }
      expect(drawn).toBeGreaterThan(0);
    });
  }
  it("the user's case: a report between two cards in the third column of the ungrouped grid stays in the box — never up to the bus", () => {
    const L = layout(), rest = L.boxes.find((b: any) => b.loose);
    const third = rest.cells.filter((_c: any, i: number) => i % rest.cols === 2);                      // the third column, top to bottom
    expect([rest.cols, third.length]).toEqual([3, 3]);
    const [upper, lower] = [third[0], third[2]];
    const [e] = T.trafficEdges([msg(1, upper.node.name, lower.node.name, "delivering", "report")], L);
    expect(Math.min(...e.pts.map((pt: any) => pt.y)), "not above the box (the bus is under General)").toBeGreaterThanOrEqual(rest.y);
    expect(Math.max(...e.pts.map((pt: any) => pt.y)), "not below the lower card's row").toBeLessThanOrEqual(lower.y + C.OC.NH);
  });
  it("a name not on the canvas draws nothing; nor does a line inside one folded team", () => {
    expect(T.trafficEdges([msg(1, "ember", "ghost"), msg(2, "ghost", "atlas")], layout())).toEqual([]);
    expect(T.trafficEdges([msg(1, "pixel", "flint")], layout(new Set(["Web"])))).toEqual([]);
  });
  it("a paused instance is on the canvas: its line ends on its card", () => {
    const L = layout(), [e] = T.trafficEdges([msg(1, "atlas", "moss")], L);
    expect(endShape(L, "moss")!(e.pts[e.pts.length - 1])).toBe(true);
    expect(cardsOf(L).find((c: any) => c.node.name === "moss").node.state).toBe("paused");
  });
  it("only General (two cards, no team or other instance): a line between them, just under them — never at an infinite bus", () => {
    const L = layout(new Set(), { top: O.buildOrgView(ORG, app.appStore.get()).top, teams: [], rest: { nodes: [], counts: [] }, total: 2, counts: [] });
    expect(L.boxes).toEqual([]);
    const [e] = T.trafficEdges([msg(1, "atlas", "beacon")], L);
    for (const pt of e.pts) expect(Number.isFinite(pt.y) && pt.y >= L.tops[0].y + L.tops[0].h, JSON.stringify(pt)).toBe(true);
    expect([endShape(L, "atlas")!(e.pts[0]), endShape(L, "beacon")!(e.pts[e.pts.length - 1])]).toEqual([true, true]);
  });
});

describe("the work: a delegation stays until its report", () => {
  it("delegationOk: a 16-hex id, two different names, a known state, an age", () => {
    expect(T.delegationOk(del(1, "atlas", "ember"))).toEqual({ id: hex(1), from: "atlas", to: "ember", state: "open", age: 0 });
    for (const bad of [null, { ...del(1, "a", "b"), id: "cid-1" }, del(1, "a", "a"), { ...del(1, "a", "b"), state: "closed" }, { ...del(1, "a", "b"), age_ms: -1 }, { ...del(1, "a", "b"), age_ms: "1" }])
      expect(T.delegationOk(bad), JSON.stringify(bad)).toBeNull();
  });
  it("open: in progress until its report — far past the message fade; done: one return pulse, worker → delegator, then gone", () => {
    const s = T.createTrafficStore();
    expect(s.delegation(del(1, "atlas", "ember"), 0)).toBe(true);
    expect(s.delegation(del(1, "atlas", "ember"), 1), "the same open again: no news").toBe(false);
    s.sweep(T.FADE_MS * 50);
    expect(s.items().map((i: any) => [i.from, i.to, i.kind, i.phase])).toEqual([["atlas", "ember", "task", "work"]]);
    expect(s.delegation(del(1, "atlas", "ember", "done"), T.FADE_MS * 50)).toBe(true);
    expect(s.items().map((i: any) => [i.from, i.to, i.kind, i.phase])).toEqual([["ember", "atlas", "report", "return"]]);
    expect(s.sweep(T.FADE_MS * 50 + T.RETURN_MS)).toBe(true);
    expect(s.items()).toEqual([]);
  });
  it("cancelled (the task never arrived): gone at once; expired: fades as no report yet; an unseen one's expiry draws nothing", () => {
    const s = T.createTrafficStore();
    s.delegation(del(1, "atlas", "ember"), 0); s.delegation(del(2, "atlas", "quill"), 0);
    s.delegation(del(1, "atlas", "ember", "cancelled"), 1);
    s.delegation(del(2, "atlas", "quill", "expired"), 1);
    expect(s.items().map((i: any) => [i.to, i.phase])).toEqual([["quill", "stale"]]);
    expect(s.delegation(del(3, "atlas", "sage", "expired"), 1)).toBe(false);
    s.sweep(1 + T.FADE_MS);
    expect(s.items()).toEqual([]);
  });
  it("its wait runs out on the page too (the age it came with counts): then no report yet", () => {
    const s = T.createTrafficStore();
    s.delegation(del(1, "atlas", "ember", "open", T.DELEGATION_TTL_MS - 1000), 0);
    s.sweep(999);
    expect(s.items()[0].phase).toBe("work");
    s.sweep(1000);
    expect(s.items()[0].phase).toBe("stale");
  });
  it("a snapshot is the truth for what is open: listed ones are drawn (a reload, the public link); one it no longer lists is gone", () => {
    const s = T.createTrafficStore();
    expect(s.load({ items: [], delegations: [del(1, "atlas", "ember", "open", 60_000), del(2, "atlas", "kite", "done")] }, 0)).toBe(true);
    expect(s.items().map((i: any) => [i.to, i.phase])).toEqual([["ember", "work"]]);
    expect(s.load({ items: [], delegations: [] }, 1)).toBe(true);
    expect(s.items()).toEqual([]);
  });
  it("#2135 review: ended work is remembered — a snapshot that still lists it (asked for before, or not) never draws it again", () => {
    const s = T.createTrafficStore();
    const since = s.streamRev();                                                        // a read goes out
    s.delegation(del(1, "atlas", "ember"), 0);
    s.delegation(del(1, "atlas", "ember", "done"), 1_000);
    s.sweep(1_000 + T.RETURN_MS);
    expect(s.items()).toEqual([]);
    const old = { items: [], delegations: [del(1, "atlas", "ember", "open", 500)] };
    expect(s.load(old, 1_000 + T.RETURN_MS + 1, since), "the held answer arrives").toBe(false);
    expect(s.load(old, 1_000 + T.RETURN_MS + 2), "even as a fresh one").toBe(false);
    expect(s.items()).toEqual([]);
    // Expired, taken back, run out here: the same.
    s.delegation(del(2, "atlas", "quill"), 0); s.delegation(del(2, "atlas", "quill", "expired"), 1);
    s.delegation(del(3, "atlas", "sage"), 0); s.delegation(del(3, "atlas", "sage", "cancelled"), 1);
    s.delegation(del(4, "atlas", "kite", "open", T.DELEGATION_TTL_MS), 0); s.sweep(1); s.sweep(1 + T.FADE_MS);
    s.sweep(2 + T.FADE_MS);
    expect(s.load({ items: [], delegations: [del(2, "atlas", "quill"), del(3, "atlas", "sage"), del(4, "atlas", "kite")] }, 3 + T.FADE_MS)).toBe(false);
    expect(s.items()).toEqual([]);
  });
  it("#2135 review: a snapshot asked for before the stream's latest news ends and rewinds nothing; it only adds what is new", () => {
    const s = T.createTrafficStore();
    s.apply(msg(1, "atlas", "ember", "queued", "task"), 0);
    const since = s.streamRev();
    s.apply(msg(1, "atlas", "ember", "delivering", "task"), 1);
    expect(s.streamRev(), "a stream item counts").toBe(since + 1);
    s.delegation(del(1, "atlas", "ember"), 1);
    const old = { items: [msg(1, "atlas", "ember", "queued", "task"), msg(2, "beacon", "kite", "queued")], delegations: [] };
    expect(s.load(old, 2, since)).toBe(true);
    expect(s.items().map((i: any) => [i.to, i.state, i.phase ?? null])).toEqual([["ember", "delivering", null], ["kite", "queued", null], ["ember", "delivering", "work"]]);
    // A message the stream drew after the read went out is not ended by the answer that does not know it.
    const since2 = s.streamRev();
    s.apply(msg(3, "atlas", "sage", "delivering"), 2);
    expect(s.load({ items: [], delegations: [] }, 2, since2)).toBe(false);
    expect(s.items().some((i: any) => i.to === "sage")).toBe(true);
    // A fresh one (nothing heard since it was asked for) is the truth again.
    expect(s.load({ items: [], delegations: [] }, 3)).toBe(true);
    expect(s.items()).toEqual([]);
  });
  it("edges: in progress and its return are lines of their own (not merged with the task message); live first", () => {
    const s = T.createTrafficStore();
    s.apply(msg(9, "atlas", "ember", "delivering", "task"), 0);
    s.delegation(del(1, "atlas", "ember"), 0);
    const e = T.trafficEdges(s.items(), layout());
    expect(e.map((x: any) => [x.hue, x.phase])).toEqual([["task", "live"], ["task", "work"]]);
  });
  it("the list says who is working for whom", () => {
    const s = T.createTrafficStore();
    s.delegation(del(1, "atlas", "ember"), 0);
    expect(T.sendingBy(s.items()).get("atlas")).toEqual([{ key: "task>ember>work", kind: "task", to: "ember", queued: false, working: true }]);
  });
  it("a delivered message lingers FADE_MS = 12 s (an MCP send settles almost at once), ×N while they share a line", () => {
    expect(T.FADE_MS).toBe(12_000);
    const s = T.createTrafficStore();
    s.apply(msg(1, "atlas", "ember", "delivered"), 0); s.apply(msg(2, "atlas", "ember", "delivered"), 5_000);
    const [e] = T.trafficEdges(s.items(), layout());
    expect([e.phase, e.n]).toEqual(["fading", 2]);
    s.sweep(11_999); expect(s.items()).toHaveLength(2);
    s.sweep(12_000); expect(s.items()).toHaveLength(1);
  });
});

describe("the page", () => {
  it("a delegation: drawn in progress from the stream, still there long after; its report: the return line, then gone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "performance"] });
    const m = mount(); await vi.advanceTimersByTimeAsync(50); await m;
    emit("delegation", del(1, "atlas", "ember")); await vi.advanceTimersByTimeAsync(20);
    expect(flows()).toEqual(["h-task ph-work"]);
    await vi.advanceTimersByTimeAsync(T.FADE_MS * 3);
    expect(flows(), "no report yet: still in progress").toEqual(["h-task ph-work"]);
    emit("delegation", del(1, "atlas", "ember", "done")); await vi.advanceTimersByTimeAsync(20);
    expect(flows()).toEqual(["h-report ph-return"]);
    const f = p.root.querySelector(".oc-flow");
    expect([f.getAttribute("marker-start"), f.getAttribute("marker-end")]).toEqual(["url(#oc-src-report)", "url(#oc-ah-report)"]);
    await vi.advanceTimersByTimeAsync(T.RETURN_MS + 1100);
    expect(flows()).toEqual([]);
    vi.useRealTimers();
  });
  it("#2135 review: a slow snapshot overtaken by the stream's done (and the return gone) never redraws the work", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "performance"] });
    let release!: () => void;
    hold = new Promise<void>((r) => { release = r; });
    snapshot = { now: "", items: [], delegations: [del(1, "atlas", "ember", "open", 1_000)] };   // as the server saw it when asked
    const m = mount(); await vi.advanceTimersByTimeAsync(50); await m;
    expect(flows(), "the read is still out").toEqual([]);
    emit("delegation", del(1, "atlas", "ember")); emit("delegation", del(1, "atlas", "ember", "done"));
    await vi.advanceTimersByTimeAsync(T.RETURN_MS + 1100);
    expect(flows()).toEqual([]);
    release(); await vi.advanceTimersByTimeAsync(50);
    expect(flows(), "the old answer arrives: nothing comes back").toEqual([]);
    vi.useRealTimers();
  });
  it("#2135 review: a slow snapshot that does not know a delegation the stream opened meanwhile does not end it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "performance"] });
    let release!: () => void;
    hold = new Promise<void>((r) => { release = r; });
    const m = mount(); await vi.advanceTimersByTimeAsync(50); await m;
    emit("delegation", del(2, "beacon", "kite")); await vi.advanceTimersByTimeAsync(20);
    expect(flows()).toEqual(["h-task ph-work"]);
    release(); await vi.advanceTimersByTimeAsync(50);
    expect(flows(), "the answer from before it: the line stays").toEqual(["h-task ph-work"]);
    vi.useRealTimers();
  });
  it("on opening, the snapshot's open delegations are drawn (a reload, the public link)", async () => {
    snapshot = { now: "", items: [], delegations: [del(1, "beacon", "lark", "open", 300_000)] };
    await mount();
    expect(flows()).toEqual(["h-task ph-work"]);
  });
  it("the key names in progress, done and no report yet", async () => {
    await mount();
    emit("delegation", del(1, "atlas", "ember")); await settle(2);
    const rows = p.root.querySelectorAll(".oc-legend .oc-lg").map((r: any) => r.textContent.trim());
    for (const s of ["in progress (until its report)", "done (report back)", "no report yet"]) expect(rows, s).toContain(s);
  });
});
