/**
 * #1918 phase 2, on a phone (the user's decision 2): the canvas opens on General and the first row of teams, packed
 * narrow (one team a row), no smaller than readable — not the whole fleet shrunk.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { page, settle, h, type AppPage } from "./helpers/app-harness.js";

const INSTANCES = [{ name: "atlas", status: "running", backend: "claude-code" },
  ...Array.from({ length: 14 }, (_, i) => ({ name: `m${i}`, status: "running", backend: "codex" }))];
const ORG = { general: ["atlas"], teams: [{ name: "One", members: ["m0", "m1", "m2", "m3", "m4"] }, { name: "Two", members: ["m5", "m6", "m7", "m8", "m9"] },
  { name: "Three", members: ["m10", "m11", "m12", "m13"] }], instances: {} };

let p: AppPage;
let C: any, O: any, app: any, fleet: any;
beforeAll(async () => {
  p = page({ url: "http://127.0.0.1:19280/ui/fleet/org", matchNarrow: true });
  (globalThis as any).fetch = async (url: string) => ({ ok: true, status: 200, json: async () => (url === "/ui/org" ? ORG : {}) });
  app = await import("/assets/app-store.js");
  fleet = await import("/ui/js/panel-fleet.js");
  C = await import("/ui/js/fleet-canvas.js");
  O = await import("/ui/js/fleet-org.js");
});
afterAll(() => { p.restore(); delete (globalThis as any).fetch; });

describe("the canvas on a phone", () => {
  it("narrow packing; opens on General and the first team at a readable size, starting at the left", async () => {
    app.appStore.set({ ready: true, instances: INSTANCES, exec: {}, awaiting: {}, needs: [] });
    await p.mount(h(fleet.FleetPanel, { route: { panel: "fleet", tab: "org" }, navKey: "fleet:org|1|en" })); await settle(6);
    const L = C.canvasLayout(O.buildOrgView(ORG, app.appStore.get()), new Set(), { narrow: true });
    // Drawn narrow: two columns at most, so "One" (five members) is three lines of two.
    const one = p.root.querySelectorAll(".oc-node").filter((n: any) => /^One\//.test(n.getAttribute("data-key")));
    expect(new Set(one.map((n: any) => n.getAttribute("transform").match(/\((\d+) /)[1])).size).toBe(2);
    const m = /translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(p.root.querySelector(".oc-world").getAttribute("transform"))!;
    const v = { x: +m[1]!, y: +m[2]!, k: +m[3]! }, r = C.openingRegion(L);
    expect(v).toEqual(C.fitView(r, { w: 960, h: 600 }, { margin: 12, minK: 0.75 }));
    // At a phone's width the region (General, the first team, the trunk) fits whole at a readable size.
    const ph = C.fitView(r, { w: 390, h: 600 }, { margin: 12, minK: 0.75 });
    expect(ph.k).toBeGreaterThanOrEqual(0.75);
    expect([ph.x + r.x * ph.k >= 12 - 1e-9, ph.x + (r.x + r.w) * ph.k <= 390 - 12 + 1e-9]).toEqual([true, true]);
    expect(r.y + r.h).toBeLessThan(L.boxes[1].y);
  });
});
