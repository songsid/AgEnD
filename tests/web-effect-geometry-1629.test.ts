import { describe, expect, it, vi } from "vitest";
const { createEffectGeometry, hostEffectRect, hostEffectSpace } = await import(new URL("../src/ui/shared/effect-geometry.js", import.meta.url).href);
const rect = { x: 10, y: 20, width: 100, height: 80 };
function fixture(options = {}) {
  const sheets: any[] = [], doc: any = { adoptedStyleSheets: [] as any[] };
  const html = { ownerDocument: doc, parentElement: null, isConnected: true }; doc.documentElement = html;
  const host = { document: doc, getComputedStyle: vi.fn(() => ({ transform: "none", perspective: "none", filter: "none", contain: "none", willChange: "auto" } as Record<string, string>)), CSS: { supports: vi.fn(() => true) }, CSSStyleSheet: class {
    cssRules: any[] = [];
    constructor() { sheets.push(this); }
    insertRule(_css: string, index: number) { const values = new Map<string, string>(); this.cssRules.splice(index, 0, { style: { values, setProperty: vi.fn((k: string, v: string, priority: string) => { expect(priority).toBe("important"); values.set(k, v); }), getPropertyValue: (k: string) => values.get(k) ?? "" } }); return index; }
    deleteRule(i: number) { this.cssRules.splice(i, 1); }
  } };
  const trusted: any[] = [], root = { querySelectorAll: vi.fn(() => trusted) }, classes = new Set<string>();
  const values = () => sheets[0]?.cssRules[0]?.style.values ?? new Map();
  const frame = { ownerDocument: doc, parentElement: html, isConnected: true, getBoundingClientRect: vi.fn(() => Object.fromEntries(["x", "y", "width", "height"].map(k => [k, parseFloat(values().get(k === "x" ? "left" : k === "y" ? "top" : k))]))), classList: { add: vi.fn((x: string) => classes.add(x)), remove: vi.fn((x: string) => classes.delete(x)) }, remove: vi.fn() };
  host.getComputedStyle.mockImplementation(() => ({ transform: "none", perspective: "none", filter: "none", contain: "none", willChange: "auto", ...Object.fromEntries(["position", "pointerEvents", "visibility", "opacity", "zIndex", "clipPath"].map(k => [k, values().get(k.replace(/[A-Z]/g, c => "-" + c.toLowerCase()))])) }));
  const api = createEffectGeometry({ window: host, trustRoot: root, ...options });
  return { api, frame, trusted, host, root, sheets, classes, bind(by = "agent", layer = "front") { return api.bind(frame, { by, layer }); }, style: () => sheets[0].cssRules[0].style };
}
const trust = (r = { x: 20, y: 30, width: 10, height: 10 }) => ({ isConnected: true, getBoundingClientRect: () => r });
describe("#1629 CSSOM effect placement and trust holes", () => {
  it("uses a host-generated class and owned stylesheet with no inline attribute", () => {
    const h = fixture(), binding = h.bind(); expect(binding.ok).toBe(true); expect(h.host.document.adoptedStyleSheets).toEqual([h.sheets[0]]);
    expect([...h.classes]).toEqual([expect.stringMatching(/^agend-effect-geometry-\d+$/)]); expect(h.style().values.get("visibility")).toBe("hidden");
    expect(h.style().values.get("pointer-events")).toBe("none"); expect(h.style().values.get("opacity")).toBe("0.85"); expect(h.style().values.get("z-index")).toBe("20");
    expect(binding.sync(rect)).toBe(true); expect(h.style().values.get("left")).toBe("10px"); expect(h.style().values.get("width")).toBe("100px"); expect(h.style().values.get("visibility")).toBe("visible");
    expect(h.frame).not.toHaveProperty("style");
  });
  it("copies native DOMRect fields, clips padded composer/reply/prompt rectangles and updates after movement", () => {
    const h = fixture(), b = h.bind(); class NativeRect { x = 20; y = 30; width = 10; height = 10; }
    h.trusted.push(trust(new NativeRect()), trust({ x: 50, y: 30, width: 10, height: 10 }), trust({ x: 80, y: 30, width: 10, height: 10 }));
    expect(b.sync(rect)).toBe(true); const initial = h.style().values.get("clip-path"); expect(initial).toContain("M2 2H28V28H2Z"); expect(initial).toContain("M32 2H58V28H32Z"); expect(initial).toContain("M62 2H88V28H62Z");
    h.trusted.splice(0, 3, trust({ x: 21.2, y: 31.2, width: 10, height: 10 })); b.hide(); expect(h.style().values.get("visibility")).toBe("hidden");
    expect(b.sync(rect)).toBe(true); expect(h.style().values.get("clip-path")).toContain("M3 3H30V30H3Z");
  });
  it("protects an unmarked provenance as an agent, while human front and behind frames have no holes", () => {
    for (const [by, layer, clipped, opacity] of [["unknown", "front", true, "0.85"], ["human", "front", false, "1"], ["agent", "behind", false, "1"]] as const) {
      const h = fixture(), b = h.bind(by, layer); h.trusted.push(trust()); expect(b.sync(rect)).toBe(true);
      expect(h.style().values.get("clip-path")).toBe(clipped ? 'path(evenodd, "M0 0H100V80H0ZM2 2H28V28H2Z")' : "none"); expect(h.style().values.get("opacity")).toBe(opacity);
      expect(h.style().values.get("pointer-events")).toBe("none");
    }
  });
  it.each(["missing", "nonfinite", "disconnected", "many"])("unknown trust geometry %s hides, never reuses an old clip as visible", fault => {
    const h = fixture(), b = h.bind(); expect(b.sync(rect)).toBe(true);
    if (fault === "missing") h.root.querySelectorAll.mockImplementation(() => { throw Error("unknown"); });
    else if (fault === "nonfinite") h.trusted.push(trust({ x: NaN, y: 1, width: 2, height: 3 }));
    else if (fault === "disconnected") h.trusted.push({ ...trust(), isConnected: false });
    else h.trusted.push(...Array.from({ length: 129 }, () => trust()));
    expect(b.sync(rect)).toBe(false); expect(h.style().values.get("visibility")).toBe("hidden");
  });
  it("accepts native SVG command serialization while preserving each coordinate token", () => {
    const h = fixture(), b = h.bind(); h.trusted.push(trust());
    h.style().getPropertyValue = () => 'path(evenodd, "M 0 0 H 100 V 80 H 0 Z M 2 2 H 28 V 28 H 2 Z")';
    expect(b.sync(rect)).toBe(true); expect(h.style().values.get("visibility")).toBe("visible");
    h.style().getPropertyValue = () => 'path(evenodd, "M 0 0 H 10 V 80 H 0 Z M 22 2 H 28 V 28 H 2 Z")';
    expect(b.sync(rect)).toBe(false); expect(h.style().values.get("visibility")).toBe("hidden");
  });
  it("a failed CSS rule binding removes its rule and frame", () => {
    const h = fixture(); h.frame.classList.add.mockImplementation(() => { throw Error("class unavailable"); });
    expect(h.bind()).toMatchObject({ ok: false }); expect(h.sheets[0].cssRules).toHaveLength(0); expect(h.frame.remove).toHaveBeenCalledOnce();
  });
  it("a rejected CSS path stays hidden instead of falling back to no clipping", () => {
    const h = fixture(), b = h.bind(); h.style().setProperty.mockImplementation((k: string, v: string) => { if (k !== "clip-path") h.style().values.set(k, v); });
    expect(b.sync(rect)).toBe(false); expect(h.style().values.get("visibility")).toBe("hidden");
  });
  it.each(["position", "pointerEvents", "visibility", "opacity", "zIndex", "clipPath"])("a computed %s cascade mismatch never reveals the frame", key => {
    const h = fixture(), b = h.bind(), original = h.host.getComputedStyle.getMockImplementation()!;
    h.host.getComputedStyle.mockImplementation(() => ({ ...original(), [key]: "unknown" }));
    expect(b.sync(rect)).toBe(false); expect(h.style().values.get("visibility")).toBe("hidden");
    if (key === "visibility") expect(h.frame.remove).toHaveBeenCalled();
  });
  it.each(["x", "y", "width", "height"])("a physical %s mismatch never reveals the frame", key => {
    const h = fixture(), b = h.bind(); h.frame.getBoundingClientRect.mockReturnValue({ ...rect, [key]: rect[key as keyof typeof rect] + 1 });
    expect(b.sync(rect)).toBe(false); expect(h.style().values.get("visibility")).toBe("hidden");
  });
  it.each([{ x: NaN }, { x: 1.2 }, { y: 1e8 }, { width: 0 }, { height: 4097 }, { width: 4096, height: 4096 }])("rejects unknown/unbounded frame rectangle %s", patch => {
    const h = fixture(), b = h.bind(); expect(b.sync({ ...rect, ...patch })).toBe(false); expect(h.style().values.get("visibility")).toBe("hidden");
  });
  it("a disconnected or foreign-document frame cannot be revealed", () => {
    const h = fixture(), b = h.bind(); h.frame.isConnected = false; expect(b.sync(rect)).toBe(false);
    h.frame.isConnected = true; h.frame.ownerDocument = {} as any; expect(b.sync(rect)).toBe(false); expect(h.style().values.get("visibility")).toBe("hidden");
  });
  it("hiding is immediate and disposal physically removes every frame and only its own stylesheet", () => {
    const h = fixture(), b = h.bind(), other = {}; h.host.document.adoptedStyleSheets.push(other); b.sync(rect); h.api.hide(); expect(h.style().values.get("visibility")).toBe("hidden");
    h.api.dispose(); h.api.dispose(); expect(h.frame.remove).toHaveBeenCalledOnce(); expect(h.classes.size).toBe(0); expect(h.sheets[0].cssRules).toHaveLength(0); expect(h.host.document.adoptedStyleSheets).toEqual([other]); expect(b.sync(rect)).toBe(false); expect(h.api.bind(h.frame, { layer: "front" }).ok).toBe(false);
  });
  it.each(["transform", "perspective", "filter", "backdropFilter", "contain", "willChange", "zoom", "contentVisibility", "rotate", "scale", "translate", "offsetPath"])("an unknown %s viewport space refuses before a rule and hides an existing frame", key => {
    const h = fixture(), b = h.bind(); expect(b.sync(rect)).toBe(true);
    h.host.getComputedStyle.mockImplementation(() => ({ transform: "none", perspective: "none", filter: "none", contain: "none", willChange: "auto", [key]: "unknown" }));
    expect(b.sync(rect)).toBe(false); expect(h.style().values.get("visibility")).toBe("hidden"); expect(h.bind().ok).toBe(false); expect(h.sheets[0].cssRules).toHaveLength(1);
  });
  it("unreadable or disconnected viewport axes fail closed", () => {
    const h = fixture(); h.host.getComputedStyle.mockImplementation(() => { throw Error("unknown"); }); expect(hostEffectSpace(h.host, h.frame)).toBe(false);
    expect(hostEffectSpace(h.host, null)).toBe(false);
  });
  it("CSS capabilities are required before creating a binding", () => {
    expect(createEffectGeometry().ok).toBe(false); const h = fixture({ window: { document: {}, CSS: { supports: () => false } } }); expect(h.api.ok).toBe(false); expect(h.sheets).toHaveLength(0);
  });
});
describe("host rectangle snapshot", () => {
  it("rounds outward and never passes a DOMRect prototype into policy", () => {
    expect(hostEffectRect(trust({ x: 1.2, y: 2.8, width: 50.2, height: 30.3 }))).toEqual({ x: 1, y: 2, width: 51, height: 32 });
  });
  it.each([null, { isConnected: false }, trust({ x: 1, y: 2, width: Infinity, height: 3 }), trust({ x: 1, y: 2, width: 5000, height: 3 }), trust({ x: 1, y: 2, width: 0, height: 3 })])("unknown or excessive viewport geometry refuses %s", node => expect(hostEffectRect(node)).toBeNull());
});
