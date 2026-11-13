/** A failed/cancelled join does not forget TOFU. A changed established identity never silently pins again. */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { companyIdentityDigest, joinIdentitySchema, type JoinIdentity } from "./protocol.js";
import { sha256 } from "../identity.js";
import { hash, validated, parseStrictJson, HubProtocolError } from "../validation.js";
import { ensurePrivateDirectory, readPrivateFile } from "../private-files.js";
import { createJoinPrivate, syncJoinPrivate, writeJoinPrivate } from "./private.js";
import { hubOrigin } from "../tls.js";

export class CompanyIdentityChanged extends HubProtocolError { constructor() { super("denied"); } }
const trustSchema = z.strictObject({ v: z.literal(1), hub: joinIdentitySchema, fingerprint: hash });
export class CompanyTrustStore {
  constructor(private readonly home: string) {}
  path(webOrigin: string): string { return `hub-member/company-trust/${sha256(hubOrigin(webOrigin))}.json`; }
  /**
   * M-2921 (the Fleet's probe): how this Hub identity compares with what is saved — READ ONLY: it never creates the
   * trust directory or a pin (spec A-L4: a probe leaves no trace). "known": it matches the saved pin (or the existing
   * binding of the same origin); "new": nothing saved for that origin; "changed": it differs from either.
   */
  peek(hub: JoinIdentity, existing: JoinIdentity | null): "new" | "known" | "changed" {
    const fingerprint = companyIdentityDigest(hub), suffix = this.path(hub.webOrigin);
    const sameOrigin = !!existing && existing.webOrigin === hub.webOrigin;
    if (sameOrigin && companyIdentityDigest(existing!) !== fingerprint) return "changed";
    let present = false;
    try { lstatSync(join(this.home, suffix)); present = true; } catch { /* nothing saved */ }
    if (!present) return sameOrigin ? "known" : "new";
    try {
      const previous = validated(trustSchema, parseStrictJson(readPrivateFile(this.home, suffix, 8192)));
      return previous.hub.webOrigin === hub.webOrigin && previous.fingerprint === companyIdentityDigest(previous.hub) && previous.fingerprint === fingerprint ? "known" : "changed";
    } catch { return "changed"; }
  }
  /** Only the separate confirmed local repair calls this; ordinary Start/Retry always checkAndPin. */
  repair(hub: JoinIdentity, expected: string | null, current: () => boolean): void {
    const fingerprint = companyIdentityDigest(hub), suffix = this.path(hub.webOrigin);
    if (!current() || expected === null || validated(hash, expected) !== fingerprint) throw new CompanyIdentityChanged();
    const previous = readPrivateFile(this.home, suffix, 8192), parsed = validated(trustSchema, parseStrictJson(previous));
    if (parsed.hub.webOrigin !== hub.webOrigin || parsed.fingerprint !== companyIdentityDigest(parsed.hub)) throw new CompanyIdentityChanged();
    const unchanged = () => current() && readPrivateFile(this.home, suffix, 8192) === previous;
    writeJoinPrivate(this.home, suffix, JSON.stringify({ v: 1, hub, fingerprint }), unchanged);
  }
  /** M-2901 (#3429): the exact bytes of a web address's pin, or null when there is none (read only). */
  pinBytes(webOrigin: string): string | null {
    const suffix = this.path(webOrigin);
    try { lstatSync(join(this.home, suffix)); } catch { return null; }
    return readPrivateFile(this.home, suffix, 8192);
  }
  /**
   * M-2901 (#3429), Reconnect only: the Hub's member address moved, proven by the caller (its issuer-signed descriptor,
   * anchored to the identity pinned before the binding retired; only memberOrigin differs). Replace exactly `previous` —
   * the pin read then, which must be `from`'s own — with `to`, for the same web address. A pin changed meanwhile (another
   * repair, a join), a different web address or a stale reconnect writes nothing.
   */
  reanchor(from: JoinIdentity, to: JoinIdentity, previous: string, current: () => boolean): void {
    if (from.webOrigin !== to.webOrigin) throw new CompanyIdentityChanged();
    const suffix = this.path(to.webOrigin);
    let parsed: z.infer<typeof trustSchema>;
    try { parsed = validated(trustSchema, parseStrictJson(previous)); } catch { throw new CompanyIdentityChanged(); }
    if (parsed.hub.webOrigin !== from.webOrigin || parsed.fingerprint !== companyIdentityDigest(parsed.hub) || parsed.fingerprint !== companyIdentityDigest(from))
      throw new CompanyIdentityChanged();
    const unchanged = () => current() && this.pinBytes(to.webOrigin) === previous;
    if (!unchanged()) throw new CompanyIdentityChanged();
    writeJoinPrivate(this.home, suffix, JSON.stringify({ v: 1, hub: to, fingerprint: companyIdentityDigest(to) }), unchanged);
  }
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
      syncJoinPrivate(this.home, suffix); // A prior failed flush may have left this exact file visible but not durable.
      if (!current()) throw new HubProtocolError("stale");
      return expected ? "company-link" : "known";
    }
    if (!current()) throw new HubProtocolError("stale");
    createJoinPrivate(this.home, suffix, JSON.stringify({ v: 1, hub, fingerprint }));
    if (!current()) throw new HubProtocolError("stale");
    return expected ? "company-link" : existing ? "known" : "first-use";
  }
}
