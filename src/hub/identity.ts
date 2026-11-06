import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { person, validated, parseStrictJson, HubProtocolError } from "./validation.js";
import { leaseSchema, validateAsker, validateAuthorization } from "./protocol.js";
import type { HubAskerEnvelope, HubAttachmentRef, HubAuthorizationRequest, HubAuthorizationLease, PersonKey } from "./types.js";
export const sha256 = (input: string | Buffer): string => createHash("sha256").update(input).digest("hex");
/** The canonical digest of an attachments-v1 file list, in its order. */
export function attachmentsDigest(refs: readonly HubAttachmentRef[]): string {
  return sha256(JSON.stringify(refs.map(r => [r.id, r.name, r.size, r.mime, r.sha256])));
}
/** A message's contentDigest. With nothing but text it is sha256(text), as before. With files (D) and/or reply buttons
 * (F, its own canonical digest) it also binds them, so the asker signature, receipts and the release lease cover them
 * with no new envelope or lease field. */
export function messageContentDigest(kind: "question" | "answer", text: string, extras?: { attachments?: readonly HubAttachmentRef[]; buttonsDigest?: string }): string {
  const files = extras?.attachments?.length ? attachmentsDigest(extras.attachments) : null, buttons = extras?.buttonsDigest ?? null;
  if (files === null && buttons === null) return sha256(text);
  return sha256(JSON.stringify([`agend-hub-${kind}-extras-v1`, sha256(text), files, buttons]));
}
export function personKeyString(input: PersonKey): string { const p = validated(person, input); return `${p.realm}/${p.objectId}`; }
function tuple(e: HubAskerEnvelope): string {
  return JSON.stringify(["agend-hub-ask-v1", e.v, e.issuer, e.issuerKeyId, e.messageId, e.asker.realm, e.asker.objectId,
    e.owner.realm, e.owner.objectId, e.destinationFleetId, e.exposureId, e.roomId, e.grantId, e.grantRevision,
    e.exposureRevision, e.revocationVersion, e.contentDigest, e.issuedAt, e.expiresAt, e.nonce]);
}
export function signAsker(input: Omit<HubAskerEnvelope, "signature">, key: KeyObject): HubAskerEnvelope {
  const e = validateAsker({ ...input, signature: "A".repeat(86) });
  if (key.asymmetricKeyType !== "ed25519" || key.type !== "private") throw new HubProtocolError();
  return { ...e, signature: sign(null, Buffer.from(tuple(e)), key).toString("base64url") };
}
export interface HubIdentityBinding {
  hubId: string; issuerKeyId: string; issuerPublicKey: KeyObject; fleetId: string; owner: PersonKey;
  revocationVersion: number; now: number;
}
export function verifyAsker(input: unknown, text: string, binding: HubIdentityBinding, attachments?: readonly HubAttachmentRef[]): HubAskerEnvelope {
  const e = validateAsker(input), key = binding.issuerPublicKey;
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519" || e.issuer !== binding.hubId || e.issuerKeyId !== binding.issuerKeyId
    || e.destinationFleetId !== binding.fleetId || personKeyString(e.owner) !== personKeyString(binding.owner)
    || e.contentDigest !== messageContentDigest("question", text, { attachments }) || e.revocationVersion !== binding.revocationVersion
    || !Number.isSafeInteger(binding.now) || e.expiresAt <= binding.now || e.issuedAt > binding.now + 5_000
    || e.expiresAt <= e.issuedAt || e.expiresAt - e.issuedAt > 120_000
    || Buffer.from(e.signature, "base64url").toString("base64url") !== e.signature
    || !verify(null, Buffer.from(tuple(e)), key, Buffer.from(e.signature, "base64url"))) throw new HubProtocolError("denied");
  return e;
}
export function operationDigest(input: HubAuthorizationRequest): string {
  const r = validateAuthorization(input);
  return sha256(JSON.stringify(["agend-hub-operation-v1", r.messageId, r.operationId, r.phase, r.exposureRevision,
    r.phase === "tool" ? r.tool.name : null, r.phase === "tool" ? r.tool.argumentsDigest : null,
    r.phase === "release-answer" ? r.answer.answerId : null, r.phase === "release-answer" ? r.answer.contentDigest : null]));
}
export function verifyLease(input: HubAuthorizationLease, request: HubAuthorizationRequest, expected: { linkEpoch: number; revocationVersion: number; now: number }): HubAuthorizationLease {
  const lease = validated(leaseSchema, input), r = validateAuthorization(request);
  if (lease.messageId !== r.messageId || lease.operationId !== r.operationId || lease.phase !== r.phase
    || lease.exposureRevision !== r.exposureRevision || lease.operationDigest !== operationDigest(r)
    || lease.linkEpoch !== expected.linkEpoch || lease.revocationVersion !== expected.revocationVersion
    || lease.expiresAt <= expected.now || lease.expiresAt > expected.now + 5_000) throw new HubProtocolError("stale");
  return lease;
}
export function canonicalArguments(input: unknown): string {
  const canonical = (v: unknown, depth: number): string => {
    if (depth > 32) throw new HubProtocolError();
    if (v === null || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) return JSON.stringify(v);
    if (typeof v === "string") { parseStrictJson(JSON.stringify(v)); return JSON.stringify(v); }
    if (Array.isArray(v)) return `[${v.map(x => canonical(x, depth + 1)).join(",")}]`;
    if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
      return `{${Object.keys(v).sort().map(k => `${canonical(k, depth + 1)}:${canonical((v as Record<string, unknown>)[k], depth + 1)}`).join(",")}}`;
    }
    throw new HubProtocolError();
  };
  const out = canonical(input, 0); if (Buffer.byteLength(out) > 64 * 1024) throw new HubProtocolError(); return out;
}
export function issuerKeyId(key: KeyObject): string { return sha256((key.type === "public" ? key : createPublicKey(key)).export({ type: "spki", format: "der" })); }
