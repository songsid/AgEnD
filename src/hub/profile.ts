/** Local-owner-only pairing receipts. The UI receives projections, never these secrets. */
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createPublicKey } from "node:crypto";
import { z } from "zod";
import { atomicWriteFileSync } from "../atomic-write.js";
import { ensurePrivateDirectory, readPrivateFile } from "./private-files.js";
import { hubOrigin, verifyHubCertificate } from "./tls.js";
import { hash, person, token, uuid, epoch, validated, parseStrictJson, HubProtocolError } from "./validation.js";
import { sha256, issuerKeyId } from "./identity.js";
import { hubPairingFingerprint, type HubPairingIdentity } from "./pairing.js";
const identity = z.strictObject({ hubId: uuid, memberOrigin: z.string(), webOrigin: z.string(), spkiSha256: hash, issuerPublicKey: z.string().max(2048) });
const base = { v: z.literal(1), hub: identity, owner: person, fleetId: uuid, certificatePem: z.string().max(16 * 1024) };
export const profileSchema = z.strictObject({ ...base, credential: token, issuerKeyId: hash });
export const pendingSchema = z.strictObject({ ...base, pairingId: uuid, claimSecret: token, fingerprint: hash, expiresAt: epoch });
export type HubMemberProfile = z.infer<typeof profileSchema>;
export type HubPendingPairing = z.infer<typeof pendingSchema>;
export function validateHubBinding<T extends { hub: HubPairingIdentity; certificatePem: string }>(input: T, now = Date.now()): T {
  if (hubOrigin(input.hub.memberOrigin) !== input.hub.memberOrigin || hubOrigin(input.hub.webOrigin) !== input.hub.webOrigin || input.hub.memberOrigin === input.hub.webOrigin) throw new HubProtocolError();
  verifyHubCertificate(input.certificatePem, input.hub.memberOrigin, input.hub.spkiSha256, now);
  const key = createPublicKey(input.hub.issuerPublicKey);
  if (key.asymmetricKeyType !== "ed25519" || key.export({ type: "spki", format: "pem" }).toString() !== input.hub.issuerPublicKey) throw new HubProtocolError();
  return input;
}
export class HubMemberProfileStore {
  constructor(private readonly home: string, readonly hubId: string) { validated(uuid, hubId); }
  private suffix(name: string): string { return `hub-member/${this.hubId}/${name}.json`; }
  private read(name: string): unknown { return parseStrictJson(readPrivateFile(this.home, this.suffix(name))); }
  readProfile(): HubMemberProfile {
    const p = validateHubBinding(validated(profileSchema, this.read("pairing")));
    if (p.hub.hubId !== this.hubId || issuerKeyId(createPublicKey(p.hub.issuerPublicKey)) !== p.issuerKeyId) throw new HubProtocolError(); return p;
  }
  readPending(): HubPendingPairing {
    const p = validateHubBinding(validated(pendingSchema, this.read("pending")));
    if (p.hub.hubId !== this.hubId || p.fingerprint !== hubPairingFingerprint(p.hub, p.pairingId, p.owner, sha256(p.claimSecret))) throw new HubProtocolError(); return p;
  }
  profileDigest(): string | null { return existsSync(join(this.home, this.suffix("pairing"))) ? sha256(readPrivateFile(this.home, this.suffix("pairing"))) : null; }
  savePending(input: HubPendingPairing, current: () => boolean): void {
    const p = validateHubBinding(validated(pendingSchema, input));
    if (!current() || p.hub.hubId !== this.hubId || p.fingerprint !== hubPairingFingerprint(p.hub, p.pairingId, p.owner, sha256(p.claimSecret))) throw new HubProtocolError("stale");
    ensurePrivateDirectory(this.home, `hub-member/${this.hubId}`);
    if (existsSync(join(this.home, this.suffix("pending")))) throw new HubProtocolError("conflict");
    atomicWriteFileSync(join(this.home, this.suffix("pending")), JSON.stringify(p), { mode: 0o600, beforeRename: () => { if (!current()) throw new HubProtocolError("stale"); } });
  }
  saveProfile(input: HubMemberProfile, expectedDigest: string | null, current: () => boolean): void {
    const p = validateHubBinding(validated(profileSchema, input));
    if (!current() || p.hub.hubId !== this.hubId || this.profileDigest() !== expectedDigest || issuerKeyId(createPublicKey(p.hub.issuerPublicKey)) !== p.issuerKeyId) throw new HubProtocolError("stale");
    ensurePrivateDirectory(this.home, `hub-member/${this.hubId}`);
    atomicWriteFileSync(join(this.home, this.suffix("pairing")), JSON.stringify(p), { mode: 0o600, beforeRename: () => {
      if (!current() || this.profileDigest() !== expectedDigest) throw new HubProtocolError("stale");
    } });
  }
  clearPending(): void { readPrivateFile(this.home, this.suffix("pending")); unlinkSync(join(this.home, this.suffix("pending"))); }
}
