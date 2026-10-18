import { describe, it, expect, vi } from "vitest";
const { createChatEffectRuntime, createEffectWriter, chatEffectIdentity, chatEffectState } = await import(new URL("../src/ui/shared/effect-chat-runtime.js", import.meta.url).href);
const id = "a".repeat(32), epoch = "b".repeat(16);
const deferred = () => { let resolve: (v: any) => void = () => {}; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function flush() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function rig(patch: any = {}) {
  let now = 0, live = true, ended = false, values: any = { ownerScope: "person", ownerEpoch: epoch }, serial = 0;
  const listeners = new Set<() => void>(), timers = new Map<number, () => void>();
  const host: any = { document: { body: { dataset: { mode: "full", previewOrigin: "https://preview.example", previewBoot: "c".repeat(32) } }, documentElement: { getAttribute: () => JSON.stringify(values) } },
    AgendAuth: { sessionEnded: () => ended, onSessionEnd: vi.fn((fn: () => void) => { listeners.add(fn); if (ended) fn(); return () => listeners.delete(fn); }) },
    localStorage: {}, crypto: {}, performance: { now: () => now }, AbortController, fetch: vi.fn(async () => ({ ok: true, body: { cancel: vi.fn(async () => {}) } })),
    setTimeout(fn: () => void) { timers.set(++serial, fn); return serial; }, clearTimeout(n: number) { timers.delete(n); },
  };
  const placement = { id, by: "agent", at: 1, manifest: { title: "Own effect", regions: ["chat"], layer: "front" }, params: { size: 2 } };
  const loader = { ok: true, placements: vi.fn(async () => ({ rev: 1, effects: [placement] })), resource: vi.fn(async () => ({ id, params: { size: 2 } })), dispose: vi.fn() };
  let options: any, view: any[] = [];
  const registry = { ok: true, update: vi.fn((ds: any[]) => { view = ds.map(d => ({ ...d, phase: "running", verdict: "active" })); }), snapshot: () => view, dispose: vi.fn(), resume: vi.fn(() => true), publish: vi.fn() };
  const collector = { ok: true, add: vi.fn(() => true), report: vi.fn(() => ({ id, profile: { v: 1, device: "standard" } })), dispose: vi.fn() };
  const context = { safe: false, publicLink: false, reducedMotion: false, saveData: false, hidden: false, enabled: true, show: true, transportReady: true, optIn: true, constrained: false, modal: false, openInstance: "own" };
  const observation = { context, ownerCss: "off", mode: "light", state: "working" };
  const changes = vi.fn(), element: any = { isConnected: true };
  patch.prepare?.({ host, loader, registry, context, values, element });
  const api = createChatEffectRuntime({ window: host, name: "own", element, current: () => live, observe: () => observation, onChange: changes,
    factories: { loader: () => loader, registry: (o: any) => { options = o; return registry; }, safety: vi.fn(), stock: vi.fn(() => ({ ok: true })), collector: () => collector } });
  return { api, host, loader, registry, collector, changes, context, observation, placement, element, timers, options: () => options,
    at(n: number) { now = n; }, stale() { live = false; }, signOut() { ended = true; for (const fn of [...listeners]) fn(); }, values(v: any) { values = v; } };
}

describe("#1629 real Chat runtime ownership", () => {
  it.each(["public", "poll", "view", "header", "epoch", "scope", "ended", "auth"])("%s cannot construct a registry or load resources", fault => {
    const h = rig({ prepare({ host, values }: any) {
      if (fault === "public") host.document.body.dataset.publicLink = "1";
      if (fault === "poll") host.document.body.dataset.webTransport = "poll";
      if (fault === "view") host.document.body.dataset.mode = "view-only";
      if (fault === "header") values.ownerScope = "none";
      if (fault === "epoch") values.ownerEpoch = "invalid";
      if (fault === "scope") delete values.ownerScope;
      if (fault === "ended") host.AgendAuth.onSessionEnd = (fn: () => void) => { fn(); return () => {}; };
      if (fault === "auth") delete host.AgendAuth.onSessionEnd;
    } });
    expect(h.api.ok).toBe(false); expect(h.options()).toBeUndefined(); expect(h.loader.placements).not.toHaveBeenCalled();
    h.api.dispose();
  });
  it.each(["loader", "registry"])("a refused %s primitive without dispose stays a recoverable unavailable pool", kind => {
    const h = rig({ prepare(parts: any) { parts[kind].ok = false; delete parts[kind].dispose; } });
    expect(h.api.ok).toBe(false); expect(h.api.snapshot().error).toBe("runtime_unavailable"); expect(() => h.api.dispose()).not.toThrow();
  });
  it("accepts explicit host operator but never exposes its identity to a frame", async () => {
    const h = rig({ prepare({ values }: any) { values.ownerScope = "operator"; } });
    expect(chatEffectIdentity(h.host)).toEqual({ epoch, scope: "operator" }); h.api.sync(); await flush();
    expect(h.loader.placements).toHaveBeenCalledWith("own", expect.any(AbortSignal));
    expect(h.registry.update.mock.calls.at(-1)?.[0]).toEqual([expect.objectContaining({ id, instance: "own", by: "agent", params: { size: 2 }, element: h.element })]);
    expect(h.registry.update.mock.calls.at(-1)?.[0][0]).not.toHaveProperty("ownerEpoch"); h.api.dispose();
  });
  it.each(["safe", "publicLink", "reducedMotion", "saveData", "hidden", "enabled", "show", "transportReady"])("gate %s prevents metadata/resource reads", fault => {
    const h = rig(); (h.context as any)[fault] = ["safe", "publicLink", "reducedMotion", "saveData", "hidden"].includes(fault); h.api.sync();
    expect(h.loader.placements).not.toHaveBeenCalled(); expect(h.loader.resource).not.toHaveBeenCalled(); h.api.dispose();
  });
  it("an old metadata answer cannot restore frames after a new revision", async () => {
    const first = deferred(), h = rig(); h.loader.placements.mockImplementationOnce(() => first.promise as any);
    h.api.sync(); h.api.changed(); expect(h.registry.update.mock.calls.at(-1)?.[0]).toEqual([]);
    first.resolve({ rev: 0, effects: [{ ...h.placement, by: "human" }] }); await flush();
    expect(h.registry.update.mock.calls.some(call => call[0].some(p => p.by === "human"))).toBe(false);
    expect(h.loader.placements).toHaveBeenCalledTimes(2); expect(h.api.snapshot().effects[0].by).toBe("agent"); h.api.dispose();
  });
  it("sign-out physically disposes the pool before held work or a subsequent sync runs", () => {
    const h = rig(); h.signOut(); expect(h.registry.dispose).toHaveBeenCalledOnce(); expect(h.loader.dispose).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it.each(["signout", "route", "detached", "dispose"])("%s fences held metadata and all owned participants", async fault => {
    const first = deferred(), h = rig(); h.loader.placements.mockImplementationOnce(() => first.promise as any); h.api.sync();
    if (fault === "signout") h.signOut(); if (fault === "route") h.stale(); if (fault === "detached") h.element.isConnected = false; if (fault === "dispose") h.api.dispose();
    first.resolve({ rev: 1, effects: [h.placement] }); await flush(); h.api.sync();
    expect(h.registry.dispose).toHaveBeenCalled(); expect(h.loader.dispose).toHaveBeenCalled(); expect(h.api.snapshot().effects).toEqual([]); h.api.dispose();
  });
  it("failed resources stop the whole pool, and no update retries them", async () => {
    const h = rig(); h.api.sync(); await flush(); h.loader.resource.mockResolvedValueOnce(null as any);
    expect(await h.options().load({ id }, new AbortController().signal)).toBe(null);
    expect(h.api.snapshot().error).toBe("resource_unavailable"); expect(h.registry.dispose).toHaveBeenCalledOnce();
    h.api.sync(); h.api.changed(); expect(h.loader.placements).toHaveBeenCalledTimes(1); h.api.dispose();
  });
  it("late old resource cannot stop a newer revision", async () => {
    const held = deferred(), h = rig(); h.api.sync(); await flush(); h.loader.resource.mockImplementationOnce(() => held.promise as any);
    const read = h.options().load({ id }, new AbortController().signal); h.api.changed(); held.resolve(null); await read; await flush();
    expect(h.api.snapshot().error).toBe(null); expect(h.registry.dispose).not.toHaveBeenCalled(); h.api.dispose();
  });
  it("only current-instance boolean reply and closed state/theme signals reach the registry", async () => {
    const h = rig(); h.api.sync(); await flush(); h.registry.publish.mockClear();
    h.api.reply({ instance: "other", text: "secret" }); expect(h.registry.publish).not.toHaveBeenCalled();
    h.api.reply({ instance: "own", text: "secret", id: 4 }); expect(h.registry.publish).toHaveBeenCalledWith("reply", {}, "own");
    h.registry.publish.mockClear(); h.observation.state = "secret"; h.observation.mode = "system"; h.api.sync(); expect(h.registry.publish).not.toHaveBeenCalled(); h.api.dispose();
  });
  it("pause/resume are explicit and never discard the persisted provenance or params", async () => {
    const h = rig(); h.api.sync(); await flush(); expect(h.api.pause(id)).toBe(true);
    expect(h.registry.update.mock.calls.at(-1)?.[0][0]).toMatchObject({ paused: true, by: "agent", params: { size: 2 } });
    expect(h.registry.resume).not.toHaveBeenCalled(); expect(h.api.resume(id)).toBe(true); expect(h.registry.resume).toHaveBeenCalledWith(`chat:${id}`); h.api.dispose();
  });
  it("an unrelated revision never resumes an unchanged manually paused placement", async () => {
    const h = rig(); h.api.sync(); await flush(); h.api.pause(id); h.api.changed(); await flush();
    expect(h.registry.update.mock.calls.at(-1)?.[0][0].paused).toBe(true); expect(h.registry.resume).not.toHaveBeenCalled();
    h.loader.placements.mockResolvedValueOnce({ rev: 3, effects: [{ ...h.placement, params: { size: 3 } }] }); h.api.changed(); await flush();
    expect(h.registry.update.mock.calls.at(-1)?.[0][0].paused).toBe(false); h.api.dispose();
  });
  it("reports only current owners and direct closed collector output; responses grant no authority", async () => {
    const h = rig(); h.api.sync(); await flush(); let live = true;
    const owner = { key: `chat:${id}`, id, device: "standard", current: () => live };
    h.options().onMount(owner); h.at(9999); h.options().onProfile({ verdict: "ok" }, owner); await flush(); expect(h.host.fetch).not.toHaveBeenCalled();
    h.at(10000); h.options().onProfile({ verdict: "ok" }, owner); await flush();
    expect(h.host.fetch).toHaveBeenCalledWith(`/ui/effects/profile/${id}?instance=own&ownerEpoch=${epoch}`, expect.objectContaining({ body: JSON.stringify({ v: 1, device: "standard" }) }));
    h.collector.add.mockClear(); live = false; h.at(20000); h.options().onProfile({ verdict: "paused" }, owner); await flush(); expect(h.host.fetch).toHaveBeenCalledTimes(1); expect(h.collector.add).not.toHaveBeenCalled();
    h.options().onRetire(owner); expect(h.collector.dispose).toHaveBeenCalledOnce(); h.api.dispose();
  });
  it("a first terminal pause may report before ten seconds, but never replays a report", async () => {
    const h = rig(); const owner = { key: "x", id, device: "standard", current: () => true }; h.options().onMount(owner); h.at(6000);
    h.options().onProfile({ verdict: "paused" }, owner); h.options().onProfile({ verdict: "paused" }, owner); await flush(); expect(h.host.fetch).toHaveBeenCalledTimes(1); h.api.dispose();
  });
  it("removal refreshes authoritative placements, while a stale completion cannot publish", async () => {
    const h = rig(); h.api.sync(); await flush(); expect(await h.api.remove(id)).toBe(true); await flush(); expect(h.loader.placements).toHaveBeenCalledTimes(2);
    const held = deferred(); h.host.fetch.mockImplementationOnce(() => held.promise as any); const remove = h.api.remove(id); await flush(); h.stale(); held.resolve({ ok: true });
    expect(await remove).toBe(false); expect(h.loader.placements).toHaveBeenCalledTimes(2); h.api.dispose();
  });
});

describe("#1629 profile/write physical reservations", () => {
  it("keeps timed-out writes reserved across disposed route writers until physical settlement", async () => {
    const h = rig(), held = deferred(); h.host.fetch.mockImplementation(() => held.promise as any);
    const a = createEffectWriter(h.host, () => true); const calls = [a.post("/x", {}), a.post("/x", {}), a.post("/x", {})]; await flush();
    for (const fn of [...h.timers.values()]) fn(); expect(await Promise.all(calls)).toEqual([false, false, false]); a.dispose();
    const b = createEffectWriter(h.host, () => true); expect(await b.post("/x", {})).toBe(false); expect(h.host.fetch).toHaveBeenCalledTimes(3);
    held.resolve({ ok: true }); await flush(); expect(await b.post("/x", {})).toBe(true); expect(h.host.fetch).toHaveBeenCalledTimes(4); b.dispose(); h.api.dispose();
  });
  it("the physical cap refuses a fourth dispatch even across canceled route writers", async () => {
    const h = rig(), held = deferred(); h.host.fetch.mockImplementation(() => held.promise as any);
    const a = createEffectWriter(h.host, () => true); const calls = [a.post("/x", {}), a.post("/x", {}), a.post("/x", {})]; await flush(); a.dispose();
    const b = createEffectWriter(h.host, () => true); const fourth = b.post("/x", {}); await flush(); expect(h.host.fetch).toHaveBeenCalledTimes(3);
    held.resolve({ ok: true }); expect(await Promise.all(calls)).toEqual([false, false, false]); expect(await fourth).toBe(false); b.dispose(); h.api.dispose();
  });
  it.each([10000, 10001, -1, NaN, Infinity])("late/invalid time %s cannot publish a write result", async now => {
    const h = rig(), held = deferred(); h.host.fetch.mockImplementationOnce(() => held.promise as any); const writer = createEffectWriter(h.host, () => true), done = writer.post("/x", {});
    await flush(); h.at(now); held.resolve({ ok: true }); expect(await done).toBe(false); writer.dispose(); h.api.dispose();
  });
  it.each([-1, NaN, Infinity])("an invalid initial clock %s sends nothing and permanently revokes the writer", async now => {
    const h = rig(), writer = createEffectWriter(h.host, () => true); h.at(now); expect(await writer.post("/x", {})).toBe(false); h.at(100); expect(await writer.post("/x", {})).toBe(false); expect(h.host.fetch).not.toHaveBeenCalled(); writer.dispose(); h.api.dispose();
  });
  it("clock rollback between completed writes cannot send a second request", async () => {
    const h = rig(), writer = createEffectWriter(h.host, () => true); h.at(100); expect(await writer.post("/x", {})).toBe(true); h.at(99); expect(await writer.post("/x", {})).toBe(false); expect(h.host.fetch).toHaveBeenCalledTimes(1); writer.dispose(); h.api.dispose();
  });
  it("waits for body cancellation and never parses arbitrary response data", async () => {
    const h = rig(), body = deferred(), json = vi.fn(() => { throw Error("not authority"); });
    h.host.fetch.mockResolvedValueOnce({ ok: true, body: { cancel: () => body.promise }, json } as any);
    const writer = createEffectWriter(h.host, () => true); let done = false; const answer = writer.post("/x", {}).then((r: boolean) => { done = true; return r; }); await flush(); expect(done).toBe(false);
    body.resolve(null); expect(await answer).toBe(true); expect(json).not.toHaveBeenCalled(); writer.dispose(); h.api.dispose();
  });
});
it("execution projection sends no text or unknown state", () => {
  const s: any = { instances: [{ name: "own", status: "running" }], awaiting: {}, exec: { own: "working" } };
  for (const [input, output] of [["working", "working"], ["stuck", "working"], ["idle", "idle"], ["secret", null]]) { s.exec.own = input; expect(chatEffectState(s, "own")).toBe(output); }
  s.awaiting.own = "secret permission text"; expect(chatEffectState(s, "own")).toBe("needs_you"); s.instances[0].status = "paused"; expect(chatEffectState(s, "own")).toBe("stopped"); expect(chatEffectState(s, "other")).toBe(null);
});


describe("#2118 separate session playback capability", () => {
  it("public/poll and local guest get Chat only, never personal identity", async () => {
    const { effectPlaybackIdentity, chatEffectIdentity } = await import(new URL("../src/ui/shared/effect-chat-runtime.js", import.meta.url).href);
    for (const extra of [{ publicLink: "1", webTransport: "poll" }, { tier: "guest" }]) {
      const h: any = { document: { body: { dataset: { mode: "full", effectEpoch: "e".repeat(16), effectScope: "chat", ...extra } }, documentElement: { getAttribute: () => JSON.stringify({ ownerScope: "none", ownerEpoch: null }) } } };
      const id = effectPlaybackIdentity(h); expect(id).toEqual({ epoch: "e".repeat(16), scope: "chat" }); expect(Object.isFrozen(id)).toBe(true); expect(chatEffectIdentity(h)).toBeNull();
      h.document.body.dataset.effectScope = "owner"; expect(effectPlaybackIdentity(h)).toBeNull();
    }
  });
  it("rejects missing/malformed capability, view/header, stale owner epoch and a forged public owner scope", async () => {
    const { effectPlaybackIdentity } = await import(new URL("../src/ui/shared/effect-chat-runtime.js", import.meta.url).href);
    for (const patch of [{ effectEpoch: "" }, { effectEpoch: "E".repeat(16) }, { effectScope: "admin" }, { effectScope: "chat" }, { mode: "view-only" }, { publicLink: "1", webTransport: "poll" }]) {
      const h: any = { document: { body: { dataset: { mode: "full", effectEpoch: "e".repeat(16), effectScope: "owner", ...patch } }, documentElement: { getAttribute: () => JSON.stringify({ ownerScope: "person", ownerEpoch: "e".repeat(16) }) } } };
      expect(effectPlaybackIdentity(h), JSON.stringify(patch)).toBeNull();
    }
    const h: any = { document: { body: { dataset: { mode: "full", effectEpoch: "e".repeat(16), effectScope: "owner" } }, documentElement: { getAttribute: () => JSON.stringify({ ownerScope: "person", ownerEpoch: "f".repeat(16) }) } } };
    expect(effectPlaybackIdentity(h)).toBeNull(); h.document.documentElement.getAttribute = () => null; expect(effectPlaybackIdentity(h)).toBeNull();
  });
});
