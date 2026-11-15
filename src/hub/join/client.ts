/** Fleet backchannel. Discovery uses browser HTTPS trust; secret-bearing requests use the existing pinned member agent. */
import { request, type Agent } from "node:https";
import type { IncomingMessage } from "node:http";
import { HUB_LIMITS } from "../protocol.js";
import * as tls from "node:tls";
import type { LookupFunction } from "node:net";
import type { KeyObject } from "node:crypto";
import { z } from "zod";
import { HubProtocolError, hash, epoch, parseStrictJson, validated } from "../validation.js";
import { hubOrigin, pinnedHubAgent, HubTlsIdentityError, verifyHubCertificate } from "../tls.js";
import { companyIdentityDigest, joinIdentitySchema, signJoinProof, validateJoinBinding, type JoinBinding, type JoinPurpose } from "./protocol.js";
import { companyDescriptorSchema, verifyCompanyDescriptor } from "./descriptor.js";
import { CompanyIdentityChanged } from "./trust.js";
import { pilotCertificateAgent, presentedPilotCertificate } from "./certificate.js";
const metadataSchema = z.strictObject({ v: z.literal(1), hub: joinIdentitySchema, identityDigest: hash,
  certificatePem: z.string().max(16 * 1024), features: z.array(z.string().max(64)).max(16) });
export type CompanyJoinMetadata = z.infer<typeof metadataSchema> & { name?: string; descriptor?: z.infer<typeof companyDescriptorSchema> };
/** M-2921 / S1.1: the display-only extras a Hub sends when asked (X-AgEnD-Join-Display: 1); an older Hub sends none. */
const displayMetadataSchema = metadataSchema.extend({ name: z.string().max(200).optional() });
/** M-2901 (#3429): asked with X-AgEnD-Join-Descriptor: the Hub's issuer-signed descriptor (an older Hub sends none). */
const descriptorField = { descriptor: companyDescriptorSchema.optional() };
/**
 * M-2921 (the Fleet's probe): why the Hub could not be read, for the person's message — keeping the code a caller saw
 * before ("unavailable", or "invalid" for a body that is not a Hub's), so start/retry behave as they did.
 */
export class CompanyJoinReachError extends HubProtocolError {
  constructor(readonly kind: "unreachable" | "certificate" | "not-hub", code: "unavailable" | "invalid" = "unavailable") { super(code); }
}
const CERT_ERRORS = new Set(["ERR_AGEND_PILOT_CERTIFICATE", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_UNTRUSTED", "CERT_REVOKED", "HOSTNAME_MISMATCH"]);
export class CompanyJoinRemoteError extends Error {
  constructor(readonly code: string) { super("Hub join refused"); }
}
/** Per-request OS and configured roots, with no process/global trust-store mutation. Node <22.15 retains its default roots. */
function browserRoots(): string[] | undefined {
  return typeof tls.getCACertificates === "function" ? [...tls.getCACertificates("default"), ...tls.getCACertificates("system")] : undefined;
}
export class CompanyJoinClient {
  constructor(private readonly options: { ca?: tls.SecureContextOptions["ca"]; lookup?: LookupFunction; now?(): number } = {}) {}
  private async json(origin: string, path: string, body: unknown | undefined, current: () => boolean, agent?: Agent, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    hubOrigin(origin); if (!current()) throw new HubProtocolError("stale");
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    if (bytes !== undefined && Buffer.byteLength(bytes) > 24 * 1024) throw new HubProtocolError("invalid");
    return new Promise((resolve, reject) => {
      let settled = false, req: ReturnType<typeof request> | undefined, response: IncomingMessage | undefined;
      let deadline: NodeJS.Timeout | undefined;
      const finish = (error?: unknown, value?: unknown) => {
        if (settled) return; settled = true; clearTimeout(deadline);
        if (error !== undefined) reject(error); else resolve(value);
      };
      const fail = (error: unknown) => {
        if (settled) return; finish(error); response?.destroy(); req?.destroy();
      };
      // Socket inactivity does not bound DNS, connect, or a response that keeps trickling bytes.
      deadline = setTimeout(() => fail(new CompanyJoinReachError("unreachable")), HUB_LIMITS.rpcTimeout);
      deadline.unref();
      try {
        req = request(origin + path, { method: bytes === undefined ? "GET" : "POST", agent: agent ?? false,
          ...(agent ? {} : { ca: this.options.ca ?? browserRoots() }), minVersion: "TLSv1.2", lookup: this.options.lookup,
          headers: { Accept: "application/json", ...extraHeaders, ...(bytes === undefined ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bytes) }) } }, res => {
          response = res;
          const chunks: Buffer[] = []; let length = 0;
          if (!current()) return fail(new HubProtocolError("stale"));
          // Never follow redirects (including to a different origin), accept cookies, or treat HTML as a machine result.
          if ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400 || res.headers["set-cookie"] !== undefined
            || res.headers["content-encoding"] !== undefined || !/^application\/json(?:;|$)/i.test(String(res.headers["content-type"] ?? "")))
            return fail(new CompanyJoinReachError("not-hub"));
          res.on("data", part => {
            if (settled) return;
            if (!current()) return fail(new HubProtocolError("stale"));
            length += part.length; if (length > 48 * 1024) return fail(new HubProtocolError("unavailable")); chunks.push(Buffer.from(part));
          });
          res.on("error", () => fail(new HubProtocolError("unavailable")));
          res.on("end", () => {
            if (settled) return;
            try {
              if (!current()) throw new HubProtocolError("stale");
              const value = parseStrictJson(Buffer.concat(chunks), 48 * 1024);
              if (res.statusCode !== 200) {
                const parsed = z.strictObject({ code: z.enum(["denied", "invalid", "stale", "conflict", "expired", "revoked", "not-found", "backpressure", "limit-reached", "incompatible", "unavailable", "uncertain"]) }).safeParse(value);
                if (!parsed.success) throw new CompanyJoinReachError("not-hub", "invalid");
                throw new CompanyJoinRemoteError(parsed.data.code);
              }
              finish(undefined, value);
            } catch (error) { fail(error); }
          });
        });
        req.setTimeout(HUB_LIMITS.rpcTimeout, () => fail(new CompanyJoinReachError("unreachable")));
        req.on("error", error => fail(error instanceof HubTlsIdentityError ? new CompanyIdentityChanged()
          : new CompanyJoinReachError(CERT_ERRORS.has(String((error as NodeJS.ErrnoException).code)) ? "certificate" : "unreachable")));
        if (!current()) { fail(new HubProtocolError("stale")); return; }
        req.end(bytes);
      } catch (error) { fail(error); }
    });
  }

  /** `display` (M-2921 / S1.1): ask for the display-only extras (`name`); a Hub that predates them answers without. */
  async discover(origin: string, current: () => boolean, options: { display?: boolean; descriptor?: boolean; certificateFingerprint?: string } = {}): Promise<CompanyJoinMetadata> {
    const canonical = hubOrigin(origin);
    if (canonical !== origin) throw new HubProtocolError("invalid");
    const agent = options.certificateFingerprint === undefined ? undefined
      : pilotCertificateAgent(origin, options.certificateFingerprint, current, this.options.lookup, this.options.now);
    let raw: unknown;
    try { raw = await this.json(origin, "/hub/v1/join/metadata", undefined, current, agent,
      { ...(options.display ? { "X-AgEnD-Join-Display": "1" } : {}), ...(options.descriptor ? { "X-AgEnD-Join-Descriptor": "1" } : {}) }); }
    finally { agent?.destroy(); }
    const base = options.display ? displayMetadataSchema : metadataSchema;
    const parsed = (options.descriptor ? base.extend(descriptorField) : base).safeParse(raw);
    if (!parsed.success) throw new CompanyJoinReachError("not-hub", "invalid");            // JSON, but not a Hub's metadata
    const value: CompanyJoinMetadata = parsed.data;
    if (value.hub.webOrigin !== origin || companyIdentityDigest(value.hub) !== value.identityDigest) throw new CompanyIdentityChanged();
    // M-2901 (#3429): a descriptor, when sent, must verify and sign exactly the identity this answer names; else it is absent.
    if (value.descriptor) {
      try { verifyCompanyDescriptor(value.descriptor); } catch { throw new CompanyIdentityChanged(); }
      if (value.descriptor.fingerprint !== value.identityDigest) throw new CompanyIdentityChanged();
    }
    verifyHubCertificate(value.certificatePem, value.hub.memberOrigin, value.hub.spkiSha256, this.options.now?.() ?? Date.now());
    if (!current()) throw new HubProtocolError("stale");
    if (!value.features.includes("company-join-v1")) throw new CompanyJoinRemoteError("incompatible");
    return value;
  }
  inspectCertificate(origin: string, current: () => boolean) {
    return presentedPilotCertificate(origin, current, this.options.lookup, this.options.now);
  }
  /** `display` (M-2921 / S1.3): ask the Hub for its display-only extras in this answer (redeem: ownerLabel, hubName). */
  async command(binding: JoinBinding, purpose: JoinPurpose, payload: unknown, key: KeyObject, current: () => boolean, options: { display?: boolean } = {}): Promise<unknown> {
    validateJoinBinding(binding); if (!current()) throw new HubProtocolError("stale");
    const agent = pinnedHubAgent(binding.hub, current);
    try {
      const challenge = validated(z.strictObject({ nonce: hash, expiresAt: epoch }), await this.json(binding.hub.memberOrigin,
        "/hub/v1/join/challenge", { binding, purpose }, current, agent));
      const now = this.options.now?.() ?? Date.now();
      if (challenge.expiresAt <= now || challenge.expiresAt - now > 30_000 || !current()) throw new HubProtocolError("stale");
      const proof = signJoinProof(binding, purpose, challenge.nonce, challenge.expiresAt, payload, key);
      return await this.json(binding.hub.memberOrigin, `/hub/v1/join/${purpose}`, { binding, payload, proof }, current, agent, options.display ? { "X-AgEnD-Join-Display": "1" } : {});
    } finally { agent.destroy(); }
  }
}
