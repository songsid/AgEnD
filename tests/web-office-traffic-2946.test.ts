/**
 * #2946 (hxhsandy; the user's minimal step, hmsg-c9478146): the Office's traffic items — the task, message, report and
 * broadcast props carried between desks — were too small and too fast, read as glitches.
 * - Bigger: the built-in props are drawn PROP_SCALE (1.75×) larger, in the scene's units (so they scale with the room as
 *   its people do); a pack's own `props` keep their size.
 * - Slower: at least FLIGHT.MIN_MS (2.5 s) in the air. A burst never becomes a backlog lagging the events: at most
 *   FLIGHT.MAX in the air or waiting to start, the newest of a burst fly, the rest are dropped, and a trip under way is
 *   never cut short for a new one. The same in All offices (between tiles).
 * - A key: the Office's Key toggle (only while it shows traffic) opens a strip under its bar with the four shapes, as
 *   the scene draws them, and their words, in en and zh-TW; the org chart's line key is the canvas's only.
 * - Reduced motion: nothing flies (unchanged).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const INSTANCES = [
  { name: "atlas", display_name: "Atlas", status: "running", backend: "claude-code" },
  { name: "quill", status: "running", backend: "kiro-cli" },
];
const ORG = { general: ["atlas"], teams: [{ name: "Web", members: ["quill"] }], instances: {} };
const STORE = { ready: true, instances: INSTANCES, exec: {}, awaiting: {}, needs: [] };
const id16 = (n: number) => n.toString(16).padStart(16, "0");

let p: AppPage;
let M: any, O: any, K: any, F: any, I: any, app: any, nav: any, fleet: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org" });
  (globalThis as any).fetch = async (url: string) => ({ ok: true, status: 200,
    json: async () => (url === "/ui/org" ? ORG : url === "/ui/offices" ? { rev: 0, offices: [] } : url === "/ui/office-skins" ? { rev: "", packs: [] }
      : url === "/ui/traffic" ? { items: [], delegations: [] } : {}) });
  app = await import("/assets/app-store.js");
  nav = await import("/assets/app-nav.js");
  nav.startRouter(p.window);
  I = await import("/assets/app-i18n.js");
  fleet = await import("/ui/js/panel-fleet.js");
  M = await import("/ui/js/fleet-office-model.js");
  O = await import("/ui/js/fleet-office-overview.js");
  K = await import("/ui/js/fleet-office-skin.js");
  F = await import("/ui/js/fleet-office.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });
beforeEach(async () => { await p.unmount(); p.storage.clear(); nav.navigate("/ui/fleet/org"); app.appStore.set(STORE); });

// Two desks side by side: the shortest trip there is.
const L = () => ({ mode: "desks", width: 400, height: 200, rooms: [{ key: "r", x: 0, y: 0, w: 400, h: 200, desks: [
  { key: "a", x: 0, y: 0, w: 88, h: 53, node: { name: "atlas" }, seat: { x: 40, y: 60 } },
  { key: "b", x: 100, y: 0, w: 88, h: 53, node: { name: "quill" }, seat: { x: 140, y: 60 } }] }], waypoints: [], edges: [] });
const item = (n: number, o: Record<string, unknown> = {}) => ({ id: id16(n), from: "atlas", to: "quill", kind: "send", state: "delivering", fading: false, ...o });

describe("slower: at least 2.5 s in the air", () => {
  it("the shortest trip still takes MIN_MS: in the air just before it, gone after", () => {
    expect(M.FLIGHT.MIN_MS).toBeGreaterThanOrEqual(2500);
    expect(M.flightMs(1)).toBe(M.FLIGHT.MIN_MS);
    expect(M.flightMs(1e6)).toBe(M.FLIGHT.MAX_MS);
    const f = M.createFlights(), l = L();
    f.sync([item(1)], 0);
    expect(f.frame(0, l)).toHaveLength(1);
    expect(f.frame(M.FLIGHT.MIN_MS - 100, l)).toHaveLength(1);                 // 100 px at SPEED would be ~0.3 s: held to 2.5 s
    expect(f.frame(M.FLIGHT.MIN_MS + 1, l)).toEqual([]);
  });
});

describe("a burst never becomes a backlog", () => {
  it("a burst of 30: the newest MAX fly, each within (MAX − 1) × STAGGER of now; the rest are dropped, never queued", () => {
    const f = M.createFlights(), l = L();
    expect(f.sync(Array.from({ length: 30 }, (_, k) => item(k + 1)), 1000)).toBe(M.FLIGHT.MAX);
    expect(f.size()).toBe(M.FLIGHT.MAX);
    const latest = 1000 + (M.FLIGHT.MAX - 1) * M.FLIGHT.STAGGER_MS;
    expect(latest - 1000).toBeLessThanOrEqual(2500);                              // the last starts within 2.5 s of the event
    const up = f.frame(latest, l).map((x: any) => x.id);
    expect(up).toEqual(Array.from({ length: M.FLIGHT.MAX }, (_, k) => id16(30 - M.FLIGHT.MAX + 1 + k)));
    // All landed by the last's start + MAX_MS; the 18 dropped never fly later.
    expect(f.frame(latest + M.FLIGHT.MAX_MS + 1, l)).toEqual([]);
    expect(f.size()).toBe(0);
    expect(f.sync(Array.from({ length: 30 }, (_, k) => item(k + 1)), latest + M.FLIGHT.MAX_MS + 2)).toBe(0);
  });
  it("a trip under way is never cut short for a new one: a full sky drops the newcomers; once one lands, the next flies", () => {
    const f = M.createFlights({ max: 3 }), l = L();
    f.sync([item(1), item(2), item(3)], 0);
    const first = f.frame(1000, l).map((x: any) => x.id);
    expect(first).toEqual([id16(1), id16(2), id16(3)]);
    expect(f.sync([item(4), item(5)], 1000)).toBe(0);                            // no room: dropped, not queued
    expect(f.frame(1500, l).map((x: any) => x.id)).toEqual(first);                 // the three keep flying
    const landed = M.FLIGHT.MIN_MS + 2 * M.FLIGHT.STAGGER_MS + 1;
    expect(f.frame(landed, l)).toEqual([]);
    expect(f.sync([item(6)], landed)).toBe(1);
    expect(f.frame(landed, l).map((x: any) => x.id)).toEqual([id16(6)]);
  });
  it("between tiles (All offices): the same cap and the same minimum", () => {
    const f = O.createCrossFlights();
    expect(f.sync(Array.from({ length: 30 }, (_, k) => item(k + 1)), 0)).toBe(M.FLIGHT.MAX);
    expect(f.size()).toBe(M.FLIGHT.MAX);
    expect(f.sync([item(99)], 10)).toBe(0);
  });
  it("reduced motion: nothing flies (and what was seen is not flown later)", () => {
    const f = M.createFlights();
    expect(f.sync([item(1)], 0, true)).toBe(0);
    expect(f.size()).toBe(0);
    expect(f.sync([item(1)], 10)).toBe(0);
  });
});

function recCtx() {
  const rects: number[][] = [];
  let m = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const ctx: any = {
    fillStyle: "", save() { stack.push(m.slice()); }, restore() { m = stack.pop()!; },
    translate(x: number, y: number) { m = [m[0], m[1], m[2], m[3], m[4] + m[0] * x + m[2] * y, m[5] + m[1] * x + m[3] * y]; },
    scale(sx: number, sy: number) { m = [m[0] * sx, m[1] * sx, m[2] * sy, m[3] * sy, m[4], m[5]]; },
    beginPath() {}, ellipse() {}, fill() {},
    fillRect(x: number, y: number, w: number, hh: number) { rects.push([m[0] * x + m[4], m[3] * y + m[5], m[0] * w, m[3] * hh]); },
    drawImage(...a: number[]) { rects.push(a.slice(-4)); },
  };
  return { ctx, rects };
}
const extent = (rects: number[][]) => ({ w: Math.max(...rects.map((r) => r[0] + r[2])) - Math.min(...rects.map((r) => r[0])),
  h: Math.max(...rects.map((r) => r[1] + r[3])) - Math.min(...rects.map((r) => r[1])) });
const env = () => ({ pal: K.DEFAULT_PAL });

describe("bigger: the built-in props at PROP_SCALE", () => {
  // Each shape's art width (Q = 2 px per art pixel): the folder, envelope and horn 8 art pixels across, the paper 6.
  it.each([["task", 16], ["send", 16], ["report", 12], ["broadcast", 16]])("%s: its %i px art drawn 1.5–2× larger, centred on its point", (hue, art) => {
    expect(K.PROP_SCALE).toBeGreaterThanOrEqual(1.5);
    expect(K.PROP_SCALE).toBeLessThanOrEqual(2);
    const { ctx, rects } = recCtx();
    K.pixelSkin.drawProp(ctx, { hue, kind: hue, x: 500, y: 300, t: 0 }, 0, env());
    const e = extent(rects);
    expect(e.w).toBeCloseTo((art as number) * K.PROP_SCALE, 5);                  // was `art` px across before #2946
    const left = Math.min(...rects.map((r) => r[0])), right = Math.max(...rects.map((r) => r[0] + r[2]));
    expect((left + right) / 2).toBeCloseTo(500, 5);                              // centred on its point, as before
  });
  it("on Cozy, Guild and School (the picture styles fall back to the built-in prop) the same size; a pack's own prop keeps its size", () => {
    for (const id of ["cozy", "guild", "school"]) {
      const { ctx, rects } = recCtx();
      K.skinFor(id).drawProp(ctx, { hue: "task", kind: "task", x: 500, y: 300, t: 0 }, 0, env());
      expect(extent(rects).w, id).toBeCloseTo(16 * K.PROP_SCALE, 5);
    }
    const pack = { ...K.COZY_PACK, props: { send: { src: "p.png", w: 10, h: 10, dw: 20, dh: 20, frames: 1, fps: 1, ax: 5, ay: 10 } } };
    const sk = K.spriteSkin(pack, new Map([["p.png", { width: 10, height: 10 }]]), K.studioSkin);
    const { ctx, rects } = recCtx();
    sk.drawProp(ctx, { hue: "send", kind: "send", x: 500, y: 300, t: 0 }, 0, env());
    expect(rects).toHaveLength(1);
    expect(rects[0].slice(2)).toEqual([20, 20]);                                   // drawn at the pack's own size (dw × dh)
  });
});

describe("the key", () => {
  const office = async () => {
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: `fleet:org|${Math.random()}|en` })); await settle(6);
    p.root.querySelectorAll(".oc-tools .seg-inline button")[2].click(); await settle(6);
  };
  it("the Office's Key toggle opens the four shapes with their words, kept per browser; the org chart's line key is the canvas's", async () => {
    await office();
    expect(p.root.querySelector(".oc-key")).toBeNull();                         // the lines' key: not in the Office
    const btn = () => p.root.querySelector(".oo-key-btn");
    expect(btn()?.textContent).toBe("Key");
    expect(btn()?.getAttribute("aria-expanded")).toBe("false");
    expect(p.root.querySelector(".oo-key")).toBeNull();
    btn().click(); await settle(4);
    expect(btn()?.getAttribute("aria-expanded")).toBe("true");
    const rows = p.root.querySelectorAll(".oo-key-row");
    expect(rows.map((r: any) => r.getAttribute("data-kind"))).toEqual(["task", "send", "report", "broadcast"]);
    expect(rows.map((r: any) => r.querySelector("span").textContent)).toEqual(["Folder: a task", "Envelope: a message", "Paper: a report", "Horn: a broadcast"]);
    expect(rows.every((r: any) => r.querySelector("canvas.oo-key-icon"))).toBe(true);
    expect(p.storage.get("agend_org_office_key")).toBe("1");
    await p.unmount(); await office();
    expect(p.root.querySelectorAll(".oo-key-row")).toHaveLength(4);             // still open here
    // Back on the canvas: its own key toggle.
    p.root.querySelectorAll(".oc-tools .seg-inline button")[0].click(); await settle(4);
    expect(p.root.querySelector(".oc-key")).not.toBeNull();
    expect(p.root.querySelector(".oo-key")).toBeNull();
  });
  it("no Key while the Office shows no traffic (Live off)", async () => {
    p.storage.set("agend_org_live", "0");
    await office();
    expect(p.root.querySelector(".oo-key-btn")).toBeNull();
  });
  it("the words in zh-TW, every key in both languages; the rows are the scene's four kinds, in their theme tokens", () => {
    const keys = ["key", "keyTitle", "keyLabel", "keyTask", "keySend", "keyReport", "keyBroadcast"];
    expect(keys.map((k) => I.tIn("zh-TW", `orgo.${k}`))).toEqual(["圖例", "桌子之間傳遞的物品代表什麼", "桌子之間傳遞的物品", "資料夾：任務", "信封：訊息", "紙張：回報", "喇叭：廣播"]);
    for (const k of keys) expect(I.tIn("en", `orgo.${k}`), k).not.toBe(`orgo.${k}`);
    expect(F.KEY_KINDS.map(([hue]: string[]) => hue)).toEqual(Object.keys(K.DEFAULT_PAL.fx));
  });
});
