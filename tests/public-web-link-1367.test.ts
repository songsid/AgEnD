import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PublicWebLink, publicLinkSettings, validPublicLinkPatch } from "../src/public-web-link.js";
import { TunnelPurposeLane } from "../src/tunnel/purpose-lane.js";
import type { PublicLinkDelivery } from "../src/public-web-link.js";
import type { TunnelHandle } from "../src/tunnel/types.js";
import { loadFleetConfig } from "../src/config.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: () => { throw Error("no processes"); }, execFileSync: () => { throw Error("no CLI"); }, execSync: () => { throw Error("no CLI"); } }));
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const owner = { adapterId: "owner", userId: "admin", chatId: "G", threadId: "T", binding: {} };
function rig() {
  let now = 0, permitted = true, web: any = {};
  const gateway = { listen: vi.fn(async () => new URL("http://127.0.0.1:9999")), setHost: vi.fn(), close: vi.fn(), readinessMarker: "fixture", server: {} };
  let lost!: () => void;
  const handle: TunnelHandle = { provider: "fake", visibility: "public", baseUrl: "https://sample.trycloudflare.com", pageUrl: "https://sample.trycloudflare.com/signin", pid: 12, identity: "fake", stop: vi.fn(), onUnexpectedExit: cb => { lost = () => cb({ code: 1, signal: null }); return vi.fn(); } };
  const manager = { start: vi.fn(async (_provider, context) => { context.onCandidateHost?.("sample.trycloudflare.com"); return { ok: true as const, handle }; }), stop: vi.fn(async () => ({ confirmed: true as const })) };
  const lane = new TunnelPurposeLane(manager);
  const ensure = vi.fn(async (_options: unknown) => ({ path: "/private/pinned", source: "agend" as const }));
  const revoke = vi.fn(), log = vi.fn(), unconfirmed = vi.fn();
  const publicLink = new PublicWebLink({ dataDir: "/fixture", web: () => web, permitted: () => permitted, reserve: id => lane.reserve("dashboard", id),
    createGateway: () => gateway as never, ensure, provider: () => ({ name: "fake" }) as never, revoke, log, onCleanupUnconfirmed: unconfirmed, now: () => now, wallNow: () => 100_000 });
  return { publicLink, ensure, lane, gateway, manager, handle, revoke, log, unconfirmed, lost: () => lost(), advance: (n: number) => { now += n; }, allow: (value: boolean) => { permitted = value; }, settings: (value: any) => { web = value; } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe("public link access/child ownership, no real listener or tunnel", () => {
  it("defaults offer only; no installer, listener or child without consent", () => {
    const h = rig(); expect(h.publicLink.status()).toEqual({ state: "closed" }); expect(h.ensure).not.toHaveBeenCalled();
    expect(publicLinkSettings(undefined)).toEqual({ allowed: true, ttlMs: 7_200_000, protocol: "http2" });
  });
  it("reserves a shared purpose before installer await, public uses pinnedOnly", async () => {
    const h = rig(), wait = deferred<{ path: string; source: "agend" }>(); h.ensure.mockReturnValue(wait.promise);
    const delivery = h.publicLink.deliver(owner, async () => true);
    expect(h.lane.reserve("login", "different")).toBeNull(); expect(h.manager.start).not.toHaveBeenCalled();
    expect(h.ensure.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ pinnedOnly: true }));
    wait.resolve({ path: "/private/pinned", source: "agend" }); expect(await delivery).toBe(true);
    expect(h.manager.start.mock.calls[0]?.[1].origin.href).toBe("http://127.0.0.1:9999/");
    await h.publicLink.close("end"); expect(h.lane.reserve("login", "different")).not.toBeNull();
  });
  it.each(["https://user@sample.trycloudflare.com/signin", "https://user:pass@sample.trycloudflare.com/signin", "https://sample.trycloudflare.com/signin?code=private"])("rejects a published URL with credentials or embedded code: %s", async pageUrl => {
    const h = rig(), send = vi.fn(async () => true);
    h.manager.start.mockResolvedValue({ ok: true, handle: { ...h.handle, pageUrl } });
    expect(await h.publicLink.deliver(owner, send)).toBe(false);
    expect(send).not.toHaveBeenCalled(); expect(h.manager.stop).toHaveBeenCalledTimes(1);
  });
  it("same startup A fails/B confirmed: A cannot close B's link", async () => {
    const h = rig(), a = deferred<boolean>(), b = deferred<boolean>();
    const first = h.publicLink.deliver(owner, () => a.promise);
    const second = h.publicLink.deliver({ ...owner, userId: "other-admin" }, () => b.promise);
    b.resolve(true); expect(await second).toBe(true); a.resolve(false); expect(await first).toBe(false);
    expect(h.manager.start).toHaveBeenCalledTimes(1); expect(h.manager.stop).not.toHaveBeenCalled(); expect(h.publicLink.status().state).toBe("open");
    await h.publicLink.close("end");
  });
  it("failed sole recipient closes; later failure on an already delivered link does not", async () => {
    const a = rig(); expect(await a.publicLink.deliver(owner, async () => false)).toBe(false); expect(a.manager.stop).toHaveBeenCalledTimes(1);
    const b = rig(); await b.publicLink.deliver(owner, async () => true); expect(await b.publicLink.deliver(owner, async () => false)).toBe(false); expect(b.manager.stop).not.toHaveBeenCalled(); await b.publicLink.close("end");
  });
  it("fixed consent TTL includes startup and reuse never renews it; timer lag does not extend access", async () => {
    const h = rig(); h.settings({ public_link: { ttl_minutes: 1 } }); let first!: PublicLinkDelivery;
    await h.publicLink.deliver(owner, async l => { first = l; return true; });
    h.advance(30_000); await h.publicLink.deliver(owner, async l => { expect(l.expiresAt).toBe(first.expiresAt); return true; });
    h.advance(30_000); expect(first.isCurrent()).toBe(false); expect(h.publicLink.status().state).toBe("closing");
    expect(h.revoke).toHaveBeenCalledWith(first.exposureId); expect(h.gateway.close).toHaveBeenCalled(); await h.publicLink.close("end");
  });
  it("raw YAML load cannot extend the controller past its 8h hard cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-public-ttl-"));
    const path = join(dir, "fleet.yaml");
    writeFileSync(path, JSON.stringify({ instances: {}, web: { public_link: { ttl_minutes: 900 } } }));
    const h = rig(); let link!: PublicLinkDelivery;
    try {
      h.settings(loadFleetConfig(path).web);
      expect(await h.publicLink.deliver(owner, async value => { link = value; return true; })).toBe(true);
      expect(link.expiresAt).toBe(100_000 + 480 * 60_000);
      h.advance(480 * 60_000 - 1); expect(link.isCurrent()).toBe(true);
      h.advance(1); expect(link.isCurrent()).toBe(false);
      expect(h.publicLink.status().state).toBe("closing");
      await h.publicLink.close("end");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("close fences synchronously and waits late startup before stop; old click cannot close reopen", async () => {
    const h = rig(), wait = deferred<any>(); h.ensure.mockReturnValueOnce(wait.promise);
    const delivery = h.publicLink.deliver(owner, async () => true); const old = h.publicLink.exposureId!;
    const close = h.publicLink.close("shutdown"); expect(h.revoke).toHaveBeenCalledWith(old); expect(h.publicLink.status().state).toBe("closing"); expect(h.manager.stop).not.toHaveBeenCalled();
    wait.resolve({ path: "/private/pinned", source: "agend" }); await close; expect(await delivery).toBe(false); expect(h.manager.start).not.toHaveBeenCalled();
    await h.publicLink.deliver(owner, async () => true); await h.publicLink.close("old button", old); expect(h.publicLink.status().state).toBe("open"); await h.publicLink.close("end");
  });
  it("unconfirmed child keeps lane blocked; web access is closed", async () => {
    const h = rig(); await h.publicLink.deliver(owner, async () => true);
    h.manager.stop.mockResolvedValue({ confirmed: false, reason: "fixture", pid: 12, identity: "fake" } as never);
    expect((await h.publicLink.close("end")).confirmed).toBe(false); expect(h.publicLink.status().state).toBe("cleanup_unconfirmed");
    expect(h.unconfirmed).toHaveBeenCalled(); expect(h.lane.reserve("login", "different")).toBeNull(); expect(await h.publicLink.deliver(owner, async () => true)).toBe(false);
  });
  it.each(["policy", "binding", "exit"])("%s loss closes existing access", async why => {
    const h = rig(); await h.publicLink.deliver(owner, async () => true);
    if (why === "policy") h.settings({ public_link: { allow_public: false } }); else if (why === "binding") h.allow(false); else h.lost();
    h.publicLink.refresh(); expect(h.revoke).toHaveBeenCalled(); expect(h.gateway.close).toHaveBeenCalled(); await h.publicLink.close("end");
  });
  it.each([{ ttl_minutes: 0 }, { ttl_minutes: 481 }, { ttl_minutes: 1.5 }, { allow_public: "true" }, { protocol: "bad" }, { protocol: ["quic"] }])("rejects invalid config %j", cfg => expect(validPublicLinkPatch(cfg)).toBe(false));
  it("allows sparse valid patches without populating defaults", () => { expect(validPublicLinkPatch({})).toBe(true); expect(validPublicLinkPatch({ ttl_minutes: 480 })).toBe(true); });
});
