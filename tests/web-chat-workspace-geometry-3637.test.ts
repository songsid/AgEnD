import { describe, expect, it } from "vitest";
import * as geometry from "/assets/pane-geometry.js";
import * as model from "/assets/chat-workspace-model.js";

describe("one physical geometry for split, dock and float", () => {
  it.each(["right", "stack"])("clamps %s at both real pane minimums, not just a percentage", layout => {
    const min = layout === "stack" ? 320 : 360, total = layout === "stack" ? 700 : 900;
    const low = geometry.splitSize(900, 700, layout, .1), high = geometry.splitSize(900, 700, layout, .9);
    expect(low.first).toBe(min); expect(high.second).toBe(min);
    expect(low.first + low.second + geometry.SASH).toBe(total);
    expect(geometry.splitSize(900, 700, layout, NaN).first).toBe((total - 8) / 2);
  });
  it("bounds a restored or resized floating pane to the chat area", () => {
    expect(geometry.floatBox(900, 700, { x: -200, y: 900, width: 2000, height: 100 })).toEqual({ x: 0, y: 340, width: 900, height: 360 });
    const first = geometry.floatBox(1000, 900);
    expect(first.width).toBe(560); expect(first.height).toBe(460);
    expect(first.x + first.width).toBeLessThanOrEqual(1000); expect(first.y + first.height).toBeLessThanOrEqual(820);
    expect(Object.values(geometry.floatBox(900, 700, { x: NaN, y: Infinity, width: NaN, height: -Infinity })).every(Number.isFinite)).toBe(true);
  });
  it("rejects outside drops and previews the exact edge half or center", () => {
    const rect = { left: 100, top: 50, width: 800, height: 600 };
    for (const [x, y, zone] of [[110, 350, "left"], [890, 350, "right"], [500, 60, "top"], [500, 640, "bottom"], [500, 350, "center"]] as const) expect(geometry.dropZone(rect, x, y)).toBe(zone);
    expect(geometry.dropZone(rect, 99, 350)).toBeNull(); expect(geometry.dropZone(rect, 500, 651)).toBeNull();
    expect(geometry.dropBox(rect, "right")).toEqual({ left: 500, top: 50, width: 400, height: 600 });
    expect(geometry.dropBox(rect, "top")).toEqual({ left: 100, top: 50, width: 800, height: 300 });
  });
});

describe("float URLs and preferences stay topology-only", () => {
  it("retains a physical minimum on an ultra-wide screen rather than imposing a second percentage minimum", () => {
    const w: any = { ...model.openBeside(null, { panel: "chat", instance: "alpha" }, "beta"), ratio: 360 / 4992 };
    const restored: any = model.readWorkspace(new URL(model.workspacePath(w), "https://fleet.example"));
    expect(geometry.splitSize(5000, 900, restored.layout, restored.ratio).first).toBe(360);
    expect(geometry.splitSize(5000, 900, "right", 0).first).toBe(360);
    expect(geometry.splitSize(5000, 900, "right", 1).second).toBe(360);
  });
  it("roundtrips a bounded float without persisting drafts or arbitrary fields", () => {
    const w: any = { ...model.openBeside(null, { panel: "chat", instance: "alpha" }, "beta"), layout: "float", floating: "a", rect: { x: 10, y: 20, width: 560, height: 460, token: "discard" } };
    const saved = model.saveWorkspace(w), next: any = model.restoreWorkspace(saved);
    expect(next?.layout).toBe("float"); expect(next?.floating).toBe("a"); expect(next?.rect).toEqual({ x: 10, y: 20, width: 560, height: 460 });
    expect(JSON.stringify(saved)).not.toContain("discard");
    expect(model.readWorkspace(new URL(model.workspacePath(next), "https://fleet.example"), null, true)).toEqual(next);
    expect(model.readWorkspace(new URL("https://fleet.example/ui/chat/alpha?compare=beta&layout=float&floatX=NaN"), null, true)).toBeNull();
    expect(model.twoPaneFits(1400, 900, 350, "float")).toBe(false);
  });
});

describe("a dock remains a two-agent topology", () => {
  it("retiring a floating layout removes its stale rectangle and floating owner", () => {
    const w: any = { ...model.openBeside(null, { panel: "chat", instance: "alpha" }, "beta"), layout: "float", floating: "b", rect: { x: 20, y: 30, width: 560, height: 460 } };
    for (const zone of ["left", "right", "top", "bottom"]) {
      const dock: any = model.dockWorkspace(w, "a", zone, "beta");
      expect(dock).not.toHaveProperty("floating"); expect(dock).not.toHaveProperty("rect");
      expect(dock.a).toBe(w.a); expect(dock.b).toBe(w.b);
    }
  });
  it("re-docks or swaps the existing pane without duplicating or remounting either agent", () => {
    const w: any = model.openBeside(null, { panel: "log", instance: "alpha" }, "beta");
    const dock: any = model.dockWorkspace(w, "a", "left", "beta");
    expect(dock.a).toBe(w.a); expect(dock.b).toBe(w.b); expect(dock.flipped).toBe(true); expect(dock.focus).toBe("b");
    expect(model.dockWorkspace(w, "a", "center", "beta")?.flipped).toBe(true);
    expect(model.dockWorkspace(w, "a", "center", "alpha")).toBe(w);
  });
  it("a third agent replaces the target alone and the requested edge decides visual order", () => {
    const w: any = model.openBeside(null, { panel: "chat", instance: "alpha" }, "beta");
    const dock: any = model.dockWorkspace(w, "a", "bottom", "gamma");
    expect(dock.a.route.instance).toBe("gamma"); expect(dock.b).toBe(w.b); expect(dock.layout).toBe("stack"); expect(dock.flipped).toBe(true);
    expect(model.dockWorkspace(w, "b", "center", "gamma")?.a).toBe(w.a);
    expect(model.dockWorkspace(w, "b", "outside", "gamma")).toBe(w);
    expect(model.dockWorkspace(w, "b", "right", "../unsafe")).toBe(w);
  });
});
