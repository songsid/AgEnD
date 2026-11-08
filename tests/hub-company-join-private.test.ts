/** Real filesystem/FD traces with injected fsync failure; no simulated power-cut claim. */
import { afterEach, describe, expect, it, vi } from "vitest";
const trace = vi.hoisted(() => ({ paths: [] as string[], fail: "" }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, fsyncSync(fd: number) {
    const path = fs.readlinkSync(`/proc/self/fd/${fd}`); trace.paths.push(path);
    if (path === trace.fail) throw Object.assign(Error("Owned fsync failure"), { code: "EIO" });
    fs.fsyncSync(fd);
  } };
});
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { CompanyTrustStore } from "../src/hub/join/trust.js";
import { CompanyJoinController } from "../src/hub/join/local.js";
import { companyIdentityDigest } from "../src/hub/join/protocol.js";
const homes: string[] = [];
afterEach(() => { trace.fail = ""; trace.paths = []; for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function world() {
  const home = mkdtempSync(join(tmpdir(), "company-private-")); chmodSync(home, 0o700); homes.push(home);
  const issuer = generateKeyPairSync("ed25519"), hub = { hubId: randomUUID(), webOrigin: "https://hub.example.test", memberOrigin: "https://hub.example.test:9443",
    spkiSha256: "a".repeat(64), issuerPublicKey: issuer.publicKey.export({ type: "spki", format: "pem" }).toString() };
  return { home, hub, trust: new CompanyTrustStore(home) };
}
describe("strict ancestor durability", () => {
  it.each([false, true])("a pin flushes every ancestor through home before returning (existing parents %s)", parents => {
    const w = world(); if (parents) mkdirSync(join(w.home, "hub-member/company-trust"), { recursive: true, mode: 0o700 });
    w.trust.checkAndPin(w.hub, null, null, () => true);
    expect(trace.paths.slice(-4)).toEqual([join(w.home, w.trust.path(w.hub.webOrigin)), join(w.home, "hub-member/company-trust"), join(w.home, "hub-member"), w.home]);
  });
  it("a pin left behind by a failed ancestor flush cannot bypass the failure on Retry", () => {
    const w = world(); trace.fail = w.home;
    expect(() => w.trust.checkAndPin(w.hub, null, null, () => true)).toThrow("fsync");
    expect(existsSync(join(w.home, w.trust.path(w.hub.webOrigin)))).toBe(true);
    expect(() => new CompanyTrustStore(w.home).checkAndPin(w.hub, null, null, () => true)).toThrow("fsync");
    trace.fail = ""; expect(w.trust.checkAndPin(w.hub, null, null, () => true)).toBe("known"); expect(trace.paths.at(-1)).toBe(w.home);
  });
  it.each([false, true])("a cold journal/current pointer is ancestor-durable before any push; flush failure holds (%s)", fail => {
    const w = world(), metadata = { v: 1 as const, hub: w.hub, identityDigest: companyIdentityDigest(w.hub), certificatePem: "", features: ["company-join-v1"] };
    const push = vi.fn(async (binding: any) => {
      const journal = trace.paths.find(p => /company-joins\/[^/]+\.json$/.test(p)); expect(journal).toBeTruthy();
      expect(trace.paths.lastIndexOf(w.home)).toBeGreaterThan(trace.paths.indexOf(journal!));
      expect(trace.paths.lastIndexOf(w.home)).toBeGreaterThan(trace.paths.lastIndexOf(join(w.home, "hub-member/company-join-current.json")));
      return { requestId: binding.requestId, expiresAt: Date.now() + 600_000, browserAction: w.hub.webOrigin + "/hub/join/open" };
    });
    const session = { ownerKey: {}, sessionId: "b".repeat(64), authorityEpoch: 1, hostHere: true, current: () => true };
    const controller = new CompanyJoinController({ home: w.home, schedule: false,
      client: { discover: async () => metadata, command: push }, snapshot: () => ({ membership: false, binding: null }),
      enableMembership() {}, activate() {}, link: () => "offline" });
    const start = () => controller.start({ address: w.hub.webOrigin, label: "Fleet", fleetOrigin: "http://127.0.0.1:4444" }, { session, confirmedCurrent: () => true });
    return (async () => {
      try {
        if (fail) {
          trace.fail = w.home; await expect(start()).rejects.toThrow("fsync"); await expect(start()).rejects.toThrow("fsync"); expect(push).not.toHaveBeenCalled(); trace.fail = "";
        }
        expect(await start()).toMatchObject({ state: "awaiting-sign-in" }); expect(push).toHaveBeenCalledOnce();
      } finally { controller.close(); }
    })();
  });
});
