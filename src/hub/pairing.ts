import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { HubProtocolError, hash, person, token, uuid, validated } from "./validation.js";
import { personKeyString, sha256 } from "./identity.js";
import type { HubTransportState, HubTransportStore } from "./store.js";
import type { HubActor, HubDirectory, HubRequestContext, PersonKey } from "./types.js";
const TTL = 10 * 60_000;
const secret = () => randomBytes(32).toString("hex");
export interface HubPairingIdentity {
  hubId: string; memberOrigin: string; webOrigin: string; spkiSha256: string; issuerPublicKey: string;
}
export function hubPairingFingerprint(identity: HubPairingIdentity, pairId: string, owner: PersonKey, claimDigest: string): string {
  validated(uuid, identity.hubId); validated(hash, identity.spkiSha256); validated(uuid, pairId); validated(hash, claimDigest); validated(person, owner);
  return sha256(JSON.stringify(["agend-hub-pair-v1", identity.hubId, identity.memberOrigin, identity.spkiSha256,
    identity.issuerPublicKey, identity.webOrigin, pairId, owner.realm, owner.objectId, claimDigest]));
}
export function displayHubFingerprint(fingerprint: string): string {
  return validated(hash, fingerprint).slice(0, 32).toUpperCase().match(/.{4}/g)!.join("-");
}
const pairBody = z.strictObject({ code: z.string().regex(/^[a-f0-9]{12}$/) });
const claimBody = z.strictObject({ pairingId: uuid, fleetId: uuid, claimSecret: token });
export class HubPairingService {
  constructor(private readonly options: { store: HubTransportStore; identity: HubPairingIdentity; directory: HubDirectory;
    enabled(): boolean; now?: () => number; fenceFleet(fleetId: string, reason: "replaced" | "revoked"): void }) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private check(): void { if (!this.options.enabled()) throw new HubProtocolError("unavailable"); }
  private audit(actor: HubActor | { kind: "member"; fleetId: string }, action: string, requestId: string) {
    return { at: this.now(), requestId, actor: actor.kind === "directory" ? { kind: "person" as const, person: actor.person } : actor.kind === "member" ? actor : { kind: "local-host" as const }, action, result: "allowed" as const };
  }
  private budget(state: HubTransportState, key: string, maximum = 10): boolean {
    const now = this.now(); state.buckets = state.buckets.filter(x => now - x.since < 60_000);
    const digest = sha256(key), row = state.buckets.find(x => x.key === digest);
    if (!row) { if (state.buckets.length >= 1024) return false; state.buckets.push({ key: digest, since: now, attempts: 1 }); return true; }
    row.attempts = Math.min(row.attempts + 1, maximum + 1); return row.attempts <= maximum;
  }
  async create(ctx: HubRequestContext, owner: PersonKey): Promise<{ pairingId: string; code: string; expiresAt: number }> {
    validated(person, owner); this.check();
    const eligible = await this.options.directory.checkEligibility(owner);
    if (!eligible.eligible || personKeyString(eligible.person.key) !== personKeyString(owner)) throw new HubProtocolError("denied");
    const admin = await ctx.requireAdmin(); this.check();
    const id = randomUUID(), code = randomBytes(6).toString("hex"), expiresAt = this.now() + TTL;
    this.options.store.mutate(this.audit(admin, "pairing.created", ctx.requestId), state => {
      state.pairings = state.pairings.filter(p => p.expiresAt > this.now());
      if (state.pairings.length >= 64) throw new HubProtocolError("backpressure");
      state.pairings.push({ id, owner: { ...owner }, codeHash: sha256(code), expiresAt, fleetId: null, claimHash: null, fingerprint: null,
        ownerConfirmed: false, adminApproved: false, state: "offered" });
    });
    return { pairingId: id, code, expiresAt };
  }
  /** Unauthenticated bootstrap accepts a code only: no cookies, passwords, exports or directory attributes. */
  pair(input: unknown): { pairingId: string; fleetId: string; claimSecret: string; fingerprint: string; expiresAt: number; hub: HubPairingIdentity; owner: PersonKey } {
    const { code } = validated(pairBody, input); this.check();
    const invalid = this.options.store.read().buckets.find(b => b.key === sha256("pair:invalid"));
    if (invalid && this.now() - invalid.since < 60_000 && invalid.attempts > 10
      && !this.options.store.read().pairings.some(p => p.codeHash === sha256(code))) throw new HubProtocolError("denied");
    const claimSecret = secret(), claimHash = sha256(claimSecret), fleetId = randomUUID();
    const result = this.options.store.mutate(this.audit({ kind: "member", fleetId }, "pairing.claim-requested", randomUUID()), state => {
      const p = state.pairings.find(p => p.codeHash === sha256(code) && p.state === "offered" && p.expiresAt > this.now());
      if (!p) { this.budget(state, "pair:invalid"); return null; }
      if (!this.budget(state, `pair:${p.id}`)) return null;
      p.codeHash = null; p.claimHash = claimHash; p.fleetId = fleetId; p.state = "pending";
      p.fingerprint = hubPairingFingerprint(this.options.identity, p.id, p.owner, claimHash);
      return { pairingId: p.id, fleetId, claimSecret, fingerprint: p.fingerprint, expiresAt: p.expiresAt, hub: { hubId: this.options.identity.hubId, memberOrigin: this.options.identity.memberOrigin, webOrigin: this.options.identity.webOrigin, spkiSha256: this.options.identity.spkiSha256, issuerPublicKey: this.options.identity.issuerPublicKey }, owner: { ...p.owner } };
    });
    if (!result) throw new HubProtocolError("denied"); return result;
  }
  async confirmOwner(ctx: HubRequestContext, pairId: string, fingerprint: string): Promise<void> {
    validated(uuid, pairId); validated(hash, fingerprint); const owner = await ctx.requirePerson(); this.check();
    this.options.store.mutate(this.audit({ kind: "directory", person: owner, sessionId: "" }, "pairing.owner-confirmed", ctx.requestId), state => {
      const p = state.pairings.find(p => p.id === pairId);
      if (!p || p.state !== "pending" || p.expiresAt <= this.now() || p.fingerprint !== fingerprint || personKeyString(p.owner) !== personKeyString(owner)) throw new HubProtocolError("denied");
      p.ownerConfirmed = true;
    });
  }
  async approve(ctx: HubRequestContext, pairId: string, fingerprint: string): Promise<void> {
    validated(uuid, pairId); validated(hash, fingerprint); const admin = await ctx.requireAdmin(); this.check();
    this.options.store.mutate(this.audit(admin, "pairing.approved", ctx.requestId), state => {
      const p = state.pairings.find(p => p.id === pairId);
      if (!p || p.state !== "pending" || p.expiresAt <= this.now() || p.fingerprint !== fingerprint || !p.ownerConfirmed) throw new HubProtocolError("denied");
      p.adminApproved = true;
    });
  }
  async claim(input: unknown): Promise<{ status: "pending" } | { status: "approved"; fleetId: string; credential: string }> {
    const body = validated(claimBody, input); this.check(); const credential = secret();
    const offered = this.options.store.read().pairings.find(p => p.id === body.pairingId && p.fleetId === body.fleetId && p.claimHash === sha256(body.claimSecret));
    if (offered) {
      const eligible = await this.options.directory.checkEligibility(offered.owner);
      if (!eligible.eligible || personKeyString(eligible.person.key) !== personKeyString(offered.owner)) throw new HubProtocolError("denied");
    }
    this.check();
    const outcome = this.options.store.mutate(this.audit({ kind: "member", fleetId: body.fleetId }, "pairing.claimed", randomUUID()), state => {
      const p = state.pairings.find(p => p.id === body.pairingId && p.fleetId === body.fleetId && p.claimHash === sha256(body.claimSecret));
      if (!p || p.state !== "pending" || p.expiresAt <= this.now() || !this.budget(state, `claim:${p.id}`, 60)) return null;
      if (!p.ownerConfirmed || !p.adminApproved) return { status: "pending" as const };
      if (state.fleets.length >= 256) throw new HubProtocolError("backpressure");
      p.state = "claimed"; p.claimHash = null;
      state.fleets.push({ id: body.fleetId, owner: p.owner, credentialHash: sha256(credential), generation: 1, status: "active" });
      return { status: "approved" as const, fleetId: body.fleetId, credential };
    });
    if (!outcome) throw new HubProtocolError("denied"); return outcome;
  }
  authenticate(credential: string): { fleetId: string; owner: PersonKey; generation: number } {
    validated(token, credential); this.check(); const digest = Buffer.from(sha256(credential), "hex");
    const fleet = this.options.store.read().fleets.find(f => f.status === "active" && f.credentialHash && timingSafeEqual(digest, Buffer.from(f.credentialHash, "hex")));
    if (!fleet) throw new HubProtocolError("denied"); return { fleetId: fleet.id, owner: fleet.owner, generation: fleet.generation };
  }
  bindingCurrent(fleetId: string, generation: number): boolean {
    try { this.check(); const f = this.options.store.read().fleets.find(f => f.id === fleetId); return f?.status === "active" && f.generation === generation; } catch { return false; }
  }
  async connect(credential: string): Promise<{ fleetId: string; owner: PersonKey; generation: number; linkEpoch: number; revocationVersion: number }> {
    let f = this.authenticate(credential);
    const eligible = await this.options.directory.checkEligibility(f.owner);
    if (!eligible.eligible || personKeyString(eligible.person.key) !== personKeyString(f.owner)) throw new HubProtocolError("denied");
    f = this.authenticate(credential); this.options.fenceFleet(f.fleetId, "replaced");
    return this.options.store.mutate(this.audit({ kind: "member", fleetId: f.fleetId }, "member.connected", randomUUID()), state => {
      const current = state.fleets.find(x => x.id === f.fleetId);
      if (!current || current.generation !== f.generation || current.status !== "active") throw new HubProtocolError("stale");
      state.nextLinkEpoch++; return { ...f, linkEpoch: state.nextLinkEpoch, revocationVersion: state.revocationVersion };
    });
  }
  async revoke(ctx: HubRequestContext, fleetId: string): Promise<void> {
    validated(uuid, fleetId); const admin = await ctx.requireAdmin(); this.check(); this.options.fenceFleet(fleetId, "revoked");
    this.options.store.mutate(this.audit(admin, "member.revoked", ctx.requestId), state => {
      const f = state.fleets.find(f => f.id === fleetId); if (!f) throw new HubProtocolError("not-found");
      f.status = "revoked"; f.credentialHash = null; f.generation++; state.revocationVersion++;
    });
  }
}
