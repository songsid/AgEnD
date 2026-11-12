/** Dedicated AES-GCM delivery receipts. No bearer is placed in audit content, URLs, status or notices. */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { sha256 } from "../identity.js";
import { readPrivateFile } from "../private-files.js";
import { epoch, hash, person, token, uuid, validated, parseStrictJson, HubProtocolError } from "../validation.js";
import { createJoinPrivate, syncJoinPrivate } from "./private.js";
import { verifierSchema } from "./protocol.js";

const bindingSchema = z.strictObject({ hubIdentityDigest: hash, requestId: uuid, operationId: uuid, owner: person, fleetId: uuid,
  generation: epoch, joinKeyThumbprint: hash, verifierS256: verifierSchema, issuedCredentialHash: hash,
  resourceRevision: epoch, committedSource: z.enum(["group", "manual", "code"]), provenanceDigest: hash,
  issuedAt: epoch, deliveryDeadline: epoch, outerDeadline: epoch });
export type DeliveryBinding = z.infer<typeof bindingSchema>;
const binary = (min: number, max = min) => z.string().refine(s => /^[A-Za-z0-9_-]+$/.test(s)
  && Buffer.from(s, "base64url").toString("base64url") === s && Buffer.from(s, "base64url").length >= min && Buffer.from(s, "base64url").length <= max);
const envelopeSchema = z.strictObject({ v: z.literal(1), alg: z.literal("A256GCM"), keyId: uuid,
  nonce: binary(12), ciphertext: binary(1, 512), tag: binary(16) });
export type DeliveryReceipt = z.infer<typeof envelopeSchema>;
const keySchema = z.strictObject({ v: z.literal(1), id: uuid, key: binary(32) });

function binding(input: DeliveryBinding): DeliveryBinding {
  const b = validated(bindingSchema, input);
  if (b.generation < 1 || b.resourceRevision < 1 || b.deliveryDeadline <= b.issuedAt || b.deliveryDeadline > b.issuedAt + 120_000
    || b.deliveryDeadline > b.outerDeadline) throw new HubProtocolError("invalid");
  return b;
}
function aad(b: DeliveryBinding, keyId: string): Buffer {
  return Buffer.from(JSON.stringify(["agend-hub-join-delivery-v1", keyId, b.hubIdentityDigest, b.requestId, b.operationId,
    b.owner.realm, b.owner.objectId, b.fleetId, b.generation, b.joinKeyThumbprint, b.verifierS256, b.issuedCredentialHash,
    "fleet", b.resourceRevision, b.committedSource, b.provenanceDigest, b.issuedAt, b.deliveryDeadline, b.outerDeadline]));
}
/** Caller inserts (keyId,nonce) under a UNIQUE constraint in the same issuance transaction. */
export function createJoinSealer(home: string, hasRetainedReceipts: () => boolean) {
  const suffix = "hub/secrets/join-delivery.key";
  if (!existsSync(join(home, suffix))) {
    if (hasRetainedReceipts()) throw new HubProtocolError("unavailable");
    createJoinPrivate(home, suffix, JSON.stringify({ v: 1, id: randomUUID(), key: randomBytes(32).toString("base64url") }));
  }
  const key = validated(keySchema, parseStrictJson(readPrivateFile(home, suffix, 1024)));
  syncJoinPrivate(home, suffix);
  const material = Buffer.from(key.key, "base64url");
  return {
    keyId: key.id,
    seal(input: DeliveryBinding, secret: string): DeliveryReceipt {
      const b = binding(input), credential = validated(token, secret);
      if (sha256(credential) !== b.issuedCredentialHash) throw new HubProtocolError("denied");
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", material, nonce);
      cipher.setAAD(aad(b, key.id));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ v: 1, credential }), "utf8"), cipher.final()]);
      return { v: 1, alg: "A256GCM", keyId: key.id, nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
    },
    /** Existing-resource/session/key/nonce authority checks belong to the service immediately around this call. */
    open(input: DeliveryBinding, receipt: unknown, now: number): string {
      const b = binding(input), e = validated(envelopeSchema, receipt);
      if (e.keyId !== key.id || !Number.isSafeInteger(now) || now < b.issuedAt || now >= b.deliveryDeadline || now >= b.outerDeadline)
        throw new HubProtocolError("expired");
      try {
        const decipher = createDecipheriv("aes-256-gcm", material, Buffer.from(e.nonce, "base64url"));
        decipher.setAAD(aad(b, key.id)); decipher.setAuthTag(Buffer.from(e.tag, "base64url"));
        const plaintext = Buffer.concat([decipher.update(Buffer.from(e.ciphertext, "base64url")), decipher.final()]);
        const p = validated(z.strictObject({ v: z.literal(1), credential: token }), parseStrictJson(plaintext, 256));
        if (sha256(p.credential) !== b.issuedCredentialHash) throw new HubProtocolError("denied");
        return p.credential;
      } catch { throw new HubProtocolError("denied"); }
    },
  };
}
