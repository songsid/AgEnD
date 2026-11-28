import vm from "node:vm";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { s3bRig } from "./helpers/hub-s3b-rig.js";
import { appManifest, withAppIconLinks } from "../src/web-icons.js";

const source = readFileSync(new URL("../src/ui/shared/theme.js", import.meta.url), "utf8");
function browser(stored = "dark", systemLight = true) {
  const attrs = new Map<string, string>(); const nodes: any[] = [];
  const events: Record<string, (() => void)[]> = {}; const frames: (() => void)[] = [];
  let mutate = (_records?: unknown[]) => {}, mediaChange = () => {}, custom: string | null = null, ready = true;
  const root = { getAttribute: (k: string) => attrs.get(k), setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k), parentElement: null };
  const body = { parentElement: root }, header = { parentElement: body, getClientRects: () => [{}], getBoundingClientRect: () => ({ top: 0 }) };
  const make = () => ({ content: "", setAttribute(k: string, v: string) { (this as any)[k] = v; }, removeAttribute(k: string) { delete (this as any)[k]; }, remove() { nodes.splice(nodes.indexOf(this), 1); } });
  nodes.push(Object.assign(make(), { content: "#ffffff", media: "(prefers-color-scheme: light)" }), Object.assign(make(), { content: "#212121", media: "(prefers-color-scheme: dark)" }));
  const mode = () => attrs.get("data-theme") ?? (systemLight ? "light" : "dark");
  const document = { documentElement: root, body, head: { appendChild: (n: any) => nodes.push(n) }, createElement: make,
    querySelectorAll: (s: string) => s.includes("theme-color") ? [...nodes] : s === ".panel-head" ? [header] : [],
    addEventListener: (name: string, cb: () => void) => (events[name] ??= []).push(cb) };
  const window: any = { document, requestAnimationFrame: (cb: () => void) => frames.push(cb),
    getComputedStyle: (el: any) => ({ backgroundColor: !ready ? "" : el === header ? custom ?? "rgba(0, 0, 0, 0)" : el === body ? mode() === "dark" ? "rgb(33, 33, 33)" : "rgb(255, 255, 255)" : "rgba(0, 0, 0, 0)", getPropertyValue: () => "" }),
    matchMedia: () => ({ get matches() { return systemLight; }, addEventListener: (_n: string, cb: () => void) => { mediaChange = cb; } }),
    addEventListener: (name: string, cb: () => void) => (events[name] ??= []).push(cb) };
  const localStorage = { getItem: (k: string) => k === "agend_theme" ? stored : null, setItem() {}, removeItem() {} };
  class Observer { constructor(cb: (records?: unknown[]) => void) { mutate = cb; } observe() {} }
  vm.runInNewContext(source, { document, window, localStorage, MutationObserver: Observer });
  const flush = () => { for (let i = 0; frames.length && i < 20; i++) frames.shift()!(); expect(frames).toHaveLength(0); };
  flush();
  return { nodes, theme: window.AgendTheme, flush, change: () => { mutate(); flush(); }, frames,
    records: (records: unknown[]) => { mutate(records); flush(); },
    custom: (v: string | null) => { custom = v; }, cssReady: (v: boolean) => { ready = v; },
    event: (name: string) => { events[name]?.forEach(f => f()); flush(); },
    system: (v: boolean) => { systemLight = v; mediaChange(); flush(); } };
}

describe("installed app chrome follows the rendered page", () => {
  it("uses the explicit choice over the OS and leaves one unqualified theme-color", () => {
    const b = browser("dark", true);
    expect(b.nodes).toHaveLength(1); expect(b.nodes[0].media).toBeUndefined();
    expect(b.nodes[0].content).toBe("rgb(33, 33, 33)");
  });
  it("updates live for explicit and system changes", () => {
    const b = browser(); b.theme.set("light"); b.flush(); expect(b.nodes[0].content).toBe("rgb(255, 255, 255)");
    b.theme.set("system"); b.flush(); b.system(false); expect(b.nodes[0].content).toBe("rgb(33, 33, 33)");
  });
  it("follows and clears page/owner appearance colors after DOM and stylesheet changes", () => {
    const b = browser(); b.custom("rgb(23, 49, 63)"); b.change(); expect(b.nodes[0].content).toBe("rgb(23, 49, 63)");
    b.custom("rgb(88, 32, 64)"); b.event("load"); expect(b.nodes[0].content).toBe("rgb(88, 32, 64)");
    b.custom(null); b.change(); expect(b.nodes[0].content).toBe("rgb(33, 33, 33)");
  });
  it("M-3455: the split view's own size/drag writes (.ws-geometry) never re-read the colours; other changes still do", () => {
    const b = browser(); const geometry = { classList: { contains: (c: string) => c === "ws-geometry" } };
    const pane = { classList: { contains: () => false } };
    b.custom("rgb(23, 49, 63)");
    b.records([{ type: "attributes", attributeName: "style", target: geometry }, { type: "attributes", attributeName: "class", target: geometry }]);
    expect(b.nodes[0].content).toBe("rgb(33, 33, 33)");                                          // a divider drag: colours not re-read
    b.records([{ type: "attributes", attributeName: "style", target: geometry }, { type: "attributes", attributeName: "style", target: pane }]);
    expect(b.nodes[0].content).toBe("rgb(23, 49, 63)");                                          // an agent page colour on a pane
    b.custom("rgb(88, 32, 64)"); b.records([{ type: "childList", target: geometry }]);
    expect(b.nodes[0].content).toBe("rgb(88, 32, 64)");                                          // panes added or removed
  });
  it("M-3486: a text box's own height (the composer's style write) never re-reads the colours; its class still does", () => {
    const b = browser(); const box = { tagName: "TEXTAREA", classList: { contains: () => false } };
    b.custom("rgb(23, 49, 63)");
    b.records([{ type: "attributes", attributeName: "style", target: box }]);
    expect(b.nodes[0].content).toBe("rgb(33, 33, 33)");                                          // typing / a divider drag
    b.records([{ type: "attributes", attributeName: "class", target: box }]);
    expect(b.nodes[0].content).toBe("rgb(23, 49, 63)");                                          // a class change may be a colour
  });
  it("recovers when CSS becomes ready after boot", () => {
    const b = browser(); b.cssReady(false); b.theme.set("light"); b.flush(); expect(b.nodes[0].content).toBe("#ffffff");
    b.cssReady(true); b.event("DOMContentLoaded"); expect(b.nodes[0].content).toBe("rgb(255, 255, 255)");
  });
  it("keeps a stable same-origin standalone identity and one color tag on Fleet and Hub HTML", () => {
    const m = JSON.parse(appManifest()); expect(m.id).toBe("/"); expect(m.display).toBe("standalone");
    expect([m.start_url, m.scope, ...m.icons.map((i: any) => i.src)] .every((v: string) => v.startsWith("/") && !v.startsWith("//"))).toBe(true);
    const html = withAppIconLinks(readFileSync(new URL("../src/ui/app.html", import.meta.url), "utf8"));
    expect(html.match(/name="theme-color"/g)).toHaveLength(1); expect(html).not.toMatch(/name="theme-color"[^>]*media=/);
  });
  it("serves the Hub's advertised manifest and icons without signing in", async () => {
    const r = await s3bRig();
    try {
      const html = await r.call(null, "GET", "/ui/hub");
      expect(html.text.match(/name="theme-color"/g)).toHaveLength(1);
      expect(html.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect((await r.call(null, "GET", "/assets/theme.js")).status).toBe(200);
      const m = await r.call(null, "GET", "/manifest.webmanifest?v=default");
      expect(m.status).toBe(200); expect(m.headers.get("content-type")).toBe("application/manifest+json");
      expect((await r.call(null, "HEAD", "/manifest.webmanifest")).text).toBe("");
      for (const origin of ["http://localhost:19280", "https://agend.example.test"]) expect(new URL(m.json.icons[0].src, origin).origin).toBe(origin);
      expect(m.json).toMatchObject({ name: "AgEnD Hub", id: "/", display: "standalone", background_color: "#212121", theme_color: "#212121" });   // M-3882: the Hub is named and drawn as its own app
      for (const path of m.json.icons.map((i: any) => i.src)) {
        const icon = await fetch(r.base + path); expect(icon.status).toBe(200); expect(icon.headers.get("content-type")).toBe("image/png");
      }
    } finally { await r.close(); }
  });
});
