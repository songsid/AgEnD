/** Read-only seal helper; only S5's confirmed initialization transaction writes the manifest. */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { z } from "zod";
import { epoch, hash, uuid, validated, parseStrictJson } from "./validation.js";
import { readPrivateFile } from "./private-files.js";
import { readHubIdentity } from "./tls.js";
const schema = z.strictObject({ v: z.literal(1), hubId: uuid, planDigest: hash, committedAt: epoch,
  confirmationId: z.string().regex(/^[a-f0-9]{32}$/), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) });
export type HubInitializationManifest = z.infer<typeof schema>;
function bytes(m: Omit<HubInitializationManifest, "signature">): Buffer {
  return Buffer.from(JSON.stringify(["agend-hub-init-v1", 1, m.hubId, m.planDigest, m.committedAt, m.confirmationId]));
}
export function sealHubInitialization(input: { home: string; planDigest: string; confirmationId: string; committedAt: number }): string {
  const metadata = parseStrictJson(readPrivateFile(input.home, "hub/keys/identity.json")) as { memberOrigin?: unknown };
  if (typeof metadata.memberOrigin !== "string") throw Error("Hub identity is invalid");
  const identity = readHubIdentity({ home: input.home, memberOrigin: metadata.memberOrigin });
  const manifest = validated(schema, { v: 1, hubId: identity.hubId, planDigest: input.planDigest, committedAt: input.committedAt, confirmationId: input.confirmationId, signature: "A".repeat(86) });
  return sign(null, bytes(manifest), createPrivateKey(readPrivateFile(input.home, "hub/keys/issuer-key.pem"))).toString("base64url");
}
export function verifyHubInitialization(input: { home: string; hubId: string; memberOrigin: string; planDigest: string }): HubInitializationManifest {
  const identity = readHubIdentity(input), manifest = validated(schema, parseStrictJson(readPrivateFile(input.home, "hub/init-manifest.json")));
  if (manifest.hubId !== identity.hubId || manifest.hubId !== input.hubId || manifest.planDigest !== validated(hash, input.planDigest)
    || Buffer.from(manifest.signature, "base64url").toString("base64url") !== manifest.signature
    || !verify(null, bytes(manifest), createPublicKey(identity.issuerPublicKey), Buffer.from(manifest.signature, "base64url"))) throw Error("Hub initialization confirmation differs");
  return manifest;
}
