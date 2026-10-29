/**
 * #2860: in Cozy (the default style) an area over capacity used to show name tags — and #2761's level badges — on hover
 * or focus only (the crowd rule, #2513), so most of an ordinary fleet showed no name. Now a crowded area keeps a compact
 * tag (smaller font and plate, the badge left of it) on everyone it has room for, a neighbour's a row lower; one that
 * would still touch a tag already drawn, its badge included, is left to hover or focus. Uncrowded areas, the hovered
 * person and a tile too small to read (tagsOff, #2554) are as before.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, type AppPage } from "./helpers/app-harness.js";

let p: AppPage;
let Z: any, K: any, F: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  Z = await import("/ui/js/fleet-office-zones.js");
  K = await import("/ui/js/fleet-office-skin.js");
  F = await import("/ui/js/fleet-office.js");
});
afterAll(async () => { await p.unmount(); p.restore(); });

const NAMES = ["研一官網前端 claude", "grok-scout", "General 總管", "資料平台 dbt 模型新增", "agend-dev-claude", "qa-1", "infra-terraform-state",
  "codex-refactor-bot", "mobile-ios-release", "rd1-platform", "Release captain", "data-warehouse", "web-claude", "agend-reviewer",
  "doupo-manifests", "Grok — answers in threads", "nightly-bench", "sol", "kiro-steering", "awp-ota-frontend"];
const LEVELS = [12, 27, 3, 12, 27, 27, 40, 40, 8, 50, 120, 3, 8, 40, 1500, 120, 50, 3, 12, 27];

/** Cozy (the built-in pack, its picture not loaded) with every tag drawn recorded: [label, x, y, compact]. */
function scene(n: number, state = "idle", furniture: any[] = []) {
  const base = K.SKINS.get("cozy"), cozy = furniture.length ? { ...base, pack: { ...base.pack, furniture: [...base.pack.furniture, ...furniture] } } : base;
  const drawn: any[] = [];
  const skin = { ...cozy, drawCharacter() {}, drawFurniture() {}, drawBubble() {},
    drawTag: (ctx: any, x: number, y: number, look: any, env: any, compact = false) => { drawn.push({ label: look.label, x, y, compact, badge: look.badge }); } };
  const nodes = NAMES.slice(0, n).map((name) => ({ name, state, i: { name } }));
  const L = Z.zonesLayout(cozy.pack, nodes);
  const looks = new Map(L.rooms.flatMap((r: any) => r.desks).filter((d: any) => d.node).map((d: any, i: number) => [d.key,
    { name: d.node.name, label: d.node.name, state, pose: state, badge: { text: String(LEVELS[i % LEVELS.length]), tier: 1 } }]));
  const part = F.partOf(L, looks, skin, true, Z.createWalkers(), { frame: () => [], size: () => 0 });
  const ctx = new Proxy({ measureText: (t: string) => ({ width: [...t].length * 5.5 }), font: "" } as any,
    { get(o, k) { if (k in o) return o[k]; return () => {}; }, set(o, k, v) { o[k] = v; return true; } });
  const env = { pal: { ...K.DEFAULT_PAL }, mode: "dark", labels: { areas: {} } };
  const draw = (hot: string | null = null, tagsOff = false) => { drawn.length = 0; F.drawPart(ctx, part, 1, 0, 0, 0, true, hot, env, tagsOff); return [...drawn]; };
  const footprint = (t: any) => K.tagFootprint(ctx, K.tagBox(ctx, t.x, t.y, t.label, t.compact), t.badge, t.compact);
  return { L, draw, footprint, part, ctx, cozy };
}
const touch = (a: any, b: any) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("#2860 a crowded area keeps compact tags", () => {
  it("20 idle members in Cozy: the lounge is over capacity, and everyone has a tag — the crowd's compact", () => {
    const s = scene(20);
    expect([...s.L.over]).toContain("lounge");
    const tags = s.draw().filter((t) => NAMES.includes(t.label));
    const crowded = new Set(s.part.desks.filter((d: any) => s.L.over.has(d.area)).map((d: any) => d.node.name));
    expect(crowded.size).toBeGreaterThan(10);
    // Before: only the people outside a crowd (20 − crowded). Now all but one or two blocked in the densest spot.
    expect(tags.length).toBeGreaterThanOrEqual(18);
    for (const t of tags) expect(t.compact, t.label).toBe(crowded.has(t.label));
    const untagged = NAMES.filter((n) => !tags.some((t) => t.label === n));
    for (const n of untagged) expect(crowded.has(n), n).toBe(true);           // only a crowd's can be left to hover
  });

  it("no two tags touch, their level badges included", () => {
    for (const n of [12, 16, 20]) {
      const s = scene(n);
      const boxes = s.draw().map(s.footprint);
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(touch(boxes[i], boxes[j]), `${n}: ${i}×${j}`).toBe(false);
    }
  });

  it("a neighbour's compact tag drops a row (12) instead of going; one that still touches is left to hover", () => {
    const s = scene(20);
    const compact = s.draw().filter((t) => t.compact);
    const seat = new Map([...s.L.seats].map(([k, v]: any) => [k, v]));
    const drops = compact.map((t) => t.y - seat.get(t.label).y);
    expect(new Set(drops)).toEqual(new Set([0, 12]));
  });

  it("the hovered person keeps the full tag; a tile too small to read (tagsOff) still shows only that one", () => {
    const s = scene(20);
    const who = s.part.desks.find((d: any) => s.L.over.has(d.area));
    const hovered = s.draw(who.key).find((t) => t.label === who.node.name);
    expect(hovered.compact).toBe(false);
    const off = s.draw(who.key, true).filter((t) => NAMES.includes(t.label));
    expect(off.map((t) => [t.label, t.compact])).toEqual([[who.node.name, false]]);
  });

  it("#2862 review: a hovered person in the middle of the crowd keeps a full tag no compact one touches", () => {
    const s = scene(20);
    const inCrowd = s.part.desks.filter((d: any) => s.L.over.has(d.area)).sort((a: any, b: any) => a.seat.x - b.seat.x);
    for (const who of [inCrowd[Math.floor(inCrowd.length / 2)], inCrowd[1]]) {
      const drawn = s.draw(who.key);
      const full = drawn.find((t) => t.label === who.node.name);
      expect(full.compact).toBe(false);
      const fullBox = s.footprint(full);
      for (const t of drawn.filter((x) => x.compact)) expect(touch(s.footprint(t), fullBox), `${t.label} × ${who.node.name}`).toBe(false);
    }
  });

  it("#2862 review: a furniture item's own name in the crowded area is clear of every compact tag", () => {
    const probe = scene(20);
    const inCrowd = probe.part.desks.filter((d: any) => probe.L.over.has(d.area));
    const mid = inCrowd[Math.floor(inCrowd.length / 2)].seat;
    const s = scene(20, "idle", [{ id: "barista", label: "Barista bot", x: mid.x + 6, y: mid.y + 4, depth: "y" }]);
    const drawn = s.draw();
    const sign = drawn.find((t) => t.label === "Barista bot");
    expect(sign?.compact).toBe(false);
    for (const t of drawn.filter((x) => x.compact)) expect(touch(s.footprint(t), s.footprint(sign)), t.label).toBe(false);
  });

  it("an area with room keeps full tags (nothing over capacity: nothing compact)", () => {
    const s = scene(2);
    expect(s.L.over.size).toBe(0);
    expect(s.draw().filter((t) => t.compact)).toEqual([]);
  });

  it("the compact tag is smaller than the full one, and its badge sits whole to its left", () => {
    const { ctx } = scene(1);
    const full = K.tagBox(ctx, 100, 100, "agend-reviewer"), small = K.tagBox(ctx, 100, 100, "agend-reviewer", true);
    expect(small.h).toBeLessThan(full.h);
    expect(small.w).toBeLessThan(full.w);
    const foot = K.tagFootprint(ctx, small, { text: "1.5k", tier: 4 }, true);
    expect([foot.y, foot.h, foot.x + foot.w]).toEqual([small.y, small.h, small.x + small.w]);   // no higher, no taller: left only
    expect(foot.x).toBeLessThan(small.x);
  });
});
