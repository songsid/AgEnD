/**
 * M-3665 (leftovers of #4421's review), the Fleet office and a Hub room's alike:
 * - paused and stopped (a Hub room's offline agent) no longer look the same: stopped is drawn faded, with a power-off
 *   mark beside it, on every style; paused as ever;
 * - one office zoomed out past TAG_READ_K (a phone's whole office, ~30 %) draws no 3 px name tags: the names show as a
 *   row of chips over the stage's foot, a call first;
 * - the zone chips under the stage wrap instead of scrolling off its edge ("Nap cor…").
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

let p: AppPage;
let Z: any, K: any, F: any, M: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  Z = await import("/ui/js/fleet-office-zones.js");
  K = await import("/ui/js/fleet-office-skin.js");
  F = await import("/ui/js/fleet-office.js");
  M = await import("/ui/js/fleet-office-model.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

const CSS = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8");
const rule = (sel: string) => { const i = CSS.indexOf(`${sel} {`); expect(i, sel).toBeGreaterThanOrEqual(0); return CSS.slice(i, CSS.indexOf("}", i)); };

/** A style drawn as the page draws it (drawPart): who is drawn at what alpha, and the marks (arcs) drawn after them. */
function scene(style: string, tagsOff: any = false, zoom = 1, o: { ratio?: number; hot?: string; cover?: boolean } = {}) {
  const base = K.SKINS.get(style), drawn: any[] = [], tags: string[] = [];
  const scales: number[] = [];
  const ctx: any = new Proxy({ globalAlpha: 1, font: "", measureText(t: string) { return { width: [...t].length * 6 }; }, arcs: 0, arc() { this.arcs++; },
    scale(k: number) { scales.push(k); }, transform(k: number) { scales.push(k); } } as any,
    { get(o, k) { if (k in o) return typeof o[k] === "function" ? o[k].bind(o) : o[k]; return () => {}; }, set(o, k, v) { o[k] = v; return true; } });
  const skin = { ...base, drawFurniture() {}, drawBackground() {}, drawBubble() {},
    drawCharacter: (c: any, box: any, look: any) => { drawn.push({ name: look.name, state: look.state, alpha: c.globalAlpha, arcsBefore: c.arcs }); },
    drawTag: (c: any, x: number, y: number, look: any) => { tags.push(look.label); } };
  const nodes = [{ name: "napper", state: "paused" }, { name: "offline", state: "stopped" }, { name: "caller", state: "stuck" }, { name: "worker", state: "working" }]
    .map((n) => ({ ...n, i: { name: n.name } }));
  const L = Z.zonesLayout(base.pack, nodes);
  const looks = new Map(L.rooms.flatMap((r: any) => r.desks).filter((d: any) => d.node).map((d: any) => [d.key,
    { name: d.node.name, label: d.node.name, state: d.node.state, pose: d.node.state === "stuck" ? "needs" : d.node.state === "stopped" ? "paused" : d.node.state }]));
  const part = F.partOf(L, looks, skin, true, Z.createWalkers(), { frame: () => [], size: () => 0 });
  const ratio = o.ratio ?? 1, a = zoom * ratio;          // drawPart's a: bitmap px a unit (the CSS zoom × the device ratio)
  const env = { pal: { ...K.DEFAULT_PAL }, mode: "light", labels: { areas: {} }, ratio };
  const callerKey = L.rooms.flatMap((r: any) => r.desks).find((d: any) => d.node && d.node.name === "caller")?.key;
  if (o.cover) part.cover = { x: -1e6, y: -1e6, w: 2e6, h: 2e6 };   // an open card over the whole scene (bitmap px)
  F.drawPart(ctx, part, a, 0, 0, 0, true, o.hot === "caller" ? callerKey : null, env, tagsOff);
  return { drawn, tags, arcs: ctx.arcs, scales };
}

/** The Desks style (no zones) as the page draws it: the scale applied to each offline mark (ctx.scale). */
function deskScene(zoom: number, ratio: number) {
  const scales: number[] = [];
  const ctx: any = new Proxy({ globalAlpha: 1, font: "", measureText(t: string) { return { width: [...t].length * 6 }; }, scale(k: number) { scales.push(k); } } as any,
    { get(o, k) { if (k in o) return typeof o[k] === "function" ? o[k].bind(o) : o[k]; return () => {}; }, set(o, k, v) { o[k] = v; return true; } });
  const base = K.SKINS.get("pixel");
  const skin = { ...base, drawCharacter() {}, drawTag() {}, drawBubble() {}, drawRoom() {}, drawDeskBack() {}, drawDeskFront() {} };
  const nodes = [{ name: "offline", state: "stopped" }, { name: "worker", state: "working" }].map((n) => ({ ...n, i: { name: n.name } }));
  const L = M.autoLayout([{ key: "d", name: "d", lobby: false, nodes }], { width: 1280 });
  const looks = new Map(M.desksOf(L).map((d: any) => [d.key, { name: d.node.name, label: d.node.name, state: d.node.state, pose: d.node.state === "stopped" ? "paused" : d.node.state }]));
  const part = F.partOf(L, looks, skin, false, Z.createWalkers(), { frame: () => [], size: () => 0 });
  F.drawPart(ctx, part, zoom * ratio, 0, 0, 0, true, null, { pal: { ...K.DEFAULT_PAL }, mode: "light", labels: { areas: {} }, ratio }, zoom < F.TAG_READ_K);
  return scales;
}

describe("paused and stopped (offline) look different", () => {
  for (const style of ["cozy", "studio", "studio-large", "guild", "school"]) {
    it(`${style}: stopped drawn faded with a power-off mark; paused, a call and work as ever`, () => {
      const s = scene(style), by = new Map(s.drawn.map((d: any) => [d.name, d]));
      expect((by.get("offline") as any).alpha).toBeLessThan(0.6);
      for (const n of ["napper", "caller", "worker"]) expect((by.get(n) as any).alpha, n).toBe(1);
      expect(s.arcs, "the power-off mark (its disc and ring)").toBeGreaterThanOrEqual(2);
    });
  }
  it("offLook: stopped only (not paused, not a call, not an empty desk)", () => {
    expect([F.offLook({ state: "stopped", pose: "paused" }), F.offLook({ state: "paused", pose: "paused" }), F.offLook({ state: "stuck", pose: "needs" }), F.offLook({ state: "stopped", pose: "away" }), F.offLook(null)])
      .toEqual([true, false, false, false, false]);
  });
});

describe("zoomed out past TAG_READ_K: the names as chips, not 3 px tags", () => {
  it("the threshold sits between a phone's whole office (~0.3) and a desk's fit (0.6 in a Hub room, 0.7+ in the Fleet)", () => {
    expect(F.TAG_READ_K).toBeGreaterThan(0.3);
    expect(F.TAG_READ_K).toBeLessThan(0.6);
  });
  it("tags off: no name tags drawn (a call's bubble is not a tag and still shows)", () => {
    expect(scene("cozy", false).tags.length).toBeGreaterThan(0);
    expect(scene("cozy", true).tags).toEqual([]);
  });
  const near = (xs: number[], k: number) => xs.some((s) => Math.abs(s - k) < 1e-9);
  for (const ratio of [1, 2, 3]) it(`leader's check (device ratio ${ratio}): too far out (CSS zoom 0.3), a caller's tag on the map at TAG_READ_K's size; nobody else's`, () => {
    const far = scene("cozy", true, 0.3, { ratio });
    expect(far.tags).toEqual(["caller"]);
    expect(near(far.scales, F.TAG_READ_K / 0.3)).toBe(true);        // by the CSS zoom (Prism #4423: not a = zoom × ratio)
    expect(scene("cozy", true, 1, { ratio }).tags).toEqual([]);      // tags off at a readable zoom (a small tile): as before
  });
  it("Hide names at 0.3: the caller's tag, once (as #4466)", () => { expect(scene("cozy", "names", 0.3, { ratio: 2 }).tags).toEqual(["caller"]); });
  it("a hovered caller gets one tag, never the small one and the readable one (Prism #4423)", () => {
    for (const ratio of [1, 2]) expect(scene("cozy", true, 0.3, { ratio, hot: "caller" }).tags, `ratio ${ratio}`).toEqual(["caller"]);
  });
  it("under an open card, no caller's tag (as every tag; Prism #4423)", () => {
    for (const ratio of [1, 2]) expect(scene("cozy", true, 0.3, { ratio, cover: true }).tags, `ratio ${ratio}`).toEqual([]);
  });
  it("cozy: the offline mark keeps its TAG_READ_K size when zoomed further out, whatever the device ratio; readable, drawn as is", () => {
    for (const ratio of [1, 2]) expect(near(scene("cozy", true, 0.3, { ratio }).scales, F.TAG_READ_K / 0.3), `ratio ${ratio}`).toBe(true);
    expect(scene("cozy", false, 1, { ratio: 2 }).scales).toEqual([]);
  });
  it("Desks (no zones): the same floor on its offline mark (Prism #4423: the desk path had none)", () => {
    for (const ratio of [1, 2]) expect(near(deskScene(0.3, ratio), F.TAG_READ_K / 0.3), `ratio ${ratio}`).toBe(true);
    expect(deskScene(1, 2)).toEqual([]);
  });
  it("leader's check: the name row is flat (no shadow) and fades at an edge with more to scroll, never a chip cut short", () => {
    expect(rule(".oo[data-tags-off] .oo-desks")).not.toContain("box-shadow");
    expect(rule(".oo[data-tags-off] .oo-desks[data-more-right]")).toContain("mask-image: linear-gradient(to right");
    expect(rule(".oo[data-tags-off] .oo-desks[data-more-left]")).toContain("mask-image: linear-gradient(to left");
    const src = readFileSync(join(process.cwd(), "src", "ui", "fleet-office.js"), "utf8");
    expect(src).toContain('<ul class="oo-desks" ref=${desksRef} onScroll=${desksCue}');
  });
  it("the CSS: the people row shows over the stage's foot, whole touch targets, a call first and marked", () => {
    const row = rule(".oo[data-tags-off] .oo-desks");
    for (const k of ["position: absolute", "clip: auto", "overflow-x: auto", "display: flex"]) expect(row).toContain(k);
    expect(rule(".oo[data-tags-off] .oo-desk")).toContain("min-height: var(--tap)");
    // Prism #4423: fullscreen too (its canvas draws no tags either below TAG_READ_K) — no rule leaves .fs out.
    expect(CSS).not.toMatch(/\.oo\[data-tags-off\]:not\(\.fs\)/);
    expect(rule(".oo[data-tags-off] .oo-desks > li[data-call]")).toContain("order: -1");
    expect(rule(".oo[data-tags-off] .oo-desks > li[data-call] .oo-desk")).toContain("border-color: var(--warn)");
  });
  it("#4466 Hide names: the zoomed-out row keeps only the callers, and none at all when nobody calls", () => {
    expect(rule(".oo[data-tags-off][data-names-off] .oo-desks > li:not([data-call])")).toContain("display: none");
    expect(rule(".oo[data-tags-off][data-names-off] .oo-desks:not(:has(> li[data-call]))")).toContain("display: none");
    const src = readFileSync(join(process.cwd(), "src", "ui", "fleet-office.js"), "utf8");
    expect(src).toContain('data-names-off=${namesOff ? "" : undefined}');   // on the element data-tags-off is toggled on (ooRef)
    // One office: too far out to read hides every tag; otherwise Hide names keeps the callers' (as the All-offices tiles).
    expect(src).toContain('v.k < TAG_READ_K || (s.namesOff ? "names" : false)');
  });
});

describe("the zone chips under the stage wrap, never cut", () => {
  it("wrap, no sideways scroll, no edge fade", () => {
    const r = rule(".oo > .oo-zone-pills, .oo > .oo-zone-pills[data-more-left], .oo > .oo-zone-pills[data-more-right]");
    for (const k of ["flex-wrap: wrap", "overflow-x: visible", "mask-image: none"]) expect(r).toContain(k);
  });
});
