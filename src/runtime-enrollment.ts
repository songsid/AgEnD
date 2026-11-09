/**
 * server side of "join with a one-time token from the install command".
 *
 * Two small pieces live here, both used only by the AgEnD host (the Windows Runtime has its own checks in runtime-client.ts):
 *  - the server's ENROLLMENT IDENTITY: an Ed25519 key kept in the AgEnD data folder. Its SHA-256 fingerprint is what an install command pins, and the
 *    server signs a fresh nonce with it before the Runtime sends the token (like `kubeadm join --discovery-token-ca-cert-hash`). It is not a TLS
 *    certificate and replaces nothing: HTTPS validation still applies. It adds "this is the AgEnD the page was talking to" on top, so a token is never
 *    sent to a different server that happens to answer at the same address (a reused tailnet name, a wrong network, a typo that resolves).
 *  - the TOKEN: 256 random bits, shown once, kept only as a SHA-256 hash.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual, type KeyObject } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { RUNTIME_ENROLL_TOKEN_PATTERN, runtimeServerFingerprint } from "./runtime-protocol.js";

export const ENROLL_IDENTITY_FILE = "runtime-server-identity.json";
/** A token is good for 15 minutes and one use: long enough to move a command to another computer, short enough that a leaked one is mostly dead. */
export const ENROLL_TTL_MS = 15 * 60_000;
export const generateEnrollToken = (): string => `agend_enroll_${randomBytes(32).toString("base64url")}`;
export const hashEnrollToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export function isEnrollToken(value: unknown): value is string { return typeof value === "string" && RUNTIME_ENROLL_TOKEN_PATTERN.test(value); }
/** Constant-time comparison of a presented token with a stored hash. */
export function enrollTokenMatches(token: string, tokenHash: string): boolean {
  return /^[a-f0-9]{64}$/.test(tokenHash) && timingSafeEqual(Buffer.from(hashEnrollToken(token), "hex"), Buffer.from(tokenHash, "hex"));
}

export interface RuntimeServerIdentity {
  /** SHA-256 of the SPKI public key, lower-case hex. */
  readonly fingerprint: string;
  /** SPKI DER, base64url. */
  readonly publicKey: string;
  /** Detached Ed25519 signature, base64url. */
  signature(message: Uint8Array): string;
}
function describe(privateKey: KeyObject): RuntimeServerIdentity {
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return { fingerprint: runtimeServerFingerprint(der), publicKey: der.toString("base64url"), signature: message => sign(null, message, privateKey).toString("base64url") };
}
/**
 * Loads this AgEnD's enrollment identity, creating it on first use. The file is private (0600), holds only this key, and is never sent anywhere.
 * An unreadable or odd file is an error, never silently replaced: replacing it would change the fingerprint under every command already handed out.
 */
export function loadRuntimeServerIdentity(home: string): RuntimeServerIdentity {
  const path = join(home, ENROLL_IDENTITY_FILE);
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw Error("Invalid runtime server identity file");
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as { version?: unknown }).version !== 1 || typeof (value as { privateKey?: unknown }).privateKey !== "string") throw Error("Malformed runtime server identity file");
    const key = createPrivateKey((value as { privateKey: string }).privateKey);
    if (key.asymmetricKeyType !== "ed25519") throw Error("Malformed runtime server identity file");
    return describe(key);
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  atomicWriteFileSync(path, JSON.stringify({ version: 1, createdAt: new Date().toISOString(), privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }, null, 2) + "\n", { mode: 0o600 });
  return describe(privateKey);
}
