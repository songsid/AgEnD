/** Company join v1. Public machine data only; every purpose binds the complete immutable operation. */
import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalArguments, sha256 } from "../identity.js";
import { hubOrigin } from "../tls.js";
import { epoch, hash, uuid, validated, HubProtocolError } from "../validation.js";
import { canonicalCompanyFleetOrigin } from "../../authority/company-join.js";

const b64 = (length: number) => z.string().length(length).regex(/^[A-Za-z0-9_-]+$/).refine(s => Buffer.from(s, "base64url").toString("base64url") === s);
export const verifierSchema = b64(43);
export const joinIdentitySchema = z.strictObject({ hubId: uuid, webOrigin: z.string().max(2048), memberOrigin: z.string().max(2048),
  spkiSha256: hash, issuerPublicKey: z.string().max(2048) });
export type JoinIdentity = z.infer<typeof joinIdentitySchema>;
export const joinBindingSchema = z.strictObject({ hub: joinIdentitySchema, requestId: uuid, operationId: uuid, fleetId: uuid,
  publicKey: z.string().max(2048), fleetOrigin: z.string().max(2048), verifierS256: verifierSchema });
export type JoinBinding = z.infer<typeof joinBindingSchema>;
export const joinPurpose = z.enum(["push", "status", "redeem", "ack", "cancel", "tombstone"]);
export type JoinPurpose = z.infer<typeof joinPurpose>;
const proofSchema = z.strictObject({ v: z.literal(1), purpose: joinPurpose, nonce: hash, expiresAt: epoch, signature: b64(86) });
export type JoinProof = z.infer<typeof proofSchema>;

function publicKey(pem: string): KeyObject {
  try {
    const key = createPublicKey(pem);
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519" || key.export({ type: "spki", format: "pem" }).toString() !== pem)
      throw new HubProtocolError();
    return key;
  } catch { throw new HubProtocolError("invalid"); }
}
export function joinKeyThumbprint(pem: string): string { return sha256(publicKey(pem).export({ type: "spki", format: "der" })); }
export function pkceChallenge(verifier: string): string {
  return Buffer.from(sha256(validated(verifierSchema, verifier)), "hex").toString("base64url");
}
export function canonicalFleetOrigin(input: string): string {
  try { return canonicalCompanyFleetOrigin(input); } catch { throw new HubProtocolError("invalid"); }
}
export class CompanyBrowserHostnameConflict extends HubProtocolError { constructor() { super("invalid"); } }
/** Cookies are host-scoped, not port-scoped. A separate browser hostname is mandatory before any Fleet trust or handoff. */
export function requireSeparateJoinHosts(fleetOrigin: string, hubWebOrigin: string): void {
  const fleet = new URL(canonicalFleetOrigin(fleetOrigin)), hub = new URL(hubOrigin(hubWebOrigin));
  if (fleet.hostname === hub.hostname) throw new CompanyBrowserHostnameConflict();
}
/** Call before any browser state/cookie/AD effect. rawHeaders must additionally reject duplicate Origin headers. */
export function browserOriginProof(input: unknown, registered: string): string {
  const expected = canonicalFleetOrigin(registered);
  if (typeof input !== "string" || input !== expected) throw new HubProtocolError("denied");
  return expected;
}
export function companyIdentityDigest(input: JoinIdentity): string {
  const h = validated(joinIdentitySchema, input);
  try {
    if (hubOrigin(h.webOrigin) !== h.webOrigin || hubOrigin(h.memberOrigin) !== h.memberOrigin || h.webOrigin === h.memberOrigin)
      throw new HubProtocolError();
    publicKey(h.issuerPublicKey);
    return sha256(JSON.stringify(["agend-hub-company-identity-v1", h.hubId, h.webOrigin, h.memberOrigin, h.spkiSha256, h.issuerPublicKey]));
  } catch { throw new HubProtocolError("invalid"); }
}
export function validateJoinBinding(input: unknown): JoinBinding {
  const b = validated(joinBindingSchema, input);
  companyIdentityDigest(b.hub); canonicalFleetOrigin(b.fleetOrigin); joinKeyThumbprint(b.publicKey);
  requireSeparateJoinHosts(b.fleetOrigin, b.hub.webOrigin);
  return b;
}
function bytes(binding: JoinBinding, proof: Omit<JoinProof, "signature">, payload: unknown): Buffer {
  const b = validateJoinBinding(binding);
  return Buffer.from(JSON.stringify(["agend-hub-company-proof-v1", proof.v, proof.purpose, companyIdentityDigest(b.hub),
    b.hub.webOrigin, b.hub.memberOrigin, b.requestId, b.operationId, b.fleetId, b.fleetOrigin,
    joinKeyThumbprint(b.publicKey), b.verifierS256, proof.nonce, proof.expiresAt, sha256(canonicalArguments(payload))]));
}
export function signJoinProof(binding: JoinBinding, purpose: JoinPurpose, nonce: string, expiresAt: number, payload: unknown, key: KeyObject): JoinProof {
  const p = validated(proofSchema, { v: 1, purpose, nonce, expiresAt, signature: "A".repeat(86) });
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519"
    || joinKeyThumbprint(createPublicKey(key).export({ type: "spki", format: "pem" }).toString()) !== joinKeyThumbprint(binding.publicKey))
    throw new HubProtocolError("denied");
  return { ...p, signature: sign(null, bytes(binding, p, payload), key).toString("base64url") };
}
/** Nonce single-use is a same-DB CAS in the service, separately from signature/lifetime validation here. */
export function verifyJoinProof(binding: JoinBinding, purpose: JoinPurpose, input: unknown, payload: unknown, now: number): JoinProof {
  const p = validated(proofSchema, input);
  if (!Number.isSafeInteger(now) || now < 0 || p.purpose !== purpose || p.expiresAt <= now || p.expiresAt - now > 30_000
    || !verify(null, bytes(binding, p, payload), publicKey(binding.publicKey), Buffer.from(p.signature, "base64url")))
    throw new HubProtocolError("denied");
  return p;
}
