/**
 * #2636 part 3: the share tunnel's life — it starts with the first share (once, however many ask at the same time),
 * a share is handed out only once it is up, it stops when the last share ends, a 429 from trycloudflare ends that one
 * share with "try again later" and is never retried, the feature off / an owner no longer an admin / an office deleted
 * end shares, and a tunnel that goes away ends them all. No process and no network: a fake tunnel manager.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfficeShareService, type OfficeShareServiceDeps } from "../src/office-share-service.js";
import type { OfficeShareSource } from "../src/office-share.js";

vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: () => { throw Error("no processes"); } }));

const source: OfficeShareSource = {
  status: () => ({ instances: [] }), org: () => ({}), offices: () => ({ rev: 1, offices: [] }), acts: () => [],
  traffic: () => ({ now: "", items: [] }), needs: () => [], hidden: () => false,
};

function rig(over: Partial<OfficeShareServiceDeps> = {}, opts: { fail?: string } = {}) {
  let exit: (() => void) | null = null, n = 0;
  const starts: Array<() => void> = [];
  const manager = {
    start: vi.fn(async (_p: unknown, ctx: { onCandidateHost?(h: string): void; signal?: AbortSignal }) => {
      await new Promise<void>(r => starts.push(r));          // released by the test
      if (opts.fail) return { ok: false as const, errorKind: opts.fail, message: "429 Too Many Requests", leaseHeld: false };
      const host = `t${++n}.trycloudflare.com`;
      ctx.onCandidateHost?.(host);
      return { ok: true as const, handle: { pageUrl: `https://${host}/ready`, onUnexpectedExit: (fn: () => void) => { exit = fn; return () => { exit = null; }; } } as never };
    }),
    stop: vi.fn(async () => ({ confirmed: true }) as never),
  };
  let enabled = true;
  const owners = new Set(["discord:1"]);
  const offices = new Set(["hq"]);
  const svc = new OfficeShareService({
    source, manager, ensure: async () => ({ path: "/bin/cloudflared" }), provider: () => ({}) as never,
    config: () => ({ enabled }), officeExists: id => offices.has(id), ownerCurrent: o => owners.has(o), ...over,
  });
  const release = async () => { while (!starts.length) await new Promise(r => setTimeout(r, 1)); starts.shift()!(); };
  return { svc, manager, release, exit: () => exit?.(), setEnabled: (v: boolean) => { enabled = v; }, owners, offices };
}

let live: OfficeShareService[] = [];
afterEach(async () => { for (const s of live) await s.close(); live = []; });

describe("the share tunnel (#2636)", () => {
  it("starts once for shares asked at the same time, hands each its URL once up, and reuses it", async () => {
    const r = rig(); live.push(r.svc);
    const a = r.svc.create({ office: "hq", owner: "discord:1" }), b = r.svc.create({ office: "all", owner: "discord:1", minutes: 90, text: true });
    await r.release();
    const [ma, mb] = await Promise.all([a, b]);
    expect(r.manager.start).toHaveBeenCalledTimes(1);
    if (!ma.ok || !mb.ok) throw new Error("refused");
    expect(ma.url).toMatch(/^https:\/\/t1\.trycloudflare\.com\/o\/[A-Za-z0-9_-]{43}$/);
    expect(mb.share).toMatchObject({ office: "all", text: true });
    const c = await r.svc.create({ office: "hq", owner: "discord:1" });
    expect(c.ok && c.url.startsWith("https://t1.trycloudflare.com/o/")).toBe(true);
    expect(r.manager.start).toHaveBeenCalledTimes(1);
    expect(r.svc.list()).toHaveLength(3);
  });

  it("stops when the last share ends, and the next share starts a new one", async () => {
    const r = rig(); live.push(r.svc);
    const p = r.svc.create({ office: "hq", owner: "discord:1" });
    await r.release();
    const m = await p;
    if (!m.ok) throw new Error(m.error);
    expect(r.svc.revoke(m.share.id)).toBe(1);
    await new Promise(res => setTimeout(res, 5));
    expect(r.manager.stop).toHaveBeenCalledTimes(1);
    const q = r.svc.create({ office: "hq", owner: "discord:1" });
    await r.release();
    const again = await q;
    expect(again.ok && again.url.startsWith("https://t2.trycloudflare.com/")).toBe(true);
    expect(r.manager.start).toHaveBeenCalledTimes(2);
  });

  it("a 429 ends that share (the page says to try again later), and nothing retries", async () => {
    const r = rig({}, { fail: "rate-limited" }); live.push(r.svc);
    const p = r.svc.create({ office: "hq", owner: "discord:1" });
    await r.release();
    const m = await p;
    expect(m).toEqual({ ok: false, error: "tunnel", reason: "rate-limited" });
    expect(r.svc.list()).toEqual([]);
    await new Promise(res => setTimeout(res, 20));
    expect(r.manager.start).toHaveBeenCalledTimes(1);
  });

  it("refuses while turned off; turning it off, an owner no longer an admin or an office deleted ends shares", async () => {
    const r = rig(); live.push(r.svc);
    const p1 = r.svc.create({ office: "hq", owner: "discord:1" });
    await r.release();
    await p1;
    const m2 = await r.svc.create({ office: "all", owner: "discord:2" });
    r.owners.add("discord:2");
    const m3 = await r.svc.create({ office: "all", owner: "discord:2" });
    expect(m2.ok && m3.ok).toBe(true);
    r.owners.delete("discord:2");
    expect(r.svc.sweep()).toBe(2);
    r.offices.delete("hq");
    expect(r.svc.sweep()).toBe(1);
    expect(r.svc.list()).toEqual([]);
    r.setEnabled(false);
    expect(await r.svc.create({ office: "all", owner: "discord:1" })).toEqual({ ok: false, error: "disabled" });
  });

  it("a tunnel that goes away by itself ends every share", async () => {
    const r = rig(); live.push(r.svc);
    const p = r.svc.create({ office: "hq", owner: "discord:1" });
    await r.release();
    await p;
    r.exit();
    expect(r.svc.list()).toEqual([]);
    const q = r.svc.create({ office: "hq", owner: "discord:1" });
    await r.release();
    expect((await q).ok).toBe(true);
    expect(r.manager.start).toHaveBeenCalledTimes(2);
  });

});

describe("an ended share's limiter keys (#2662 review)", () => {
  it("the page's and the pictures' minute of an ended share are forgotten; an open share's are kept", async () => {
    let made: { limiter?: { admit(id: string, l?: { requests: number; bytes: number }): boolean }; pictureLimiter?: { admit(id: string, l?: { requests: number; bytes: number }): boolean } } = {};
    const createGateway = ((opts: typeof made) => { made = opts; return { listen: async () => new URL("http://127.0.0.1:12345"), setHost: () => {}, close: () => {}, readinessMarker: "stub" }; }) as never;
    const r = rig({ createGateway }); live.push(r.svc);
    const p = r.svc.create({ office: "hq", owner: "discord:1" });
    await r.release();
    const a = await p, b = await r.svc.create({ office: "hq", owner: "discord:1" });
    if (!a.ok || !b.ok) throw new Error("refused");
    const one = { requests: 1, bytes: 1e9 };
    for (const lim of [made.limiter!, made.pictureLimiter!]) for (const id of [a.share.id, b.share.id]) { expect(lim.admit(id, one)).toBe(true); expect(lim.admit(id, one)).toBe(false); }
    r.svc.revoke(a.share.id);
    expect([made.limiter!.admit(a.share.id, one), made.pictureLimiter!.admit(a.share.id, one)], "ended: forgotten").toEqual([true, true]);
    expect([made.limiter!.admit(b.share.id, one), made.pictureLimiter!.admit(b.share.id, one)], "still open: kept").toEqual([false, false]);
  });
});
