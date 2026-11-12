import { afterEach, describe, expect, it, vi } from "vitest";
import { createPopoutTransport, receivePopoutDraft, POPOUT_DEADLINE_MS } from "/ui/js/chat-popout-transport.js";
const scope = "viewer-scope", name = "alpha", nonce = "12a34567-1234-1234-1234-123456789abc";
const msg = (type: string, rest = {}) => ({ channel: "agend-chat-popout-v1", type, name, scope, ...rest });
function windowDouble() {
  const listeners = new Map<string, Set<Function>>();
  const w: any = { location: { origin: "https://fleet.example" }, crypto: { randomUUID: () => nonce }, closed: false,
    addEventListener: (k: string, f: Function) => { if (!listeners.has(k)) listeners.set(k, new Set()); listeners.get(k)!.add(f); },
    removeEventListener: (k: string, f: Function) => listeners.get(k)?.delete(f),
    count: (type: string) => listeners.get(type)?.size || 0,
    fire: (type: string, e: any = {}) => [...(listeners.get(type) || [])].forEach(f => f(e)), postMessage: vi.fn() };
  w.open = vi.fn(); return w;
}
afterEach(() => vi.useRealTimers());
describe("real pop-out exact-window, one-use handoff", () => {
  function fixture() {
    vi.useFakeTimers(); const win = windowDouble(), child = windowDouble(); win.open.mockReturnValue(child);
    const notify = vi.fn(), complete = vi.fn(() => true); let live = true;
    const owner = createPopoutTransport({ win, scope, notify });
    const open = () => owner.open({ name, payload: { text: "draft", files: [], reply: null }, current: () => live, complete });
    const receive = (data: any, source = child, origin = win.location.origin) => win.fire("message", { data, source, origin });
    return { win, child, owner, notify, complete, open, receive, revoke: () => { live = false; } };
  }
  it("opens synchronously with just the existing route and presentation; closes its source only after exact ACK", () => {
    const f = fixture(); expect(f.open()).toBe(true); expect(f.win.open).toHaveBeenCalledWith("/ui/chat/alpha?presentation=popout", "_blank", expect.any(String));
    expect(f.complete).not.toHaveBeenCalled(); f.receive(msg("ready"));
    expect(f.child.postMessage).toHaveBeenCalledWith(msg("draft", { nonce, payload: { text: "draft", files: [], reply: null } }), "https://fleet.example");
    expect(f.complete).not.toHaveBeenCalled(); f.receive(msg("received", { nonce })); f.receive(msg("received", { nonce }));
    expect(f.complete).toHaveBeenCalledTimes(1); f.owner.close();
  });
  it("rejects foreign origin/window/viewer/agent/nonce and duplicate READY without disclosing a draft", () => {
    const f = fixture(); f.open();
    f.receive(msg("ready"), {}, "https://fleet.example"); f.receive(msg("ready"), f.child, "https://else.example");
    f.receive(msg("ready", { scope: "someone else" })); f.receive(msg("ready", { name: "beta" })); expect(f.child.postMessage).not.toHaveBeenCalled();
    f.receive(msg("ready")); f.receive(msg("ready")); expect(f.child.postMessage).toHaveBeenCalledTimes(1);
    f.receive(msg("received", { nonce: "other" })); expect(f.complete).not.toHaveBeenCalled(); f.owner.close();
  });
  it.each(["blocked", "closed", "timeout", "revoked", "pagehide", "refused"])("retains the source on %s, without another popup or effect", reason => {
    const f = fixture(); if (reason === "blocked") f.win.open.mockReturnValue(null);
    f.open(); if (reason === "closed") f.child.closed = true;
    if (reason === "revoked") f.revoke(); if (reason === "pagehide") f.win.fire("pagehide");
    if (reason === "refused") { f.receive(msg("ready")); f.receive(msg("refused", { nonce })); }
    vi.advanceTimersByTime(POPOUT_DEADLINE_MS); f.receive(msg("received", { nonce }));
    expect(f.complete).not.toHaveBeenCalled(); if (reason !== "blocked") expect(f.child.opener).toBeNull(); expect(f.notify).toHaveBeenCalled(); expect(f.win.open).toHaveBeenCalledTimes(1); f.owner.close();
  });
  it("keeps an operation single-flight and refuses a stale ACK even before the polling tick", () => {
    const f = fixture(); f.open(); expect(f.open()).toBe(false); expect(f.win.open).toHaveBeenCalledTimes(1);
    f.receive(msg("ready")); f.revoke(); f.receive(msg("received", { nonce })); expect(f.complete).not.toHaveBeenCalled(); f.owner.close();
  });
  it("child waits for its current composer and acknowledges at most one validated draft, then detaches opener", () => {
    vi.useFakeTimers(); const win = windowDouble(), parent = windowDouble(); win.opener = parent; let ready = false;
    const accept = vi.fn(() => true), stop = receivePopoutDraft({ win, name, scope, current: () => true, ready: () => ready, accept });
    expect(parent.postMessage).not.toHaveBeenCalled(); ready = true; vi.advanceTimersByTime(50);
    expect(parent.postMessage).toHaveBeenCalledWith(msg("ready"), win.location.origin);
    for (const e of [{ source: {}, origin: win.location.origin }, { source: parent, origin: "https://other.example" }]) win.fire("message", { ...e, data: msg("draft", { nonce, payload: {} }) });
    expect(accept).not.toHaveBeenCalled();
    const e = { source: parent, origin: win.location.origin, data: msg("draft", { nonce, payload: { text: "unsent" } }) };
    win.fire("message", e); win.fire("message", e); expect(accept).toHaveBeenCalledTimes(1); expect(win.opener).toBeNull();
    expect(parent.postMessage).toHaveBeenLastCalledWith(msg("received", { nonce }), win.location.origin); stop();
  });
});

it.each([15_000, -1])("checks the final clock at ACK (%s), before retiring any source", delta => {
  vi.useFakeTimers(); const win = windowDouble(), child = windowDouble(); win.open.mockReturnValue(child);
  let now = 10_000; const complete = vi.fn(() => true), owner = createPopoutTransport({ win, scope, now: () => now });
  owner.open({ name, payload: {}, current: () => true, complete });
  win.fire("message", { source: child, origin: win.location.origin, data: msg("ready") }); now += delta;
  win.fire("message", { source: child, origin: win.location.origin, data: msg("received", { nonce }) });
  expect(complete).not.toHaveBeenCalled(); owner.close();
});
it.each(["expired", "revoked", "not-ready"])("the child refuses %s offers before importing any draft", reason => {
  vi.useFakeTimers(); const win = windowDouble(), parent = windowDouble(); win.opener = parent;
  let live = true, ready = true, now = 0; const accept = vi.fn(() => true);
  const close = receivePopoutDraft({ win, name, scope, current: () => live, ready: () => ready, accept, now: () => now });
  if (reason === "expired") now = POPOUT_DEADLINE_MS; if (reason === "revoked") live = false; if (reason === "not-ready") ready = false;
  win.fire("message", { source: parent, origin: win.location.origin, data: msg("draft", { nonce, payload: {} }) });
  expect(accept).not.toHaveBeenCalled(); expect(parent.postMessage).toHaveBeenLastCalledWith(msg("refused", { nonce }), win.location.origin); close();
});

it("50 sequential open/ACK/close cycles return handlers and timers to their baseline", () => {
  vi.useFakeTimers(); const win = windowDouble(), child = windowDouble(); win.open.mockReturnValue(child);
  const complete = vi.fn(() => true), owner = createPopoutTransport({ win, scope });
  for (let i = 0; i < 50; i++) {
    expect(owner.open({ name, payload: {}, current: () => true, complete })).toBe(true);
    win.fire("message", { source: child, origin: win.location.origin, data: msg("ready") });
    win.fire("message", { source: child, origin: win.location.origin, data: msg("received", { nonce }) });
    expect(win.count("message")).toBe(0); expect(vi.getTimerCount()).toBe(0);
  }
  expect(complete).toHaveBeenCalledTimes(50); owner.close(); expect(win.count("pagehide")).toBe(0);
});
