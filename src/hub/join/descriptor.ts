/** Public company link: authenticates a pinned tuple, never grants enrollment or proves company distribution. */
import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { hash, validated, parseStrictJson, HubProtocolError } from "../validation.js";
import { companyIdentityDigest, joinIdentitySchema, joinKeyThumbprint, type JoinIdentity } from "./protocol.js";
import { verifyCompanyInvitation } from "./invitation.js";
import { hubOrigin } from "../tls.js";
const signature = z.string().length(86).regex(/^[A-Za-z0-9_-]+$/).refine(s => Buffer.from(s, "base64url").toString("base64url") === s);
export const companyDescriptorSchema = z.strictObject({ v: z.literal(1), hub: joinIdentitySchema, fingerprint: hash, signature });
const bytes = (hub: JoinIdentity) => Buffer.from(JSON.stringify(["agend-hub-company-descriptor-v1", companyIdentityDigest(hub)]));
export function signCompanyDescriptor(hub: JoinIdentity, key: KeyObject) {
  const pub = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  if (key.type !== "private" || joinKeyThumbprint(pub) !== joinKeyThumbprint(hub.issuerPublicKey)) throw new HubProtocolError("denied");
  return { v: 1 as const, hub, fingerprint: companyIdentityDigest(hub), signature: sign(null, bytes(hub), key).toString("base64url") };
}
export function verifyCompanyDescriptor(input: unknown) {
  const d = validated(companyDescriptorSchema, input);
  if (companyIdentityDigest(d.hub) !== d.fingerprint || !verify(null, bytes(d.hub), createPublicKey(d.hub.issuerPublicKey), Buffer.from(d.signature, "base64url")))
    throw new HubProtocolError("denied");
  return d;
}
export function parseCompanyAddress(input: string): { webOrigin: string; expected: string | null; invitation?: string } {
  if (typeof input !== "string" || input.length > 8192 || input !== input.trim()) throw new HubProtocolError("invalid");
  try {
    const u = new URL(input);
    if (!u.hash) return { webOrigin: hubOrigin(input), expected: null };
    if (u.pathname !== "/join-info" || u.search || u.username || u.password || !(u.hash.startsWith("#hub=") || u.hash.startsWith("#invite="))) throw new HubProtocolError("invalid");
    const isInvite = u.hash.startsWith("#invite="), encoded = u.hash.slice(isInvite ? 8 : 5);
    if (isInvite) {
      const invite = verifyCompanyInvitation(encoded);
      if (invite.hub.webOrigin !== u.origin) throw new HubProtocolError("denied");
      return { webOrigin: u.origin, expected: companyIdentityDigest(invite.hub), invitation: encoded };
    }
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || Buffer.from(encoded, "base64url").toString("base64url") !== encoded) throw new HubProtocolError("invalid");
    const d = verifyCompanyDescriptor(parseStrictJson(Buffer.from(encoded, "base64url"), 6144));
    if (d.hub.webOrigin !== u.origin) throw new HubProtocolError("denied");
    return { webOrigin: u.origin, expected: d.fingerprint };
  } catch (error) { if (error instanceof HubProtocolError) throw error; throw new HubProtocolError("invalid"); }
}
