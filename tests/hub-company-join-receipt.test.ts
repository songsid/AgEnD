/** #3423 AEAD tuple/expiry negatives. Existing-resource authority is tested separately at the service boundary. */
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJoinSealer, type DeliveryBinding } from "../src/hub/join/receipt.js";
import { sha256 } from "../src/hub/identity.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function world() {
  const home = mkdtempSync(join(tmpdir(), "agend-join-receipt-")); chmodSync(home, 0o700); homes.push(home);
  const credential = randomBytes(32).toString("hex");
  const binding: DeliveryBinding = { hubIdentityDigest: "a".repeat(64), requestId: randomUUID(), operationId: randomUUID(),
    owner: { realm: "corp", objectId: randomUUID() }, fleetId: randomUUID(), generation: 1, joinKeyThumbprint: "b".repeat(64),
    verifierS256: "c".repeat(43), issuedCredentialHash: sha256(credential), resourceRevision: 1, committedSource: "group",
    provenanceDigest: "d".repeat(64), issuedAt: 10_000, deliveryDeadline: 130_000, outerDeadline: 600_000 };
  return { home, credential, binding, sealer: createJoinSealer(home, () => false) };
}

describe("private company-join delivery receipts", () => {
  it("persists a dedicated private key; retries/restarts recover the same secret without an audit field", () => {
    const { home, credential, binding, sealer } = world(), receipt = sealer.seal(binding, credential);
    expect(JSON.stringify(receipt)).not.toContain(credential);
    expect(readFileSync(join(home, "hub/secrets/join-delivery.key"), "utf8")).not.toContain(credential);
    expect(statSync(join(home, "hub/secrets/join-delivery.key")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "hub/secrets")).mode & 0o777).toBe(0o700);
    expect(sealer.open(binding, receipt, 20_000)).toBe(credential);
    expect(createJoinSealer(home, () => true).open(binding, receipt, 20_000)).toBe(credential);
    expect(sealer.seal(binding, credential).nonce).not.toBe(receipt.nonce);
  });
  it.each(["hubIdentityDigest", "requestId", "operationId", "owner", "fleetId", "generation", "joinKeyThumbprint",
    "verifierS256", "issuedCredentialHash", "resourceRevision", "committedSource", "provenanceDigest", "issuedAt", "deliveryDeadline", "outerDeadline"] as const)(
    "refuses authenticated row substitution at %s", field => {
      const { credential, binding, sealer } = world(), receipt = sealer.seal(binding, credential);
      const changed = field === "owner" ? { realm: "corp", objectId: randomUUID() }
        : field === "committedSource" ? "manual" : typeof binding[field] === "number" ? (binding[field] as number) + 1
          : field === "requestId" || field === "operationId" || field === "fleetId" ? randomUUID()
            : field === "verifierS256" ? "e".repeat(43) : "e".repeat(64);
      expect(() => sealer.open({ ...binding, [field]: changed }, receipt, 20_000)).toThrow();
    });
  it("refuses wrong key/tag/ciphertext, exact expiry and plaintext whose hash differs from the committed credential", () => {
    const { credential, binding, sealer } = world(), receipt = sealer.seal(binding, credential), other = world();
    expect(() => other.sealer.open(binding, receipt, 20_000)).toThrow();
    expect(() => sealer.open(binding, { ...receipt, tag: randomBytes(16).toString("base64url") }, 20_000)).toThrow();
    expect(() => sealer.open(binding, { ...receipt, ciphertext: randomBytes(80).toString("base64url") }, 20_000)).toThrow();
    expect(() => sealer.open(binding, receipt, binding.deliveryDeadline)).toThrow();
    expect(() => sealer.seal(binding, randomBytes(32).toString("hex"))).toThrow();
    expect(() => sealer.open(binding, { ...receipt, alg: "none" }, 20_000)).toThrow();
    expect(() => sealer.open(binding, { ...receipt, nonce: receipt.nonce + "=" }, 20_000)).toThrow();
  });
  it("never regenerates a missing sealing key while receipts are retained", () => {
    const { home } = world(); rmSync(join(home, "hub/secrets/join-delivery.key"));
    expect(() => createJoinSealer(home, () => true)).toThrow();
  });
});
