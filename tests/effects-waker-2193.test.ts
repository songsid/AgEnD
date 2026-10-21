/**
 * #2193: the effects runtime stays unloaded until there is something to play. The waker (src/ui/effects-waker.js)
 * watches fields the page already has — the open chat's effect_chat_v, the person's personal effect slots — and loads
 * and starts the unchanged runtime once, on the first of them (or a Try offer, or a personal effect saved in Settings).
 * Modeled stores and a stub runtime module; the browser proof is scripts/manual/smoke/smoke-effects-dormant.mts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const env = vi.hoisted(() => {
  function store(value: any) {
    const listeners = new Set<any>();
    return { get: () => value, set(patch: any) { value = { ...value, ...patch }; for (const fn of [...listeners]) fn(value); },
      subscribe(fn: any) { listeners.add(fn); return () => listeners.delete(fn); }, listeners };
  }
  return { app: store({ instances: [] }), nav: store({ route: null, seq: 0 }), ownerFx: false, ownerFxListeners: new Set<any>(),
    start: null as any, started: null as any, owner: { dead: false, api: { ok: true } } as any };
});
vi.mock("/assets/app-store.js", () => ({ appStore: env.app }));
vi.mock("/assets/app-nav.js", () => ({ navStore: env.nav }));
vi.mock("/assets/app-prefs.js", () => ({ ownerEffectsChosen: () => env.ownerFx, onOwnerEffectsChanged: (fn: any) => { env.ownerFxListeners.add(fn); return () => env.ownerFxListeners.delete(fn); } }));
vi.mock("../src/ui/app-effects.js", () => ({ startAppEffects: (...a: any[]) => env.start(...a), getAppEffects: () => env.started }));

const EMPTY = createHash("sha256").update(JSON.stringify([])).digest("hex").slice(0, 32);
const SOME = createHash("sha256").update(JSON.stringify([{ id: "a".repeat(32) }])).digest("hex").slice(0, 32);
const inst = (name: string, v = EMPTY) => ({ name, status: "running", effect_chat_v: v });
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
const store = { onAgentReply: () => () => {} };

async function boot() {
  vi.resetModules(); env.started = null;
  env.start = vi.fn(() => { env.started = env.owner; return env.owner; });
  // @ts-expect-error — a JS module of the app, with no types
  const w = await import("../src/ui/effects-waker.js");
  w.startEffectsWaker({ store });
  return w;
}
beforeEach(() => {
  env.app.listeners.clear(); env.nav.listeners.clear(); env.ownerFxListeners.clear(); env.ownerFx = false;
  env.app.set({ canvasWorker: true, instances: [inst("a"), inst("b"), inst("c")] }); env.nav.set({ route: { panel: "chat", instance: "a" }, seq: 1 });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("#2193: the effects waker", () => {
  it("the empty-list hash is the server's (fleet-manager hashes JSON.stringify(placements.effects))", async () => {
    const w = await boot();
    expect(w.EMPTY_CHAT_EFFECTS).toBe(EMPTY);
    expect(readFileSync(new URL("../src/fleet-manager.ts", import.meta.url), "utf8"))
      .toContain('createHash("sha256").update(JSON.stringify(this.themeStore.get(name).placements.effects)).digest("hex").slice(0, 32)');
  });
  it("nothing configured: no wake through status frames, chat switches and other chats' placements — nothing imported", async () => {
    const w = await boot();
    for (let i = 0; i < 20; i++) env.app.set({ uptime: i });                          // status frames
    for (const n of ["b", "c", "a", "b"]) env.nav.set({ route: { panel: "chat", instance: n }, seq: env.nav.get().seq + 1 });
    env.app.set({ instances: [inst("a"), inst("b"), inst("z", SOME)] });               // a chat not open has some
    env.nav.set({ route: { panel: "fleet" }, seq: 9 });
    await flush();
    expect([w.effectsLoaded(), w.effectsAwake(), w.getAppEffects()]).toEqual([false, false, null]); expect(env.start).not.toHaveBeenCalled();
    expect(w.chatHasEffects("z")).toBe(true); expect(w.chatHasEffects("a")).toBe(false); expect(w.chatHasEffects("nope")).toBe(false);
  });
  it("the open chat gaining its first placement wakes it — once", async () => {
    const w = await boot();
    const heard = vi.fn(); w.onEffectsAwake(heard);
    env.app.set({ instances: [inst("a", SOME), inst("b"), inst("c")] }); await flush();
    expect(w.effectsLoaded()).toBe(true); expect(env.start).toHaveBeenCalledExactlyOnceWith({ store }); expect(heard).toHaveBeenCalledOnce();
    expect(w.getAppEffects()).toBe(env.owner);
    env.app.set({ instances: [inst("a", SOME), inst("b", SOME)] }); await flush();
    expect(env.start).toHaveBeenCalledOnce();
    const late = vi.fn(); w.onEffectsAwake(late); expect(late).toHaveBeenCalledOnce();   // already awake: told at once
  });
  it("opening a chat that has placements wakes it", async () => {
    env.app.set({ instances: [inst("a"), inst("b", SOME)] });
    const w = await boot(); await flush(); expect(w.effectsLoaded()).toBe(false);
    env.nav.set({ route: { panel: "chat", instance: "b" }, seq: 2 }); await flush();
    expect(env.start).toHaveBeenCalledOnce(); expect(w.effectsLoaded()).toBe(true);
  });
  it("a personal effect slot wakes it — at boot, or when one is chosen later on any panel", async () => {
    env.ownerFx = true; env.nav.set({ route: { panel: "fleet" }, seq: 1 });
    await boot(); await flush(); expect(env.start).toHaveBeenCalledOnce();
    env.ownerFx = false; env.ownerFxListeners.clear(); const w = await boot(); await flush(); expect(w.effectsLoaded()).toBe(false);
    env.ownerFx = true; for (const fn of [...env.ownerFxListeners]) fn(true); await flush();
    expect(w.effectsLoaded()).toBe(true); expect(env.start).toHaveBeenCalledOnce();
  });
  it("single episode: rapid switching through chats with placements, and wakes asked from several places at once, start it once", async () => {
    env.app.set({ instances: ["a", "b", "c", "d"].map((n) => inst(n, SOME)) });
    const w = await boot();
    const asks = [w.wakeEffects(), w.wakeEffects()];
    for (let i = 0; i < 12; i++) env.nav.set({ route: { panel: "chat", instance: "abcd"[i % 4] }, seq: 10 + i });
    asks.push(w.wakeEffects());
    const owners = await Promise.all(asks); await flush();
    expect(w.effectsLoaded()).toBe(true); expect(env.start).toHaveBeenCalledOnce(); expect(new Set(owners)).toEqual(new Set([env.owner]));
  });
  it("awake, the waker itself does nothing on later changes (the runtime has its own subscriptions)", async () => {
    env.app.set({ instances: [inst("a", SOME)] });
    await boot(); await flush(); expect(env.start).toHaveBeenCalledOnce();
    const read = vi.spyOn(env.nav, "get");
    for (let i = 0; i < 10; i++) env.app.set({ uptime: i });
    expect(read).not.toHaveBeenCalled();
  });
  it("a runtime that cannot start (unsupported browser): loaded, not awake for good — getAppEffects stays null, no retry loop", async () => {
    const w = await boot();
    env.start = vi.fn(() => null);
    expect(await w.wakeEffects()).toBeNull(); expect(w.effectsLoaded()).toBe(true);
    expect(await w.wakeEffects()).toBeNull(); expect(env.start).toHaveBeenCalledOnce();
  });
  it("owner CSS is not the runtime's: owner-css.js does not import it, and the shell installs it on its own", () => {
    const css = readFileSync(new URL("../src/ui/shared/owner-css.js", import.meta.url), "utf8");
    const app = readFileSync(new URL("../src/ui/shared/app.js", import.meta.url), "utf8");
    expect(css).not.toMatch(/app-effects|effects-waker|effect-app-runtime/);
    expect(app).toMatch(/installOwnerCss\(\)/);
    expect(app).not.toMatch(/app-effects\.js|effects-waker\.js/);
  });
});

describe("#2275 experimental runtime admission", () => {
  it("off rejects every wake reason and direct calls without scheduling a runtime import", async () => {
    env.app.set({ canvasWorker: false, instances: [inst("a", SOME)] }); env.ownerFx = true;
    const w = await boot(); await flush();
    expect(w.effectsAwake()).toBe(false);
    const rejected = w.wakeEffects(); expect(w.effectsAwake()).toBe(false);
    expect(await rejected).toBeNull(); expect(w.effectsAwake()).toBe(false); expect(w.chatHasEffects("a")).toBe(false);
    expect(w.getAppEffects()).toBeNull(); expect(env.start).not.toHaveBeenCalled(); expect(w.effectsLoaded()).toBe(false);
  });
  it("disable disposes current playback, preserves placement data and enabling restores playback", async () => {
    env.app.set({ instances: [inst("a", SOME)] });
    const w = await boot(); const dispose = vi.fn(() => { env.started = null; }); env.owner.dispose = dispose;
    await flush(); expect(env.start).toHaveBeenCalledOnce();
    env.app.set({ canvasWorker: false }); await flush();
    expect(dispose).toHaveBeenCalledWith(true); expect(w.getAppEffects()).toBeNull();
    expect(env.app.get().instances[0].effect_chat_v).toBe(SOME);
    env.app.set({ canvasWorker: true }); await flush(); expect(env.start).toHaveBeenCalledTimes(2);
  });
  it("disable before the pending runtime import settles fences its startup", async () => {
    const w = await boot(); const pending = w.wakeEffects(); env.app.set({ canvasWorker: false });
    expect(await pending).toBeNull(); expect(env.start).not.toHaveBeenCalled();
    env.app.set({ canvasWorker: true }); await w.wakeEffects(); expect(env.start).toHaveBeenCalledOnce();
  });
});

it("#2275 re-enable waits for physical retirement and never overlaps the old owner's pending reads", async () => {
  env.app.set({ instances: [inst("a", SOME)] }); const w = await boot(); await flush();
  let release = () => {}; const retired = new Promise<void>(resolve => { release = resolve; });
  env.owner.dispose = vi.fn(() => { env.started = null; return retired; });
  env.app.set({ canvasWorker: false }); env.app.set({ canvasWorker: true }); await flush(); expect(env.start).toHaveBeenCalledOnce();
  expect(w.effectsLoaded()).toBe(false); const awake = vi.fn(); w.onEffectsAwake(awake); expect(awake).not.toHaveBeenCalled();
  release(); await flush(); expect(awake).toHaveBeenCalledOnce(); expect(w.effectsLoaded()).toBe(true); expect(env.start).toHaveBeenCalledTimes(2); expect(w.getAppEffects()).toBe(env.owner);
});
