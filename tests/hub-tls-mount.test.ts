import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { provisionHubIdentity, readHubIdentity, verifyHubCertificate, hubOrigin } from "../src/hub/tls.js";
import { sealHubInitialization, verifyHubInitialization } from "../src/hub/initialization.js";
import { sha256 } from "../src/hub/identity.js";
import { HubMount } from "../src/hub/mount.js";
const scratch: string[] = [];
afterEach(() => scratch.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function home() {
  mkdirSync(".artifacts", { recursive: true }); const path = mkdtempSync(join(process.cwd(), ".artifacts/hub-tls-test-")); chmodSync(path, 0o700); scratch.push(path); return path;
}
async function initialized() {
  const root = home(), memberOrigin = "https://127.0.0.1:39443", identity = await provisionHubIdentity({ home: root, memberOrigin }), digest = sha256("plan");
  const manifest = { v: 1, hubId: identity.hubId, planDigest: digest, committedAt: new Date().toISOString(), confirmationId: "a".repeat(32) };
  const signature = sealHubInitialization({ home: root, ...manifest });
  writeFileSync(join(root, "hub/init-manifest.json"), JSON.stringify({ ...manifest, signature }), { mode: 0o600 });
  return { root, identity, digest, memberOrigin, manifest, signature };
}
describe("Hub identity provisioning and off-default composition", () => {
  it("provisions private independent TLS/issuer keys with the exact address, and refuses overwrite", async () => {
    const f = await initialized(); expect(readHubIdentity({ home: f.root, memberOrigin: f.memberOrigin })).toEqual(f.identity);
    const pem = readFileSync(join(f.root, "hub/keys/tls-cert.pem"), "utf8");
    expect(verifyHubCertificate(pem, f.memberOrigin, f.identity.spkiSha256)).toBeDefined();
    expect(() => verifyHubCertificate(pem, "https://different.test", f.identity.spkiSha256)).toThrow();
    expect(() => verifyHubCertificate(pem, f.memberOrigin, "b".repeat(64))).toThrow();
    expect(() => verifyHubCertificate(pem, f.memberOrigin, f.identity.spkiSha256, Date.now() + 366 * 86_400_000)).toThrow();
    await expect(provisionHubIdentity({ home: f.root, memberOrigin: f.memberOrigin })).rejects.toThrow("already exists");
    chmodSync(join(f.root, "hub/keys/issuer-key.pem"), 0o644);
    expect(() => readHubIdentity({ home: f.root, memberOrigin: f.memberOrigin })).toThrow("permissions");
  });
  it.each(["http://hub.test", "https://user:password@hub.test", "https://hub.test/path", "https://hub.test/?token=x", "https://hub.test/#fragment"])("refuses an unsafe machine origin %s", input => expect(() => hubOrigin(input)).toThrow());
  it("seals only the exact initialized plan, without writing a manifest or storing the bearer reference", async () => {
    const root = home(), memberOrigin = "https://127.0.0.1:39443", identity = await provisionHubIdentity({ home: root, memberOrigin });
    const data = { v: 1, hubId: identity.hubId, planDigest: sha256("plan"), committedAt: new Date().toISOString(), confirmationId: "a".repeat(32) };
    const signature = sealHubInitialization({ home: root, ...data }); expect(existsSync(join(root, "hub/init-manifest.json"))).toBe(false);
    writeFileSync(join(root, "hub/init-manifest.json"), JSON.stringify({ ...data, signature }), { mode: 0o600 });
    expect(verifyHubInitialization({ home: root, hubId: identity.hubId, memberOrigin, planDigest: data.planDigest }).signature).toBe(signature);
    expect(() => verifyHubInitialization({ home: root, hubId: identity.hubId, memberOrigin, planDigest: sha256("changed") })).toThrow();
    writeFileSync(join(root, "hub/init-manifest.json"), JSON.stringify({ ...data, confirmationId: "b".repeat(32), signature }));
    expect(() => verifyHubInitialization({ home: root, hubId: identity.hubId, memberOrigin, planDigest: data.planDigest })).toThrow();
  });
  it("does absolutely no factory, plan/key/file work when both switches are off", async () => {
    const factory = vi.fn(), plan = vi.fn(), hold = vi.fn();
    const mount = new HubMount({ home: "/nonexistent/off-mode", planDigest: plan, createServer: factory, createMember: factory, hold });
    await mount.apply({}); await mount.apply({ hub: { enabled: false }, hub_member: { enabled: false } });
    expect(factory).not.toHaveBeenCalled(); expect(plan).not.toHaveBeenCalled(); expect(hold).not.toHaveBeenCalled();
    expect(mount.serverEnabled()).toBe(false); expect(mount.memberEnabled()).toBe(false);
  });
  it("YAML alone cannot mount a server, and failure produces a visible hold", async () => {
    const factory = vi.fn(), hold = vi.fn(); const mount = new HubMount({ home: home(), planDigest: () => sha256("plan"), createServer: factory, createMember: factory, hold });
    await mount.apply({ hub: { enabled: true, hubId: "a", memberOrigin: "https://hub.test" } });
    expect(factory).not.toHaveBeenCalled(); expect(hold).toHaveBeenCalledWith("initialization"); expect(mount.serverEnabled()).toBe(false);
  });
  it("invalidates before awaiting shutdown, and a superseded factory cannot start", async () => {
    const f = await initialized(); let release!: (value: any) => void;
    const service = { start: vi.fn(async () => {}), fence: vi.fn(), close: vi.fn(async () => {}) };
    const factory = vi.fn(() => new Promise<any>(resolve => { release = resolve; }));
    const mount = new HubMount({ home: f.root, planDigest: () => f.digest, createServer: factory, createMember: vi.fn(), hold: vi.fn() });
    const starting = mount.apply({ hub: { enabled: true, hubId: f.identity.hubId, memberOrigin: f.memberOrigin } });
    await vi.waitFor(() => expect(factory).toHaveBeenCalled()); const old = mount.epoch();
    const stopping = mount.apply({ hub: { enabled: false } });
    expect(mount.epoch()).toBeGreaterThan(old); expect(mount.serverEnabled()).toBe(false);
    release(service); await Promise.all([starting, stopping]); expect(service.start).not.toHaveBeenCalled(); expect(service.fence).toHaveBeenCalled(); expect(service.close).toHaveBeenCalled();
  });
});

it("reports a valid manifest plus failed service startup as unavailable, without claiming its seal is invalid", async () => {
  const f = await initialized(), hold = vi.fn(), close = vi.fn(async () => {});
  const mount = new HubMount({ home: f.root, planDigest: () => f.digest, createServer: async () => ({ start: async () => { throw Error("inert listener failure"); }, fence: vi.fn(), close }), createMember: vi.fn(), hold });
  await mount.apply({ hub: { enabled: true, hubId: f.identity.hubId, memberOrigin: f.memberOrigin } });
  expect(hold).toHaveBeenCalledExactlyOnceWith("service-unavailable"); expect(mount.serverEnabled()).toBe(false); expect(close).toHaveBeenCalled();
});
it("accepts only the initializer's canonical ISO timestamp in the signed manifest", async () => {
  const f = await initialized();
  for (const committedAt of [Date.now(), [f.manifest.committedAt], "2026-13-01T00:00:00.000Z", "2026-01-01T00:00:00Z"]) {
    expect(() => sealHubInitialization({ home: f.root, planDigest: f.digest, confirmationId: "a".repeat(32), committedAt: committedAt as never })).toThrow();
  }
});
