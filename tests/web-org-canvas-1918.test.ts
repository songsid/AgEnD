/**
 * #1918 phase 2: Fleet → Org chart as a canvas (src/ui/fleet-canvas.js).
 * - Layout: fixed slots — folding a team or searching moves no other team; rows wrap at a width; the tree is a stem, a
 *   bus per row, a trunk joining rows, a drop per team (none for the instances in no team).
 * - The view: pan (drag, after a few pixels), pinch, wheel and + / − / 0; the transform is one SVG attribute that a
 *   re-render keeps; a phone opens on General and the first row (the user's decision 2), never smaller than readable.
 * - A card opens the instance's chat (not after a drag); a team folds per device; search dims the rest, counts, and
 *   Enter unfolds and shows the first match; Canvas or List per device (the list is #1389's chart).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const INSTANCES = [
  { name: "atlas", display_name: "Atlas", status: "running", backend: "claude-code" },
  { name: "pixel", display_name: "Comet", status: "running", backend: "codex" },
  ...["quill", "sage", "orbit", "nova", "ember", "lark", "moss", "juno", "flint", "wren"].map((name, i) => ({ name, status: "running", backend: ["codex", "kiro-cli", "grok"][i % 3] })),
  { name: "tide", status: "crashed", backend: "claude-code" },
];
const ORG = {
  general: ["atlas"],
  teams: [{ name: "Platform", members: ["pixel", "quill", "sage", "orbit"] }, { name: "Web", members: ["nova", "ember", "lark", "moss", "juno"] },
    { name: "Research", members: ["flint", "wren"] }, { name: "Empty", members: [] }],
  instances: {},
};

let orgAnswer: unknown = ORG;
let p: AppPage;
let C: any, O: any, app: any, fleet: any, nav: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  (globalThis as any).fetch = async (url: string) => ({ ok: true, status: 200, json: async () => (url === "/ui/org" ? orgAnswer : {}) });
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  nav.startRouter(p.window);
  fleet = await import("/ui/js/panel-fleet.js");
  C = await import("/ui/js/fleet-canvas.js");
  O = await import("/ui/js/fleet-org.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => {
  await p.unmount();
  p.storage.clear();
  orgAnswer = ORG;
  nav.navigate("/ui/fleet/org");
  app.appStore.set({ ready: true, instances: INSTANCES, exec: { atlas: "working", quill: "working" }, awaiting: {}, needs: [] });
});
const mount = async () => { await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: `fleet:org|${Math.random()}|en` })); await settle(6); };
const svg = () => p.root.querySelector(".oc-svg");
const world = () => p.root.querySelector(".oc-world");
const card = (name: string) => p.root.querySelectorAll(".oc-node").find((n: any) => n.getAttribute("data-name") === name);
const team = (key: string) => p.root.querySelectorAll(".oc-team").find((n: any) => n.getAttribute("data-team") === key);
const tf = () => { const m = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(world().getAttribute("transform")); return m ? { x: +m[1]!, y: +m[2]!, k: +m[3]! } : null; };
const view = () => O.buildOrgView(ORG, app.appStore.get());
/** Nine more instances in no team: a fleet taller than the viewport is wide (fitting its height is smaller than its width). */
const tall = () => app.appStore.set((s: any) => ({ ...s, instances: [...INSTANCES, ...Array.from({ length: 9 }, (_, i) => ({ name: `extra-${i}`, status: "running", backend: "codex" }))] }));

describe("layout: fixed slots", () => {
  it("General on top, centred; teams in order in rows that wrap; members in 1–3 columns; the instances in no team last, loose", () => {
    const L = C.canvasLayout(view());
    expect(L.tops.map((c: any) => c.node.name)).toEqual(["atlas"]);
    expect(L.tops[0].x + L.tops[0].w / 2).toBeCloseTo(L.width / 2);
    expect(L.boxes.map((b: any) => [b.name, b.cols, b.cells.length, b.loose])).toEqual([["Platform", 2, 4, false], ["Web", 3, 5, false], ["Research", 2, 2, false],
      ["Empty", 1, 0, false], [null, 1, 1, true]]);
    // Platform (2 columns) + Web (3) fill a row (ROW_MAX); Research, Empty and the rest wrap to a second.
    const rows = [...new Set(L.boxes.map((b: any) => b.y))];
    expect(rows).toHaveLength(2);
    expect(L.boxes.filter((b: any) => b.y === rows[0]).map((b: any) => b.name)).toEqual(["Platform", "Web"]);
    for (const b of L.boxes) expect(b.x + b.w <= C.OC.ROW_MAX || b.x === 0, b.name).toBe(true);
    // Cards sit inside their box, never on each other.
    for (const b of L.boxes) for (const c of b.cells) expect(c.x >= b.x && c.y >= b.y + C.OC.HEAD && c.x + c.w <= b.x + b.w && c.y + c.h <= b.y + b.h).toBe(true);
    expect(L.boxes.find((b: any) => b.name === "Empty").h).toBe(C.OC.FOLDED);
  });
  it("folding a team moves no other team (each slot is sized as if open); only its own cells go", () => {
    const open = C.canvasLayout(view()), shut = C.canvasLayout(view(), new Set(["Web"]));
    const at = (L: any) => L.boxes.map((b: any) => [b.key, b.x, b.y, b.w]);
    expect(at(shut)).toEqual(at(open));
    const web = shut.boxes.find((b: any) => b.key === "Web");
    expect([web.folded, web.cells.length, web.h, web.slotH]).toEqual([true, 0, C.OC.FOLDED, open.boxes.find((b: any) => b.key === "Web").slotH]);   // one summary row
    expect(shut.boxes.find((b: any) => b.key === "Platform").cells).toHaveLength(4);
    // A whole row folded: the rows below stay where they were too.
    expect(at(C.canvasLayout(view(), new Set(["Platform", "Web"])))).toEqual(at(open));
    expect(C.canvasLayout(view(), new Set(["Empty"])).boxes.find((b: any) => b.key === "Empty").folded, "nothing to fold").toBe(false);
    // The instances in no team fold by a key no team name can be.
    expect(C.canvasLayout(view(), new Set([C.REST_KEY])).boxes.at(-1).folded).toBe(true);
  });
  it("a folded team's states wrap inside its box, most pressing first; it grows only within its slot", () => {
    const states = ["needs", "crashed", "stuck", "working", "idle", "paused", "stopped", "missing"];
    const counts = states.map((st, i) => [st, i + 1]);
    const en = { needs: "Needs you", crashed: "Crashed", stuck: "Looks stuck", working: "Working", idle: "Idle", paused: "Paused", stopped: "Stopped", missing: "Not in the fleet" } as Record<string, string>;
    const zh = { needs: "等你回應", crashed: "已當掉", stuck: "似乎卡住", working: "工作中", idle: "閒置", paused: "已暫停", stopped: "已停止", missing: "不在 fleet 中" } as Record<string, string>;
    for (const [w, labels] of [[434, en], [636, en], [434, zh], [232, en]] as const) {
      const rows = C.summaryRows(counts, w, (st: string, n: number) => `${n} ${labels[st]}`);
      expect(rows.flat().map((it: any) => it.s), `${w}`).toEqual(states);
      // Every item starts inside the box and ends before its right padding (an item alone on its row may not, but none is that wide here).
      for (const row of rows) { const last = row[row.length - 1]; expect(last.dx + 24 + [...last.label].reduce((x: number, ch: string) => x + (ch.codePointAt(0)! >= 0x2e80 ? 12 : 6.6), 0)).toBeLessThanOrEqual(w - 14 + 1e-9); }
      expect(rows.length, `${w}`).toBeGreaterThan(1);
    }
    expect(C.summaryRows(counts, 434, (st: string, n: number) => `${n} ${zh[st]}`).length).toBeGreaterThanOrEqual(C.summaryRows(counts, 636, (st: string, n: number) => `${n} ${en[st]}`).length);
    // In a layout: an eight-member team with eight states, folded, narrow and wide; the whole row folded too.
    const mixed = { top: [], teams: [{ name: "Mixed", nodes: states.map((st) => ({ name: st, state: st })), counts }, { name: "Next", nodes: [{ name: "x", state: "idle" }], counts: [["idle", 1]] }], rest: { nodes: [], counts: [] } };
    for (const narrow of [false, true]) {
      const open = C.canvasLayout(mixed, new Set(), { narrow, label: (st: string, n: number) => `${n} ${en[st]}` });
      const shut = C.canvasLayout(mixed, new Set(["Mixed", "Next"]), { narrow, label: (st: string, n: number) => `${n} ${en[st]}` });
      const box = shut.boxes[0];
      expect(box.summary.length).toBeGreaterThan(1);
      expect(box.h).toBeGreaterThanOrEqual(C.OC.HEAD + 10 + box.summary.length * 20);
      expect(box.h).toBeLessThanOrEqual(open.boxes[0].h);
      expect(shut.boxes.map((b: any) => [b.x, b.y])).toEqual(open.boxes.map((b: any) => [b.x, b.y]));
    }
  });
  it("the tree: General's stem, a bus per row, the trunk joining the rows, one drop per team; none for the loose box", () => {
    const L = C.canvasLayout(view());
    const teamed = L.boxes.filter((b: any) => !b.loose);
    expect(L.tree).toHaveLength(1 + 1 + 2 + teamed.length);
    expect(L.tree[0]).toBe(`M${L.tops[0].x + L.tops[0].w / 2} ${L.tops[0].y + L.tops[0].h} V${teamed[0].busY}`);
    expect(L.tree).toContain(`M${C.OC.TRUNK} ${teamed[0].busY} V${teamed.at(-1).busY}`);
    for (const b of teamed) expect(L.tree).toContain(`M${b.x + b.w / 2} ${b.busY} V${b.y}`);
    const loose = L.boxes.find((b: any) => b.loose);
    expect(L.tree.some((d: string) => d.startsWith(`M${loose.x + loose.w / 2} `))).toBe(false);
    // One row, no General: no stem, no trunk.
    const one = C.canvasLayout({ ...view(), top: [], teams: view().teams.slice(0, 1), rest: { nodes: [], counts: [] } });
    expect(one.tree).toEqual([`M${one.boxes[0].x + one.boxes[0].w / 2} ${one.boxes[0].busY} H${one.boxes[0].x + one.boxes[0].w / 2}`, `M${one.boxes[0].x + one.boxes[0].w / 2} ${one.boxes[0].busY} V${one.boxes[0].y}`]);
    // Two in General: each drops to a joiner, one stem from its middle.
    const two = C.canvasLayout({ ...view(), top: [view().top[0], { ...view().top[0], name: "bridge" }] });
    expect(two.tops).toHaveLength(2);
    expect(two.tree.slice(0, 4).every((d: string) => d.startsWith("M"))).toBe(true);
    expect(two.tree[2]).toBe(`M${two.tops[0].x + two.tops[0].w / 2} ${two.tops[0].y + two.tops[0].h + 16} H${two.tops[1].x + two.tops[1].w / 2}`);
  });
  it("a phone packs narrower: one team a row, at most two columns", () => {
    const L = C.canvasLayout(view(), new Set(), { narrow: true });
    expect(L.boxes.map((b: any) => b.cols)).toEqual([2, 2, 2, 1, 1]);
    expect(new Set(L.boxes.map((b: any) => b.y)).size).toBe(L.boxes.length);
    expect(Math.max(...L.boxes.map((b: any) => b.w))).toBeLessThanOrEqual(C.OC.ROW_MAX_NARROW);
  });
  it("a phone's opening region: General and the first row of teams only", () => {
    const L = C.canvasLayout(view());
    const r = C.openingRegion(L), first = L.boxes.filter((b: any) => b.busY === L.boxes[0].busY);
    expect(r.y).toBe(L.tops[0].y);
    expect(r.x, "the trunk joining the rows is in view").toBe(C.OC.TRUNK - 8);
    expect(r.y + r.h).toBe(Math.max(...first.map((b: any) => b.y + b.slotH)));
    expect(r.y + r.h).toBeLessThan(L.boxes.at(-1).y);
  });
});

describe("the view's arithmetic", () => {
  it("zoomAt keeps the point under the cursor; zoom is clamped", () => {
    const v = { x: 40, y: -20, k: 1 }, z = C.zoomAt(v, 2, 300, 200);
    expect([(300 - v.x) / v.k, (200 - v.y) / v.k]).toEqual([(300 - z.x) / z.k, (200 - z.y) / z.k]);
    expect(C.zoomAt(v, 100, 0, 0).k).toBe(C.K_MAX);
    expect(C.zoomAt(v, 0.001, 0, 0).k).toBe(C.K_MIN);
  });
  it("fitView: the region as large as fits (≤ 1.25), centred across, from the top; minK holds it readable", () => {
    const f = C.fitView({ x: 0, y: 0, w: 1000, h: 500 }, { w: 548, h: 900 });
    expect(f.k).toBeCloseTo(0.5);
    expect([f.x + 500 * f.k, f.y]).toEqual([274, 24]);
    expect(C.fitView({ x: 0, y: 0, w: 100, h: 100 }, { w: 1000, h: 1000 }).k).toBe(1.25);
    // Held at minK and wider than the viewport: it starts at its left (a team's name is not cut off).
    expect(C.fitView({ x: 10, y: 0, w: 4000, h: 500 }, { w: 400, h: 800 }, { minK: 0.6 })).toEqual({ k: 0.6, x: 24 - 6, y: 24 });
    // widthOnly: the height runs on below.
    expect(C.fitView({ x: 0, y: 0, w: 1000, h: 5000 }, { w: 548, h: 600 }, { widthOnly: true }).k).toBeCloseTo(0.5);
    expect(C.fitView({ x: 0, y: 0, w: 100, h: 5000 }, { w: 548, h: 600 }, { widthOnly: true, maxK: 1 }).k).toBe(1);
  });
  it("nearest: the next card that way, preferring the one in line", () => {
    const cards = [{ key: "a", x: 0, y: 0, w: 10, h: 10 }, { key: "b", x: 100, y: 0, w: 10, h: 10 }, { key: "c", x: 60, y: 80, w: 10, h: 10 }, { key: "d", x: 0, y: 100, w: 10, h: 10 }];
    expect(C.nearest(cards, "a", [1, 0]).key).toBe("b");
    expect(C.nearest(cards, "a", [0, 1]).key).toBe("d");
    expect(C.nearest(cards, "a", [-1, 0])).toBeNull();
    expect(C.nearest(cards, "zz", [1, 0])).toBeNull();
  });
});

describe("the canvas on the page", () => {
  it("opens as the canvas: an SVG application with General's card, each member's card, its state, and a team per box", async () => {
    tall(); await mount();
    expect(svg().getAttribute("role")).toBe("application");
    expect(svg().getAttribute("aria-label")).toContain("Enter opens a chat");
    expect(card("atlas").getAttribute("class")).toContain("lead");
    expect(card("quill").getAttribute("aria-label")).toBe("quill — Working · Codex. Open chat");
    expect(card("quill").getAttribute("class")).toContain("st-working");
    expect(card("tide").getAttribute("class")).toContain("st-crashed");
    expect(p.root.querySelectorAll(".oc-team").map((g: any) => g.getAttribute("data-team"))).toEqual(["Platform", "Web", "Research", "Empty", C.REST_KEY]);
    expect(p.root.querySelectorAll(".oc-tree path")).toHaveLength(C.canvasLayout(view()).tree.length);
    expect(!!p.root.querySelector(".org-team"), "the list is not drawn too").toBe(false);
    // The desktop opening: the fleet's width in the viewport, from the top, no larger than life (no size in this DOM: 960 × 600).
    const v = tf()!, L = C.canvasLayout(view());
    expect(v.k).toBeCloseTo((960 - 48) / (L.width - C.OC.TRUNK + 40));
    expect(v.y).toBe(24);
    expect(L.height * v.k, "the rest is below").toBeGreaterThan(600 - 48);
  });
  it("a card opens that instance's chat; the click that ends a drag does not", async () => {
    await mount();
    card("quill").click(); await settle(2);
    expect(location.pathname).toBe("/ui/chat/quill");
    nav.navigate("/ui/fleet/org"); await mount();
    const before = tf()!;
    fire(card("sage"), "pointerdown", { pointerId: 1, clientX: 100, clientY: 100, pointerType: "mouse", button: 0 });
    fire(card("sage"), "pointermove", { pointerId: 1, clientX: 140, clientY: 130 });
    fire(card("sage"), "pointermove", { pointerId: 1, clientX: 160, clientY: 150 });
    fire(card("sage"), "pointerup", { pointerId: 1, clientX: 160, clientY: 150 });
    card("sage").click(); await settle(2);
    expect(location.pathname).toBe("/ui/fleet/org");
    const after = tf()!;
    expect([after.x - before.x, after.y - before.y, after.k]).toEqual([60, 50, before.k]);
    // A click with no pointer at all (a screen reader's), a moment after the drag: it opens.
    await settle(1);
    card("orbit").click(); await settle(2);
    expect(location.pathname).toBe("/ui/chat/orbit");
    nav.navigate("/ui/fleet/org"); await mount();
    fire(card("sage"), "pointerdown", { pointerId: 3, clientX: 100, clientY: 100, pointerType: "mouse", button: 0 });
    fire(card("sage"), "pointermove", { pointerId: 3, clientX: 160, clientY: 150 });
    fire(card("sage"), "pointerup", { pointerId: 3, clientX: 160, clientY: 150 });
    // A tap (no movement) after that drag opens again.
    fire(card("sage"), "pointerdown", { pointerId: 2, clientX: 10, clientY: 10, pointerType: "mouse", button: 0 });
    fire(card("sage"), "pointerup", { pointerId: 2, clientX: 10, clientY: 10 });
    await settle(1);
    card("sage").click(); await settle(2);
    expect(location.pathname).toBe("/ui/chat/sage");
  });
  it("Enter on a card opens; + / − / 0 zoom and fit; the wheel zooms; a re-render keeps the view", async () => {
    tall(); await mount();
    const k0 = tf()!.k;
    fire(svg(), "keydown", { key: "+" });
    expect(tf()!.k).toBeCloseTo(k0 * 1.25);
    fire(svg(), "keydown", { key: "-" });
    expect(tf()!.k).toBeCloseTo(k0);
    const wheel = fire(svg(), "wheel", { deltaY: -200, clientX: 0, clientY: 0 });
    expect(wheel.defaultPrevented, "the wheel zooms the canvas, not the page").toBe(true);
    const zoomed = tf()!;
    expect(zoomed.k).toBeGreaterThan(k0);
    app.appStore.set((s: any) => ({ ...s, exec: { ...s.exec, sage: "working" } })); await settle(4);
    expect(card("sage").getAttribute("class")).toContain("st-working");
    expect(tf(), "the live state re-rendered; the view stayed").toEqual(zoomed);
    // 0 (and Fit) show the whole fleet, height too (no size in this DOM: 960 × 600).
    const L = C.canvasLayout(view()), fitK = C.fitView({ x: C.OC.TRUNK - 20, y: 0, w: L.width - C.OC.TRUNK + 40, h: L.height + 10 }, { w: 960, h: 600 }).k;
    fire(svg(), "keydown", { key: "0" });
    expect(tf()!.k).toBeCloseTo(fitK);
    expect(fitK).toBeLessThan(k0);
    p.root.querySelectorAll(".oc-zoom button")[0].click();
    expect(tf()!.k).toBeCloseTo(fitK * 1.25);
    p.root.querySelectorAll(".oc-zoom button")[2].click();
    expect(tf()!.k).toBeCloseTo(fitK);
    fire(card("pixel"), "keydown", { key: "Enter" }); await settle(2);
    expect(location.pathname).toBe("/ui/chat/pixel");
  });
  it("a card that gets focus off screen is brought into view; one in view stays put", async () => {
    await mount();
    for (let i = 0; i < 4; i++) fire(svg(), "keydown", { key: "+" });
    const v0 = tf()!;
    fire(card("atlas"), "focusin");
    const v1 = tf()!, L = C.canvasLayout(view()), c = L.tops[0];
    expect([v1.x + (c.x + c.w / 2) * v1.k, v1.y + (c.y + c.h / 2) * v1.k, v1.k]).toEqual([480, 300, v0.k]);
    fire(card("atlas"), "focusin");
    expect(tf()).toEqual(v1);
  });
  it("two pointers pinch from their first move: the canvas point under the old midpoint goes to the new one", async () => {
    await mount();
    const v0 = tf()!;
    const down = (id: number, x: number, y = 300) => fire(svg(), "pointerdown", { pointerId: id, clientX: x, clientY: y, pointerType: "touch" });
    const move = (id: number, x: number, y = 300) => fire(svg(), "pointermove", { pointerId: id, clientX: x, clientY: y });
    down(1, 400); down(2, 500);
    move(2, 600);                                                          // no warm-up move: 100 → 200 apart, midpoint 450 → 500
    const v1 = tf()!;
    expect(v1.k).toBeCloseTo(v0.k * 2);
    expect([(500 - v1.x) / v1.k, (300 - v1.y) / v1.k], "the point that was under 450 is under 500").toEqual([expect.closeTo((450 - v0.x) / v0.k), expect.closeTo((300 - v0.y) / v0.k)]);
    // Both fingers move the same way: the canvas pans with them, no zoom.
    move(1, 450); move(2, 650);
    const v2 = tf()!;
    expect([v2.k, v2.x - v1.x]).toEqual([expect.closeTo(v1.k), expect.closeTo(50)]);
    // Together again (200 → 100 apart): back to the opening zoom.
    move(2, 550);
    expect(tf()!.k).toBeCloseTo(v0.k);
    // One finger lifted: the other pans on at once (even a few pixels: it is no tap).
    fire(svg(), "pointerup", { pointerId: 2 });
    const v3 = tf()!;
    move(1, 453);
    expect(tf()!.x - v3.x).toBeCloseTo(3);
    fire(svg(), "pointerup", { pointerId: 1 });
    card("quill").click(); await settle(2);
    expect(location.pathname, "the click that ends a pinch opens nothing").toBe("/ui/fleet/org");
  });
  it("a third finger lifted: the two left pinch on from where they are", async () => {
    await mount();
    const down = (id: number, x: number) => fire(svg(), "pointerdown", { pointerId: id, clientX: x, clientY: 300, pointerType: "touch" });
    down(1, 400); down(2, 500); down(3, 900);
    fire(svg(), "pointerup", { pointerId: 3 });
    const v0 = tf()!;
    fire(svg(), "pointermove", { pointerId: 2, clientX: 600, clientY: 300 });
    expect(tf()!.k).toBeCloseTo(v0.k * 2);
  });
  it("pinchView: the old midpoint's canvas point lands on the new midpoint; zoom by the spans' ratio, clamped", () => {
    const v = { x: 10, y: 20, k: 1 }, from = { mid: { x: 100, y: 100 }, dist: 50 }, to = { mid: { x: 160, y: 90 }, dist: 100 };
    const z = C.pinchView(v, from, to);
    expect([z.k, (160 - z.x) / z.k, (90 - z.y) / z.k]).toEqual([2, 90, 80]);
    expect(C.pinchView(v, from, { ...to, dist: 50 * 1000 }).k).toBe(C.K_MAX);
  });
  it("a search's Enter moves the view once: later renders (the stream, clearing the search, a fold) keep where the person went", async () => {
    await mount();
    const input = p.root.querySelector(".oc-find input");
    input.value = "moss"; fire(input, "input"); await settle(2);
    fire(input, "keydown", { key: "Enter" }); await settle(4);
    const centred = tf()!;
    fire(svg(), "keydown", { key: "ArrowLeft" }); fire(svg(), "keydown", { key: "-" });
    const moved = tf()!;
    expect(moved).not.toEqual(centred);
    app.appStore.set((s: any) => ({ ...s, exec: { ...s.exec, flint: "working" } })); await settle(4);
    expect(tf(), "an unrelated state change").toEqual(moved);
    input.value = ""; fire(input, "input"); await settle(2);
    expect(tf(), "the search cleared").toEqual(moved);
    team("Research").querySelector(".oc-toggle").click(); await settle(2);
    expect(tf(), "another team folded").toEqual(moved);
    // A new Enter moves it again.
    input.value = "moss"; fire(input, "input"); await settle(2);
    fire(input, "keydown", { key: "Enter" }); await settle(4);
    expect(tf()).toEqual(centred);
  });
  it("the arrow keys move between cards; the canvas itself pans", async () => {
    await mount();
    card("pixel").focus();
    fire(card("pixel"), "keydown", { key: "ArrowRight" });
    expect((document.activeElement as any).getAttribute("data-name")).toBe("quill");      // names, not nodes: a failing diff of a DOM node never ends
    fire(card("quill"), "keydown", { key: "ArrowDown" });
    expect((document.activeElement as any).getAttribute("data-name")).toBe("orbit");
    const v = tf()!;
    fire(svg(), "keydown", { key: "ArrowLeft" });
    expect(tf()!.x).toBe(v.x + 80);
  });
  it("a team folds per device: its cards go, a summary shows, the others stay put; it is still folded next time", async () => {
    await mount();
    const pos = () => p.root.querySelectorAll(".oc-box").map((r: any) => [r.getAttribute("x"), r.getAttribute("y")]);
    const before = pos();
    team("Web").querySelector(".oc-toggle").click(); await settle(2);
    expect(team("Web").querySelector(".oc-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(!!card("nova")).toBe(false);
    expect(team("Web").querySelectorAll(".oc-team-sum").map((t: any) => t.textContent)).toEqual(["5 Idle"]);
    expect(pos()).toEqual(before);
    expect(JSON.parse(localStorage.getItem("agend_org_folded")!)).toEqual(["Web"]);
    await p.unmount(); await mount();
    expect(!!card("nova")).toBe(false);
    fire(team("Web").querySelector(".oc-toggle"), "keydown", { key: "Enter" }); await settle(2);
    expect(!!card("nova")).toBe(true);
    expect(JSON.parse(localStorage.getItem("agend_org_folded")!)).toEqual([]);
    expect(team("Empty").querySelector(".oc-toggle").getAttribute("role"), "an empty team has nothing to fold").toBeNull();
  });
  it("search: the rest dims, a count; a match in a folded team says so; Enter unfolds it and shows the match", async () => {
    await mount();
    team("Web").querySelector(".oc-toggle").click(); await settle(2);
    const input = p.root.querySelector(".oc-find input");
    input.value = "MOS"; fire(input, "input"); await settle(2);
    expect(p.root.querySelector(".oc-found").textContent).toBe("1 found");
    expect(card("pixel").getAttribute("class")).toContain("dim");
    expect(team("Platform").getAttribute("class")).toContain("dim");
    expect(team("Web").querySelector(".oc-team-meta").textContent).toBe("1 found · expand");
    // The overview marks where the matches are: the folded team's box (its card is not drawn).
    expect(p.root.querySelectorAll(".oc-mini-team.match")).toHaveLength(1);
    expect(p.root.querySelectorAll(".oc-mini-hit")).toHaveLength(0);
    fire(input, "keydown", { key: "Enter" }); await settle(4);
    expect(card("moss").getAttribute("class")).toContain("match");
    expect(p.root.querySelectorAll(".oc-mini-hit").map((r: any) => [r.getAttribute("x"), r.getAttribute("y")])).toEqual([[card("moss").getAttribute("transform").match(/\((\d+) /)[1], card("moss").getAttribute("transform").match(/ (\d+)\)/)[1]]]);
    const v = tf()!, L = C.canvasLayout(view()), c = L.boxes.find((b: any) => b.key === "Web").cells.find((x: any) => x.node.name === "moss");
    expect(v.k).toBeGreaterThanOrEqual(1);
    expect([v.x + (c.x + c.w / 2) * v.k, v.y + (c.y + c.h / 2) * v.k]).toEqual([480, 300]);
    input.value = "come"; fire(input, "input"); await settle(2);
    expect(card("pixel").getAttribute("class")).toContain("match");           // the display name too ("Comet")
    input.value = "zzz"; fire(input, "input"); await settle(2);
    expect(p.root.querySelector(".oc-found").textContent).toBe("No match");
  });
  it("Canvas or List, per device: the list is #1389's chart under the same bar", async () => {
    await mount();
    const [canvasBtn, listBtn] = p.root.querySelectorAll(".oc-tools .seg-inline button");
    expect([canvasBtn.getAttribute("aria-pressed"), listBtn.getAttribute("aria-pressed")]).toEqual(["true", "false"]);
    listBtn.click(); await settle(2);
    expect(!!svg()).toBe(false);
    expect(p.root.querySelectorAll(".org-team h3").map((e: any) => e.textContent.trim())).toEqual(["Platform", "Web", "Research", "Empty", "Not in a team"]);
    expect(p.root.querySelectorAll(".org-head")).toHaveLength(1);          // the bar's count, not the list's own too
    expect(!!p.root.querySelector(".oc-find"), "search is the canvas's").toBe(false);
    expect(localStorage.getItem("agend_org_mode")).toBe("list");
    await p.unmount(); await mount();
    expect(!!svg()).toBe(false);
    p.root.querySelectorAll(".oc-tools .seg-inline button")[0].click(); await settle(2);
    expect(!!svg()).toBe(true);
  });
  it("a member the fleet no longer lists: a card that says so and opens nothing", async () => {
    orgAnswer = { ...ORG, teams: [{ name: "Platform", members: ["pixel", "gone"] }] };
    await mount();
    expect([card("gone").getAttribute("role"), card("gone").getAttribute("class")]).toEqual(["img", expect.stringContaining("st-missing")]);
    expect(card("gone").getAttribute("aria-label")).toBe("gone — Not in the fleet");
    card("gone").click(); await settle(2);
    fire(card("gone"), "keydown", { key: "Enter" }); await settle(2);
    expect(location.pathname).toBe("/ui/fleet/org");
  });
  it("the overview: a click centres the canvas there; the viewport is marked on it", async () => {
    await mount();
    const mini = p.root.querySelector(".oc-mini"), L = C.canvasLayout(view());
    const box = { x: C.OC.TRUNK - 30, y: 0, w: L.width - C.OC.TRUNK + 60, h: L.height + 20 };
    expect(mini.getAttribute("viewBox")).toBe(`${box.x} ${box.y} ${box.w} ${box.h}`);
    // Wider than the canvas's shape: the drawing is letterboxed left and right (and a click is measured from it).
    mini.getBoundingClientRect = () => ({ left: 0, top: 0, width: 600, height: 120, right: 600, bottom: 120 });
    fire(mini, "click", { clientX: 300, clientY: 60 });
    const v = tf()!;
    // The overview's middle is the whole's middle: it is now the viewport's middle (960 × 600 here).
    expect(v.x + (box.x + box.w / 2) * v.k).toBeCloseTo(480);
    expect(v.y + (box.y + box.h / 2) * v.k).toBeCloseTo(300);
    const mv = p.root.querySelector(".oc-mini-view");
    expect([+mv.getAttribute("x"), +mv.getAttribute("width")]).toEqual([-v.x / v.k, 960 / v.k]);
  });
  it("a folded team of eight states draws every count inside its box", async () => {
    orgAnswer = { ...ORG, teams: [{ name: "Mixed", members: ["pixel", "quill", "sage", "orbit", "nova", "ember", "lark", "ghost"] }] };
    app.appStore.set((s: any) => ({ ...s, exec: { quill: "working", sage: "stuck" }, awaiting: { pixel: "Allow?" },
      instances: s.instances.map((i: any) => (i.name === "orbit" ? { ...i, status: "crashed" } : i.name === "nova" ? { ...i, status: "paused" } : i.name === "ember" ? { ...i, status: "stopped" } : i)) }));
    await mount();
    team("Mixed").querySelector(".oc-toggle").click(); await settle(2);
    const box = team("Mixed").querySelector(".oc-box"), right = +box.getAttribute("x") + +box.getAttribute("width"), bottom = +box.getAttribute("y") + +box.getAttribute("height");
    const texts = team("Mixed").querySelectorAll(".oc-team-sum");
    expect(texts.map((t: any) => t.textContent)).toEqual(["1 Needs you", "1 Crashed", "1 Looks stuck", "1 Working", "1 Idle", "1 Paused", "1 Stopped", "1 Not in the fleet"]);
    for (const t of texts) { expect(+t.getAttribute("x")).toBeLessThan(right - 14); expect(+t.getAttribute("y")).toBeLessThan(bottom); }
    expect(new Set(texts.map((t: any) => t.getAttribute("y"))).size).toBeGreaterThan(1);
    // Each dot sits on its count's line.
    const dots = team("Mixed").querySelectorAll(".oc-dot");
    expect(dots.map((d: any) => +d.getAttribute("cy") + 4)).toEqual(texts.map((t: any) => +t.getAttribute("y")));
  });
  it("the identity colour's bar: a bar on every card, painted only where the bar is chosen (bar only, ring only, off)", async () => {
    app.appStore.set((s: any) => ({ ...s, instances: s.instances.map((i: any) => (i.name === "quill" ? { ...i, color: { person: "#cf222e" }, color_show: { person: ["bar"] } }
      : i.name === "sage" ? { ...i, color: { person: "#cf222e" }, color_show: { person: ["ring"] } } : i)) }));
    await mount();
    expect(p.root.querySelectorAll(".oc-node").every((n: any) => !!n.querySelector(".oc-idbar"))).toBe(true);
    const cls = (n: string) => card(n).getAttribute("class").split(" ").filter((c: string) => c.startsWith("id"));
    expect([cls("quill"), cls("sage")]).toEqual([["idc", "id-bar"], ["idc", "id-ring"]]);
    const css = (await import("node:fs")).readFileSync(new URL("../src/ui/shared/app.css", import.meta.url), "utf8");
    expect(css).toContain(".oc-idbar { display: none; }");
    expect(css).toContain(".oc-node.idc.id-bar .oc-idbar { display: inline; fill: var(--id); }");
    // Colours off for this host: no card is painted, bar or ring.
    localStorage.setItem("agend_color_off", "on");
    await p.unmount(); await mount();
    expect([cls("quill"), cls("sage")]).toEqual([[], []]);
  });
  it("no styles in markup: per-card values are SVG attributes (#1300)", async () => {
    await mount();
    expect(p.root.querySelectorAll("[style]")).toHaveLength(0);
    expect(card("quill").getAttribute("transform")).toMatch(/^translate\(\d+ \d+\)$/);
  });
});
