/** Explicit AD trust bootstrap for the existing settings controller. No writer or independent directory budget. */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { canonicalArguments } from "./identity.js";
import { resolveDirectoryConfig } from "./directory/config.js";
import { inspectDirectoryCertificate, fetchDirectoryCa, sameDirectoryFingerprint, type DirectoryCertificateProbe } from "./init/directory-certificate.js";
import { HubProtocolError, validated } from "./validation.js";
import type { HubDirectoryProofContext, HubDirectoryProofSource } from "./settings-directory-proof.js";
import type { PersonKey } from "./types.js";

const text = (max: number) => z.string().min(1).max(max);
const inspectRequest = z.strictObject({ url: text(2048) });
const fetchRequest = z.strictObject({ ref: z.string().regex(/^[A-Za-z0-9_-]{32}$/), fingerprint: text(95),
  bindDn: text(1024).optional(), bindPassword: text(1024).optional() }).refine(r => (r.bindDn === undefined) === (r.bindPassword === undefined));
const actorKey = ({ requestId: _requestId, ...actor }: HubDirectoryProofContext["actor"]) => canonicalArguments(actor);
const TTL = 300_000, MAX_PROBES = 32;
export class HubDirectorySettingsCaError extends Error {
  constructor(readonly code: "ca-invalid" | "ca-trust" | "ca-auth-required" | "ca-unavailable" | "ca-unsupported") { super(code); }
}
interface Probe {
  actor: string; source: HubDirectoryProofSource; probe: DirectoryCertificateProbe; createdAt: number; expiresAt: number;
}
export interface HubDirectorySettingsCaDeps {
  /** Acquires the SAME configured-admin/D3 source checks as the other settings operations. */
  source(context: HubDirectoryProofContext): HubDirectoryProofSource;
  withDirectoryRead<T>(person: PersonKey, work: () => Promise<T>): Promise<T>;
  now?(): number;
  /** Inert tests only; production uses the existing pinned TLS/AIA implementation. */
  inspectCertificate?: typeof inspectDirectoryCertificate;
  fetchCa?: typeof fetchDirectoryCa;
}
export function createHubDirectorySettingsCa(options: HubDirectorySettingsCaDeps) {
  const deps = { ...options }, now = deps.now ?? Date.now, inspect = deps.inspectCertificate ?? inspectDirectoryCertificate, fetch = deps.fetchCa ?? fetchDirectoryCa;
  const probes = new Map<string, Probe>();
  let stopped = false, preparing = 0;
  const time = () => { const t = now(); if (!Number.isSafeInteger(t) || t < 0) throw new HubProtocolError("revoked"); return t; };
  const context = (input: HubDirectoryProofContext) => ({ actor: structuredClone(input.actor), current: input.current, signal: input.signal });
  const check = (record: Pick<Probe, "actor" | "source" | "createdAt" | "expiresAt">, ctx: HubDirectoryProofContext) => {
    const before = time();
    if (stopped || ctx.signal?.aborted || ctx.current() !== true || actorKey(ctx.actor) !== record.actor || !record.source.current()) throw new HubProtocolError("revoked");
    const source = deps.source(ctx);
    if (!source.current() || source.image !== record.source.image || source.epoch !== record.source.epoch || source.directory !== record.source.directory)
      throw new HubProtocolError("revoked");
    // Material/authority callbacks may advance the clock; the final sample follows them.
    const t = time(); if (before < record.createdAt || before >= record.expiresAt || t < record.createdAt || t >= record.expiresAt) throw new HubProtocolError("revoked");
  };
  const admitted = async <T>(record: Pick<Probe, "actor" | "source" | "createdAt" | "expiresAt">, ctx: HubDirectoryProofContext, work: () => Promise<T>) => {
    check(record, ctx);
    try {
      const result = await deps.withDirectoryRead(record.source.administrator, async () => { check(record, ctx); return work(); });
      check(record, ctx); return result;
    } catch (error) {
      check(record, ctx);
      if (error instanceof HubProtocolError || error instanceof HubDirectorySettingsCaError) throw error;
      // Only the bootstrap's fixed error vocabulary crosses the private route; never LDAP text or secrets.
      const code = error instanceof Error ? error.message : "";
      const bounded: Readonly<Record<string, HubDirectorySettingsCaError["code"]>> = {
        directory_ca_invalid: "ca-invalid", directory_ca_pin: "ca-trust", directory_ca_auth_required: "ca-auth-required",
        directory_ca_expired: "ca-trust", directory_ca_hostname: "ca-trust", directory_ca_unsupported: "ca-unsupported", directory_ca_aia: "ca-unsupported",
      };
      throw new HubDirectorySettingsCaError(Object.hasOwn(bounded, code) ? bounded[code]! : "ca-unavailable");
    }
  };
  return {
    inspect(raw: unknown, input: HubDirectoryProofContext) {
      const request = validated(inspectRequest, raw), ctx = context(input), original = deps.source(ctx), createdAt = time();
      const source = { ...original, config: structuredClone(original.config), administrator: { ...original.administrator },
        groups: structuredClone(original.groups), current: original.current.bind(original) };
      let url: string;
      try { url = resolveDirectoryConfig({ ...source.config, url: request.url }).url; } catch { throw new HubProtocolError("invalid"); }
      const record = { actor: actorKey(ctx.actor), source, createdAt, expiresAt: createdAt + TTL };
      check(record, ctx);
      for (const [ref, old] of probes) if (createdAt >= old.expiresAt || createdAt < old.createdAt || old.source.image !== source.image
        || old.source.epoch !== source.epoch || old.source.directory !== source.directory) probes.delete(ref);
      if (!Number.isSafeInteger(record.expiresAt)) throw new HubProtocolError("revoked");
      if (probes.size + preparing >= MAX_PROBES) throw new HubProtocolError("backpressure");
      preparing++;
      return admitted(record, ctx, async () => {
        const probe = structuredClone(await inspect(url)); check(record, ctx);
        if (probe.url !== url) throw new HubProtocolError("unavailable");
        return probe;
      }).then(probe => {
        check(record, ctx);
        const ref = randomBytes(24).toString("base64url"); probes.set(ref, { ...record, probe });
        return { ref, expiresAt: record.expiresAt, server: url, certificate: structuredClone(probe.certificate) };
      }).finally(() => { preparing--; });
    },
    fetch(raw: unknown, input: HubDirectoryProofContext) {
      const request = validated(fetchRequest, raw), ctx = context(input), record = probes.get(request.ref);
      if (!record) throw new HubProtocolError("not-found");
      check(record, ctx); probes.delete(request.ref); // One use before a credential-bearing await; failed/ambiguous fetches cannot replay.
      if (!sameDirectoryFingerprint(record.probe.certificate.fingerprint256, request.fingerprint)) throw new HubDirectorySettingsCaError("ca-trust");
      const credentials = request.bindDn === undefined ? undefined : { bindDn: request.bindDn, password: request.bindPassword! };
      return admitted(record, ctx, async () => {
        const bundle = await fetch(structuredClone(record.probe), request.fingerprint, credentials); check(record, ctx);
        return { server: record.probe.url, leafFingerprint: record.probe.certificate.fingerprint256,
          caPem: bundle.pem, certificates: structuredClone(bundle.certificates) };
      });
    },
    close() { stopped = true; probes.clear(); },
  };
}
