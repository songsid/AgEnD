import { describe, expect, it } from "vitest";
import * as model from "/assets/chat-workspace-model.js";
import { workspaceMemory } from "/assets/chat-workspace-memory.js";
import { followRoster } from "/assets/view-roster-store.js";

const url = (path: string) => new URL(path, "https://fleet.example");
const single = { panel: "chat", instance: "alpha" };
describe("two-pane navigation uses one bounded topology", () => {
  it("roundtrips each pane's view/category, focus and layout through a real route", () => {
    let w = model.openBeside(null, single, "beta", "stack");
    w = model.navigatePane(w, "a", url("/ui/fleet/agent/alpha?cat=runtime"));
    w = model.navigatePane(w, "b", url("/ui/log/beta"));
    const path = model.workspacePath(w);
    const next = model.readWorkspace(url(path), w);
    expect(next).toEqual(w);
    expect(path).not.toMatch(/token|secret|session/);
  });
  it("focus never changes leases and reopening an existing agent cannot duplicate it", () => {
    const w = model.openBeside(null, single, "beta");
    const focused = model.openBeside(w, single, "alpha");
    expect(focused.focus).toBe("a");
    expect(focused.a).toBe(w.a); expect(focused.b).toBe(w.b);
    expect(model.openBeside(null, single, "alpha")).toBeNull();
  });
  it("a message anchor belongs to exactly its pane and is excluded from device preferences", () => {
    let w = model.openBeside(null, single, "beta");
    w = model.navigatePane(w, "a", url("/ui/chat/alpha#m=abc-17"));
    w = model.navigatePane(w, "b", url("/ui/chat/beta#m=def-9"));
    const restored = model.readWorkspace(url(model.workspacePath(w)));
    expect(restored.a.hash).toBe("#m=abc-17"); expect(restored.b.hash).toBe("#m=def-9");
    expect(JSON.stringify(model.saveWorkspace(w))).not.toMatch(/abc-17|def-9/);
  });
  it("a third agent replaces only the non-focused pane and local tabs keep the other lease", () => {
    const w = model.openBeside(null, single, "beta");
    const next = model.openBeside(w, single, "gamma");
    expect(next.b).toBe(w.b); expect(next.a.route.instance).toBe("gamma");
    expect(next.a.seq).toBeGreaterThan(w.a.seq);
    const tab = model.navigatePane(next, "b", url("/view/beta"));
    expect(tab.a).toBe(next.a); expect(tab.b.route.panel).toBe("view");
    expect(tab.focus).toBe("b");
  });
  it("plain local navigation to an already open agent focuses it rather than duplicating it", () => {
    const w = model.openBeside(null, single, "beta");
    const next = model.navigatePane(w, "b", url("/ui/log/alpha"));
    expect(next.focus).toBe("a"); expect(next.a.route.panel).toBe("log");
    expect(next.b.route.instance).toBe("beta");
  });
  it("rejects malformed, duplicate, unsupported and oversized URL state", () => {
    for (const path of ["/ui/chat/alpha?compare=alpha", "/ui/chat/alpha?compare=beta&compare=gamma",
      "/ui/chat/alpha?compare=..%2Fsecret", "/settings?compare=beta", "/ui/chat/alpha?compare=beta&paneB=unknown",
      "/ui/chat/alpha?compare=" + "x".repeat(129)]) expect(model.readWorkspace(url(path))).toBeNull();
  });
  it("only persists topology, never arbitrary query data or message anchors", () => {
    let w = model.openBeside(null, single, "beta");
    w = model.navigatePane(w, "a", url("/ui/fleet/agent/alpha?cat=runtime&token=never-store#message"));
    const value = model.saveWorkspace(w);
    expect(JSON.stringify(value)).not.toMatch(/never-store|token|message|seq/);
    expect(model.restoreWorkspace(value)?.a.search).toBe("?cat=runtime");
    expect(model.restoreWorkspace({ ...value, b: value.a })).toBeNull();
  });
  it("uses actual available width and stack height without changing phone breakpoints", () => {
    expect(model.twoPaneFits(1200, 760, 700, "right")).toBe(true);
    expect(model.twoPaneFits(1199, 1000, 700, "right")).toBe(false);
    expect(model.twoPaneFits(1400, 759, 700, "right")).toBe(false);
    expect(model.twoPaneFits(1400, 900, 647, "stack")).toBe(false);
    expect(model.twoPaneFits(1400, 900, 648, "stack")).toBe(true);
  });
  it("isolates device layout by opaque viewer scope and tolerates blocked storage", () => {
    const saved = new Map<string, string>(), storage = { getItem: (k: string) => saved.get(k), setItem: (k: string, v: string) => saved.set(k, v), removeItem: (k: string) => saved.delete(k) };
    const a = workspaceMemory(storage, "a".repeat(64)), b = workspaceMemory(storage, "b".repeat(64));
    a.write(model.openBeside(null, single, "beta"));
    expect(a.read()?.b.route.instance).toBe("beta"); expect(b.read()).toBeNull();
    a.clear(); expect(a.read()).toBeNull();
    const denied = workspaceMemory(new Proxy({}, { get() { throw new Error("blocked"); } }), "a".repeat(64));
    expect(() => { denied.write(model.openBeside(null, single, "beta")); denied.clear(); }).not.toThrow();
    expect(denied.read()).toBeNull();
    workspaceMemory(storage, "a-person-or-token").write(model.openBeside(null, single, "beta")); expect(saved.size).toBe(0);
  });
  it("two View panes share one roster owner until the last pane releases it", () => {
    let starts = 0, ends = 0;
    const start = () => { starts++; return () => { ends++; }; };
    const a = followRoster(start), b = followRoster(start);
    expect(starts).toBe(1); a(); a(); expect(ends).toBe(0);
    b(); expect(ends).toBe(1);
    const next = followRoster(start); expect(starts).toBe(2); next(); expect(ends).toBe(2);
  });
});
