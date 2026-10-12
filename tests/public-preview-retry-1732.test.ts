/**
 * #1732: a public link's preview tunnel that comes up unreachable is started once more, with a fresh quick tunnel, in
 * the background: one retry, only on unreachable, only while the exposure is live and early enough to end inside the
 * page's wait. The link never sees it.
 *
 * The real PublicWebLink on the fleet's one real TunnelPurposeLane, the real PublicPreview; tunnels, gateways and the
 * clock are fakes. No cloudflared, no fleet, no network.
 */
import { describe, expect, it, vi } from "vitest";
import { PublicWebLink } from "../src/public-web-link.js";
import { TunnelPurposeLane } from "../src/tunnel/purpose-lane.js";
import type { TunnelHandle } from "../src/tunnel/types.js";
import { PREVIEW_RETRY_WITHIN_MS, PublicPreview, type PublicPreviewGateway } from "../src/public-preview.js";

const owner = { adapterId: "owner", userId: "admin", chatId: "G", threadId: "T", binding: {} };
const DASH = "dash-host.trycloudflare.com";
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(y => { resolve = y; }); return { promise, resolve }; };

const handle = (host: string, path: string): TunnelHandle => ({ provider: "fake", visibility: "public", baseUrl: `https://${host}`, pageUrl: `https://${host}${path}`,
  pid: 1, identity: "fake", stop: vi.fn(), onUnexpectedExit: () => vi.fn() });
type Attempt = { ok: true; handle: TunnelHandle } | { ok: false; errorKind: string; message: string; leaseHeld: boolean };
const unreachable: Attempt = { ok: false, errorKind: "readiness-failed", message: "the public URL never served this page", leaseHeld: false };
const ready = (n: number): Attempt => ({ ok: true, handle: handle(`prev-${n}.trycloudflare.com`, "/ready") });

/** The link and its preview; each preview attempt answers with the next of `attempts` (a function may wait or act). */
function rig(attempts: Array<Attempt | (() => Promise<Attempt>)>, opts: { clock?: { t: number } } = {}) {
  const clock = opts.clock ?? { t: 0 };
  const manager = { start: vi.fn(async (_p: unknown, ctx: any) => { ctx.onCandidateHost?.(DASH); return { ok: true as const, handle: handle(DASH, "/signin") }; }),
    stop: vi.fn(async () => ({ confirmed: true as const })) };
  const lane = new TunnelPurposeLane(manager);
  const sids: string[] = [];
  const previewManager = {
    start: vi.fn(async (_p: unknown, ctx: any) => {
      sids.push(ctx.sid);
      const next = attempts.shift();
      if (!next) throw new Error("no more attempts scripted");
      const result = typeof next === "function" ? await next() : next;
      if (result.ok) ctx.onCandidateHost?.(new URL(result.handle.pageUrl).host);
      return result;
    }),
    stop: vi.fn(async () => ({ confirmed: true as const })),
  };
  const gateway: PublicPreviewGateway = { server: {} as never, readinessMarker: "pm", bootId: "f".repeat(32), listen: vi.fn(async () => new URL("http://127.0.0.1:9998")),
    setHost: vi.fn(), close: vi.fn() };
  const logs: string[] = [];
  let permitted = true;
  const link = new PublicWebLink({
    dataDir: "/fixture", web: () => ({}), permitted: () => permitted, reserve: id => lane.reserve("dashboard", id),
    createGateway: () => ({ listen: vi.fn(async () => new URL("http://127.0.0.1:9999")), setHost: vi.fn(), close: vi.fn(), readinessMarker: "m", server: {} }) as never,
    ensure: vi.fn(async () => ({ path: "/pinned", source: "agend" as const })), provider: () => ({ name: "fake" }) as never,
    revoke: vi.fn(), log: vi.fn(), now: () => 0, wallNow: () => 100_000,
    createPreview: ({ id, expiresAt, dashboardOrigin, isCurrent }) => new PublicPreview({ exposureId: id, expiresAt, dashboardOrigin, isCurrent,
      manager: previewManager, provider: () => ({ name: "fake" }) as never, createGateway: () => gateway, now: () => clock.t, log: e => logs.push(e) }),
  });
  const status = () => link.previewStatus(link.exposureId!);
  return { link, lane, manager, previewManager, gateway, sids, logs, clock, status, revokeOwner: () => { permitted = false; } };
}

describe("#1732: one retry, with a fresh quick tunnel, when the preview comes up unreachable", () => {
  it("unreachable → exactly one more start (a new sid) → ready at the second tunnel's origin", async () => {
    const h = rig([unreachable, ready(2)]);
    expect(await h.link.deliver(owner, async () => true)).toBe(true);
    await tick();
    expect(h.previewManager.start).toHaveBeenCalledTimes(2);
    expect(new Set(h.sids).size).toBe(2);
    expect(h.status()).toEqual({ state: "ready", origin: "https://prev-2.trycloudflare.com", boot: "f".repeat(32) });
    expect(h.logs).toContain("preview unreachable; retrying once");
    await h.link.close("end");
  });

  it("unreachable twice → failed with the second attempt's reason; never a third", async () => {
    const h = rig([unreachable, unreachable, ready(3)]);
    await h.link.deliver(owner, async () => true); await tick();
    expect(h.previewManager.start).toHaveBeenCalledTimes(2);
    expect(h.status()).toEqual({ state: "failed", reason: "unreachable" });
    await h.link.close("end");
  });

  it("the second attempt's own reason is the one shown", async () => {
    const h = rig([unreachable, { ok: false, errorKind: "spawn-failed", message: "x", leaseHeld: false }]);
    await h.link.deliver(owner, async () => true); await tick();
    expect(h.status()).toEqual({ state: "failed", reason: "spawn-failed" });
    await h.link.close("end");
  });

  it("still 'starting' while the retry runs; the first tunnel's host is fenced before it", async () => {
    const second = deferred<Attempt>();
    const h = rig([unreachable, () => second.promise]);
    await h.link.deliver(owner, async () => true); await tick();
    expect(h.previewManager.start).toHaveBeenCalledTimes(2);
    expect(h.status()).toEqual({ state: "starting" });
    expect(h.gateway.setHost).toHaveBeenLastCalledWith(null);
    second.resolve(ready(2)); await tick();
    expect(h.status()).toMatchObject({ state: "ready" });
    await h.link.close("end");
  });
});

describe("#1732: no retry otherwise", () => {
  it.each([
    ["spawn-failed", { ok: false, errorKind: "spawn-failed", message: "x", leaseHeld: false }, "spawn-failed"],
    ["no-address (timeout)", { ok: false, errorKind: "timeout", message: "x", leaseHeld: false }, "no-address"],
    ["lease-held", { ok: false, errorKind: "lease-held", message: "x", leaseHeld: true }, "lease-held"],
    ["unreachable, but a child not proven gone (leaseHeld)", { ...unreachable, leaseHeld: true }, "unreachable"],
  ] as const)("%s → failed at once, one attempt", async (_label, first, reason) => {
    const h = rig([first as Attempt, ready(2)]);
    await h.link.deliver(owner, async () => true); await tick();
    expect(h.previewManager.start).toHaveBeenCalledTimes(1);
    expect(h.status()).toEqual({ state: "failed", reason });
    await h.link.close("end");
  });

  it("after the bound: an unreachable first attempt that ended too late for a second inside the page's wait", async () => {
    const clock = { t: 0 };
    const h = rig([async () => { clock.t = PREVIEW_RETRY_WITHIN_MS + 1; return unreachable; }, ready(2)], { clock });
    await h.link.deliver(owner, async () => true); await tick();
    expect(h.previewManager.start).toHaveBeenCalledTimes(1);
    expect(h.status()).toEqual({ state: "failed", reason: "unreachable" });
    await h.link.close("end");
  });

  it("control: at the bound exactly, it still retries", async () => {
    const clock = { t: 0 };
    const h = rig([async () => { clock.t = PREVIEW_RETRY_WITHIN_MS; return unreachable; }, ready(2)], { clock });
    await h.link.deliver(owner, async () => true); await tick();
    expect(h.previewManager.start).toHaveBeenCalledTimes(2);
    await h.link.close("end");
  });

  it("the exposure closed while the first attempt ran: no retry, and the close is not held up", async () => {
    const first = deferred<Attempt>();
    const h = rig([() => first.promise, ready(2)]);
    await h.link.deliver(owner, async () => true); await tick();
    const closing = h.link.close("admin close");
    first.resolve(unreachable);
    expect((await closing).confirmed).toBe(true);
    await tick();
    expect(h.previewManager.start).toHaveBeenCalledTimes(1);
    expect(h.lane.reserve("login", "next")).not.toBeNull();
  });

  it("the exposure no longer current (its owner lost access) when the first attempt ends: no retry", async () => {
    const first = deferred<Attempt>();
    const h = rig([() => first.promise, ready(2)]);
    await h.link.deliver(owner, async () => true); await tick();
    h.revokeOwner();
    first.resolve(unreachable); await tick();
    expect(h.previewManager.start).toHaveBeenCalledTimes(1);
    await h.link.close("end");
  });
});

describe("#1732: the link never sees the retry", () => {
  it("delivered at once while the preview is still on its first attempt; its steps and tunnel are untouched by the retry", async () => {
    const first = deferred<Attempt>(), second = deferred<Attempt>();
    const h = rig([() => first.promise, () => second.promise]);
    const seen: string[] = [];
    expect(await h.link.deliver(owner, async () => { seen.push("delivered"); return true; })).toBe(true);
    expect(seen).toEqual(["delivered"]);
    first.resolve(unreachable); await tick();
    expect(h.previewManager.start).toHaveBeenCalledTimes(2);
    expect(h.link.status().state).toBe("open");
    expect(h.manager.start).toHaveBeenCalledTimes(1);
    expect(h.manager.stop).not.toHaveBeenCalled();
    second.resolve(unreachable); await tick();
    expect(h.status()).toEqual({ state: "failed", reason: "unreachable" });
    expect(h.link.status().state).toBe("open");
    expect(h.manager.stop).not.toHaveBeenCalled();
    expect((await h.link.close("end")).confirmed).toBe(true);
  });
});
