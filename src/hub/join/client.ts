/** Fleet backchannel. Discovery uses browser HTTPS trust; secret-bearing requests use the existing pinned member agent. */
import { request, type Agent } from "node:https";
import * as tls from "node:tls";
import type { LookupFunction } from "node:net";
import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { HubProtocolError, hash, epoch, parseStrictJson, validated } from "../validation.js";
import { hubOrigin, pinnedHubAgent, HubTlsIdentityError, verifyHubCertificate } from "../tls.js";
import { companyIdentityDigest, joinIdentitySchema, signJoinProof, validateJoinBinding, type JoinBinding, type JoinPurpose } from "./protocol.js";
import { CompanyIdentityChanged } from "./trust.js";
const metadataSchema = z.strictObject({ v: z.literal(1), hub: joinIdentitySchema, identityDigest: hash,
  certificatePem: z.string().max(16 * 1024), features: z.array(z.string().max(64)).max(16) });
export type CompanyJoinMetadata = z.infer<typeof metadataSchema>;
export class CompanyJoinRemoteError extends Error {
  constructor(readonly code: string) { super("Hub join refused"); }
}
/** Per-request OS and configured roots, with no process/global trust-store mutation. Node <22.15 retains its default roots. */
function browserRoots(): string[] | undefined {
  return typeof tls.getCACertificates === "function" ? [...tls.getCACertificates("default"), ...tls.getCACertificates("system")] : undefined;
}
export class CompanyJoinClient {
  constructor(private readonly options: { ca?: tls.SecureContextOptions["ca"]; lookup?: LookupFunction; now?(): number } = {}) {}
  private async json(origin: string, path: string, body: unknown | undefined, current: () => boolean, agent?: Agent): Promise<unknown> {
    hubOrigin(origin); if (!current()) throw new HubProtocolError("stale");
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    if (bytes !== undefined && Buffer.byteLength(bytes) > 24 * 1024) throw new HubProtocolError("invalid");
    return new Promise((resolve, reject) => {
      const req = request(origin + path, { method: bytes === undefined ? "GET" : "POST", agent: agent ?? false,
        ...(agent ? {} : { ca: this.options.ca ?? browserRoots() }), minVersion: "TLSv1.2", lookup: this.options.lookup,
        headers: { Accept: "application/json", ...(bytes === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bytes) }) } }, res => {
        const chunks: Buffer[] = []; let length = 0;
        const fail = (error: unknown) => { res.destroy(); req.destroy(); reject(error); };
        if (!current()) return fail(new HubProtocolError("stale"));
        // Never follow redirects (including to a different origin), accept cookies, or treat HTML as a machine result.
        if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400 || res.headers["set-cookie"] !== undefined
          || res.headers["content-encoding"] !== undefined || !/^application\/json(?:;|$)/i.test(String(res.headers["content-type"] ?? "")))
          return fail(new HubProtocolError("unavailable"));
        res.on("data", part => {
          length += part.length; if (length > 48 * 1024) return fail(new HubProtocolError("unavailable")); chunks.push(Buffer.from(part));
        });
        res.on("error", () => reject(new HubProtocolError("unavailable")));
        res.on("end", () => {
          try {
            if (!current()) throw new HubProtocolError("stale");
            const value = parseStrictJson(Buffer.concat(chunks), 48 * 1024);
            if (res.statusCode !== 200) {
              const parsed = validated(z.strictObject({ code: z.enum(["denied", "invalid", "stale", "conflict", "expired", "revoked", "not-found", "backpressure", "limit-reached", "incompatible", "unavailable", "uncertain"]) }), value);
              throw new CompanyJoinRemoteError(parsed.code);
            }
            resolve(value);
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(5_000, () => req.destroy(new Error("Join request timed out")));
      req.on("error", error => reject(error instanceof HubTlsIdentityError ? new CompanyIdentityChanged() : new HubProtocolError("unavailable")));
      if (!current()) { req.destroy(); reject(new HubProtocolError("stale")); return; }
      req.end(bytes);
    });
  }
  async discover(origin: string, current: () => boolean): Promise<CompanyJoinMetadata> {
    const canonical = hubOrigin(origin);
    if (canonical !== origin) throw new HubProtocolError("invalid");
    const value = validated(metadataSchema, await this.json(origin, "/hub/v1/join/metadata", undefined, current));
    if (value.hub.webOrigin !== origin || companyIdentityDigest(value.hub) !== value.identityDigest) throw new CompanyIdentityChanged();
    verifyHubCertificate(value.certificatePem, value.hub.memberOrigin, value.hub.spkiSha256, this.options.now?.() ?? Date.now());
    if (!current()) throw new HubProtocolError("stale");
    if (!value.features.includes("company-join-v1")) throw new CompanyJoinRemoteError("incompatible");
    return value;
  }
  async command(binding: JoinBinding, purpose: JoinPurpose, payload: unknown, key: KeyObject, current: () => boolean): Promise<unknown> {
    validateJoinBinding(binding); if (!current()) throw new HubProtocolError("stale");
    const agent = pinnedHubAgent(binding.hub, current);
    try {
      const challenge = validated(z.strictObject({ nonce: hash, expiresAt: epoch }), await this.json(binding.hub.memberOrigin,
        "/hub/v1/join/challenge", { binding, purpose }, current, agent));
      const now = this.options.now?.() ?? Date.now();
      if (challenge.expiresAt <= now || challenge.expiresAt - now > 30_000 || !current()) throw new HubProtocolError("stale");
      const proof = signJoinProof(binding, purpose, challenge.nonce, challenge.expiresAt, payload, key);
      return await this.json(binding.hub.memberOrigin, `/hub/v1/join/${purpose}`, { binding, payload, proof }, current, agent);
    } finally { agent.destroy(); }
  }
}
