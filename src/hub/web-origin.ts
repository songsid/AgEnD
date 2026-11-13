/**
 * M-2901 (#3428 follow-up): a connected Fleet learns the Hub's current web address.
 *
 * The Hub host can move its web address (settings-web-address.ts); the member address, its pinned TLS key, the issuer key
 * and every pairing stay the same. A member keeps the web address it paired with in its profile, and three of its own
 * dashboard links are built from it (Settings → Hub's open link, a shared agent's "who may ask", the sidebar Hub switcher).
 *
 * - On a link where both ends list `web-origin-v1`, the Hub's welcome carries one statement, signed with the Hub's issuer
 *   key: {hubId, issuerKeyId, fleetId, memberOrigin, webOrigin, revision}. `revision` is the sealed `hub.webAddress.revision`
 *   (0 for a Hub whose address never changed).
 * - The member verifies it against the issuer key it pinned when it paired, and the address the way a join validates one
 *   (bare https origin, not the member address). It keeps the statement verbatim in `hub-member/<hubId>/web-origin.json`,
 *   beside — never inside — `pairing.json`: the profile's digest is an identity key (link state, retired binding,
 *   company-join settlement), so the profile stays byte-identical.
 * - Every read re-verifies the kept statement; one that does not verify, or names another Hub or Fleet, is ignored and the
 *   profile's address applies. A lower revision never replaces a higher one; the same revision never names two addresses.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import type { z } from "zod";
import { atomicWriteFileSync } from "../atomic-write.js";
import { ensurePrivateDirectory, readPrivateFile } from "./private-files.js";
import { hubOrigin } from "./tls.js";
import { issuerKeyId } from "./identity.js";
import { uuid, validated, parseStrictJson, HubProtocolError } from "./validation.js";
import { webOriginStatementSchema } from "./protocol.js";
import type { HubMemberProfile } from "./profile.js";

export const HUB_WEB_ORIGIN_CAPABILITY = "web-origin-v1";
export { webOriginStatementSchema };
export type HubWebOriginStatement = z.infer<typeof webOriginStatementSchema>;
/** What a statement is bound to: this Hub, its issuer key, the one Fleet the link authenticated, the member address. */
export interface HubWebOriginBinding { hubId: string; issuerKeyId: string; fleetId: string; memberOrigin: string }

function bytes(b: HubWebOriginBinding, s: Omit<HubWebOriginStatement, "signature">): Buffer {
  return Buffer.from(JSON.stringify(["agend-hub-web-origin-v1", s.v, b.hubId, b.issuerKeyId, b.fleetId, b.memberOrigin, s.webOrigin, s.revision]));
}
/** The join's rule for a Hub web address: a bare https origin (no path, credentials or trailing dot), not the member one. */
export function validHubWebOrigin(webOrigin: string, memberOrigin: string): boolean {
  try { return hubOrigin(webOrigin) === webOrigin && hubOrigin(memberOrigin) === memberOrigin && webOrigin !== memberOrigin; } catch { return false; }
}
export function signHubWebOrigin(binding: HubWebOriginBinding, webOrigin: string, revision: number, key: KeyObject): HubWebOriginStatement {
  validated(uuid, binding.hubId); validated(uuid, binding.fleetId);
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519" || issuerKeyId(key) !== binding.issuerKeyId
    || !validHubWebOrigin(webOrigin, binding.memberOrigin)) throw new HubProtocolError("invalid");
  const s = validated(webOriginStatementSchema, { v: 1, webOrigin, revision, signature: "A".repeat(86) });
  return { ...s, signature: sign(null, bytes(binding, s), key).toString("base64url") };
}
/** Throws "denied" unless the statement is this binding's, signed by its issuer key, and names a valid address. */
export function verifyHubWebOrigin(input: unknown, binding: HubWebOriginBinding, issuerPublicKey: KeyObject): HubWebOriginStatement {
  const s = validated(webOriginStatementSchema, input);
  if (issuerPublicKey.type !== "public" || issuerPublicKey.asymmetricKeyType !== "ed25519" || issuerKeyId(issuerPublicKey) !== binding.issuerKeyId
    || !validHubWebOrigin(s.webOrigin, binding.memberOrigin)
    || Buffer.from(s.signature, "base64url").toString("base64url") !== s.signature
    || !verify(null, bytes(binding, s), issuerPublicKey, Buffer.from(s.signature, "base64url"))) throw new HubProtocolError("denied");
  return s;
}
/** A member's binding, from its own pinned profile (never from anything the Hub sends). */
export function memberWebOriginBinding(profile: HubMemberProfile): { binding: HubWebOriginBinding; key: KeyObject } {
  return { binding: { hubId: profile.hub.hubId, issuerKeyId: profile.issuerKeyId, fleetId: profile.fleetId, memberOrigin: profile.hub.memberOrigin },
    key: createPublicKey(profile.hub.issuerPublicKey) };
}

/** The kept statement for one paired Hub. Reads never throw: anything that does not verify is as if absent. */
export class HubMemberWebOriginStore {
  constructor(private readonly home: string, readonly hubId: string) { validated(uuid, hubId); }
  private get suffix(): string { return `hub-member/${this.hubId}/web-origin.json`; }
  /** The verified kept statement for this profile, or null. */
  read(profile: HubMemberProfile): HubWebOriginStatement | null {
    try {
      if (profile.hub.hubId !== this.hubId || !existsSync(join(this.home, this.suffix))) return null;
      const { binding, key } = memberWebOriginBinding(profile);
      return verifyHubWebOrigin(parseStrictJson(readPrivateFile(this.home, this.suffix, 8 * 1024)), binding, key);
    } catch { return null; }
  }
  /** The address this Fleet's links use: the kept statement's when one verifies with a revision above 0, else the profile's. */
  effective(profile: HubMemberProfile): string {
    const s = this.read(profile);
    return s && s.revision > 0 ? s.webOrigin : profile.hub.webOrigin;
  }
  /**
   * Decide what a verified statement changes. "unchanged": nothing to write. "changed": the caller writes it with `save`.
   * Refuses ("stale") a lower revision than the kept one, or the same revision naming another address.
   */
  plan(profile: HubMemberProfile, statement: HubWebOriginStatement): { kind: "unchanged" } | { kind: "changed"; from: string } {
    const kept = this.read(profile), from = this.effective(profile);
    const keptRevision = kept?.revision ?? 0;
    if (statement.revision < keptRevision || statement.revision === keptRevision && statement.webOrigin !== from && (kept || statement.revision === 0))
      throw new HubProtocolError("stale");
    if (statement.webOrigin === from && statement.revision === keptRevision) return { kind: "unchanged" };
    return { kind: "changed", from };
  }
  save(profile: HubMemberProfile, statement: HubWebOriginStatement, current: () => boolean): void {
    const { binding, key } = memberWebOriginBinding(profile);
    const s = verifyHubWebOrigin(statement, binding, key);
    if (!current() || profile.hub.hubId !== this.hubId) throw new HubProtocolError("stale");
    ensurePrivateDirectory(this.home, `hub-member/${this.hubId}`);
    atomicWriteFileSync(join(this.home, this.suffix), JSON.stringify(s), { mode: 0o600, beforeRename: () => { if (!current()) throw new HubProtocolError("stale"); } });
  }
}

/**
 * The member's step for one welcome statement: verify it against the pinned profile, decide it against the kept one, and
 * keep it — each decision recorded in the member's own audit log, the write inside that record's transaction ("updated":
 * nothing is kept without its record). A refusal changes nothing and the link goes on. Returns what was decided.
 */
export function learnHubWebOrigin(deps: {
  home: string; profile: HubMemberProfile; current(): boolean;
  /** Append one audit record in a transaction; `inTransaction` runs inside it, before it commits. */
  record(entry: { action: "web-origin.updated" | "web-origin.refused"; result: "completed" | "denied"; reasonCode: string }, inTransaction: () => void): void;
  log(level: "info" | "warn", message: string, fields: Record<string, unknown>): void;
}, statement: unknown): "updated" | "unchanged" | "refused" {
  const store = new HubMemberWebOriginStore(deps.home, deps.profile.hub.hubId);
  let verified: HubWebOriginStatement, plan: ReturnType<HubMemberWebOriginStore["plan"]>;
  try {
    const { binding, key } = memberWebOriginBinding(deps.profile);
    verified = verifyHubWebOrigin(statement, binding, key);
    plan = store.plan(deps.profile, verified);
  } catch (error) {
    const reason = error instanceof HubProtocolError && error.code === "stale" ? "stale" : "unverified";
    deps.log("warn", "Hub web address statement refused", { reason });
    deps.record({ action: "web-origin.refused", result: "denied", reasonCode: reason }, () => {});
    return "refused";
  }
  if (plan.kind === "unchanged") return "unchanged";
  deps.record({ action: "web-origin.updated", result: "completed", reasonCode: `revision:${verified.revision}` },
    () => store.save(deps.profile, verified, deps.current));
  deps.log("info", "The Hub's web address changed", { from: plan.from, to: verified.webOrigin, revision: verified.revision });
  return "updated";
}
