/** Active GET deadlines include headers and body. Inert transports, fake time; no account or network. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page } from "./helpers/app-harness.js";
let clients: any;
const reply = (body: any = {}, status = 200) => ({ ok: status === 200, status, headers: new Headers(), json: async () => body });
const flush = async () => { await vi.advanceTimersByTimeAsync(0); };
beforeAll(async () => { const p = page(); clients = await import("/ui/js/hub-client.js"); p.restore(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture(timeout = 100) {
  const signals: AbortSignal[] = []; let calls = 0, release!: (v: any) => void;
  const fetchImpl = vi.fn(async (_path: string, init: any) => {
    if (++calls === 1) { signals.push(init.signal); return await new Promise(r => { release = r; }); }
    return reply({ version: calls });
  });
  return { client: clients.createHubWebClient({ fetchImpl, readTimeoutMs: timeout }), signals, fetchImpl, release: (v: any) => release(v) };
}
describe("whole-attempt read deadlines", () => {
  it("aborts a held fetch and lets the next GET finish without reload or retrying the timed-out GET", async () => {
    vi.useFakeTimers(); const f = fixture(), seen: any[] = [];
    f.client.adminOverview().then((r: any) => seen.push(r)); f.client.groupPolicy().then((r: any) => seen.push(r));
    await flush(); await vi.advanceTimersByTimeAsync(99); expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([expect.objectContaining({ ok: false, status: 0, code: "unreachable", timedOut: true }), expect.objectContaining({ ok: true, version: 2 })]);
    expect(f.signals[0]?.aborted).toBe(true); expect(f.fetchImpl).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it("the deadline also covers a body that never completes after headers arrive", async () => {
    vi.useFakeTimers(); let finish!: (v: any) => void, signal!: AbortSignal, n = 0;
    const fetchImpl = vi.fn(async (_path: string, init: any) => ++n === 1
      ? (signal = init.signal, { ...reply(), json: () => new Promise(r => { finish = r; }) }) : reply({ next: true }));
    const c = clients.createHubWebClient({ fetchImpl, readTimeoutMs: 100 }), seen: any[] = [];
    c.adminOverview().then((r: any) => seen.push(r)); c.rooms().then((r: any) => seen.push(r)); await flush();
    await vi.advanceTimersByTimeAsync(100); expect(seen).toHaveLength(2); expect(seen[0]).toMatchObject({ code: "unreachable" }); expect(signal.aborted).toBe(true);
    finish({ privateOldData: true }); await flush(); expect(seen).toHaveLength(2); expect(seen[1]).toMatchObject({ ok: true, next: true });
  });
  it("a late timed-out 401 body cannot end the current session or drain its next queued read", async () => {
    vi.useFakeTimers(); let finish!: (v: any) => void, n = 0;
    const c = clients.createHubWebClient({ readTimeoutMs: 100, fetchImpl: vi.fn(async () => ++n === 1 ? { ...reply({}, 401), json: () => new Promise(r => { finish = r; }) } : reply({ next: true })) });
    const ended = vi.fn(), seen: any[] = []; c.onSignedOut(ended); c.adminOverview().then((r: any) => seen.push(r));
    await flush(); await vi.advanceTimersByTimeAsync(100); expect(seen).toHaveLength(1);
    finish({ code: "denied" }); await flush(); expect(ended).not.toHaveBeenCalled(); expect(await c.rooms()).toMatchObject({ ok: true, next: true });
  });
  it("a normal response just before the budget completes and cleans the timer", async () => {
    vi.useFakeTimers(); const f = fixture(); const read = f.client.adminOverview(); await flush(); await vi.advanceTimersByTimeAsync(99);
    f.release(reply({ healthy: true })); await flush(); expect(await read).toMatchObject({ ok: true, healthy: true });
    expect(f.signals[0]?.aborted).toBe(false); expect(vi.getTimerCount()).toBe(0);
    await f.client.signIn("admin", "fixture-only"); expect(f.signals[0]?.aborted).toBe(false);
  });
  it.each([undefined, Infinity])("the default/invalid override %s uses a finite120s UI budget", async budget => {
    vi.useFakeTimers(); const seen: any[] = [], fetchImpl = vi.fn(async () => await new Promise(() => {}));
    const c = clients.createHubWebClient({ fetchImpl, ...(budget === undefined ? {} : { readTimeoutMs: budget }) });
    c.adminOverview().then((r: any) => seen.push(r)); await flush(); await vi.advanceTimersByTimeAsync(119999); expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); expect(seen).toEqual([expect.objectContaining({ code: "unreachable", timedOut: true })]);
  });
  it("queue wait is not charged against the next read's own attempt budget", async () => {
    vi.useFakeTimers(); let calls = 0, first!: (v: any) => void, second!: (v: any) => void;
    const fetchImpl = vi.fn(async () => ++calls === 1 ? await new Promise(r => { first = r; }) : await new Promise(r => { second = r; }));
    const c = clients.createHubWebClient({ fetchImpl, readTimeoutMs: 100 }), seen: any[] = [];
    c.adminOverview().then((r: any) => seen.push(r)); c.rooms().then((r: any) => seen.push(r)); await flush();
    await vi.advanceTimersByTimeAsync(99); first(reply({ first: true })); await flush();
    await vi.advanceTimersByTimeAsync(99); expect(seen).toEqual([expect.objectContaining({ first: true })]);
    second(reply({ healthy: true })); await flush(); expect(seen[1]).toMatchObject({ healthy: true });
  });
});

describe("cancellation and pending-only sharing", () => {
  it("queued caller abort settles promptly without sending that read or jumping past its held predecessor", async () => {
    vi.useFakeTimers(); const f = fixture(), caller = new AbortController(), seen: any[] = [];
    f.client.adminOverview(); f.client.directorySettings(caller.signal).then((r: any) => seen.push(r)); f.client.rooms(); await flush();
    caller.abort(); await flush(); expect(seen).toHaveLength(1); expect(seen[0]).toMatchObject({ code: "unreachable" }); expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100); expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("active caller abort cancels its real child signal and frees the queue", async () => {
    vi.useFakeTimers(); const f = fixture(), caller = new AbortController(), seen: any[] = [];
    f.client.directorySettings(caller.signal).then((r: any) => seen.push(r)); f.client.rooms().then((r: any) => seen.push(r)); await flush(); caller.abort(); await flush();
    expect(seen).toHaveLength(2); expect(f.signals[0]?.aborted).toBe(true); expect(seen[1]).toMatchObject({ ok: true }); expect(vi.getTimerCount()).toBe(0);
  });
  it("coalesced callers share one attempt/deadline; a later explicit read is fresh", async () => {
    vi.useFakeTimers(); const f = fixture(), first = f.client.adminOverview(), second = f.client.adminOverview(), seen: any[] = [];
    expect(first).toBe(second); first.then((r: any) => seen.push(r)); second.then((r: any) => seen.push(r));
    await flush(); await vi.advanceTimersByTimeAsync(100); expect(seen).toHaveLength(2); expect(seen.every(r => r.code === "unreachable")).toBe(true); expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(await f.client.adminOverview()).toMatchObject({ version: 2 });
  });
  it("separate caller signals do not coalesce: cancelling one cannot cancel its peer", async () => {
    vi.useFakeTimers(); const f = fixture(), a = new AbortController(), b = new AbortController(), seen: any[] = [];
    f.client.directorySettings(a.signal).then((r: any) => seen.push(r)); f.client.directorySettings(b.signal).then((r: any) => seen.push(r)); await flush(); a.abort(); await flush();
    expect(seen).toHaveLength(2); expect(seen[1]).toMatchObject({ ok: true }); expect(b.signal.aborted).toBe(false); expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each(["signIn", "signOut", "other401"])("%s retires active and queued reads promptly and aborts the active transport", async action => {
    vi.useFakeTimers(); let signal!: AbortSignal;
    const fetchImpl = vi.fn(async (_path: string, init: any) => init.method === "GET" ? (signal = init.signal, await new Promise(() => {})) : reply(action === "other401" ? { code: "denied" } : { csrf: "successor" }, action === "other401" ? 401 : 200));
    const c = clients.createHubWebClient({ fetchImpl, readTimeoutMs: 100 }), seen: any[] = [];
    c.adminOverview().then((r: any) => seen.push(r)); c.rooms().then((r: any) => seen.push(r)); await flush();
    if (action === "signIn") await c.signIn("admin", "fixture-only"); else if (action === "signOut") await c.signOut(); else await c.createPairing("colleague");
    await flush(); expect(seen).toHaveLength(2); expect(seen.every(r => r.status === 401 && r.code === "unauthenticated")).toBe(true); expect(signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("caller abort during429 backoff clears the wait and never sends another attempt", async () => {
    vi.useFakeTimers(); const caller = new AbortController(), seen: any[] = [];
    const fetchImpl = vi.fn(async (path: string) => path.includes("directory") ? reply({ code: "backpressure" }, 429) : reply({ next: true }));
    const c = clients.createHubWebClient({ fetchImpl, readTimeoutMs: 100 }); c.directorySettings(caller.signal).then((r: any) => seen.push(r)); c.rooms().then((r: any) => seen.push(r));
    await flush(); caller.abort(); await flush(); expect(seen).toHaveLength(2); expect(fetchImpl).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it("a server refusal cannot impersonate the client-only timeout marker", async () => {
    vi.useFakeTimers();
    const c = clients.createHubWebClient({ readTimeoutMs: 100, fetchImpl: async () => reply({ code: "denied", timedOut: true }, 403) });
    const result = await c.adminOverview(); expect(result).toMatchObject({ ok: false, status: 403, code: "denied" });
    expect(result).not.toHaveProperty("timedOut"); expect(vi.getTimerCount()).toBe(0);
  });
  it("writes have no new timeout or replay", async () => {
    vi.useFakeTimers(); let release!: (v: any) => void;
    const fetchImpl = vi.fn((_path: string, init: any) => { expect(init.signal).toBeUndefined(); return new Promise(r => { release = r; }); });
    const c = clients.createHubWebClient({ fetchImpl, readTimeoutMs: 100 }), seen: any[] = []; c.createPairing("colleague").then((r: any) => seen.push(r));
    await vi.advanceTimersByTimeAsync(600000); expect(seen).toEqual([]); expect(fetchImpl).toHaveBeenCalledTimes(1); release(reply({ ok: true })); await flush(); expect(seen).toHaveLength(1);
  });
});
