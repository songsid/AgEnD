/**
 * #1580 (baseline: the issue body): a dashboard tab while the fleet restarts. The real createStream (app-stream.js)
 * with a fake EventSource, fetch, document and the test's clock: a dropped stream is closed and reopened on a capped
 * exponential backoff with jitter, one EventSource at a time; a stream that fails before it speaks is probed by one
 * poll — no poll loop while the fleet is unreachable; nothing while the tab is hidden; a 401 ends it; the reconnect
 * catches up with the page's cursor (nothing lost, nothing twice); pagehide/pageshow suspend and resume it. The public
 * link's poll loop backs off the same way. Plus: one stream per tab, and the View's polls skip while reconnecting.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type Mode = "down" | "up" | "401" | "hang";
function world(opts: { random?: number } = {}) {
  const sources: any[] = [];
  const fetched: Array<{ t: number; url: string }> = [];
  const made: number[] = [];
  let fleet: Mode = "down";
  let answer: (url: string) => unknown = () => ({ status: { instances: [] }, messages: [], cursor: "bb-0", deliveries: [], prompts: [], needs: [] });
  const hangs: Array<{ ok: (v: unknown) => void; no: (e: Error) => void }> = [];
  const all: Array<{ ok: (v: unknown) => void; no: (e: Error) => void } | null> = [];
  class ES {
    url: string; listeners: Record<string, Function> = {}; onerror: Function | null = null; closed = false;
    constructor(url: string) { this.url = url; sources.push(this); made.push(Date.now()); }
    addEventListener(n: string, f: Function) { this.listeners[n] = f; }
    close() { this.closed = true; }
    frame(n: string, data: unknown, lastEventId?: string) { this.listeners[n]?.({ data: JSON.stringify(data), lastEventId }); }
  }
  const docListeners: Record<string, Function[]> = {};
  const document = {
    hidden: false,
    addEventListener(n: string, f: Function) { (docListeners[n] ??= []).push(f); },
    removeEventListener(n: string, f: Function) { docListeners[n] = (docListeners[n] ?? []).filter(x => x !== f); },
    show() { this.hidden = false; for (const f of docListeners.visibilitychange ?? []) f(); },
  };
  const env = {
    EventSource: ES, document, console,
    setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (h: any) => clearTimeout(h),
    setInterval: (f: () => void, ms: number) => setInterval(f, ms), clearInterval: (h: any) => clearInterval(h),
    performance: { now: () => Date.now() },
    random: () => opts.random ?? 1,
    fetch: (url: string) => {
      fetched.push({ t: Date.now(), url });
      if (fleet === "down") return Promise.reject(new TypeError("Failed to fetch"));
      if (fleet === "401") return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
      if (fleet === "hang") return new Promise((ok, no) => { const h = { ok, no }; hangs.push(h); all.push(h); });
      return Promise.resolve({ ok: true, status: 200, json: async () => answer(url) });
    },
  };
  return {
    env, sources, fetched, made, document,
    set fleet(m: Mode) { fleet = m; },
    answer(f: (url: string) => unknown) { answer = f; },
    open: () => sources.filter(s => !s.closed),
    /** Answer every read still on its way with `body`. */
    release(body: unknown) { for (const r of hangs.splice(0)) r.ok({ ok: true, status: 200, json: async () => body }); },
    /** The reads on their way fail (the network) — or answer 401 (the session ended). */
    failHeld() { for (const r of hangs.splice(0)) r.no(new TypeError("Failed to fetch")); },
    held401() { for (const r of hangs.splice(0)) r.ok({ ok: false, status: 401, json: async () => ({}) }); },
    get heldCount() { return hangs.filter(Boolean).length; },
    /** Answer the i-th read made while the fleet hung (in the order they were made). */
    releaseAt(i: number, body: unknown) { const r = all[i]; all[i] = null; r?.ok({ ok: true, status: 200, json: async () => body }); },
  };
}
async function load() {
  return await import("/assets/app-stream.js") as { createStream(o: unknown): any; reconnectDelay(n: number, r?: () => number): number; RECONNECT: { baseMs: number; capMs: number } };
}
afterEach(() => { vi.useRealTimers(); });
const status = { instances: [] };

describe("the backoff", () => {
  it("about 1, 2, 4, 8, 16, then 30 s — never more; jitter draws each from 50–100 % of its step", async () => {
    const { reconnectDelay } = await load();
    expect([0, 1, 2, 3, 4, 5, 6, 20, 99].map(n => reconnectDelay(n, () => 1))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
    expect([0, 1, 2, 3, 4, 5, 6].map(n => reconnectDelay(n, () => 0))).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000]);
  });
});

describe("a fleet that went away (a restart)", () => {
  it("the stream is closed at once and reopened on the backoff — one EventSource at a time, and no poll loop", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    const s = createStream({ mode: "full", env: w.env });
    const retries: number[] = [];
    s.on("retry", (r: { inMs: number }) => retries.push(r.inMs));
    s.start();
    w.sources[0].frame("status", status);
    expect(s.connection()).toBe("live");
    const t0 = Date.now();
    w.sources[0].onerror();                                   // the fleet went away
    expect([w.sources[0].closed, s.connection()]).toEqual([true, "reconnecting"]);
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(retries.at(-1)!);
      expect(w.open().length, "never two streams").toBeLessThanOrEqual(1);
      w.sources.at(-1).onerror?.();                           // this attempt fails before it speaks
      await vi.advanceTimersByTimeAsync(0);                   // its probe fails too
    }
    expect(w.made.slice(1).map(m => (m - t0) / 1000)).toEqual([1, 3, 7, 15, 31, 61, 91, 121]);
    expect(retries).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
    expect(w.fetched.length, "one probe per failed attempt, nothing else").toBe(8);
    expect(w.open()).toHaveLength(0);
    expect(s.connection()).toBe("reconnecting");
    s.close();
  });

  it("70 s down costs a handful of requests, not dozens (the browser's 3 s retry + a 5 s poll made 37)", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    const s = createStream({ mode: "full", env: w.env });
    s.start();
    w.sources[0].frame("status", status);
    w.sources[0].onerror();
    for (let t = 0; t < 70_000; t += 100) {
      await vi.advanceTimersByTimeAsync(100);
      const last = w.sources.at(-1);
      if (!last.closed && last.onerror) last.onerror();     // every attempt fails at once while it is down
    }
    const requests = (w.sources.length - 1) + w.fetched.length;
    expect(requests).toBeLessThanOrEqual(12);
    s.close();
  });

  it("a step due while the tab is hidden waits — and runs the moment it is shown", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    const s = createStream({ mode: "full", env: w.env });
    s.start();
    w.sources[0].frame("status", status);
    w.document.hidden = true;
    w.sources[0].onerror();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect([w.sources.length, w.fetched.length], "nothing while nobody looks").toEqual([1, 0]);
    w.document.show();
    expect(w.sources.length, "shown: an attempt at once").toBe(2);
    s.close();
  });

  it("the next outage starts from the first step again once the stream was back (the backoff is per outage)", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    const s = createStream({ mode: "full", env: w.env });
    const retries: number[] = [];
    s.on("retry", (r: { inMs: number }) => retries.push(r.inMs));
    s.start();
    w.sources[0].frame("status", status);
    w.sources[0].onerror();
    for (let i = 0; i < 3; i++) { await vi.advanceTimersByTimeAsync(retries.at(-1)!); w.sources.at(-1).onerror(); await vi.advanceTimersByTimeAsync(0); }
    expect(retries).toEqual([1000, 2000, 4000, 8000]);
    w.fleet = "up";
    await vi.advanceTimersByTimeAsync(8000);
    w.sources.at(-1).frame("status", status);                // back
    await vi.advanceTimersByTimeAsync(0);
    w.fleet = "down";
    w.sources.at(-1).onerror();                              // a later restart
    expect(retries.at(-1)).toBe(1000);
    s.close();
  });

  it("a stream this page let go of is not listened to: its late events change nothing", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    const s = createStream({ mode: "full", env: w.env });
    const seen: unknown[] = [];
    s.on("message", (m: unknown) => seen.push(m));
    s.start();
    w.sources[0].frame("status", status);
    const old = w.sources[0];
    old.onerror();
    await vi.advanceTimersByTimeAsync(0);
    old.frame("message", { id: "late" }, "zz-9");             // a frame that was still in the pipe
    expect([seen, s.connection(), s.cursor()]).toEqual([[], "reconnecting", ""]);
    s.close();
  });

  it("a 401 is the session ending: nothing is retried after it", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    const s = createStream({ mode: "full", env: w.env });
    s.start();
    w.fleet = "401";
    w.sources[0].onerror();                                   // fails before it speaks: the probe answers 401
    await vi.advanceTimersByTimeAsync(0);
    expect(s.connection()).toBe("ended");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect([w.sources.length, w.fetched.length]).toEqual([1, 1]);
  });
});

describe("coming back: nothing lost, nothing twice", () => {
  it("the reconnected stream's first frame starts a catch-up with the page's cursor; live events wait for its snapshot", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    const s = createStream({ mode: "full", env: w.env });
    const seen: string[] = [];
    s.on("message", (m: { id: string }) => seen.push(m.id));
    s.start();
    w.sources[0].frame("status", status);
    w.sources[0].frame("message", { id: "bb-7" }, "bb-7");
    w.sources[0].onerror();                                   // the fleet restarts; "cc-1", "cc-2" are said meanwhile
    await vi.advanceTimersByTimeAsync(1000);
    w.fleet = "hang";                                         // it is back; the catch-up read is on its way
    w.sources[1].frame("status", status);
    expect(w.fetched.map(f => f.url)).toEqual(["/ui/poll?after=bb-7"]);
    w.sources[1].frame("message", { id: "cc-3" }, "cc-3");   // said after the restart, live — held behind the snapshot
    expect(seen).toEqual(["bb-7"]);
    w.release({ status, messages: [{ id: "cc-1" }, { id: "cc-2" }], cursor: "cc-2", deliveries: [], prompts: [], needs: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen, "what was said while it was away, then what came live — each once, in order").toEqual(["bb-7", "cc-1", "cc-2", "cc-3"]);
    expect([s.connection(), s.cursor(), s.hydration()]).toEqual(["live", "cc-3", "ok"]);
    for (let i = 0; i < 6; i++) { await vi.advanceTimersByTimeAsync(10_000); w.sources[1].frame("status", status); }   // the server's 10 s status
    expect([w.fetched.length, w.sources.length], "one catch-up read, nothing after it; still the one stream").toEqual([1, 2]);
    s.close();
  });

  it("the first open is not a reconnect: no catch-up read (the chat loads its history itself)", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    w.fleet = "up";
    const s = createStream({ mode: "full", env: w.env });
    s.start();
    w.sources[0].frame("status", status);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.fetched).toEqual([]);
    s.close();
  });
});

describe("the page leaving and coming back (pagehide / pageshow)", () => {
  it("suspend() closes the stream and every timer; resume() reconnects at once and catches up", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    w.fleet = "up";
    const s = createStream({ mode: "full", env: w.env });
    s.start();
    w.sources[0].frame("status", status);
    s.suspend();
    expect(w.open()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect([w.sources.length, w.fetched.length], "nothing left running").toEqual([1, 0]);
    s.resume();
    expect(w.sources.length).toBe(2);
    w.sources[1].frame("status", status);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.fetched.map(f => f.url)).toEqual(["/ui/poll?after="]);
    s.close();
  });
  it("the app wires them: pagehide suspends, a pageshow from the back-forward cache resumes", () => {
    const app = readFileSync(join(process.cwd(), "src", "ui", "shared", "app.js"), "utf8");
    expect(app).toContain('window.addEventListener("pagehide", () => stream.suspend());');
    expect(app).toContain('window.addEventListener("pageshow", (e) => { if (e.persisted) stream.resume(); });');
  });
});

describe("the public link (poll transport)", () => {
  it("a failed poll stops the 5 s loop and backs off; answered again, the loop resumes", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    w.fleet = "up";
    const s = createStream({ mode: "full", transport: "poll", env: w.env });
    s.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.fetched).toHaveLength(3);                        // at once, 5 s, 10 s
    w.fleet = "down";
    const t0 = Date.now();
    await vi.advanceTimersByTimeAsync(5_000);                 // the loop's poll fails
    expect(s.connection()).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(60_000);
    const during = w.fetched.filter(f => f.t > t0).map(f => (f.t - t0) / 1000);
    expect(during, "the failing loop poll, then the backoff's probes — no 5 s storm").toEqual([5, 6, 8, 12, 20, 36]);
    w.fleet = "up";
    await vi.advanceTimersByTimeAsync(30_000);               // the next probe is answered
    expect(s.connection()).toBe("polling");
    const n = w.fetched.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.fetched.length - n, "every 5 s again").toBe(2);
    expect(s.usesEventSource()).toBe(false);
    s.close();
  });
});

describe("one stream per tab", () => {
  it("only app-stream.js makes an EventSource, and app.js makes the page's one stream", () => {
    const root = join(process.cwd(), "src", "ui");
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (n !== "vendor") walk(p); } else if (n.endsWith(".js")) files.push(p); } };
    walk(root);
    const makers = files.filter(f => /new\s+(?:env\.|window\.|globalThis\.)?EventSource\s*\(/.test(readFileSync(f, "utf8"))).map(f => f.slice(root.length + 1));
    expect(makers).toEqual(["shared/app-stream.js"]);
    const app = readFileSync(join(root, "shared", "app.js"), "utf8");
    expect(app.match(/createStream\(/g)).toHaveLength(1);
  });
});

// ── #1580 review (Prism): work in flight belongs to the epoch that started it; a 401 from any read ends it all ──
const snapOf = (over: Record<string, unknown> = {}) => ({ status, messages: [], cursor: "bb-1", deliveries: [], prompts: [], needs: [], ...over });
describe("work in flight is owned: suspend, resume and a stream back live let go of it", () => {
  it("P1: a catch-up waiting to retry is let go of by suspend; resume starts a new one that completes", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    const s = createStream({ mode: "full", env: w.env });
    s.start();
    w.sources[0].frame("status", status);
    w.sources[0].onerror();
    await vi.advanceTimersByTimeAsync(1000);                  // reconnect step: a new stream speaks → catch-up read fails
    w.sources[1].frame("status", status);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.hydration()).toBe("retrying");
    let oldSettled = false;
    s.catchUp().then(() => { oldSettled = true; });          // the catch-up in flight (joined)
    w.fleet = "up";
    s.suspend(); s.resume();                                 // back at once (the back-forward cache)
    w.sources.at(-1).frame("status", status);                // the new stream speaks: a NEW catch-up, not the old one
    await vi.advanceTimersByTimeAsync(0);
    expect(oldSettled, "the old one settled, not waiting forever").toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect([s.hydration(), s.connection()]).toEqual(["ok", "live"]);
    s.close();
  });
  it("P1 control: without a suspend the same retry completes on its own", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    const s = createStream({ mode: "full", env: w.env });
    s.start();
    w.sources[0].frame("status", status);
    w.sources[0].onerror();
    await vi.advanceTimersByTimeAsync(1000);
    w.sources[1].frame("status", status);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.hydration()).toBe("retrying");
    w.fleet = "up";
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.hydration()).toBe("ok");
    s.close();
  });

  it("P2 ①: a silent-stream fallback read that fails after the stream spoke does not undo the live stream", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    w.fleet = "hang";
    const s = createStream({ mode: "full", env: w.env });
    s.start();
    await vi.advanceTimersByTimeAsync(15_000);               // silent: fallback read A, held
    expect(w.heldCount).toBe(1);
    w.sources[0].frame("status", status);                    // the stream speaks: live
    w.failHeld();                                            // A fails late
    for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(10_000); w.sources[0].frame("status", status); }   // the server's 10 s status
    expect([s.connection(), w.sources.length]).toEqual(["live", 1]);
    s.close();
  });
  it("P2 ① control: the same failure while nothing is live still means reconnecting", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    w.fleet = "hang";
    const s = createStream({ mode: "full", env: w.env });
    s.start();
    await vi.advanceTimersByTimeAsync(15_000);
    w.failHeld();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.connection()).toBe("reconnecting");
    s.close();
  });

  it("P2 ②: a probe from before a suspend/resume decides nothing for the new live stream", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    w.fleet = "hang";
    const s = createStream({ mode: "full", env: w.env });
    s.start();
    w.sources[0].onerror();                                  // fails before it speaks: probe A, held
    expect(w.heldCount).toBe(1);
    s.suspend(); s.resume();
    w.sources.at(-1).frame("status", status);                // the new stream is live
    w.failHeld();                                            // the old probe fails late
    await vi.advanceTimersByTimeAsync(0);
    expect([s.connection(), w.open().length]).toEqual(["live", 1]);
    s.close();
  });

  it("P2 ③: a catch-up read answered after a suspend emits nothing", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    const seen: unknown[] = [];
    const s = createStream({ mode: "full", env: w.env });
    s.on("message", (m: unknown) => seen.push(m));
    s.start();
    w.sources[0].frame("status", status);
    w.sources[0].onerror();
    await vi.advanceTimersByTimeAsync(1000);
    w.fleet = "hang";
    w.sources[1].frame("status", status);                    // catch-up read, held
    s.suspend();
    w.release(snapOf({ messages: [{ id: "OLD" }] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
    s.close();
  });
  it("P2 ③: and it does not touch the newer catch-up's held events — they wait for that read's snapshot", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    const seen: string[] = [];
    const s = createStream({ mode: "full", env: w.env });
    s.on("message", (m: { id: string }) => seen.push(m.id));
    s.start();
    w.sources[0].frame("status", status);
    w.sources[0].onerror();
    await vi.advanceTimersByTimeAsync(1000);
    w.fleet = "hang";
    w.sources[1].frame("status", status);                    // catch-up read A, held
    s.suspend(); s.resume();
    w.sources.at(-1).frame("status", status);                // catch-up read B, held
    w.sources.at(-1).frame("message", { id: "LIVE" }, "cc-9"); // live, held behind B's snapshot
    w.releaseAt(0, snapOf({ messages: [{ id: "A-OLD" }] }));  // A answers late: let go of — applies and releases nothing
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
    w.releaseAt(1, snapOf({ messages: [{ id: "B-NEW" }] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["B-NEW", "LIVE"]);
    s.close();
  });

  it("P2 ③ control: answered without a suspend, it is applied", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    const seen: unknown[] = [];
    const s = createStream({ mode: "full", env: w.env });
    s.on("message", (m: unknown) => seen.push(m));
    s.start();
    w.sources[0].frame("status", status);
    w.sources[0].onerror();
    await vi.advanceTimersByTimeAsync(1000);
    w.fleet = "hang";
    w.sources[1].frame("status", status);
    w.release(snapOf({ messages: [{ id: "NEW" }] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([{ id: "NEW" }]);
    s.close();
  });

  it("P2 ④: the public link's queued poll is dropped by a suspend — no fetch after it", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    w.fleet = "hang";
    const s = createStream({ mode: "full", transport: "poll", env: w.env });
    s.start();                                               // t0: poll A, held
    await vi.advanceTimersByTimeAsync(5000);                 // t5: a poll asked for behind A
    s.suspend();
    w.fleet = "up";
    w.release(snapOf());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.fetched).toHaveLength(1);
    s.resume();                                              // back: its own first poll, and nothing queued from before
    await vi.advanceTimersByTimeAsync(1000);
    expect(w.fetched).toHaveLength(2);
    s.close();
  });
});

describe("a 401 from any read ends it — once, with everything queued", () => {
  it("the reconnect's catch-up answered 401: ended, one read, the stream closed", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    const s = createStream({ mode: "full", env: w.env });
    s.start();
    w.sources[0].frame("status", status);
    w.sources[0].onerror();
    await vi.advanceTimersByTimeAsync(1000);
    w.fleet = "401";
    w.sources[1].frame("status", status);
    await vi.advanceTimersByTimeAsync(10_000);
    expect([s.connection(), w.fetched.length, w.open().length]).toEqual(["ended", 1, 0]);
    expect(s.hydration(), "the catch-up does not retry a read that ended the session").not.toBe("retrying");
  });
  it("the public link: poll A answered 401 with another queued behind it — ended, one read", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    w.fleet = "hang";
    const s = createStream({ mode: "full", transport: "poll", env: w.env });
    s.start();
    await vi.advanceTimersByTimeAsync(5000);                 // the 5 s tick queues a poll behind A
    w.held401();
    await vi.advanceTimersByTimeAsync(60_000);
    expect([s.connection(), w.fetched.length]).toEqual(["ended", 1]);
  });
  it("control: a queued poll behind an answered read still runs", async () => {
    vi.useFakeTimers();
    const { createStream } = await load();
    const w = world();
    w.fleet = "hang";
    const s = createStream({ mode: "full", transport: "poll", env: w.env });
    s.start();
    await vi.advanceTimersByTimeAsync(5000);
    w.fleet = "up";
    w.release(snapOf());
    await vi.advanceTimersByTimeAsync(0);
    expect(w.fetched.length).toBe(2);
    s.close();
  });
});
