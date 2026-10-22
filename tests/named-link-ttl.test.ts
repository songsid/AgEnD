/**
 * #named-link-ttl: a fixed hostname (named tunnel) earns a longer public link — up to 10080 minutes, or 0 = no expiry —
 * and an opt-in reopen after a restart (`web.public_link.auto_open`). A quick tunnel keeps 1–480 and never auto-opens.
 * Sign-in, Close, revocation and the quick tunnel are unchanged. Stubs only: no listener, tunnel or process.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syntheticTunnelToken } from "./helpers/named-tunnel-token.js";
import { PublicWebLink, publicLinkAutoOpen, publicLinkPatchShape, publicLinkSettings, validPublicLinkPatch } from "../src/public-web-link.js";
import { PUBLIC_TUNNEL_TOKEN_ENV as ENV } from "../src/public-tunnel-config.js";
import { PublicLinkAutoOpen } from "../src/public-link-auto-open.js";
import { clearPublicLinkOwner, PUBLIC_LINK_OWNER_FILE, readPublicLinkOwner, writePublicLinkOwner } from "../src/public-link-owner.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { parseWebSettingsBody } from "../src/web-settings-patch.js";
import { loadFleetConfig } from "../src/config.js";
import { buildSettingsImpactSchema } from "../src/instance-config-impact.js";
import type { PublicLinkDelivery } from "../src/public-web-link.js";
import type { PublicLinkProgress } from "../src/public-link-progress.js";

vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: () => { throw Error("no processes"); }, execFileSync: () => { throw Error("no CLI"); }, execSync: () => { throw Error("no CLI"); } }));

const TOKEN = syntheticTunnelToken();
const HOST = "agend.example.com";
const previous = process.env[ENV];
const roots: string[] = [];
function root() { const dir = mkdtempSync(join(tmpdir(), "agend-named-ttl-")); roots.push(dir); return dir; }
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env[ENV]; else process.env[ENV] = previous;
});
const named = (extra: Record<string, unknown> = {}) => ({ public_link: { hostname: HOST, tunnel_token_env: ENV, ...extra } });
const fleet = (web: unknown) => ({ defaults: {}, instances: {}, web } as any);
const issuesAt = (web: unknown, path: string) => validateFleetConfig(fleet(web)).errors.filter(e => e.path === path);

describe("ranges per mode", () => {
  it("quick tunnel: 1..480 as before; 0, 481 and auto_open are refused, each at its own key", () => {
    for (const ttl of [1, 480]) expect(validateFleetConfig(fleet({ public_link: { ttl_minutes: ttl } })).errors).toEqual([]);
    for (const ttl of [0, 481, 10080]) expect(issuesAt({ public_link: { ttl_minutes: ttl } }, "web.public_link.ttl_minutes")).toHaveLength(1);
    expect(issuesAt({ public_link: { ttl_minutes: 600 } }, "web.public_link.ttl_minutes")[0]?.message).toMatch(/1\.\.480.*hostname/);
    expect(issuesAt({ public_link: { auto_open: true } }, "web.public_link.auto_open")).toHaveLength(1);
    // A blank hostname is a quick tunnel (what Settings writes to go back to one).
    expect(issuesAt({ public_link: { hostname: "", ttl_minutes: 600 } }, "web.public_link.ttl_minutes")).toHaveLength(1);
    expect(validateFleetConfig(fleet({ public_link: { auto_open: false } })).errors).toEqual([]);
  });
  it("fixed hostname: 1..10080 or 0 (no expiry), and auto_open", () => {
    for (const ttl of [0, 1, 481, 10080]) expect(validateFleetConfig(fleet(named({ ttl_minutes: ttl, auto_open: true }))).errors, String(ttl)).toEqual([]);
    for (const bad of [{ ttl_minutes: 10081 }, { ttl_minutes: -1 }, { ttl_minutes: 1.5 }, { auto_open: "yes" }]) {
      expect(issuesAt(named(bad), "web.public_link"), JSON.stringify(bad)).toHaveLength(1);
    }
  });
  it("a Settings patch is judged for its shape alone; the merged result for its mode", () => {
    expect(publicLinkPatchShape({ ttl_minutes: 0 })).toBe(true);            // fine as a patch onto a named config…
    expect(validPublicLinkPatch({ ttl_minutes: 0 })).toBe(false);           // …not as a whole quick-tunnel config
    expect(validPublicLinkPatch({ hostname: HOST, ttl_minutes: 0, auto_open: true })).toBe(true);
    expect(publicLinkPatchShape({ ttl_minutes: 10081 })).toBe(false);
    expect(parseWebSettingsBody({ public_link: { ttl_minutes: 0, auto_open: true } })).toEqual(expect.objectContaining({ publicLink: { ttl_minutes: 0, auto_open: true } }));
    expect(parseWebSettingsBody({ public_link: { auto_open: "true" } })).toEqual({ error: "invalid public_link settings" });
  });
  it("the runtime boundary (raw YAML never meets the validator): capped per mode, 0 = no expiry only when named", () => {
    expect(publicLinkSettings({ public_link: { ttl_minutes: 900 } }).ttlMs).toBe(480 * 60_000);
    expect(publicLinkSettings({ public_link: { ttl_minutes: 0 } }).ttlMs).toBe(120 * 60_000);
    expect(publicLinkSettings(named({ ttl_minutes: 900 })).ttlMs).toBe(900 * 60_000);
    expect(publicLinkSettings(named({ ttl_minutes: 99_999 })).ttlMs).toBe(10_080 * 60_000);
    expect(publicLinkSettings(named({ ttl_minutes: 0 })).ttlMs).toBe(Infinity);
    expect(publicLinkSettings({ public_link: { hostname: "", ttl_minutes: 0 } }).ttlMs).toBe(120 * 60_000);
  });
  it("a raw fleet.yaml going back to a quick tunnel with 900 minutes is cut to 480 at load and runtime", () => {
    const dir = root(), path = join(dir, "fleet.yaml");
    writeFileSync(path, JSON.stringify({ instances: {}, web: { public_link: { hostname: "", ttl_minutes: 900 } } }));
    expect(publicLinkSettings(loadFleetConfig(path).web).ttlMs).toBe(480 * 60_000);
  });
  it("auto_open applies only with a fixed hostname, and only while public links are allowed", () => {
    expect(publicLinkAutoOpen(named({ auto_open: true }))).toBe(true);
    expect(publicLinkAutoOpen({ public_link: { auto_open: true } })).toBe(false);
    expect(publicLinkAutoOpen(named({ auto_open: true, allow_public: false }))).toBe(false);
    expect(publicLinkAutoOpen(named())).toBe(false);
    expect(buildSettingsImpactSchema().impacts["web.public_link.auto_open"]).toBe("fleet");
  });
});

const owner = { adapterId: "discord", userId: "admin", chatId: "G", threadId: "T", binding: {} };
function rig(web: any = named({ ttl_minutes: 0 })) {
  process.env[ENV] = TOKEN;
  let now = 0, settings = web;
  const gateway = { listen: vi.fn(async () => new URL("http://127.0.0.1:19282")), setHost: vi.fn(), close: vi.fn(), readinessMarker: "marker", server: {} };
  const handle = { pageUrl: `https://${HOST}/signin`, onUnexpectedExit: () => () => {} };
  const reservation = { start: vi.fn(async (_p: unknown, _ctx: any) => ({ ok: true, handle })), stop: vi.fn(async () => ({ confirmed: true })) };
  const revoke = vi.fn(), log = vi.fn();
  const link = new PublicWebLink({ dataDir: "/fixture", web: () => settings, permitted: () => true, reserve: () => reservation as any,
    createGateway: (() => gateway) as any, provider: () => ({}) as any, ensure: async () => ({ path: "/inert", source: "agend" }), log, revoke,
    now: () => now, wallNow: () => 1_000_000 });
  return { link, reservation, gateway, revoke, log, advance: (ms: number) => { now += ms; }, settings: (v: any) => { settings = v; } };
}

describe("ttl_minutes 0 with a fixed hostname: no expiry", () => {
  beforeEach(() => vi.useFakeTimers());
  it("arms no timer, says 'no expiry' (no expiresAt), stays open however long — and Close still closes and revokes", async () => {
    const h = rig(); let link!: PublicLinkDelivery;
    expect(await h.link.deliver(owner, async l => { link = l; return true; })).toBe(true);
    expect(link.expiresAt).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.link.status()).toEqual({ state: "open", noExpiry: true });
    // The tunnel child and its lease get a finite far-future wall time (JSON-safe), never Infinity.
    expect(h.reservation.start.mock.calls[0]![1].expiresAt).toBe(Number.MAX_SAFE_INTEGER);
    h.advance(30 * 24 * 60 * 60_000); await vi.advanceTimersByTimeAsync(60_000);
    expect(link.isCurrent()).toBe(true); expect(h.link.status().state).toBe("open");
    await h.link.close("admin close");
    expect(h.revoke).toHaveBeenCalledWith(link.exposureId); expect(link.isCurrent()).toBe(false);
    expect(h.link.status()).toEqual({ state: "closed" });
  });
  it("a policy change still ends it (refresh), as any link", async () => {
    const h = rig(); await h.link.deliver(owner, async () => true);
    h.settings(named({ ttl_minutes: 0, allow_public: false })); h.link.refresh();
    expect(h.revoke).toHaveBeenCalled(); await h.link.close("end");
  });
  it("a finite named lifetime above 480 is kept and enforced", async () => {
    const h = rig(named({ ttl_minutes: 7 * 24 * 60 })); let link!: PublicLinkDelivery;
    await h.link.deliver(owner, async l => { link = l; return true; });
    expect(link.expiresAt).toBe(1_000_000 + 10_080 * 60_000);
    h.advance(10_080 * 60_000 - 1); expect(link.isCurrent()).toBe(true);
    h.advance(1); expect(link.isCurrent()).toBe(false); expect(h.link.status().state).toBe("closing");
    await h.link.close("end");
  });
});

describe("openUnattended: the same start and readiness, nothing sent", () => {
  it("opens without any delivery; a later /web by the same owner joins it and gets its URL privately", async () => {
    const h = rig();
    expect(await h.link.openUnattended(owner)).toBe("opened");
    expect(h.reservation.start).toHaveBeenCalledTimes(1);
    expect(h.reservation.start.mock.calls[0]![1].readinessMarker).toBe("marker");   // the same probe as a requested link
    expect(h.link.status().state).toBe("open");
    const send = vi.fn(async (_l: PublicLinkDelivery) => true);
    expect(await h.link.deliver(owner, send)).toBe(true);
    expect(send.mock.calls[0]![0].url).toBe(`https://${HOST}/signin`);
    expect(h.reservation.start).toHaveBeenCalledTimes(1);
    // A joining request that fails its own delivery never closes a link nobody else was owed.
    expect(await h.link.deliver(owner, async () => false)).toBe(false);
    expect(h.link.status().state).toBe("open");
    expect(await h.link.openUnattended(owner)).toBe("busy");
    await h.link.close("end");
  });
  it("a failed start closes it and reports the failed step", async () => {
    const h = rig(); let last: PublicLinkProgress | undefined;
    h.reservation.start.mockResolvedValueOnce({ ok: false, errorKind: "ready-timeout", message: "x" } as never);
    expect(await h.link.openUnattended(owner, p => { last = p; })).toBe("failed");
    expect(last?.failed).toBeDefined();
    expect(h.reservation.stop).toHaveBeenCalled(); expect(h.link.status()).toEqual({ state: "closed" });
  });
});

describe("PublicLinkAutoOpen: once after start, named only", () => {
  function runner(web: any, outcomes: Array<"opened" | "busy" | "failed"> = ["opened"], who: any = owner) {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const open = vi.fn(async (_o: unknown, onProgress: (p: PublicLinkProgress) => void) => {
      const outcome = outcomes.shift() ?? "failed";
      if (outcome === "failed") onProgress({ startedAt: 0, steps: [{ step: "tunnel", startedAt: 0, endedAt: 1 }], failed: { step: "tunnel", reason: "unknown" } } as never);
      return outcome;
    });
    const notifyFailed = vi.fn(async () => {}), log = vi.fn();
    const auto = new PublicLinkAutoOpen({ web: () => web, ready: () => true, owner: () => who, open, notifyFailed, log, retryMs: [10, 20],
      setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return { cancel: () => { timers.splice(timers.indexOf(t), 1); } }; } });
    const fire = async () => { const t = timers.shift(); t?.fn(); await Promise.resolve(); await Promise.resolve(); };
    return { auto, open, notifyFailed, log, timers, fire };
  }
  const flush = () => new Promise(r => setImmediate(r));
  it("named + auto_open: opens once; a second start in the same process does nothing", async () => {
    const r = runner(named({ auto_open: true }));
    expect(r.auto.start()).toBe(true); await flush();
    expect(r.auto.start()).toBe(false); await flush();
    expect(r.open).toHaveBeenCalledTimes(1); expect(r.open.mock.calls[0]![0]).toBe(owner);
    expect(r.timers).toHaveLength(0); expect(r.notifyFailed).not.toHaveBeenCalled();
  });
  it.each([
    ["a quick tunnel", { public_link: { auto_open: true } }],
    ["auto_open off", named()],
    ["public links not allowed", named({ auto_open: true, allow_public: false })],
  ])("ignored with %s", async (_why, web) => {
    const r = runner(web); expect(r.auto.start()).toBe(false); await flush();
    expect(r.open).not.toHaveBeenCalled();
  });
  it("no remembered (current) owner: nothing is opened, nobody is told", async () => {
    const r = runner(named({ auto_open: true }), ["opened"], null);
    r.auto.start(); await flush();
    expect(r.open).not.toHaveBeenCalled(); expect(r.notifyFailed).not.toHaveBeenCalled();
  });
  it("failures retry a bounded number of times, then the owner hears once", async () => {
    const r = runner(named({ auto_open: true }), ["failed", "failed", "failed", "opened"]);
    r.auto.start(); await flush();
    expect(r.timers.map(t => t.ms)).toEqual([10]);
    await r.fire(); await flush(); expect(r.timers.map(t => t.ms)).toEqual([20]);
    await r.fire(); await flush();
    expect(r.open).toHaveBeenCalledTimes(3); expect(r.timers).toHaveLength(0);
    expect(r.notifyFailed).toHaveBeenCalledTimes(1);
    expect((r.notifyFailed.mock.calls[0] as unknown[])[1]).toEqual(expect.objectContaining({ failed: expect.objectContaining({ reason: "unknown" }) }));
  });
  it("a link someone opened meanwhile ends it quietly; stop() cancels a pending retry", async () => {
    const busy = runner(named({ auto_open: true }), ["busy"]); busy.auto.start(); await flush();
    expect(busy.timers).toHaveLength(0); expect(busy.notifyFailed).not.toHaveBeenCalled();
    const stopped = runner(named({ auto_open: true }), ["failed"]); stopped.auto.start(); await flush();
    expect(stopped.timers).toHaveLength(1); stopped.auto.stop(); expect(stopped.timers).toHaveLength(0);
    expect(stopped.notifyFailed).not.toHaveBeenCalled();
  });
  it("auto_open turned off before a retry: the retry does nothing", async () => {
    const web: any = named({ auto_open: true });
    const r = runner(web, ["failed", "opened"]); r.auto.start(); await flush();
    web.public_link.auto_open = false; await r.fire(); await flush();
    expect(r.open).toHaveBeenCalledTimes(1); expect(r.notifyFailed).not.toHaveBeenCalled();
  });
});

describe("carry of #2450 (Fable's review P2-3): auto_open is started by the fleet's own start", () => {
  it("startAll calls it once, after the web chat announcement ('fleet ready') and before READY=1, in the same method", () => {
    const src = readFileSync(join(process.cwd(), "src", "fleet-manager.ts"), "utf8");
    const calls = [...src.matchAll(/\n\s+this\.startPublicLinkAutoOpen\(\);/g)].map(m => m.index!);
    const announce = src.indexOf("void this.announceWebChatOnce(agendVersion);"), ready = src.indexOf('sdNotify("READY=1");');
    const between = (a: number, b: number) => src.slice(a, b);
    const methodStart = /\n  (?:private |public |protected )?(?:async )?[a-zA-Z]+\([^)]*\)[^{\n]*\{\n/;
    expect([calls.length, announce > 0 && announce < calls[0]!, calls[0]! < ready, methodStart.test(between(announce, ready))]).toEqual([1, true, true, false]);
  });
});

describe("the remembered owner", () => {
  it("round-trips only the account and General (0600), rejects junk, and is forgotten", () => {
    const dir = root();
    expect(readPublicLinkOwner(dir)).toBeNull();
    writePublicLinkOwner(dir, { ...owner, username: "secret-name", binding: { live: true } } as never);
    expect(readPublicLinkOwner(dir)).toEqual({ adapterId: "discord", userId: "admin", chatId: "G", threadId: "T" });
    expect(JSON.parse(readFileSync(join(dir, PUBLIC_LINK_OWNER_FILE), "utf-8"))).toEqual({ adapterId: "discord", userId: "admin", chatId: "G", threadId: "T" });
    if (process.platform !== "win32") expect(statSync(join(dir, PUBLIC_LINK_OWNER_FILE)).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, PUBLIC_LINK_OWNER_FILE), JSON.stringify({ adapterId: "x", userId: 5, chatId: "G" }));
    expect(readPublicLinkOwner(dir)).toBeNull();
    clearPublicLinkOwner(dir); clearPublicLinkOwner(dir);
    expect(readPublicLinkOwner(dir)).toBeNull();
  });
});
