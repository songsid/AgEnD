import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { HubMemberProfileStore } from "../src/hub/profile.js";
import { hubPairingFingerprint } from "../src/hub/pairing.js";
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

it.each(["server", "member"] as const)("retains %s cleanup ownership after a refused close and blocks replacement until a positive close", async kind => {
  const f = await initialized(); let physical = 0, refuse = true;
  const factory = vi.fn(async () => {
    physical++; let closed = false;
    return { start: async () => {}, fence: vi.fn(), close: async () => { if (refuse) throw Error("unconfirmed"); if (!closed) { closed = true; physical--; } } };
  });
  const hold = vi.fn(), mount = new HubMount({ home: f.root, planDigest: () => f.digest, createServer: factory, createMember: factory, hold });
  const config = kind === "server" ? { hub: { enabled: true, hubId: f.identity.hubId, memberOrigin: f.memberOrigin } } : { hub_member: { enabled: true } };
  await mount.apply(config); expect(physical).toBe(1);
  await expect(mount.apply({})).rejects.toThrow("cleanup");
  await expect(mount.apply(config)).rejects.toThrow("cleanup");
  expect(factory).toHaveBeenCalledTimes(1); expect(physical).toBe(1); expect(hold).toHaveBeenCalledWith("service-unavailable");
  refuse = false; await mount.apply(config); expect(physical).toBe(1); expect(factory).toHaveBeenCalledTimes(2);
  await mount.close(); expect(physical).toBe(0);
});
it.each(["factory", "start"] as const)("close drains an owned pending %s before reporting shutdown", async phase => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const service = { start: vi.fn(async () => { if (phase === "start") await gate; }), fence: vi.fn(), close: vi.fn(async () => {}) };
  const factory = vi.fn(async () => { if (phase === "factory") await gate; return service; });
  const mount = new HubMount({ home: "/nonexistent/inert", planDigest: vi.fn(), createServer: vi.fn(), createMember: factory, hold: vi.fn() });
  const starting = mount.apply({ hub_member: { enabled: true } });
  await vi.waitFor(() => expect(phase === "factory" ? factory : service.start).toHaveBeenCalled());
  let closed = false; const stopping = mount.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 0)); expect(closed).toBe(false);
  release(); await Promise.all([starting, stopping]); expect(closed).toBe(true); expect(service.close).toHaveBeenCalled();
  if (phase === "factory") expect(service.start).not.toHaveBeenCalled();
});

it("reads historical pairing receipts after same-key renewal while the live peer still needs a valid matching certificate", async () => {
  const f = await initialized(), store = new HubMemberProfileStore(f.root, f.identity.hubId);
  const certificatePem = readFileSync(join(f.root, "hub/keys/tls-cert.pem"), "utf8");
  const hub = { hubId: f.identity.hubId, spkiSha256: f.identity.spkiSha256, issuerPublicKey: f.identity.issuerPublicKey, memberOrigin: f.memberOrigin, webOrigin: "https://127.0.0.1:39444" };
  const owner = { realm: "directory", objectId: randomUUID() }, fleetId = randomUUID(), pairingId = randomUUID(), claimSecret = "a".repeat(64);
  store.saveProfile({ v: 1, hub, owner, fleetId, certificatePem, credential: "b".repeat(64), issuerKeyId: f.identity.issuerKeyId }, null, () => true);
  store.savePending({ v: 1, hub, owner, fleetId, certificatePem, pairingId, claimSecret,
    fingerprint: hubPairingFingerprint(hub, pairingId, owner, sha256(claimSecret)), expiresAt: Date.now() + 600_000 }, () => true);
  execFileSync("/usr/bin/openssl", ["req", "-new", "-x509", "-sha256", "-days", "730", "-key", join(f.root, "hub/keys/tls-key.pem"), "-out", join(f.root, "hub/keys/tls-cert.pem"), "-subj", "/CN=AgEnD Hub", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore", timeout: 10_000 });
  const future = Date.now() + 366 * 86_400_000, renewed = readFileSync(join(f.root, "hub/keys/tls-cert.pem"), "utf8");
  expect(verifyHubCertificate(renewed, f.memberOrigin, f.identity.spkiSha256, future)).toBeDefined();
  expect(() => verifyHubCertificate(certificatePem, f.memberOrigin, f.identity.spkiSha256, future)).toThrow();
  expect(() => verifyHubCertificate(renewed, f.memberOrigin, "c".repeat(64), future)).toThrow();
  expect(() => verifyHubCertificate(renewed, "https://different.test", f.identity.spkiSha256, future)).toThrow();
  const clock = vi.spyOn(Date, "now").mockReturnValue(future);
  try {
    expect(readHubIdentity({ home: f.root, memberOrigin: f.memberOrigin })).toEqual(f.identity);
    expect(store.readProfile().certificatePem).toBe(certificatePem); expect(store.readPending().certificatePem).toBe(certificatePem);
  } finally { clock.mockRestore(); }
});
