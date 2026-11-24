/**
 * M-3633: a person's card leaves the office in view.
 * - On a phone the bottom sheet takes at most half the window (any pack card: a large avatar and every section scroll
 *   inside it), its actions stay at its foot, and a swipe down closes it only from its top (scrolled in, it scrolls).
 * - On a desk the floating card keeps off the areas' names (cardSpot): the same spot when it covers none, else lower,
 *   else the other side, else the spot covering the least.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error — a JS module of the app, with no types
import { cardSpot } from "../src/ui/fleet-office-view.js";
import { page, h, settle, type AppPage } from "./helpers/app-harness.js";
import { fire } from "./helpers/mini-dom.js";

const CSS = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.css"), "utf8");
const rule = (sel: string) => { const i = CSS.indexOf(`${sel} {`); expect(i, sel).toBeGreaterThanOrEqual(0); return CSS.slice(i, CSS.indexOf("}", i)); };

describe("the phone sheet (app.css)", () => {
  it("at most half the window, plain and pack cards alike; it scrolls; its actions stay at its foot", () => {
    expect(rule(".oo-card.sheet")).toContain("max-height: var(--oo-sheet-max, 50dvh)");
    expect(rule(".oo-card-custom.sheet .oo-card-body")).toContain("max-height: var(--oo-sheet-max, 50dvh)");
    expect(CSS).not.toMatch(/\.oo-card[^{]*\.sheet[^{]*\{[^}]*75dvh/);
    expect(rule(".oo-card.sheet")).toContain("touch-action: pan-y");
    const actions = rule(".oo-card.sheet .oo-card-actions, .oo-card-custom.sheet .oo-card-actions");
    expect(actions).toContain("position: sticky");
    expect(actions).toContain("background: var(--oo-card-bg, var(--surface))");
  });
});

describe("a swipe down closes the sheet only from its top", () => {
  let card: any;
  const mounted: AppPage[] = [];
  beforeAll(async () => { const p = page(); card = await import("/ui/js/fleet-office-card.js"); p.restore(); });
  afterEach(async () => { for (const p of mounted.splice(0)) { await p.unmount(); p.restore(); } });
  const open = async () => {
    const p = page(); mounted.push(p);
    let closed = 0;
    const model = card.cardModel({ node: { name: "n", display_name: "Notes", status: "running", execution_state: "idle" }, lv: () => 1, levels: null, share: true, rows: [], display: "Notes", state: "Idle", now: "", where: "" });
    await p.mount(h(card.OfficeCard, { model, avatar: () => {}, sheet: true, place: () => {}, onFind: () => {}, onClose: () => { closed++; } }));
    await settle(4);
    return { el: p.root.querySelector(".oo-card.sheet") as any, closed: () => closed };
  };
  const swipe = (el: any, dy: number) => { fire(el, "pointerdown", { clientY: 100 }); fire(el, "pointerup", { clientY: 100 + dy }); };
  it("at its top: a swipe of 60 px or more closes it, a short one does not", async () => {
    const c = await open();
    swipe(c.el, 30); expect(c.closed()).toBe(0);
    swipe(c.el, 80); expect(c.closed()).toBe(1);
  });
  it("scrolled into it: the same swipe scrolls it and never closes it", async () => {
    const c = await open();
    c.el.scrollTop = 120;
    swipe(c.el, 80); expect(c.closed()).toBe(0);
    c.el.scrollTop = 0;
    swipe(c.el, 80); expect(c.closed()).toBe(1);
  });
});

describe("cardSpot: beside the person, clear of the areas' names", () => {
  const base = { gap: 20, cw: 300, ch: 400, w: 1200, h: 700 };
  it("no names in the way: right of them, level with their head (as before)", () => {
    expect(cardSpot({ ...base, px: 400, py: 300 })).toEqual({ x: 420, y: 276 });
    expect(cardSpot({ ...base, px: 1000, py: 300 })).toEqual({ x: 680, y: 276 });             // no room right: left
    expect(cardSpot({ ...base, px: 400, py: 650 })).toEqual({ x: 420, y: 292 });              // kept inside the stage
  });
  it("a name under the spot: lower, just under it", () => {
    const avoid = [{ x: 450, y: 250, w: 200, h: 40 }];
    expect(cardSpot({ ...base, px: 400, py: 300, h: 800, avoid })).toEqual({ x: 420, y: 296 });
  });
  it("lower does not fit: the other side", () => {
    const avoid = [{ x: 490, y: 150, w: 200, h: 40 }];
    expect(cardSpot({ ...base, px: 500, py: 300, h: 560, avoid })).toEqual({ x: 180, y: 152 });
  });
  it("nowhere clear: the spot covering the least", () => {
    const avoid = [{ x: 0, y: 0, w: 1200, h: 700 }];
    expect(cardSpot({ ...base, px: 400, py: 300, avoid })).toEqual({ x: 420, y: 276 });
  });
});
