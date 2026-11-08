/** #3423 protocol negatives, before implementation. No process, account or network is started. */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import {
  browserOriginProof, canonicalFleetOrigin, companyIdentityDigest, joinKeyThumbprint,
  pkceChallenge, signJoinProof, verifyJoinProof,
} from "../src/hub/join/protocol.js";

function world() {
  const key = generateKeyPairSync("ed25519"), issuer = generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ type: "spki", format: "pem" }).toString();
  const hub = { hubId: randomUUID(), webOrigin: "https://hub.example.test", memberOrigin: "https://hub.example.test:9443",
    spkiSha256: "a".repeat(64), issuerPublicKey: issuer.publicKey.export({ type: "spki", format: "pem" }).toString() };
  const binding = { hub, requestId: randomUUID(), operationId: randomUUID(), fleetId: randomUUID(), publicKey,
    fleetOrigin: "http://127.0.0.1:43210", verifierS256: pkceChallenge(randomBytes(32).toString("base64url")) };
  return { key, hub, binding };
}

describe("company join exact identity and browser-origin binding", () => {
  it.each(["hubId", "webOrigin", "memberOrigin", "spkiSha256", "issuerPublicKey"] as const)("a changed %s changes the stable Hub identity", field => {
    const { hub } = world(), other = world().hub;
    const values = { ...other, webOrigin: "https://another.example.test", memberOrigin: "https://hub.example.test:9444", spkiSha256: "b".repeat(64) };
    expect(companyIdentityDigest({ ...hub })).toBe(companyIdentityDigest(hub));
    expect(companyIdentityDigest({ ...hub, [field]: values[field] })).not.toBe(companyIdentityDigest(hub));
  });
  it("requires the actual matching browser Origin even when an attacker signs the victim's advertised origin", () => {
    const { binding, key } = world(), payload = { state: randomBytes(32).toString("base64url") };
    const proof = signJoinProof(binding, "push", randomBytes(32).toString("hex"), 50_000, payload, key.privateKey);
    expect(() => verifyJoinProof(binding, "push", proof, payload, 20_000)).not.toThrow();
    expect(() => browserOriginProof("https://attacker.example.test", binding.fleetOrigin)).toThrow();
    expect(browserOriginProof(binding.fleetOrigin, binding.fleetOrigin)).toBe(binding.fleetOrigin);
  });
  it.each([undefined, null, "null", "", ["https://fleet.example.test"], "https://fleet.example.test, https://evil.test",
    "https://fleet.example.test.evil.test", "https://fleet.example.test/", "https://fleet.example.test:444", "http://fleet.example.test"])(
    "refuses missing, opaque, ambiguous or nonexact browser origin %j", origin => {
      expect(() => browserOriginProof(origin, "https://fleet.example.test")).toThrow();
    });
  it.each(["https://u:p@fleet.example.test", "https://fleet.example.test/path", "https://fleet.example.test?q=1",
    "https://fleet.example.test#x", "https://fleet.example.test.", "file:///tmp/fleet", "http://untrusted.example.test"])(
    "refuses unsafe Fleet origin %s", value => { expect(() => canonicalFleetOrigin(value)).toThrow(); });
  it("allows canonical HTTPS and literal-loopback HTTP without port/scheme substitutions", () => {
    expect(canonicalFleetOrigin("https://fleet.example.test")).toBe("https://fleet.example.test");
    expect(canonicalFleetOrigin("http://127.0.0.1:43210")).toBe("http://127.0.0.1:43210");
  });
});

describe("one-purpose Fleet key proof", () => {
  it("signs the full transaction and payload with a canonical Ed25519 public key", () => {
    const { binding, key } = world(), payload = { verifier: "dummy-verifier", phase: "issued" };
    const proof = signJoinProof(binding, "redeem", "c".repeat(64), 50_000, payload, key.privateKey);
    expect(joinKeyThumbprint(binding.publicKey)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => verifyJoinProof(binding, "redeem", proof, payload, 20_000)).not.toThrow();
    expect(() => verifyJoinProof(binding, "ack", proof, payload, 20_000)).toThrow();
    expect(() => verifyJoinProof(binding, "redeem", proof, { ...payload, phase: "ack" }, 20_000)).toThrow();
    expect(() => verifyJoinProof(binding, "redeem", proof, payload, 50_000)).toThrow();
    expect(() => verifyJoinProof(binding, "redeem", proof, payload, 0)).toThrow(); // future proof beyond30s
    expect(() => verifyJoinProof({ ...binding, operationId: randomUUID() }, "redeem", proof, payload, 20_000)).toThrow();
    expect(() => verifyJoinProof({ ...binding, publicKey: world().binding.publicKey }, "redeem", proof, payload, 20_000)).toThrow();
    expect(() => verifyJoinProof({ ...binding, hub: { ...binding.hub, spkiSha256: "d".repeat(64) } }, "redeem", proof, payload, 20_000)).toThrow();
  });
  it("rejects private keys, alternate algorithms, noncanonical encodings and invalid verifier lengths", () => {
    const { key } = world();
    expect(() => joinKeyThumbprint(key.privateKey.export({ type: "pkcs8", format: "pem" }).toString())).toThrow();
    expect(() => joinKeyThumbprint(generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }).toString())).toThrow();
    expect(() => pkceChallenge("too-short")).toThrow();
    expect(() => pkceChallenge("x".repeat(43) + "=")).toThrow();
  });
});
