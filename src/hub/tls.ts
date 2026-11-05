import { Agent as HttpsAgent } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { generateKeyPairSync, randomUUID, X509Certificate, createPublicKey, createPrivateKey } from "node:crypto";
import { execFile } from "../child-process.js";
import { promisify } from "node:util";
import { isIP } from "node:net";
import { existsSync, mkdirSync, openSync, writeFileSync, closeSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ensurePrivateDirectory, privatePath, readPrivateFile } from "./private-files.js";
import { hash, uuid, validated, parseStrictJson } from "./validation.js";
import { issuerKeyId, sha256 } from "./identity.js";
export interface HubProvisionedIdentity { hubId: string; spkiSha256: string; issuerKeyId: string; issuerPublicKey: string }
const identitySchema = z.strictObject({ v: z.literal(1), hubId: uuid, memberOrigin: z.string(), spkiSha256: hash, issuerKeyId: hash, issuerPublicKey: z.string().max(2048) });
export function hubOrigin(input: string, protocol: "https:" | "wss:" = "https:"): string {
  const u = new URL(input);
  if (u.protocol !== protocol || u.username || u.password || u.pathname !== "/" || u.search || u.hash || u.origin === "null" || u.hostname.endsWith(".")) throw Error("Invalid Hub origin");
  return u.origin;
}
function host(origin: string): string { return new URL(hubOrigin(origin)).hostname.replace(/^\[|\]$/g, ""); }
function privateWrite(path: string, value: string): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, value, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
}
export function verifyHubCertificate(pem: string | Buffer, origin: string, pin: string | undefined, now = Date.now()): X509Certificate {
  const cert = new X509Certificate(pem), name = host(origin), digest = sha256(cert.publicKey.export({ type: "spki", format: "der" }));
  if (now < Date.parse(cert.validFrom) || now >= Date.parse(cert.validTo)
    || !(isIP(name) ? cert.checkIP(name) : cert.checkHost(name, { subject: "never", wildcards: false }))
    || pin !== undefined && digest !== validated(hash, pin)) throw Error("Hub TLS identity differs");
  return cert;
}
/** Fixed executable and argv; no caller-selected command, shell, trust-store edit or overwrite. */
export async function provisionHubIdentity(input: { home: string; memberOrigin: string }): Promise<HubProvisionedIdentity> {
  const origin = hubOrigin(input.memberOrigin), name = host(origin);
  ensurePrivateDirectory(input.home, "hub");
  const keys = join(input.home, "hub/keys");
  if (existsSync(keys)) throw Error("Hub identity already exists");
  mkdirSync(keys, { mode: 0o700 }); privatePath(input.home, "hub/keys", true);
  const tls = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), issuer = generateKeyPairSync("ed25519");
  privateWrite(join(keys, "tls-key.pem"), tls.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  privateWrite(join(keys, "issuer-key.pem"), issuer.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  const issuerPublicKey = issuer.publicKey.export({ type: "spki", format: "pem" }).toString();
  privateWrite(join(keys, "issuer-public.pem"), issuerPublicKey);
  // openssl writes only inside our new private directory; no key bytes are command-line arguments or logs.
  const certFile = join(keys, "tls-cert.pem");
  privateWrite(certFile, "");
  await promisify(execFile)("/usr/bin/openssl", ["req", "-new", "-x509", "-sha256", "-days", "365", "-key", join(keys, "tls-key.pem"), "-out", certFile,
    "-subj", "/CN=AgEnD Hub", "-addext", `subjectAltName=${isIP(name) ? "IP" : "DNS"}:${name}`], { timeout: 10_000, maxBuffer: 16 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C" } })
    .catch(() => { throw Error("Hub certificate provisioning failed"); });
  const cert = verifyHubCertificate(readPrivateFile(input.home, "hub/keys/tls-cert.pem"), origin, undefined);
  const metadata = { v: 1 as const, hubId: randomUUID(), memberOrigin: origin,
    spkiSha256: sha256(cert.publicKey.export({ type: "spki", format: "der" })), issuerKeyId: issuerKeyId(issuer.publicKey), issuerPublicKey };
  privateWrite(join(keys, "identity.json"), JSON.stringify(metadata));
  return readHubIdentity({ home: input.home, memberOrigin: origin });
}
/** Inspection may use the stored origin; all admission/mount callers pass their expected origin explicitly. */
export function readHubIdentity(input: { home: string; memberOrigin?: string }): HubProvisionedIdentity {
  const metadata = validated(identitySchema, parseStrictJson(readPrivateFile(input.home, "hub/keys/identity.json")));
  const origin = hubOrigin(input.memberOrigin ?? metadata.memberOrigin);
  const cert = verifyHubCertificate(readPrivateFile(input.home, "hub/keys/tls-cert.pem"), origin, metadata.spkiSha256);
  const issuer = createPublicKey(readPrivateFile(input.home, "hub/keys/issuer-public.pem"));
  const privateIssuer = createPrivateKey(readPrivateFile(input.home, "hub/keys/issuer-key.pem"));
  const privateTls = createPrivateKey(readPrivateFile(input.home, "hub/keys/tls-key.pem"));
  if (metadata.memberOrigin !== origin || issuer.asymmetricKeyType !== "ed25519" || privateIssuer.asymmetricKeyType !== "ed25519"
    || issuer.export({ type: "spki", format: "pem" }).toString() !== metadata.issuerPublicKey || issuerKeyId(issuer) !== metadata.issuerKeyId
    || issuerKeyId(privateIssuer) !== metadata.issuerKeyId || sha256(createPublicKey(privateTls).export({ type: "spki", format: "der" })) !== sha256(cert.publicKey.export({ type: "spki", format: "der" }))) throw Error("Hub identity files differ");
  return { hubId: metadata.hubId, spkiSha256: metadata.spkiSha256, issuerKeyId: metadata.issuerKeyId, issuerPublicKey: metadata.issuerPublicKey };
}

/** Missing means wholly unprovisioned; a partial, untrusted or changed identity is an error, never a fresh start. */
export function readHubIdentityIfPresent(home: string): HubProvisionedIdentity | undefined {
  try { privatePath(home, "hub/keys", true); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  return readHubIdentity({ home });
}

/** SPKI is the trust anchor. Per-socket verification happens before HTTP can write any credential bytes. */
export function pinnedHubAgent(binding: { memberOrigin: string; spkiSha256: string }, current: () => boolean = () => true): import("node:https").Agent {
  const origin = hubOrigin(binding.memberOrigin), hostname = host(origin), pin = validated(hash, binding.spkiSha256);
  const agent = new HttpsAgent({ keepAlive: false });
  agent.createConnection = (options, callback) => {
    let finished = false;
    const finish = (error: Error | null, socket: import("node:tls").TLSSocket) => {
      if (finished) return; finished = true; if (error) socket?.destroy(); else socket?.setTimeout(0); callback?.(error, socket);
    };
    // Deliberately no process/global TLS change: only this owned socket uses manual pinned-key authentication.
    const socket = tlsConnect({ host: hostname, port: Number(new URL(origin).port || 443),
      servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: false, minVersion: "TLSv1.2" }, () => {
      try { if (!current()) throw Error(); verifyHubCertificate(socket.getPeerCertificate().raw, origin, pin); finish(null, socket); }
      catch { finish(new HubTlsIdentityError(), socket); }
    });
    socket.setTimeout(5_000, () => { finish(Error("Hub TLS connection unavailable"), socket); });
    socket.once("error", () => finish(Error("Hub TLS connection unavailable"), socket));
    return undefined as unknown as import("node:stream").Duplex; // Agent receives the socket only through the verified callback.
  };
  return agent;
}
export class HubTlsIdentityError extends Error { constructor() { super("Hub TLS identity differs"); } }
