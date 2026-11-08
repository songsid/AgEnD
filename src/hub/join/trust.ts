/** A failed/cancelled join does not forget TOFU. A changed established identity never silently pins again. */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { companyIdentityDigest, joinIdentitySchema, type JoinIdentity } from "./protocol.js";
import { sha256 } from "../identity.js";
import { hash, validated, parseStrictJson, HubProtocolError } from "../validation.js";
import { ensurePrivateDirectory, readPrivateFile } from "../private-files.js";
import { createJoinPrivate } from "./private.js";
import { hubOrigin } from "../tls.js";

export class CompanyIdentityChanged extends HubProtocolError { constructor() { super("denied"); } }
const trustSchema = z.strictObject({ v: z.literal(1), hub: joinIdentitySchema, fingerprint: hash });
export class CompanyTrustStore {
  constructor(private readonly home: string) {}
  path(webOrigin: string): string { return `hub-member/company-trust/${sha256(hubOrigin(webOrigin))}.json`; }
  checkAndPin(hub: JoinIdentity, expected: string | null, existing: JoinIdentity | null, current: () => boolean): "known" | "first-use" | "company-link" {
    if (!current()) throw new HubProtocolError("stale");
    const fingerprint = companyIdentityDigest(hub), suffix = this.path(hub.webOrigin);
    if (expected !== null && validated(hash, expected) !== fingerprint) throw new CompanyIdentityChanged();
    if (existing && existing.webOrigin === hub.webOrigin && companyIdentityDigest(existing) !== fingerprint) throw new CompanyIdentityChanged();
    ensurePrivateDirectory(this.home, "hub-member/company-trust");
    let present = false;
    try { lstatSync(join(this.home, suffix)); present = true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (present) {
      const previous = validated(trustSchema, parseStrictJson(readPrivateFile(this.home, suffix, 8192)));
      if (previous.hub.webOrigin !== hub.webOrigin || previous.fingerprint !== companyIdentityDigest(previous.hub)
        || previous.fingerprint !== fingerprint) throw new CompanyIdentityChanged();
      if (!current()) throw new HubProtocolError("stale");
      return expected ? "company-link" : "known";
    }
    if (!current()) throw new HubProtocolError("stale");
    createJoinPrivate(this.home, suffix, JSON.stringify({ v: 1, hub, fingerprint }));
    if (!current()) throw new HubProtocolError("stale");
    return expected ? "company-link" : existing ? "known" : "first-use";
  }
}
