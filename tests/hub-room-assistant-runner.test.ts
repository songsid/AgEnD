import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomAssistantRunner } from "../src/hub/assistant/runner.js";
import { ROOM_ASSISTANT_DEFAULTS, type RoomAssistantAsk, type RoomAssistantConfig, type RoomAssistantHost, type RoomAssistantSession } from "../src/hub/assistant/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const config: RoomAssistantConfig = { enabled: true, backend: "claude-code", account: "hub-owner", ...ROOM_ASSISTANT_DEFAULTS };
const input = (roomId: string, messageId = roomId): RoomAssistantAsk => ({ roomId, roomName: `Room ${roomId}`, messageId, asker: { name: "Han" }, text: "Summarise", context: [] });
class FakeSession implements RoomAssistantSession {
  turns: Array<{ input: RoomAssistantAsk; signal: AbortSignal; reply: ReturnType<typeof deferred<{ text: string }>> }> = [];
  ask = vi.fn((input: RoomAssistantAsk, signal: AbortSignal) => {
    const reply = deferred<{ text: string }>();
    this.turns.push({ input, signal, reply });
    return reply.promise;
  });
  stop = vi.fn(async () => {});
  answer(text = "Summary", turn = this.turns.length - 1) { this.turns[turn].reply.resolve({ text }); }
}
const owned: RoomAssistantRunner[] = [];
function world(overrides: Partial<RoomAssistantConfig> = {}) {
  const sessions: FakeSession[] = [];
  const start = vi.fn<RoomAssistantHost["start"]>(async () => { const session = new FakeSession(); sessions.push(session); return session; });
  const runner = new RoomAssistantRunner({ ...config, ...overrides }, { start });
  owned.push(runner);
  const ask = (value: RoomAssistantAsk) => {
    const result = runner.ask(value);
    void result.catch(() => {}); // cancellation/error assertions below still await the original promise
    return result;
  };
  return { runner, sessions, start, ask };
}
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] }); vi.setSystemTime(0); });
afterEach(async () => { await Promise.allSettled(owned.splice(0).map(runner => runner.close())); vi.useRealTimers(); });

describe("Hub room assistant host-Fleet ownership", () => {
  it("pins pilot defaults and refuses invalid cap/idle settings", () => {
    expect(ROOM_ASSISTANT_DEFAULTS).toEqual({ cap: 3, idleMinutes: 15 });
    for (const cap of [0, 17, 1.5, NaN]) expect(() => world({ cap })).toThrow("settings");
    for (const idleMinutes of [0, 241, 1.5, NaN]) expect(() => world({ idleMinutes })).toThrow("settings");
    expect(() => world({ cap: 16, idleMinutes: 240 })).not.toThrow();
  });

  it("starts lazily with the selected account and snapshots only the last 30 room messages", async () => {
    const w = world(), request = input("room-a");
    request.context = Array.from({ length: 35 }, (_, at) => ({ author: `Person ${at}`, text: `Text ${at}`, at }));
    const result = w.ask(request);
    request.context[34].text = "later mutation";
    request.asker.name = "changed";
    expect(w.start).not.toHaveBeenCalled();
    await flush();
    expect(w.start).toHaveBeenCalledExactlyOnceWith({ roomId: "room-a", roomName: "Room room-a", backend: "claude-code", account: "hub-owner", signal: expect.any(AbortSignal) });
    expect(w.sessions[0].turns[0].input).toEqual({ ...input("room-a"), context: Array.from({ length: 30 }, (_, i) => ({ author: `Person ${i + 5}`, text: `Text ${i + 5}`, at: i + 5 })) });
    w.sessions[0].answer("**Room A only**");
    expect(await result).toEqual({ text: "**Room A only**" });
    expect(w.runner.available()).toEqual({ enabled: true, backend: "claude-code", cap: 3, running: 1, state: "idle" });
  });

  it("reserves cap during startup and stop drain, then starts waiting rooms in arrival order", async () => {
    const w = world({ cap: 1 }), launch = deferred<RoomAssistantSession>(), stopped = deferred<void>(), first = new FakeSession();
    first.stop.mockImplementation(() => stopped.promise);
    w.start.mockImplementationOnce(() => launch.promise);
    const a = w.ask(input("a")), b = w.ask(input("b")), c = w.ask(input("c"));
    await flush();
    expect(w.start.mock.calls.map(([value]) => value.roomId)).toEqual(["a"]);
    expect(w.runner.available().running).toBe(1);
    launch.resolve(first); await flush();
    first.answer(); await a; await flush();
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(w.start).toHaveBeenCalledTimes(1);
    stopped.resolve(); await flush();
    expect(w.start.mock.calls.map(([value]) => value.roomId)).toEqual(["a", "b"]);
    w.sessions[0].answer(); await b; await flush();
    expect(w.start.mock.calls.map(([value]) => value.roomId)).toEqual(["a", "b", "c"]);
    w.sessions[1].answer(); await c;
  });

  it("serializes a room's asks without holding up another room's free slot", async () => {
    const w = world({ cap: 2 }), a1 = w.ask(input("a", "a1")), a2 = w.ask(input("a", "a2")), b = w.ask(input("b"));
    await flush();
    expect(w.start.mock.calls.map(([value]) => value.roomId)).toEqual(["a", "b"]);
    expect(w.sessions[0].ask).toHaveBeenCalledTimes(1);
    expect(w.sessions[1].turns[0].input.roomId).toBe("b");
    w.sessions[0].answer(); await a1; await flush();
    expect(w.start).toHaveBeenCalledTimes(2);
    expect(w.sessions[0].turns.map(turn => turn.input.messageId)).toEqual(["a1", "a2"]);
    w.sessions[0].answer(); w.sessions[1].answer(); await Promise.all([a2, b]);
  });

  it("evicts the longest-idle room when all slots are occupied", async () => {
    const w = world({ cap: 2 }), a = w.ask(input("a")), b = w.ask(input("b")); await flush();
    w.sessions[0].answer(); await a; vi.setSystemTime(100);
    w.sessions[1].answer(); await b;
    const c = w.ask(input("c")); await flush();
    expect(w.sessions[0].stop).toHaveBeenCalledTimes(1);
    expect(w.sessions[1].stop).not.toHaveBeenCalled();
    expect(w.start.mock.calls.map(([value]) => value.roomId)).toEqual(["a", "b", "c"]);
    w.sessions[2].answer(); await c;
  });

  it("stops exactly at the configured idle boundary, measured from the latest completed answer", async () => {
    const w = world({ idleMinutes: 1 }), first = w.ask(input("a")); await flush();
    w.sessions[0].answer(); await first;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(w.sessions[0].stop).not.toHaveBeenCalled();
    const second = w.ask(input("a", "second")); await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.sessions[0].stop).not.toHaveBeenCalled(); // a working turn is not idle
    w.sessions[0].answer(); await second;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(w.sessions[0].stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(w.sessions[0].stop).toHaveBeenCalledTimes(1);
    expect(w.runner.available().running).toBe(0);
  });

  it("forgets a held launch without delivering its turn or releasing capacity before late disposal", async () => {
    const w = world({ cap: 1 }), launch = deferred<RoomAssistantSession>(), stopped = deferred<void>(), late = new FakeSession();
    late.stop.mockImplementation(() => stopped.promise);
    w.start.mockImplementationOnce(() => launch.promise);
    const a = w.ask(input("a")); await flush();
    w.runner.forget("a");
    await expect(a).rejects.toThrow("stopped");
    const b = w.ask(input("b"));
    launch.resolve(late); await flush();
    expect(late.ask).not.toHaveBeenCalled();
    expect(late.stop).toHaveBeenCalledTimes(1);
    expect(w.start).toHaveBeenCalledTimes(1);
    stopped.resolve(); await flush();
    expect(w.start.mock.calls.map(([value]) => value.roomId)).toEqual(["a", "b"]);
    w.sessions[0].answer(); await b;
  });

  it("rejects removed queued turns and fences a late answer while stopping the exact owner", async () => {
    const w = world({ cap: 1 }), a = w.ask(input("a")), queued = w.ask(input("a", "queued")); await flush();
    const stop = deferred<void>(); w.sessions[0].stop.mockImplementation(() => stop.promise);
    w.runner.forget("a");
    await expect(a).rejects.toThrow("stopped");
    await expect(queued).rejects.toThrow("removed");
    w.sessions[0].answer("must not escape");
    const replacement = w.ask(input("a", "new")); await flush();
    expect(w.start).toHaveBeenCalledTimes(1);
    stop.resolve(); await flush();
    expect(w.start).toHaveBeenCalledTimes(2);
    expect(w.sessions[1].turns[0].input.messageId).toBe("new");
    w.sessions[1].answer("New owner"); expect(await replacement).toEqual({ text: "New owner" });
  });

  it("releases a failed startup reservation so the next waiting room can start", async () => {
    const w = world({ cap: 1 }); w.start.mockRejectedValueOnce(new Error("login needed"));
    const a = w.ask(input("a")), b = w.ask(input("b")); await flush();
    await expect(a).rejects.toThrow("login needed");
    expect(w.start.mock.calls.map(([value]) => value.roomId)).toEqual(["a", "b"]);
    w.sessions[0].answer(); await b;
  });

  it("drains a failed turn before launching another room", async () => {
    const w = world({ cap: 1 }), a = w.ask(input("a")), b = w.ask(input("b")); await flush();
    const stop = deferred<void>(); w.sessions[0].stop.mockImplementation(() => stop.promise);
    w.sessions[0].turns[0].reply.reject(new Error("rate limited")); await flush();
    await expect(a).rejects.toThrow("rate limited");
    expect(w.start).toHaveBeenCalledTimes(1);
    stop.resolve(); await flush();
    expect(w.start).toHaveBeenCalledTimes(2);
    w.sessions[1].answer(); await b;
  });

  it("keeps a failed physical stop's slot and reports paused instead of exceeding cap", async () => {
    const w = world({ cap: 1 }), a = w.ask(input("a")); await flush();
    w.sessions[0].stop.mockRejectedValue(new Error("stop failed"));
    const b = w.ask(input("b")); w.runner.forget("a"); await flush();
    await expect(a).rejects.toThrow("stopped");
    await expect(b).rejects.toThrow("did not stop");
    await expect(w.ask(input("c"))).rejects.toThrow("did not stop");
    expect(w.start).toHaveBeenCalledTimes(1);
    expect(w.runner.available()).toMatchObject({ running: 1, state: "paused", note: "instance-stop-failed" });
    await expect(w.runner.close()).rejects.toThrow("did not stop");
  });

  it("shutdown cancels queued asks and waits for held startup and physical cleanup", async () => {
    const w = world({ cap: 1 }), launch = deferred<RoomAssistantSession>(), stop = deferred<void>(), late = new FakeSession();
    late.stop.mockImplementation(() => stop.promise); w.start.mockImplementationOnce(() => launch.promise);
    const a = w.ask(input("a")), b = w.ask(input("b")); await flush();
    const close = w.runner.close(), settled = vi.fn(); void close.then(settled);
    expect(w.runner.close()).toBe(close);
    await expect(a).rejects.toThrow("stopped"); await expect(b).rejects.toThrow("stopping");
    launch.resolve(late); await flush();
    expect(late.ask).not.toHaveBeenCalled(); expect(settled).not.toHaveBeenCalled();
    stop.resolve(); await close;
    expect(w.runner.available()).toMatchObject({ enabled: false, running: 0, state: "paused" });
    await expect(w.ask(input("c"))).rejects.toThrow("unavailable");
  });

  it("does not start disabled assistants", async () => {
    const w = world({ enabled: false });
    await expect(w.ask(input("a"))).rejects.toThrow("unavailable");
    expect(w.start).not.toHaveBeenCalled();
    expect(w.runner.available()).toMatchObject({ enabled: false, running: 0, state: "paused" });
  });
});
