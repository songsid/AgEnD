/**
 * #3429 option B — the member side of a relocation (src/hub/member-origin.ts; design r3 in hub-member-address-3429.md).
 * A real paired profile (hub rig) and the Hub's real issuer key. Pins Prism's and Ridge's design points:
 * - signature: only the pinned issuer key, this Hub and Fleet, the pinned member key, two different bare https origins,
 *   never the web address;
 * - D1: pending ≠ confirmed; `from` must be the anchor; an aborted A→B is superseded by A→C (and survives a restart);
 *   revisions only forward; identical retry vs same-revision equivocation; promotion only for the exact pending digest;
 * - fail closed on a corrupt/partial/other-profile file; absent = legacy;
 * - audit before file; an identical retry re-flushes and records nothing; refusals are recorded;
 * - D2/r3: a company pin left at an older hop is completed from the confirmed chain; anything else is left alone.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivateKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hubRig } from "./helpers/hub-rig.js";
import { readPrivateFile } from "../src/hub/private-files.js";
import { issuerKeyId, sha256 } from "../src/hub/identity.js";
import { HubMemberProfileStore, type HubMemberProfile } from "../src/hub/profile.js";
import { CompanyTrustStore } from "../src/hub/join/trust.js";
import { companyIdentityDigest } from "../src/hub/join/protocol.js";
import { createJoinPrivate } from "../src/hub/join/private.js";
import * as joinPrivate from "../src/hub/join/private.js";
import { HUB_RELOCATION_CHAIN_MAX, HubMemberRelocationStore, acceptHubRelocation, completeRelocationPin, promoteHubRelocation,
  relocationDigest, signHubRelocation, verifyHubRelocation, type HubRelocationAuditEntry } from "../src/hub/member-origin.js";

const rigs: Awaited<ReturnType<typeof hubRig>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const r of rigs.splice(0)) await r.close(); });
type Rig = Awaited<ReturnType<typeof hubRig>>;
const B = "https://hub-b.example.test:9443", C = "https://hub-c.example.test:9443", X = "https://hub-x.example.test:9443";

async function setup() {
  const r = await hubRig(); rigs.push(r);
  const p = await r.pair(), digest = new HubMemberProfileStore(r.memberHome, p.hub.hubId).profileDigest()!;
  const key = createPrivateKey(readPrivateFile(r.root, "hub/keys/issuer-key.pem"));
  const st = (from: string, to: string, revision: number, opts: { key?: typeof key; fleetId?: string; spki?: string } = {}) =>
    signHubRelocation({ hubId: p.hub.hubId, issuerKeyId: issuerKeyId(opts.key ?? key), fleetId: opts.fleetId ?? p.fleetId },
      { from, to, spkiSha256: opts.spki ?? p.hub.spkiSha256, revision }, opts.key ?? key);
  const store = new HubMemberRelocationStore(r.memberHome, p.hub.hubId), A = p.hub.memberOrigin;
  const records: HubRelocationAuditEntry[] = [];
  const accept = (statement: unknown, current = () => true) => acceptHubRelocation({ home: r.memberHome, profile: p, profileDigest: digest,
    webOrigins: [], current, log: () => {}, record: e => { records.push(e); } }, statement);
  const file = () => join(r.memberHome, store.suffix);
  return { r, p, digest, key, st, store, A, records, accept, file };
}

describe("#3429 B — the relocation statement", () => {
  it("verifies only for the pinned issuer key, this Hub and Fleet, the pinned member key; two different https origins, never the web address", async () => {
    const { p, st, A } = await setup();
    expect(verifyHubRelocation(st(A, B, 1), p).to).toBe(B);
    const other = generateKeyPairSync("ed25519").privateKey;
    expect(() => verifyHubRelocation(st(A, B, 1, { key: other }), p)).toThrow();
    expect(() => verifyHubRelocation(st(A, B, 1, { fleetId: randomUUID() }), p)).toThrow();
    expect(() => verifyHubRelocation(st(A, B, 1, { spki: "f".repeat(64) }), p)).toThrow();
    expect(() => verifyHubRelocation({ ...st(A, B, 1), to: C }, p)).toThrow();                          // tampered after signing
    expect(() => verifyHubRelocation(st(A, p.hub.webOrigin, 1), p)).toThrow();                          // onto the web address
    for (const bad of ["http://hub-b.example.test", "https://hub-b.example.test/x", A]) expect(() => st(A, bad, 1)).toThrow();
  });
});

describe("#3429 B — D1: pending is not confirmed; the anchor decides", () => {
  it("A→B pending is dialled first, A after; an aborted A→B is superseded by A→C (not B→C), across a restart", async () => {
    const { r, p, digest, st, store, A, accept } = await setup();
    expect(store.dialOrder(p, digest)).toEqual([A]);                                                     // absent: legacy
    expect(accept(st(A, B, 1))).toEqual({ ack: { revision: 1, digest: relocationDigest(st(A, B, 1)) } });
    expect(store.dialOrder(p, digest)).toEqual([B, A]);
    const restarted = new HubMemberRelocationStore(r.memberHome, p.hub.hubId);                          // a restart reads the file
    expect(restarted.dialOrder(p, digest)).toEqual([B, A]);
    expect(accept(st(B, C, 2))).toEqual({ refused: "unverified" });                                    // B is not the anchor (D1)
    expect(accept(st(A, C, 2))).toMatchObject({ ack: { revision: 2 } });                               // the next attempt from A
    expect(restarted.dialOrder(p, digest)).toEqual([C, A]);
    expect(accept(st(A, B, 1))).toEqual({ refused: "stale" });                                         // the old one cannot return
  });
  it("identical retry = the same ack, re-flushed, nothing new recorded; the same revision with another address = refused", async () => {
    const { st, A, accept, records, file } = await setup();
    const sync = vi.spyOn(joinPrivate, "syncJoinPrivate");
    accept(st(A, B, 1)); const bytes = readFileSync(file(), "utf8"), recorded = records.length;
    sync.mockClear();
    expect(accept(st(A, B, 1))).toMatchObject({ ack: { revision: 1 } });
    expect(sync).toHaveBeenCalledTimes(1);                                                               // equal is not proof: flushed again
    expect(records).toHaveLength(recorded);
    expect(readFileSync(file(), "utf8")).toBe(bytes);
    expect(accept(st(A, C, 1))).toEqual({ refused: "stale" });                                         // equivocation
    expect(accept({ ...st(A, C, 2), signature: "A".repeat(86) })).toEqual({ refused: "unverified" });   // a forged signature
    expect(records.at(-2)).toMatchObject({ action: "member-origin.refused", reasonCode: "stale" });
    expect(records.at(-1)).toMatchObject({ action: "member-origin.refused", reasonCode: "unverified" });
  });
  it("promotion only for the exact pending digest; a confirmation never carries over; after it the old address is never dialled", async () => {
    const { r, p, digest, st, store, A, accept } = await setup();
    const trust = new CompanyTrustStore(r.memberHome);
    const promote = (d: string) => promoteHubRelocation({ home: r.memberHome, profile: p, profileDigest: digest, webOrigin: p.hub.webOrigin,
      current: () => true, record: () => {}, trust }, d);
    accept(st(A, B, 1)); const first = relocationDigest(st(A, B, 1));
    accept(st(A, C, 2));                                                                                // a new proposal supersedes it
    expect(() => promote(first)).toThrow();                                                            // the old welcome cannot confirm C
    expect(store.dialOrder(p, digest)).toEqual([C, A]);
    promote(relocationDigest(st(A, C, 2)));
    expect(store.dialOrder(p, digest)).toEqual([C]);
    expect(new HubMemberRelocationStore(r.memberHome, p.hub.hubId).dialOrder(p, digest)).toEqual([C]);   // after a restart too
    expect(() => promote(relocationDigest(st(A, C, 2)))).toThrow();                                     // nothing pending now
    expect(accept(st(C, B, 3))).toMatchObject({ ack: { revision: 3 } });                               // the chain continues from C
  });
  it("an already-confirmed statement sent again (a lost ack, a reconnect) gets the same ack and never reopens pending", async () => {
    const { r, p, digest, st, store, A, accept, file } = await setup();
    accept(st(A, B, 1));
    store.promote(p, digest, relocationDigest(st(A, B, 1)), () => true);
    const bytes = readFileSync(file(), "utf8");
    expect(accept(st(A, B, 1))).toEqual({ ack: { revision: 1, digest: relocationDigest(st(A, B, 1)) } });
    expect(readFileSync(file(), "utf8")).toBe(bytes);
    expect(store.dialOrder(p, digest)).toEqual([B]);
    expect(new HubMemberRelocationStore(r.memberHome, p.hub.hubId).read(p, digest)).toMatchObject({ kind: "ok", state: { pending: null } });
  });
  it("a ninth confirmed hop is refused (the chain starts at the profile's own address); it stays pending", async () => {
    const { r, p, digest, st, store, A, accept } = await setup();
    const trust = new CompanyTrustStore(r.memberHome);
    let from = A;
    for (let i = 1; i <= HUB_RELOCATION_CHAIN_MAX + 1; i++) {
      const to = `https://hop${i}.example.test:9443`;
      accept(st(from, to, i));
      const go = () => promoteHubRelocation({ home: r.memberHome, profile: p, profileDigest: digest, webOrigin: p.hub.webOrigin, current: () => true, record: () => {}, trust }, relocationDigest(st(from, to, i)));
      if (i <= HUB_RELOCATION_CHAIN_MAX) { go(); from = to; } else { expect(go).toThrow(); expect(store.dialOrder(p, digest)[0]).toBe(to); }
    }
  });
});

describe("#3429 B — fail closed; record before file", () => {
  it("absent = legacy; corrupt, partial, another profile's or a broken chain = no address at all", async () => {
    const { p, digest, st, store, A, accept, file } = await setup();
    accept(st(A, B, 1));
    const good = readFileSync(file(), "utf8");
    for (const bad of ["{", good.slice(0, 40), good.replace(`"profile":"${digest}"`, `"profile":"${"0".repeat(64)}"`), good.replace('"highWater":1', '"highWater":0')]) {
      writeFileSync(file(), bad, { mode: 0o600 });
      expect(store.read(p, digest).kind).toBe("corrupt");
      expect(store.dialOrder(p, digest)).toEqual([]);
    }
    expect(store.read(p, sha256("another profile")).kind).toBe("corrupt");
  });
  it("the record commits before the file; a record that fails leaves no file and no ack", async () => {
    const { r, p, digest, st, A, file } = await setup();
    const order: string[] = [];
    const out = () => acceptHubRelocation({ home: r.memberHome, profile: p, profileDigest: digest, webOrigins: [], current: () => true, log: () => {},
      record: () => { order.push(existsSync(file()) ? "file-before-record" : "record"); throw new Error("audit full"); } }, st(A, B, 1));
    expect(out).toThrow(/audit full/);
    expect(order).toEqual(["record"]);
    expect(existsSync(file())).toBe(false);
  });
  it("a write raced by another writer (the bytes changed since planning) writes nothing", async () => {
    const { p, digest, st, store, A, accept, file } = await setup();
    accept(st(A, B, 1));
    const planned = store.plan(p, digest, st(A, C, 2));
    if (planned.kind !== "store") throw new Error("expected a store plan");
    accept(st(A, X, 3));                                                                                 // someone else moved first
    const after = readFileSync(file(), "utf8");
    expect(() => store.store(p, digest, planned, () => true)).toThrow();
    expect(readFileSync(file(), "utf8")).toBe(after);
  });
});

describe("#3429 B — D2/r3: the company pin moves only with a confirmed relocation, and is completed from the chain", () => {
  async function pinned(memberOrigin: string) {
    const s = await setup(), trust = new CompanyTrustStore(s.r.memberHome);
    const identity = { hubId: s.p.hub.hubId, webOrigin: s.p.hub.webOrigin, memberOrigin, spkiSha256: s.p.hub.spkiSha256, issuerPublicKey: s.p.hub.issuerPublicKey };
    createJoinPrivate(s.r.memberHome, trust.path(s.p.hub.webOrigin), JSON.stringify({ v: 1, hub: identity, fingerprint: companyIdentityDigest(identity) }));
    const promote = (from: string, to: string, rev: number) => { s.accept(s.st(from, to, rev)); promoteHubRelocation({ home: s.r.memberHome, profile: s.p, profileDigest: s.digest,
      webOrigin: s.p.hub.webOrigin, current: () => true, record: () => {}, trust }, relocationDigest(s.st(from, to, rev))); };
    const pin = () => JSON.parse(trust.pinBytes(s.p.hub.webOrigin)!).hub.memberOrigin;
    return { ...s, trust, promote, pin };
  }
  it("a pending relocation never moves the pin; a confirmed one does", async () => {
    const s = await pinned((await setup()).A);
    const A = s.A; s.trust.pinBytes(s.p.hub.webOrigin);
    // re-pin at this rig's own A (the helper's first setup was another rig)
    const identity = { hubId: s.p.hub.hubId, webOrigin: s.p.hub.webOrigin, memberOrigin: A, spkiSha256: s.p.hub.spkiSha256, issuerPublicKey: s.p.hub.issuerPublicKey };
    writeFileSync(join(s.r.memberHome, s.trust.path(s.p.hub.webOrigin)), JSON.stringify({ v: 1, hub: identity, fingerprint: companyIdentityDigest(identity) }), { mode: 0o600 });
    s.accept(s.st(A, B, 1));
    expect(s.pin()).toBe(A);
    s.promote(A, C, 2);
    expect(s.pin()).toBe(C);
  });
  it("a crash between promotion and the pin migration (pin = B while confirmed = A→B→C) is completed to C; a foreign pin is left alone", async () => {
    const s = await setup(), trust = new CompanyTrustStore(s.r.memberHome);
    const id = (m: string) => ({ hubId: s.p.hub.hubId, webOrigin: s.p.hub.webOrigin, memberOrigin: m, spkiSha256: s.p.hub.spkiSha256, issuerPublicKey: s.p.hub.issuerPublicKey });
    const pinText = (m: string) => JSON.stringify({ v: 1, hub: id(m), fingerprint: companyIdentityDigest(id(m)) });
    const suffix = trust.path(s.p.hub.webOrigin);
    for (const [from, to, rev] of [[s.A, B, 1], [B, C, 2]] as const) {
      s.accept(s.st(from, to, rev));
      s.store.promote(s.p, s.digest, relocationDigest(s.st(from, to, rev)), () => true);                 // promotion without the pin step
    }
    createJoinPrivate(s.r.memberHome, suffix, pinText(B));
    const complete = () => completeRelocationPin(s.r.memberHome, s.p, s.digest, s.p.hub.webOrigin, () => true, trust);
    expect(complete()).toBe("migrated");
    expect(JSON.parse(trust.pinBytes(s.p.hub.webOrigin)!).hub.memberOrigin).toBe(C);
    expect(complete()).toBe("current");                                                                  // idempotent: re-flushed
    writeFileSync(join(s.r.memberHome, suffix), pinText(X), { mode: 0o600 });
    expect(complete()).toBe("left");
    expect(JSON.parse(trust.pinBytes(s.p.hub.webOrigin)!).hub.memberOrigin).toBe(X);
  });
});
