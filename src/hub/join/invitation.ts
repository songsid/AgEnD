/** Admin-issued exception: signed Hub identity + immutable recipient. Possession is never AD identity or local Fleet consent. */
import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalArguments } from "../identity.js";
import { epoch, hash, person, uuid, validated, parseStrictJson, HubProtocolError } from "../validation.js";
import { joinIdentitySchema, companyIdentityDigest, joinKeyThumbprint } from "./protocol.js";
export const companyInvitationClaims = z.strictObject({ v: z.literal(2), id: uuid, hub: joinIdentitySchema, owner: person, approvedBy: person,
  nonce: hash, createdAt: epoch, expiresAt: epoch });
export type CompanyInvitationClaims = z.infer<typeof companyInvitationClaims>;
const envelope = z.strictObject({ claims: companyInvitationClaims, signature: z.string().length(86).regex(/^[A-Za-z0-9_-]+$/) });
const bytes = (input: CompanyInvitationClaims) => Buffer.from(canonicalArguments(["agend-hub-invitation-v2", input]));
export function signCompanyInvitation(input: CompanyInvitationClaims, key: KeyObject): string {
  const c = validated(companyInvitationClaims, input);
  if (key.type !== "private" || joinKeyThumbprint(createPublicKey(key).export({ type: "spki", format: "pem" }).toString()) !== joinKeyThumbprint(c.hub.issuerPublicKey))
    throw new HubProtocolError("denied");
  return Buffer.from(JSON.stringify({ claims: c, signature: sign(null, bytes(c), key).toString("base64url") })).toString("base64url");
}
export function verifyCompanyInvitation(input: string, now?: number): CompanyInvitationClaims {
  if (typeof input !== "string" || input.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(input) || Buffer.from(input, "base64url").toString("base64url") !== input)
    throw new HubProtocolError("invalid");
  const e = validated(envelope, parseStrictJson(Buffer.from(input, "base64url"), 6144)), c = e.claims;
  companyIdentityDigest(c.hub);
  if (c.expiresAt !== c.createdAt + 600_000 || now !== undefined && (now < c.createdAt || now >= c.expiresAt)
    || Buffer.from(e.signature, "base64url").toString("base64url") !== e.signature
    || !verify(null, bytes(c), createPublicKey(c.hub.issuerPublicKey), Buffer.from(e.signature, "base64url"))) throw new HubProtocolError("denied");
  return c;
}
