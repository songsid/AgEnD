/**
 * #3429 option B (user 11-13): a member online at a member-address change follows the Hub's issuer-signed relocation
 * (docs/design/hub-member-address-3429.md → "Online members follow", r3). This file is the member side's state and rules.
 *
 * - The statement: {v, from, to, spkiSha256, revision, signature}, signed with the Hub's issuer key over
 *   ["agend-hub-member-origin-v1", v, hubId, issuerKeyId, fleetId, from, to, spkiSha256, revision].
 * - The state, `hub-member/<hubId>/member-origin.json`, beside pairing.json (never inside it: its digest is an identity
 *   key): {v, profile (pairing.json's digest), highWater, confirmed: [chain], pending}. The anchor is the last confirmed
 *   `to`, else the profile's member address; `from` of a new statement must be the anchor (an aborted pending one is
 *   superseded, never built on). Revisions only move forward; an identical retry re-flushes the exact bytes; the same
 *   revision with another statement is refused.
 * - Promotion (pending → confirmed) only for the exact pending digest, by the caller that holds a fully validated welcome
 *   on the link it dialled to that `to`. The confirmed chain lets a company pin left behind by a crash be completed later.
 * - Absent: legacy (the profile's address). Corrupt, partial, another profile's, a broken chain: fail closed.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { readPrivateFile } from "./private-files.js";
import { createJoinPrivate, syncJoinPrivate, writeJoinPrivate } from "./join/private.js";
import { hubOrigin } from "./tls.js";
import { canonicalArguments, issuerKeyId, sha256 } from "./identity.js";
import { epoch, hash, uuid, validated, parseStrictJson, HubProtocolError } from "./validation.js";
import type { HubMemberProfile } from "./profile.js";
import { relocationStatementSchema } from "./protocol.js";

export const HUB_MEMBER_RELOCATION_CAPABILITY = "member-relocation-v1";
/** The longest confirmed chain kept: enough to complete a company pin left behind by a crash (design r3). */
export const HUB_RELOCATION_CHAIN_MAX = 8;
export { relocationStatementSchema };
export type HubRelocationStatement = z.infer<typeof relocationStatementSchema>;
export interface HubRelocationBinding { hubId: string; issuerKeyId: string; fleetId: string }
const entrySchema = z.strictObject({ statement: relocationStatementSchema, digest: hash });
const stateSchema = z.strictObject({ v: z.literal(1), profile: hash, highWater: epoch,
  confirmed: z.array(entrySchema).max(HUB_RELOCATION_CHAIN_MAX), pending: entrySchema.nullable() });
type Entry = z.infer<typeof entrySchema>;
export type HubRelocationState = z.infer<typeof stateSchema>;

function bytes(b: HubRelocationBinding, s: Omit<HubRelocationStatement, "signature">): Buffer {
  return Buffer.from(JSON.stringify(["agend-hub-member-origin-v1", s.v, b.hubId, b.issuerKeyId, b.fleetId, s.from, s.to, s.spkiSha256, s.revision]));
}
export const relocationDigest = (s: HubRelocationStatement): string => sha256(canonicalArguments(s));
const validOrigin = (o: string) => { try { return hubOrigin(o) === o; } catch { return false; } };

/** The Hub's side: sign one relocation for the Fleet its link authenticated. */
export function signHubRelocation(binding: HubRelocationBinding, s: { from: string; to: string; spkiSha256: string; revision: number }, key: KeyObject): HubRelocationStatement {
  validated(uuid, binding.hubId); validated(uuid, binding.fleetId);
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519" || issuerKeyId(key) !== binding.issuerKeyId
    || !validOrigin(s.from) || !validOrigin(s.to) || s.from === s.to) throw new HubProtocolError("invalid");
  const unsigned = validated(relocationStatementSchema, { v: 1, ...s, signature: "A".repeat(86) });
  return { ...unsigned, signature: sign(null, bytes(binding, unsigned), key).toString("base64url") };
}

/** The member's own binding and keys, from its pinned profile (never from anything the Hub sends). */
function pinned(profile: HubMemberProfile): { binding: HubRelocationBinding; key: KeyObject; spki: string } {
  return { binding: { hubId: profile.hub.hubId, issuerKeyId: profile.issuerKeyId, fleetId: profile.fleetId },
    key: createPublicKey(profile.hub.issuerPublicKey), spki: profile.hub.spkiSha256 };
}
/**
 * "denied" unless signed by the pinned issuer key for this Hub and Fleet, naming the pinned member key, moving between two
 * bare https origins that differ, and never onto the Hub's web address.
 */
export function verifyHubRelocation(input: unknown, profile: HubMemberProfile, webOrigins: readonly string[] = []): HubRelocationStatement {
  const s = validated(relocationStatementSchema, input), { binding, key, spki } = pinned(profile);
  if (key.asymmetricKeyType !== "ed25519" || issuerKeyId(key) !== binding.issuerKeyId || s.spkiSha256 !== spki
    || !validOrigin(s.from) || !validOrigin(s.to) || s.from === s.to || [profile.hub.webOrigin, ...webOrigins].includes(s.to)
    || Buffer.from(s.signature, "base64url").toString("base64url") !== s.signature
    || !verify(null, bytes(binding, s), key, Buffer.from(s.signature, "base64url"))) throw new HubProtocolError("denied");
  return s;
}

export type HubRelocationRead =
  | { kind: "absent"; anchor: string }
  | { kind: "ok"; anchor: string; state: HubRelocationState; text: string }
  | { kind: "corrupt" };

/** One paired Hub's relocation state. Every read re-verifies the whole file against the pinned profile. */
export class HubMemberRelocationStore {
  constructor(private readonly home: string, readonly hubId: string) { validated(uuid, hubId); }
  get suffix(): string { return `hub-member/${this.hubId}/member-origin.json`; }

  read(profile: HubMemberProfile, profileDigest: string): HubRelocationRead {
    if (profile.hub.hubId !== this.hubId) return { kind: "corrupt" };
    if (!existsSync(join(this.home, this.suffix))) return { kind: "absent", anchor: profile.hub.memberOrigin };
    try {
      const text = readPrivateFile(this.home, this.suffix, 64 * 1024);
      const state = validated(stateSchema, parseStrictJson(text));
      if (state.profile !== profileDigest) return { kind: "corrupt" };
      let anchor = profile.hub.memberOrigin, top = 0;
      for (const e of state.confirmed) {
        const s = verifyHubRelocation(e.statement, profile);
        if (e.digest !== relocationDigest(s) || s.from !== anchor || s.revision <= top) return { kind: "corrupt" };
        anchor = s.to; top = s.revision;
      }
      if (state.pending) {
        const s = verifyHubRelocation(state.pending.statement, profile);
        if (state.pending.digest !== relocationDigest(s) || s.from !== anchor || s.revision <= top) return { kind: "corrupt" };
        top = s.revision;
      }
      if (state.highWater < top) return { kind: "corrupt" };
      return { kind: "ok", anchor, state, text };
    } catch { return { kind: "corrupt" }; }
  }
  /** Where to dial, in order: a pending `to` first (it is not proven), then the anchor. Corrupt: none (fail closed). */
  dialOrder(profile: HubMemberProfile, profileDigest: string): string[] {
    const r = this.read(profile, profileDigest);
    if (r.kind === "corrupt") return [];
    return r.kind === "ok" && r.state.pending ? [r.state.pending.statement.to, r.anchor] : [r.anchor];
  }

  /**
   * Decide one statement against the kept state. "store": a new pending one (the caller records, then `store`s, then
   * acks). "retry": the identical pending statement again (the caller re-`flush`es, then acks). Throws "stale" for a
   * lower or equal revision that is not the identical retry, "denied" for anything unverified or not from the anchor.
   */
  plan(profile: HubMemberProfile, profileDigest: string, input: unknown, webOrigins: readonly string[] = []):
    { kind: "store"; statement: HubRelocationStatement; digest: string; expected: string | null } | { kind: "retry"; digest: string } {
    const r = this.read(profile, profileDigest);
    if (r.kind === "corrupt") throw new HubProtocolError("denied");
    const s = verifyHubRelocation(input, profile, webOrigins), digest = relocationDigest(s);
    const state = r.kind === "ok" ? r.state : null;
    if (state?.pending && state.pending.digest === digest) return { kind: "retry", digest };
    // An already-confirmed statement sent again (a lost ack, a reconnect): the same ack, its bytes flushed again — it
    // never reopens a pending state.
    if (state?.confirmed.some(e => e.digest === digest)) return { kind: "retry", digest };
    if (s.revision <= (state?.highWater ?? 0)) throw new HubProtocolError("stale");
    if (s.from !== r.anchor) throw new HubProtocolError("denied");
    return { kind: "store", statement: s, digest, expected: r.kind === "ok" ? r.text : null };
  }
  /** Write the planned pending statement: a CAS on the bytes read when planning, flushed with its parents. */
  store(profile: HubMemberProfile, profileDigest: string, planned: { statement: HubRelocationStatement; digest: string; expected: string | null }, current: () => boolean): void {
    const r = this.read(profile, profileDigest);
    if (r.kind === "corrupt" || (r.kind === "ok" ? r.text : null) !== planned.expected) throw new HubProtocolError("stale");
    const next: HubRelocationState = { v: 1, profile: profileDigest, highWater: planned.statement.revision,
      confirmed: r.kind === "ok" ? r.state.confirmed : [], pending: { statement: planned.statement, digest: planned.digest } };
    this.write(JSON.stringify(validated(stateSchema, next)), planned.expected, current);
  }
  /** An identical retry: the exact bytes again to disk (a write can be visible after its fsync failed). */
  flush(profile: HubMemberProfile, profileDigest: string, digest: string): void {
    const r = this.read(profile, profileDigest);
    if (r.kind !== "ok" || (r.state.pending?.digest !== digest && !r.state.confirmed.some(e => e.digest === digest))) throw new HubProtocolError("stale");
    syncJoinPrivate(this.home, this.suffix);
  }
  /**
   * The exact pending statement is proven (a fully validated welcome on the link dialled to its `to` — the caller's
   * proof): it joins the confirmed chain and stops being pending. Anything else pending, or nothing: "stale", no write.
   */
  promote(profile: HubMemberProfile, profileDigest: string, digest: string, current: () => boolean): HubRelocationStatement {
    const r = this.read(profile, profileDigest);
    if (r.kind !== "ok" || !r.state.pending || r.state.pending.digest !== digest) throw new HubProtocolError("stale");
    const promoted = r.state.pending, chain: Entry[] = [...r.state.confirmed, promoted];
    // The chain starts at the profile's own address (pairing.json is never rewritten), so it cannot drop its oldest hop:
    // a ninth confirmed move is refused (it stays pending and still dials first; Reconnect re-pairs from scratch).
    if (chain.length > HUB_RELOCATION_CHAIN_MAX) throw new HubProtocolError("denied");
    const next: HubRelocationState = { v: 1, profile: profileDigest, highWater: r.state.highWater, confirmed: chain, pending: null };
    this.write(JSON.stringify(validated(stateSchema, next)), r.text, current);
    return promoted.statement;
  }

  private write(text: string, expected: string | null, current: () => boolean): void {
    const now = () => existsSync(join(this.home, this.suffix)) ? readPrivateFile(this.home, this.suffix, 64 * 1024) : null;
    const unchanged = () => current() && now() === expected;
    if (!unchanged()) throw new HubProtocolError("stale");
    if (expected === null) createJoinPrivate(this.home, this.suffix, text);
    else writeJoinPrivate(this.home, this.suffix, text, unchanged);
  }
}

export type HubRelocationAuditEntry = { requestId: string; action: "member-origin.pending" | "member-origin.refused" | "member-origin.confirmed";
  result: "completed" | "denied"; reasonCode: string };
const requestIdOf = (statement: unknown): string => { try { return `member-origin:${sha256(canonicalArguments(statement))}`; } catch { return "member-origin:unparsable"; } };

/**
 * One `relocate` statement on the member: verify, decide, keep — the record committed first, then the file written and
 * flushed with its parents; only then may the caller ack. An identical retry re-flushes the exact bytes (no new record).
 * A refusal changes nothing (recorded once per statement) and the link goes on. Returns what to ack, if anything.
 */
export function acceptHubRelocation(deps: {
  home: string; profile: HubMemberProfile; profileDigest: string; webOrigins: readonly string[]; current(): boolean;
  record(entry: HubRelocationAuditEntry): void;
  log(level: "info" | "warn", message: string, fields: Record<string, unknown>): void;
}, statement: unknown): { ack: { revision: number; digest: string } } | { refused: string } {
  const store = new HubMemberRelocationStore(deps.home, deps.profile.hub.hubId), requestId = requestIdOf(statement);
  let planned: ReturnType<HubMemberRelocationStore["plan"]>;
  try { planned = store.plan(deps.profile, deps.profileDigest, statement, deps.webOrigins); }
  catch (error) {
    const reason = error instanceof HubProtocolError && error.code === "stale" ? "stale" : "unverified";
    deps.log("warn", "Hub relocation refused", { reason });
    deps.record({ requestId, action: "member-origin.refused", result: "denied", reasonCode: reason });
    return { refused: reason };
  }
  if (planned.kind === "retry") {
    store.flush(deps.profile, deps.profileDigest, planned.digest);
    const s = validated(relocationStatementSchema, statement);
    return { ack: { revision: s.revision, digest: planned.digest } };
  }
  deps.record({ requestId, action: "member-origin.pending", result: "completed", reasonCode: `revision:${planned.statement.revision}` });
  store.store(deps.profile, deps.profileDigest, planned, deps.current);
  deps.log("info", "The Hub announced a new member address", { from: planned.statement.from, to: planned.statement.to, revision: planned.statement.revision });
  return { ack: { revision: planned.statement.revision, digest: planned.digest } };
}

/**
 * Design r3: after a promotion, at start and before a Reconnect — a company pin left behind by a crash between the
 * promotion and its pin migration is completed. If this web address's pin is exactly the pinned identity with the `from`
 * of a confirmed hop, it is rewritten (CAS on its exact bytes) to the identity with the anchor; already the anchor's: its
 * bytes are flushed again; anything else is left alone (no arbitrary repair; a pending statement never moves a pin).
 */
export function completeRelocationPin(home: string, profile: HubMemberProfile, profileDigest: string, webOrigin: string, current: () => boolean,
  trust: { pinBytes(webOrigin: string): string | null; path(webOrigin: string): string;
    reanchor(from: PinIdentity, to: PinIdentity, previous: string, current: () => boolean): void }): "none" | "current" | "migrated" | "left" {
  const r = new HubMemberRelocationStore(home, profile.hub.hubId).read(profile, profileDigest);
  if (r.kind !== "ok" || !r.state.confirmed.length) return "none";
  const previous = trust.pinBytes(webOrigin);
  if (previous === null) return "none";
  let pin: PinIdentity;
  try { pin = (parseStrictJson(previous) as { hub: PinIdentity }).hub; } catch { return "left"; }
  if (!pin || pin.hubId !== profile.hub.hubId || pin.issuerPublicKey !== profile.hub.issuerPublicKey || pin.spkiSha256 !== profile.hub.spkiSha256
    || pin.webOrigin !== webOrigin) return "left";
  if (pin.memberOrigin === r.anchor) { syncJoinPrivate(home, trust.path(webOrigin)); return "current"; }
  if (!r.state.confirmed.some(e => e.statement.from === pin.memberOrigin)) return "left";
  trust.reanchor(pin, { ...pin, memberOrigin: r.anchor }, previous, current);
  return "migrated";
}
export interface PinIdentity { hubId: string; webOrigin: string; memberOrigin: string; spkiSha256: string; issuerPublicKey: string }

/**
 * The caller holds a fully validated, current welcome on the link it dialled to the pending `to` (its proof): that exact
 * statement is confirmed (recorded first), then any company pin left at an older hop is completed. Anything else
 * pending, or nothing: "stale", no record, no write.
 */
export function promoteHubRelocation(deps: {
  home: string; profile: HubMemberProfile; profileDigest: string; webOrigin: string; current(): boolean;
  record(entry: HubRelocationAuditEntry): void;
  trust: Parameters<typeof completeRelocationPin>[5];
}, digest: string): HubRelocationStatement {
  const store = new HubMemberRelocationStore(deps.home, deps.profile.hub.hubId);
  const r = store.read(deps.profile, deps.profileDigest);
  if (r.kind !== "ok" || r.state.pending?.digest !== digest) throw new HubProtocolError("stale");
  deps.record({ requestId: requestIdOf(r.state.pending.statement), action: "member-origin.confirmed", result: "completed", reasonCode: `revision:${r.state.pending.statement.revision}` });
  const promoted = store.promote(deps.profile, deps.profileDigest, digest, deps.current);
  completeRelocationPin(deps.home, deps.profile, deps.profileDigest, deps.webOrigin, deps.current, deps.trust);
  return promoted;
}

/**
 * Every member address this Fleet trusts for a statement the Hub signed for one of them (#3797's web address): pairing.json's,
 * each confirmed relocation's `to`, and a pending one's (its link authenticated the pinned key). A relocation state that
 * does not verify adds nothing.
 */
export function knownMemberOrigins(home: string, profile: HubMemberProfile, profileDigest: string | null): string[] {
  const out = [profile.hub.memberOrigin];
  if (!profileDigest) return out;
  const r = new HubMemberRelocationStore(home, profile.hub.hubId).read(profile, profileDigest);
  if (r.kind !== "ok") return out;
  for (const e of r.state.confirmed) out.push(e.statement.to);
  if (r.state.pending) out.push(r.state.pending.statement.to);
  return [...new Set(out)];
}
