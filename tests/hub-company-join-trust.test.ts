/** #3423 changed-identity and fake-link negatives, including failed-join TOFU retention. */
import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { companyIdentityDigest } from "../src/hub/join/protocol.js";
import { parseCompanyAddress, signCompanyDescriptor } from "../src/hub/join/descriptor.js";
import { CompanyTrustStore } from "../src/hub/join/trust.js";
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function world() {
  const home = mkdtempSync(join(tmpdir(), "agend-company-trust-")); chmodSync(home, 0o700); homes.push(home);
  const issuer = generateKeyPairSync("ed25519");
  const hub = { hubId: randomUUID(), memberOrigin: "https://hub.example.test:9443", webOrigin: "https://hub.example.test",
    spkiSha256: "a".repeat(64), issuerPublicKey: issuer.publicKey.export({ type: "spki", format: "pem" }).toString() };
  return { home, issuer, hub, store: new CompanyTrustStore(home) };
}
describe("company descriptor and persistent trust", () => {
  it("a signed public company link prefills the exact origin and stable identity, without an enrollment grant", () => {
    const { hub, issuer } = world(), descriptor = signCompanyDescriptor(hub, issuer.privateKey);
    const address = hub.webOrigin + "/join-info#hub=" + Buffer.from(JSON.stringify(descriptor)).toString("base64url");
    expect(parseCompanyAddress(address)).toMatchObject({ webOrigin: hub.webOrigin, expected: companyIdentityDigest(hub) });
    expect(parseCompanyAddress(hub.webOrigin)).toEqual({ webOrigin: hub.webOrigin, expected: null });
    expect(descriptor).not.toHaveProperty("credential"); expect(descriptor).not.toHaveProperty("permission");
  });
  it("rejects a fake link that changes origins/key/pin independently or adds a redirect/credential", () => {
    const { hub, issuer } = world(), descriptor = signCompanyDescriptor(hub, issuer.privateKey);
    for (const changed of [{ ...descriptor, hub: { ...hub, memberOrigin: "https://evil.test" } },
      { ...descriptor, fingerprint: "b".repeat(64) }, { ...descriptor, credential: "injected" }]) {
      expect(() => parseCompanyAddress(hub.webOrigin + "/join-info#hub=" + Buffer.from(JSON.stringify(changed)).toString("base64url"))).toThrow();
    }
    expect(() => parseCompanyAddress("https://evil.test/join-info#hub=" + Buffer.from(JSON.stringify(descriptor)).toString("base64url"))).toThrow();
    expect(() => parseCompanyAddress(hub.webOrigin + "/join-info?next=https://evil.test#hub=x")).toThrow();
    expect(() => parseCompanyAddress("http://hub.example.test")).toThrow();
  });
  it("pins first use durably before AD and retains that pin across cancellation, failure or restart", () => {
    const { store, home, hub } = world();
    expect(store.checkAndPin(hub, null, null, () => true)).toBe("first-use");
    expect(new CompanyTrustStore(home).checkAndPin(hub, null, null, () => true)).toBe("known");
    expect(() => new CompanyTrustStore(home).checkAndPin({ ...hub, spkiSha256: "b".repeat(64) }, null, null, () => true)).toThrow();
    expect(store.checkAndPin(hub, null, null, () => true)).toBe("known");
  });
  it("a trusted-link mismatch or legacy profile pin never becomes a fresh TOFU allowance", () => {
    const { store, hub } = world(), known = companyIdentityDigest(hub), other = { ...hub, spkiSha256: "b".repeat(64) };
    expect(() => store.checkAndPin(other, known, null, () => true)).toThrow();
    expect(() => store.checkAndPin(other, null, hub, () => true)).toThrow();
    expect(() => store.checkAndPin(hub, known, null, () => false)).toThrow();
    expect(store.checkAndPin(hub, known, null, () => true)).toBe("company-link");
  });
  it("rejects malformed/unsafe private state rather than forgetting the previous identity", () => {
    const { store, home, hub } = world(); store.checkAndPin(hub, null, null, () => true);
    const path = store.path(hub.webOrigin); chmodSync(join(home, path), 0o644);
    expect(() => store.checkAndPin(hub, null, null, () => true)).toThrow();
    rmSync(join(home, path)); symlinkSync("/nonexistent/company-trust", join(home, path));
    expect(() => store.checkAndPin(hub, null, null, () => true)).toThrow();
  });
});
