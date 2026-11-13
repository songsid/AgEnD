import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomAssistantService, type AssistantSavedState } from "../src/hub/assistant/service.js";
import { assistantStateStore } from "../src/hub/assistant/store.js";
import { createFleetRoomAssistant } from "../src/hub/assistant/fleet-host.js";
import type { RoomAssistantAsk, RoomAssistantConfig } from "../src/hub/assistant/types.js";
import type { AssistantQuotaBand } from "../src/hub/assistant/admin-types.js";

const config = (patch: Partial<RoomAssistantConfig> = {}): RoomAssistantConfig => ({ enabled: true, backend: "claude-code", account: null, cap: 3, idleMinutes: 15, ...patch });
const ask = (roomId = "room-a"): RoomAssistantAsk => ({ roomId, roomName: "Planning", messageId: "m-1", asker: { name: "Han" }, text: "Private room request", context: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const services: RoomAssistantService[] = [], roots: string[] = [];
afterEach(async () => {
  await Promise.allSettled(services.splice(0).map(service => service.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function world(saved: AssistantSavedState | null = null) {
  const store = { load: vi.fn(async () => saved), save: vi.fn(async (_value: AssistantSavedState) => {}) };
  const turns: Array<{ done: ReturnType<typeof deferred<{ text: string }>>; stop: ReturnType<typeof vi.fn> }> = [];
  const start = vi.fn(async () => {
    const done = deferred<{ text: string }>(), stop = vi.fn(async () => {});
    turns.push({ done, stop });
    return { ask: vi.fn(() => done.promise), stop };
  });
  const backends = vi.fn(() => [{ id: "claude-code", name: "Claude", accounts: [{ id: null as string | null, name: "Default", state: "signed-in" as const }] }]);
  let now = Date.UTC(2026, 10, 14, 12);
  const quota = vi.fn(async (_config: RoomAssistantConfig): Promise<AssistantQuotaBand> => "unknown");
  const service = new RoomAssistantService({ host: { start }, store, backends, quota, now: () => now }); services.push(service);
  return { service, store, start, turns, backends, quota, time: (value: number) => { now = value; } };
}

describe("Hub assistant admin service (fake host, no accounts)", () => {
  it("defaults off, exposes qualified backend choices and never starts a worker just to read settings", async () => {
    const w = world(), settings = await w.service.settings();
    expect(settings).toMatchObject({ enabled: false, backend: "claude-code", account: null, cap: 3, idleMinutes: 15, running: [] });
    expect(settings.backends).toHaveLength(1);
    await expect(w.service.ask(ask())).rejects.toThrow("unavailable");
    expect(w.start).not.toHaveBeenCalled();
  });

  it("validates bounds and selected account without substituting the default account", async () => {
    const w = world();
    for (const patch of [{ cap: 0 }, { cap: 17 }, { idleMinutes: 0 }, { idleMinutes: 241 }, { backend: "codex" }, { account: "../owner" }]) {
      await expect(w.service.configure(config(patch))).rejects.toThrow("Invalid");
    }
    await expect(w.service.configure(config({ account: "missing" }))).rejects.toThrow("needs sign-in");
    expect(w.store.save).not.toHaveBeenCalled();
    expect(w.start).not.toHaveBeenCalled();
    await w.service.configure(config({ cap: 1, idleMinutes: 240 }));
    expect((await w.service.settings()).cap).toBe(1);
  });

  it("shows working and idle controllers; persists only seven daily counts, never room content", async () => {
    const w = world({ config: config(), answers: [{ day: "2026-11-01", count: 999 }, { day: "2026-11-13", count: 2 }] });
    await w.service.settings();
    const result = w.service.ask(ask()); await flush();
    expect((await w.service.settings()).running).toEqual([{ roomId: "room-a", roomName: "Planning", state: "working", lastUsed: Date.UTC(2026, 10, 14, 12) }]);
    w.turns[0].done.resolve({ text: "Private answer" }); await result; await flush();
    expect((await w.service.settings()).running[0].state).toBe("idle");
    expect(w.service.available().running).toBe(0);
    const usage = await w.service.usage();
    expect(usage.days).toEqual(Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-${String(i + 8).padStart(2, "0")}`, count: i === 5 ? 2 : i === 6 ? 1 : 0 })));
    expect(usage.quota).toEqual({ band: "unknown" });
    const stored = JSON.stringify(w.store.save.mock.calls);
    expect(stored).not.toContain("Private"); expect(stored).not.toContain("room-a"); expect(stored).not.toContain("999");
    w.time(Date.UTC(2026, 10, 21));
    expect((await w.service.usage()).days.map(row => row.count)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("waits for the previous physical owner before saving or admitting a replacement", async () => {
    const w = world({ config: config(), answers: [] }); await w.service.settings();
    const turn = w.service.ask(ask()), rejected = expect(turn).rejects.toThrow(); await flush();
    const held = deferred<void>(); w.turns[0].stop.mockImplementation(() => held.promise);
    const changed = w.service.configure(config({ cap: 1 })); await flush();
    expect(w.store.save).not.toHaveBeenCalled();
    await expect(w.service.ask(ask("room-b"))).rejects.toThrow();
    expect(w.start).toHaveBeenCalledTimes(1);
    held.resolve(); await changed; await rejected;
    expect(w.store.save).toHaveBeenCalledTimes(1);
    expect((await w.service.settings()).cap).toBe(1);
  });

  it("restores the previous configuration when a settings write fails after draining", async () => {
    const w = world({ config: config(), answers: [] }); await w.service.settings();
    w.store.save.mockRejectedValueOnce(new Error("owned storage error"));
    await expect(w.service.configure(config({ enabled: false }))).rejects.toThrow("owned storage error");
    expect(w.service.available().enabled).toBe(true);
    const result = w.service.ask(ask()); await flush();
    w.turns[0].done.resolve({ text: "Restored" }); await expect(result).resolves.toEqual({ text: "Restored" });
  });

  it("does not recreate a runner when shutdown overlaps a held settings write", async () => {
    const w = world(); await w.service.settings();
    const held = deferred<void>(); w.store.save.mockImplementationOnce(() => held.promise);
    const changed = w.service.configure(config()); await flush();
    const closed = w.service.close(); held.resolve(); await Promise.all([changed, closed]);
    await expect(w.service.ask(ask())).rejects.toThrow("unavailable");
    expect(w.start).not.toHaveBeenCalled();
    expect(w.service.available().enabled).toBe(false);
  });

  it("cancels an ask forgotten during initial load", async () => {
    const w = world(), held = deferred<AssistantSavedState | null>();
    // A second provider owns its own initial read; no real files or worker are involved.
    const service = new RoomAssistantService({ host: { start: w.start }, store: { ...w.store, load: () => held.promise }, backends: w.backends }); services.push(service);
    const result = service.ask(ask()), rejected = expect(result).rejects.toThrow("unavailable");
    service.forget("room-a"); held.resolve({ config: config(), answers: [] });
    await rejected; expect(w.start).not.toHaveBeenCalled();
  });

  it("returns completed text when counter persistence fails and shows a usage warning", async () => {
    const w = world({ config: config(), answers: [] }); await w.service.settings();
    w.store.save.mockRejectedValue(new Error("counter storage down"));
    const result = w.service.ask(ask()); await flush(); w.turns[0].done.resolve({ text: "Already answered" });
    await expect(result).resolves.toEqual({ text: "Already answered" }); await flush();
    expect((await w.service.usage()).note).toBe("usage-not-saved");
    expect((await w.service.usage()).days.at(-1)?.count).toBe(1);
  });

  it("stops a selected idle controller and can start it again on a later ask", async () => {
    const w = world({ config: config(), answers: [] }); await w.service.settings();
    const first = w.service.ask(ask()); await flush(); w.turns[0].done.resolve({ text: "One" }); await first;
    await w.service.stopRoom("room-a");
    expect(w.turns[0].stop).toHaveBeenCalledTimes(1);
    expect((await w.service.settings()).running).toEqual([]);
    const second = w.service.ask(ask()); await flush(); w.turns[1].done.resolve({ text: "Two" }); await second;
    expect(w.start).toHaveBeenCalledTimes(2);
  });

  it("does not publish a previous account's quota after a configuration change", async () => {
    const w = world({ config: config(), answers: [] }); await w.service.settings();
    const held = deferred<AssistantQuotaBand>(); w.quota.mockImplementationOnce(() => held.promise);
    const usage = w.service.usage(); await flush();
    await w.service.configure(config({ enabled: false })); held.resolve("exhausted");
    expect((await usage).quota.band).toBe("unknown");
    w.quota.mockResolvedValue("near_limit"); expect((await w.service.usage()).quota.band).toBe("near_limit");
  });

  it("refuses settings replacement when a worker stop fails, retaining the failed owner", async () => {
    const w = world({ config: config(), answers: [] }); await w.service.settings();
    const turn = w.service.ask(ask()), rejected = expect(turn).rejects.toThrow(); await flush();
    w.turns[0].stop.mockRejectedValue(new Error("physical worker still owned"));
    await expect(w.service.configure(config({ cap: 1 }))).rejects.toThrow("did not stop");
    await rejected;
    expect(w.service.available()).toMatchObject({ state: "paused", note: "instance-stop-failed" });
    expect(w.store.save).not.toHaveBeenCalled();
    await expect(w.service.ask(ask("room-b"))).rejects.toThrow();
    expect(w.start).toHaveBeenCalledTimes(1);
  });
});

describe("Hub assistant non-secret state store", () => {
  async function home() { const root = await mkdtemp(join(tmpdir(), "assistant-admin-")); roots.push(root); return root; }
  it("round-trips config and daily counts with a private atomic file and no leftover temp", async () => {
    const root = await home(), store = assistantStateStore(root), saved = { config: config(), answers: [{ day: "2026-11-14", count: 2 }] };
    expect(await store.load()).toBeNull(); await store.save(saved);
    expect(await store.load()).toEqual(saved);
    expect((await stat(join(root, "assistant-state.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(root)).toEqual(["assistant-state.json"]);
    expect(await readFile(join(root, "assistant-state.json"), "utf8")).not.toContain("credential");
  });
  it.each(["null", "false", "[]", "not json"])("refuses malformed state %s instead of silently defaulting", async value => {
    const root = await home(); await writeFile(join(root, "assistant-state.json"), value);
    await expect(assistantStateStore(root).load()).rejects.toThrow();
  });
  it("refuses a symlink state file and leaves its target unchanged", async () => {
    const root = await home(), target = join(root, "untouched"); await writeFile(target, "sentinel");
    await symlink(target, join(root, "assistant-state.json"));
    await expect(assistantStateStore(root).load()).rejects.toThrow("Invalid");
    expect(await readFile(target, "utf8")).toBe("sentinel");
  });
  it("offers only a version-qualified backend and reads its account facts without a CLI probe", async () => {
    const root = await home(), version = vi.fn(async () => "2.1.316");
    let installed = "2.1.315";
    const service = createFleetRoomAssistant({ fleetHome: root, instanceHome: join(root, "workers"), version,
      facts: () => ({ binary: join(root, "not-executed"), version: installed, accounts: [{ id: "team", name: "Team", state: "signed-in" }] }) });
    services.push(service);
    expect((await service.settings()).backends).toEqual([]);
    installed = "2.1.316";
    expect((await service.settings()).backends).toEqual([{ id: "claude-code", name: "Claude", accounts: [{ id: "team", name: "Team", state: "signed-in" }] }]);
    expect(version).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });
});
