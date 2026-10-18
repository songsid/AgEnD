import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const P = await import(new URL("../src/ui/shared/effect-frame.js", import.meta.url).href);
const boot = "b".repeat(32);
function bus() {
  const listeners = new Map<string, Set<(event: any) => void>>();
  return { listeners, addEventListener(type: string, fn: (event: any) => void) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(fn); },
    removeEventListener(type: string, fn: (event: any) => void) { listeners.get(type)?.delete(fn); },
    emit(type: string, event: any = {}) { for (const fn of [...listeners.get(type) ?? []]) fn(event); } };
}
const render = (patch = {}) => ({ code: "agend.ready()", params: { density: 2 }, instance: "own", width: 100, height: 80, dpr: 1,
  assets: [{ name: "assets/a.png", mime: "image/png", bytes: new Uint8Array([1, 2]) }], wants: ["state", "reply"], ...patch });
function rig(options: Record<string, unknown> = {}, raw = render()) {
  let now = 0, seq = 0;
  const timers = new Map<number, { fn: () => void; delay: number }>(), channels: any[] = [];
  const frame = { ...bus(), contentWindow: { postMessage: vi.fn((_data: Record<string, any>, _origin: string, _ports: unknown[]) => {}) }, setAttribute: vi.fn(), remove: vi.fn(), className: "", src: "", parentNode: null as any, isConnected: false };
  const document = { createElement: vi.fn(() => frame) };
  const root = { ownerDocument: document, append: vi.fn((): void => { frame.parentNode = root; frame.isConnected = true; }) };
  const host = { ...bus(), document, location: { origin: "https://dashboard.example" }, crypto: { getRandomValues: (b: Uint8Array) => b.fill(1) },
    setTimeout(fn: () => void, delay: number) { timers.set(++seq, { fn, delay }); return seq; }, clearTimeout(id: number) { timers.delete(id); },
    MessageChannel: class { port1 = { ...bus(), start: vi.fn(), close: vi.fn(), postMessage: vi.fn() }; port2 = { close: vi.fn() }; constructor() { channels.push(this); } },
  };
  const ready = vi.fn(), removed = vi.fn();
  const { opaque, ...frameOptions } = options;
  const api = (opaque ? P.createOpaqueEffectFrame : P.createEffectFrame)({ window: host, root, origin: "https://preview.example", boot, render: raw, clock: () => now, onReady: ready, onRemove: removed, ...frameOptions });
  const hello = (patch = {}) => host.emit("message", { source: frame.contentWindow, origin: "null", data: { v: 1, type: "ready", ch: null, boot }, ports: [], ...patch });
  const port = (data: unknown) => channels[0]?.port1.emit("message", { data });
  return { api, host, root, frame, channels, timers, ready, removed, hello, port, raw, at(t: number) { now = t; } };
}
describe("#1629 owned parent effect frame", () => {
  it("#2118 mounts the exact same-listener bootstrap in an opaque sandbox, with the same private handoff", () => {
    const h = rig({ opaque: true, origin: "https://dashboard.example" });
    expect(h.api.ok).toBe(true); expect(h.frame.src).toBe("https://dashboard.example/effect-bootstrap");
    expect(h.frame.setAttribute.mock.calls).toContainEqual(["sandbox", "allow-scripts"]);
    h.hello({ source: {} }); h.hello({ origin: "https://dashboard.example" }); h.hello({ data: { v: 1, type: "ready", ch: null, boot: "d".repeat(32) } });
    expect(h.channels).toHaveLength(0);
    h.hello(); h.hello(); expect(h.channels).toHaveLength(1); expect(h.ready).not.toHaveBeenCalled();
    h.port({ type: "focus" }); h.port({ type: "ready", extra: true }); expect(h.ready).not.toHaveBeenCalled();
    h.port({ type: "ready" }); expect(h.ready).toHaveBeenCalledOnce();
    h.api.remove("done"); expect(h.frame.remove).toHaveBeenCalledOnce(); expect(h.channels[0].port1.close).toHaveBeenCalledOnce();
  });
  it.each(["https://preview.example", "http://dashboard.example", "https://dashboard.example/path", "https://dashboard.example/", "https://u:p@dashboard.example", "data:text/html,x", "null"])("#2118 refuses other origins and non-origins: %s", origin => {
    const h = rig({ opaque: true, origin });
    expect(h.api).toEqual({ ok: false, reason: "bootstrap_unknown" }); expect(h.root.append).not.toHaveBeenCalled();
  });
  it("never sends reserved mention even when the manifest wants it", () => {
    const raw = render(); raw.wants = ["mention", "reply"]; const h = rig({}, raw); h.hello(); h.port({ type: "ready" });
    expect(h.api.send({ v: 1, type: "mention", ts: 1, instance: "own" })).toBe(false);
    expect(h.api.send({ v: 1, type: "reply", ts: 1, instance: "own" })).toBe(true);
  });
  it("mounts only the trusted effect path with sandbox and no inline styles", () => {
    const h = rig(); expect(h.api.ok).toBe(true);
    expect(h.frame.src).toBe("https://preview.example/effect");
    expect(h.frame.setAttribute.mock.calls).toEqual([["sandbox", "allow-scripts"], ["tabindex", "-1"], ["aria-hidden", "true"], ["referrerpolicy", "no-referrer"]]);
    expect(h.frame.className).toBe("agend-effect-frame"); expect(h.root.append).toHaveBeenCalledWith(h.frame);
    const source = readFileSync(new URL("../src/ui/shared/effect-frame.js", import.meta.url), "utf8");
    expect(source).not.toMatch(/\.style\b|cssText|srcdoc|innerHTML|document\.write|eval\(/);
    expect([...h.timers.values()].map(t => t.delay)).toEqual([10000]);
  });
  it.each(["https://preview.example/path", "https://u:p@preview.example", "data:text/html,x", "file:///x", "https://preview.example/", "not a URL"])("refuses non-origin %s before a DOM effect", origin => {
    const h = rig({ origin }); expect(h.api).toEqual({ ok: false, reason: "preview_unknown" }); expect(h.root.append).not.toHaveBeenCalled();
  });
  it("refuses mixed-content preview before creating a frame", () => {
    const h = rig({ origin: "http://preview.example" }); expect(h.api).toEqual({ ok: false, reason: "preview_unknown" }); expect(h.host.document.createElement).not.toHaveBeenCalled();
  });
  it("refuses a same-origin preview before creating a frame", () => {
    const h = rig({ origin: "https://dashboard.example" }); expect(h.api).toEqual({ ok: false, reason: "preview_unknown" }); expect(h.host.document.createElement).not.toHaveBeenCalled();
  });
  it.each(["", "x", "a".repeat(31), "g".repeat(32)])("refuses unproven listener boot %s", boot => {
    const h = rig({ boot }); expect(h.api.ok).toBe(false); expect(h.root.append).not.toHaveBeenCalled();
  });
  it("accepts exactly the frame/null-origin/boot hello and transfers one private port once", () => {
    const h = rig();
    for (const patch of [{ source: {} }, { origin: "https://preview.example" }, { data: { v: 1, type: "ready", ch: null, boot: "c".repeat(32) } }, { data: { v: 1, type: "ready", ch: null, boot, extra: true } }, { ports: [{}] }, { data: { v: 1, type: "ready", ch: "bad", boot } }]) h.hello(patch);
    expect(h.frame.contentWindow.postMessage).not.toHaveBeenCalled(); expect(h.channels).toHaveLength(0); expect(h.ready).not.toHaveBeenCalled(); expect(h.removed).not.toHaveBeenCalled();
    h.hello(); h.hello(); expect(h.channels).toHaveLength(1); expect(h.frame.contentWindow.postMessage).toHaveBeenCalledOnce();
    expect(h.frame.contentWindow.postMessage.mock.calls[0]).toEqual([{ v: 1, type: "render", ch: "01".repeat(16), ...Object.fromEntries(Object.entries(h.raw).filter(([k]) => k !== "wants")) }, "*", [h.channels[0].port2]]);
    expect(h.channels[0].port1.start).toHaveBeenCalledOnce();
  });
  it("drops every port message except one exact ready without counters, callbacks or timer effects", () => {
    const h = rig(); h.hello(); const before = h.api.state();
    const ignored = [null, {}, [], { type: "ready", extra: true }, { type: "focus" }, { type: "pong" }, { type: "frame-time", ms: 0 }, { type: "resize", width: 10 }];
    for (const d of ignored) expect(() => h.port(d)).not.toThrow();
    expect(h.api.state()).toEqual(before); expect(h.ready).not.toHaveBeenCalled(); expect(h.removed).not.toHaveBeenCalled(); expect(h.timers.size).toBe(1);
    h.port({ type: "ready" }); h.port({ type: "ready" }); for (const d of ignored) expect(() => h.port(d)).not.toThrow();
    expect(h.ready).toHaveBeenCalledOnce(); expect(h.removed).not.toHaveBeenCalled(); expect(h.timers.size).toBe(0);
    expect(h.api.state()).toEqual({ ready: true, removed: false, loads: 0 }); expect(h.channels[0].port1.listeners.get("message").size).toBe(0);
  });
  it("ignores unreadable inbound data without touching state", () => {
    const h = rig(); const event = { source: h.frame.contentWindow, origin: "null", get data() { throw Error("data"); } };
    expect(() => h.host.emit("message", event)).not.toThrow(); expect(h.channels).toHaveLength(0); h.hello();
    expect(() => h.channels[0].port1.emit("message", event)).not.toThrow(); expect(h.ready).not.toHaveBeenCalled(); expect(h.removed).not.toHaveBeenCalled();
  });
  it("snapshots code/params/assets/wants before waiting for a hello", () => {
    const raw = render(); const h = rig({}, raw); raw.code = "changed"; raw.params.density = 999; raw.assets[0]!.bytes[0] = 99; raw.wants.length = 0;
    h.hello(); const message = h.frame.contentWindow.postMessage.mock.calls[0]![0];
    expect(message.code).toBe("agend.ready()"); expect(message.params).toEqual({ density: 2 }); expect([...message.assets[0].bytes]).toEqual([1, 2]);
    h.port({ type: "ready" }); expect(h.api.send({ v: 1, type: "state", ts: 1, instance: "own", state: "working" })).toBe(true);
  });
  it("sends only ready-owned closed signals with exact instance and wants", () => {
    const h = rig(); const own = { v: 1, type: "state", ts: 1, instance: "own", state: "working" };
    expect(h.api.send(own)).toBe(false); h.hello(); expect(h.api.send(own)).toBe(false); h.port({ type: "ready" });
    for (const bad of [{ ...own, instance: "other" }, { ...own, instance: undefined }, { ...own, text: "secret" }, { v: 1, type: "theme", ts: 1, mode: "dark" }, { v: 1, type: "pong", ts: 1 }]) expect(h.api.send(bad)).toBe(false);
    expect(h.api.send(own)).toBe(true); expect(h.channels[0].port1.postMessage.mock.calls).toEqual([[own]]);
    h.api.remove("pause"); expect(h.api.send(own)).toBe(false);
  });
  it("removal before hello drops the window listener and startup timer", () => {
    const h = rig(); h.api.remove("cancelled"); h.api.remove("again"); h.hello();
    expect(h.host.listeners.get("message")!.size).toBe(0); expect(h.timers.size).toBe(0); expect(h.channels).toHaveLength(0);
    expect(h.frame.remove).toHaveBeenCalledOnce(); expect(h.removed.mock.calls).toEqual([["cancelled"]]);
  });
  it("fails closed if secure channel nonce creation fails", () => {
    const h = rig(); h.host.crypto.getRandomValues = () => { throw Error("random unavailable"); }; h.hello();
    expect(h.removed.mock.calls).toEqual([["transport"]]); expect(h.frame.contentWindow.postMessage).not.toHaveBeenCalled();
    expect(h.channels[0].port1.close).toHaveBeenCalledOnce();
  });
  it("one inert load stays alive and the second removes with complete cleanup", () => {
    const h = rig(); h.frame.emit("load"); h.hello(); h.port({ type: "ready" }); expect(h.api.state()).toEqual({ ready: true, removed: false, loads: 1 });
    h.frame.emit("load"); h.frame.emit("load"); h.api.remove("again");
    expect(h.api.state()).toEqual({ ready: true, removed: true, loads: 2 }); expect(h.removed.mock.calls).toEqual([["navigation"]]);
    expect(h.frame.remove).toHaveBeenCalledOnce(); expect(h.channels[0].port1.close).toHaveBeenCalledOnce(); expect(h.channels[0].port2.close).toHaveBeenCalledOnce(); expect(h.timers.size).toBe(0);
    expect(h.host.listeners.get("message")!.size).toBe(0); expect(h.frame.listeners.get("load")!.size).toBe(0);
  });
  it.each(["hello", "port", "timer"])("rejects overdue %s even if its scheduled timer hasn't run", route => {
    const h = rig(); if (route !== "hello") h.hello(); h.at(10000);
    if (route === "hello") h.hello(); else if (route === "port") h.port({ type: "ready" }); else [...h.timers.values()][0]!.fn();
    expect(h.api.state().removed).toBe(true); expect(h.ready).not.toHaveBeenCalled(); expect(h.removed.mock.calls).toEqual([["startup_timeout"]]);
  });
  it("rearms an early timeout using the remaining monotonic budget", () => {
    const h = rig(), [key, timer] = [...h.timers][0]!; h.timers.delete(key); h.at(9999); timer.fn();
    expect(h.api.state().removed).toBe(false); expect([...h.timers.values()].map(t => t.delay)).toEqual([1]);
    h.hello(); h.port({ type: "ready" }); expect(h.ready).toHaveBeenCalledOnce();
  });
  it.each([NaN, Infinity, -1])("refuses an invalid initial clock %s before DOM creation", now => {
    const h = rig({ clock: () => now }); expect(h.api).toEqual({ ok: false, reason: "clock_unavailable" }); expect(h.host.document.createElement).not.toHaveBeenCalled();
  });
  it("refuses a root belonging to another document", () => {
    const h = rig({ root: { ownerDocument: {}, append: vi.fn() } }); expect(h.api).toEqual({ ok: false, reason: "unsupported" }); expect(h.host.document.createElement).not.toHaveBeenCalled();
  });
  it("a port write failure removes the frame and closes both ports", () => {
    const h = rig(); h.hello(); h.port({ type: "ready" }); h.channels[0].port1.postMessage.mockImplementation(() => { throw Error("closed"); });
    expect(h.api.send({ v: 1, type: "state", ts: 1, instance: "own", state: "working" })).toBe(false);
    expect(h.removed.mock.calls).toEqual([["transport"]]); expect(h.frame.remove).toHaveBeenCalledOnce();
    expect(h.channels[0].port1.close).toHaveBeenCalledOnce(); expect(h.channels[0].port2.close).toHaveBeenCalledOnce();
  });
  it("fails closed on a monotonic rollback rather than reviving the deadline", () => {
    const h = rig(); h.at(100); h.hello(); h.at(99); h.port({ type: "ready" });
    expect(h.removed.mock.calls).toEqual([["clock_unavailable"]]); expect(h.ready).not.toHaveBeenCalled();
  });
  it.each(["parentNode", "isConnected"])("revokes a detached frame via %s before sending", field => {
    const h = rig(); h.hello(); h.port({ type: "ready" }); (h.frame as any)[field] = field === "parentNode" ? {} : false;
    expect(h.api.send({ v: 1, type: "state", ts: 1, instance: "own", state: "working" })).toBe(false);
    expect(h.removed.mock.calls).toEqual([["detached"]]);
  });
  it("cleans up a failed transfer or host callback and cannot revive", () => {
    const failed = rig(); failed.frame.contentWindow.postMessage.mockImplementation(() => { throw Error("closed"); }); failed.hello();
    expect(failed.removed.mock.calls).toEqual([["transport"]]); expect(failed.channels[0].port1.close).toHaveBeenCalledOnce();
    const callback = rig({ onReady: () => { throw Error("callback"); } }); callback.hello(); callback.port({ type: "ready" }); expect(callback.removed.mock.calls).toEqual([["host_callback"]]);
  });
  it.each([
    { code: "x".repeat(1048577) }, { code: "x".repeat(1048577), assets: [] }, { code: 123 }, { instance: 123 }, { instance: "x".repeat(129) },
    { code: "x".repeat(600000), assets: [{ name: "assets/a.png", mime: "image/png", bytes: new Uint8Array(600000) }] },
    { assets: [{ name: "poster.png", mime: "image/png", bytes: new Uint8Array([1]) }] },
    { assets: [{ name: "cursor.png", mime: "image/png", bytes: new Uint8Array([1]) }] },
    { assets: Array.from({ length: 2 }, () => ({ name: "assets/a.png", mime: "image/png", bytes: new Uint8Array([1]) })) }, { params: Object.fromEntries(Array.from({ length: 17 }, (_, i) => ["a" + i, true])) }, { params: { x: {} } }, { assets: Array.from({ length: 17 }, (_, i) => ({ name: "assets/a" + i + ".png", mime: "image/png", bytes: new Uint8Array([1]) })) }, { params: { x: Infinity } }, { params: { x: "x".repeat(129) } }, { params: { Bad: 1 } },
    { width: 4097 }, { height: 0 }, { width: 4096, height: 4096 }, { dpr: NaN }, { dpr: 3.01 }, { dpr: 0.49 },
    { wants: ["fleet"] }, { wants: ["state", "state"] }, { wants: new Array(1) }, { assets: new Array(1) }, { instance: "" },
    { assets: [{ name: "../x.png", mime: "image/png", bytes: new Uint8Array() }] }, { assets: [{ name: "assets/a.png", mime: "text/html", bytes: new Uint8Array() }] },
    { assets: [{ name: "assets/a.png", mime: "image/png", bytes: [1] }] }, { html: "<input>" },
  ])("refuses malformed render before creating a frame: %s", patch => {
    const h = rig({}, render(patch)); expect(h.api.ok).toBe(false); expect(h.host.document.createElement).not.toHaveBeenCalled();
  });
});
