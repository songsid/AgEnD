import { describe, it, expect } from "vitest";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { canonicalArguments, operationDigest, personKeyString, sha256, signAsker, verifyAsker, verifyLease } from "../src/hub/identity.js";
import type { HubAskerEnvelope, HubAuthorizationRequest } from "../src/hub/types.js";
function fixture() {
  const key = generateKeyPairSync("ed25519"), now = 1_800_000_000_000;
  const person = { realm: "directory", objectId: randomUUID() };
  const unsigned: Omit<HubAskerEnvelope, "signature"> = { v: 1, issuer: randomUUID(), issuerKeyId: sha256("key"), messageId: randomUUID(),
    asker: { realm: "directory", objectId: randomUUID() }, owner: person, destinationFleetId: randomUUID(), exposureId: randomUUID(), roomId: randomUUID(),
    grantId: randomUUID(), grantRevision: 1, exposureRevision: 2, revocationVersion: 3, contentDigest: sha256("question"),
    issuedAt: now, expiresAt: now + 120_000, nonce: randomBytes(32).toString("hex") };
  const binding = { hubId: unsigned.issuer, issuerKeyId: unsigned.issuerKeyId, issuerPublicKey: key.publicKey, fleetId: unsigned.destinationFleetId, owner: person, revocationVersion: 3, now };
  return { key, unsigned, envelope: signAsker(unsigned, key.privateKey), binding };
}
describe("Hub signed identity and exact operation", () => {
  it("verifies exact issuer/owner/destination/body, with no local human authority fields", () => {
    const f = fixture(); expect(verifyAsker(f.envelope, "question", f.binding)).toEqual(f.envelope);
    expect(() => verifyAsker({ ...f.envelope, authority: "web-verified" }, "question", f.binding)).toThrow();
    expect(() => verifyAsker(f.envelope, "changed", f.binding)).toThrow();
    expect(personKeyString(f.envelope.asker)).toBe(`directory/${f.envelope.asker.objectId}`);
  });
  it.each(["issuer", "issuerKeyId", "messageId", "destinationFleetId", "exposureId", "roomId", "grantId", "nonce"] as const)("refuses swapped signed %s", field => {
    const f = fixture(); const swapped = { ...f.envelope, [field]: field === "issuerKeyId" || field === "nonce" ? "b".repeat(64) : randomUUID() };
    expect(() => verifyAsker(swapped, "question", f.binding)).toThrow();
  });
  it("refuses stale/current revision mismatch, future time, expiry and wrong key", () => {
    const f = fixture();
    for (const change of [{ revocationVersion: 4 }, { now: f.binding.now + 120_000 }, { now: f.binding.now - 5_001 }, { fleetId: randomUUID() }, { owner: { ...f.binding.owner, objectId: randomUUID() } }, { issuerPublicKey: generateKeyPairSync("ed25519").publicKey }]) {
      expect(() => verifyAsker(f.envelope, "question", { ...f.binding, ...change })).toThrow();
    }
    const invalid = signAsker({ ...f.unsigned, expiresAt: f.binding.now + 120_001 }, f.key.privateKey);
    expect(() => verifyAsker(invalid, "question", f.binding)).toThrow();
  });
  it("binds the actual tool/arguments, answer and phase even within a lease window", () => {
    const request: HubAuthorizationRequest = { messageId: randomUUID(), operationId: randomUUID(), exposureRevision: 1, phase: "tool", tool: { name: "read", argumentsDigest: sha256("a") } };
    const lease = { decisionId: randomUUID(), ...request, operationDigest: operationDigest(request), revocationVersion: 2, linkEpoch: 3, expiresAt: 4_000 };
    const { tool: _, ...wireLease } = lease;
    expect(verifyLease(wireLease, request, { linkEpoch: 3, revocationVersion: 2, now: 1_000 })).toEqual(wireLease);
    for (const changed of [{ ...request, operationId: randomUUID() }, { ...request, tool: { ...request.tool, name: "write" } }, { ...request, tool: { ...request.tool, argumentsDigest: sha256("b") } }, { messageId: request.messageId, operationId: request.operationId, exposureRevision: 1, phase: "release-answer" as const, answer: { answerId: randomUUID(), contentDigest: sha256("answer") } }]) {
      expect(() => verifyLease(wireLease, changed, { linkEpoch: 3, revocationVersion: 2, now: 1_000 })).toThrow();
    }
  });
  it("canonicalizes validated arguments only; rejects undefined/cycles/prototypes and unsafe values", () => {
    expect(canonicalArguments({ b: [0.5, true], a: { z: null } })).toBe('{"a":{"z":null},"b":[0.5,true]}');
    const cycle: any = {}; cycle.self = cycle;
    for (const v of [{ x: undefined }, { x: Infinity }, new Date(), cycle, { x: "\ud800" }]) expect(() => canonicalArguments(v)).toThrow();
  });
});
