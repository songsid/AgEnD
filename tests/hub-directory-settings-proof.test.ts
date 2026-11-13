/** Inert authority/controller tests; the accompanying wire suite uses actual TLS/LDAP. No public route is mounted. */
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { createHubDirectorySettingsProof, type HubDirectoryProofContext, type HubDirectoryProofDeps, type HubDirectoryProofSource } from "../src/hub/settings-directory-proof.js";
import type { HubDirectory } from "../src/hub/directory/types.js";
import type { HubDirectorySessionRotation } from "../src/hub/session-directory-transition.js";
import type { HubDirectorySettingsCandidate } from "../src/hub/settings-commit.js";
import { createHubGroupPolicyStore, groupPolicyMigration } from "../src/hub/group-policy/store.js";
import { applyHubMigrations } from "../src/hub/db.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { BIND_PASSWORD_REF } from "../src/hub/init/layout.js";
import { directoryCertificates } from "./support/hub-directory-ca-fixture.js";

const who = { realm: "fictional", objectId: "11111111-1111-4111-8111-111111111111" }, other = { ...who, objectId: "22222222-2222-4222-8222-222222222222" };
const group = { key: { ...who, objectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, dn: "CN=Old-label,DC=example,DC=test" };
const person = (key = who) => ({ key, login: "admin", dn: "CN=Admin,DC=example,DC=test", groups: [] });
const deferred = <T>() => { let resolve!: (t: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
function fixture() {
  let now = Date.now(), live = true;
  const old = {
    realm: who.realm, groupPolicy: "ad-direct-guid" as const,
    signIn: vi.fn<HubDirectory["signIn"]>(async () => ({ ok: true, person: person() })),
    checkEligibility: vi.fn<HubDirectory["checkEligibility"]>(async () => ({ eligible: true, person: person() })), close: vi.fn(async () => {}),
  };
  const source: HubDirectoryProofSource = { directory: old, config: { realm: who.realm, url: "ldaps://old.example.test", profile: "ad", baseDn: "DC=example,DC=test",
    bindDn: "CN=Reader", bindPasswordRef: BIND_PASSWORD_REF }, administrator: { ...who }, bindPassword: "\ufeff old service \n", groups: [structuredClone(group)], epoch: 0, image: "a".repeat(64), current: () => true };
  const next = {
    realm: who.realm, groupPolicy: "ad-direct-guid" as const, signIn: vi.fn<HubDirectory["signIn"]>(async () => { throw Error("NEVER forward a personal password"); }),
    checkEligibility: vi.fn<HubDirectory["checkEligibility"]>(async () => ({ eligible: true, person: person() })),
    checkPolicyGroup: vi.fn<NonNullable<HubDirectory["checkPolicyGroup"]>>(async key => ({ ok: true, group: { key, dn: "CN=Renamed,DC=example,DC=test" } })),
    close: vi.fn(async () => {}),
  };
  const db = new Database(":memory:"); db.pragma("foreign_keys=ON");
  applyHubMigrations(db, [HUB_AUDIT_MIGRATION, groupPolicyMigration("proof-hub", who.realm, "generation")]);
  const pool = createHubGroupPolicyStore({ db, hubId: "proof-hub", realm: who.realm, generation: "generation", directory: old,
    audit: createHubAudit({ db, contentKey: randomBytes(32) }), current: () => true });
  const prepared = vi.fn((_: HubDirectorySettingsCandidate, _actor: unknown, proof: () => boolean) => { expect(proof()).toBe(true); return { ref: "writer-ref", expiresAt: now + 300_000 }; });
  const commit = vi.fn((_ref: string, _actor: unknown, proof: () => boolean, _rotation?: HubDirectorySessionRotation) => { expect(proof()).toBe(true); return { receiptId: randomUUID(), directoryEpoch: 1 }; });
  const probeTls = vi.fn<NonNullable<HubDirectoryProofDeps["probeTls"]>>(async () => "A".repeat(64)), createDirectory = vi.fn<HubDirectoryProofDeps["createDirectory"]>(() => next);
  const deps: HubDirectoryProofDeps = { source: () => source, now: () => now, withDirectoryRead: (key, read) => pool.withDirectoryRead(key, read), probeTls, createDirectory,
    writer: () => ({ prepare: prepared, commit, compensate: () => { throw Error("not part of this layer"); } }) };
  const control = createHubDirectorySettingsProof(deps);
  cleanups.push(() => { control.close(); db.close(); });
  const ctx: HubDirectoryProofContext = { actor: { kind: "hub-administrator", person: { ...who }, sessionId: "admin-session", requestId: randomUUID() }, current: () => live };
  const candidate = (): HubDirectorySettingsCandidate => ({ directory: { ...source.config, url: "ldaps://new.example.test" }, bindPassword: "\ufeff candidate service \n",
    changes: ["server", "secret"], recipients: [{ kind: "host", sink: "owner-needs-you" }] });
  const credentials = { login: "admin", password: "Personal-old-only" };
  const save = async (input = candidate(), custom = ctx) => { const p = await control.prepare(input, custom); return control.apply(p.ref, { credentials, confirmation: p.trust?.challenge }, custom); };
  return { control, deps, source, ctx, candidate, credentials, old, next, probeTls, prepared, commit, createDirectory, save,
    tick: (n: number) => { now += n; }, time: () => now, live: (value: boolean) => { live = value; } };
}

describe("directory setting preparation authority", () => {
  it.each([33, 512])("re-proves all %i retained role subject/scope references before Save", async count => {
    const r = fixture(); r.source.groups = Array.from({ length: count }, (_, i) => ({ key: { realm: who.realm, objectId: randomUUID() }, dn: `CN=Retained${i}` }));
    await expect(r.save()).resolves.toMatchObject({ directoryEpoch: 1 });
    expect(r.next.checkPolicyGroup).toHaveBeenCalledTimes(count); expect(r.next.close).toHaveBeenCalledOnce();
  });
  it("refuses a reference graph over the schema bound before any directory I/O", async () => {
    const r = fixture(); r.source.groups = Array.from({ length: 513 }, () => structuredClone(group));
    await expect(r.control.prepare(r.candidate(), r.ctx)).rejects.toMatchObject({ code: "unavailable" });
    expect(r.probeTls).not.toHaveBeenCalled(); expect(r.createDirectory).not.toHaveBeenCalled();
  });
  it.each(["", "CN=Invalid\n", "x".repeat(1025), undefined])("refuses a malformed retained DN assertion before directory I/O", async dn => {
    const r = fixture(); r.source.groups = [{ ...structuredClone(group), dn: dn as string }];
    await expect(r.control.prepare(r.candidate(), r.ctx)).rejects.toMatchObject({ code: "unavailable" });
    expect(r.probeTls).not.toHaveBeenCalled(); expect(r.createDirectory).not.toHaveBeenCalled();
  });
  it("propagates the bounded server deadline to the one writer", async () => {
    const r = fixture(), p = await r.control.prepare(r.candidate(), r.ctx);
    await r.control.apply(p.ref, { credentials: r.credentials, confirmation: p.trust!.challenge }, r.ctx, undefined, () => 1600);
    expect((r.commit.mock.calls[0] as unknown[])[4]).toBe(1600);
  });
  it("acquires the response only after candidate validation and immediately before the synchronous writer commit", async () => {
    const r = fixture(), p = await r.control.prepare(r.candidate(), r.ctx), captured = vi.fn(() => {
      expect(r.prepared).toHaveBeenCalledOnce(); expect(r.next.close).toHaveBeenCalledOnce(); expect(r.commit).not.toHaveBeenCalled();
    });
    await r.control.apply(p.ref, { credentials: r.credentials, confirmation: p.trust!.challenge }, r.ctx, undefined, captured);
    expect(captured).toHaveBeenCalledOnce(); expect(r.commit).toHaveBeenCalledOnce();
  });
  it.each(["revoked", "expired", "throw", "async"])("a %s response capture cannot cross the writer decision", async mode => {
    const r = fixture(), p = await r.control.prepare(r.candidate(), r.ctx);
    const capture = () => {
      if (mode === "revoked") r.live(false);
      if (mode === "expired") r.tick(300_000);
      if (mode === "throw") throw Error("response disconnected");
      if (mode === "async") return Promise.resolve();
    };
    // Intentionally feed an invalid asynchronous callback across the typed private boundary.
    await expect(r.control.apply(p.ref, { credentials: r.credentials, confirmation: p.trust!.challenge }, r.ctx, undefined, capture as () => void)).rejects.toThrow();
    expect(r.commit).not.toHaveBeenCalled();
    await expect(r.control.apply(p.ref, {}, r.ctx)).rejects.toMatchObject({ code: "expired" });
  });
  it("refused candidate validation never acquires a response", async () => {
    const r = fixture(), p = await r.control.prepare(r.candidate(), r.ctx), capture = vi.fn();
    r.next.checkEligibility.mockResolvedValue({ eligible: false, reason: "disabled" });
    await expect(r.control.apply(p.ref, { credentials: r.credentials, confirmation: p.trust!.challenge }, r.ctx, undefined, capture)).rejects.toThrow();
    expect(capture).not.toHaveBeenCalled(); expect(r.commit).not.toHaveBeenCalled();
  });
  it("inspects without LDAP credentials, returns only a bound trust challenge, and delegates the eventual save to the shared writer", async () => {
    const r = fixture(), p = await r.control.prepare(r.candidate(), r.ctx);
    expect(p.trust).toMatchObject({ server: "ldaps://new.example.test:636", leafFingerprint: "A".repeat(64), caFingerprints: [], systemRoots: true });
    expect(JSON.stringify(p)).not.toMatch(/service|Personal|bindPassword|manifest|image/);
    expect(r.old.signIn).not.toHaveBeenCalled(); expect(r.createDirectory).not.toHaveBeenCalled();
    expect(await r.control.apply(p.ref, { credentials: r.credentials, confirmation: p.trust!.challenge }, r.ctx)).toMatchObject({ directoryEpoch: 1 });
    expect(r.old.signIn).toHaveBeenCalledExactlyOnceWith("admin", "Personal-old-only"); expect(r.next.signIn).not.toHaveBeenCalled();
    expect(r.createDirectory).toHaveBeenCalledWith(r.candidate().directory, { bindPassword: "\ufeff candidate service \n" }, { expectedServerFingerprint: "A".repeat(64) });
    expect(r.next.checkPolicyGroup).toHaveBeenCalledWith(group.key); expect(r.next.checkEligibility).toHaveBeenCalledTimes(2);
    expect(r.prepared).toHaveBeenCalledOnce(); expect(r.commit).toHaveBeenCalledOnce(); expect(r.next.close).toHaveBeenCalledOnce();
    await expect(r.control.apply(p.ref, { credentials: r.credentials, confirmation: p.trust!.challenge }, r.ctx)).rejects.toMatchObject({ code: "expired" });
  });
  it.each([undefined, "wrong"])("refuses trust confirmation %s BEFORE either password destination", async confirmation => {
    const r = fixture(), p = await r.control.prepare(r.candidate(), r.ctx);
    await expect(r.control.apply(p.ref, { confirmation, credentials: r.credentials }, r.ctx)).rejects.toMatchObject({ code: "trust" });
    expect(r.old.signIn).not.toHaveBeenCalled(); expect(r.createDirectory).not.toHaveBeenCalled(); expect(r.commit).not.toHaveBeenCalled();
  });
  it("does not add a trust dialog for same-host search/password edits, and preserves the opaque old secret on reuse", async () => {
    const r = fixture(), c = r.candidate(); c.directory.url = r.source.config.url; c.directory.baseDn = "OU=People,DC=example,DC=test"; delete c.bindPassword;
    const p = await r.control.prepare(c, r.ctx); expect(p.trust).toBeNull();
    await r.control.apply(p.ref, { credentials: r.credentials }, r.ctx);
    expect(r.createDirectory.mock.calls[0]![1].bindPassword).toBe("\ufeff old service \n");
  });
  it.each(["url", "bindDn", "profile", "realm"] as const)("refuses implicit secret forwarding or identity-model change in %s", async field => {
    const r = fixture(), c = r.candidate(); c.directory.url = r.source.config.url; delete c.bindPassword;
    if (field === "profile") c.directory.profile = "openldap";
    else c.directory[field] = field === "url" ? "ldaps://another.example.test" : field === "realm" ? "different" : "CN=Another";
    await expect(r.control.prepare(c, r.ctx)).rejects.toMatchObject({ code: "invalid" }); expect(r.probeTls).not.toHaveBeenCalled();
  });
  it("refuses a foreign bind-secret reference before inspecting the candidate", async () => {
    const r = fixture(), c = r.candidate(); c.directory.bindPasswordRef = "foreign-secret-reference";
    await expect(r.control.prepare(c, r.ctx)).rejects.toMatchObject({ code: "invalid" });
    expect(r.probeTls).not.toHaveBeenCalled(); expect(r.old.signIn).not.toHaveBeenCalled(); expect(r.prepared).not.toHaveBeenCalled();
  });
  it("requires recent OLD-directory authentication and refuses a same-login/different immutable admin", async () => {
    const r = fixture(); let p = await r.control.prepare(r.candidate(), r.ctx);
    await expect(r.control.apply(p.ref, { confirmation: p.trust!.challenge }, r.ctx)).rejects.toMatchObject({ code: "reauthentication" });
    r.old.signIn.mockResolvedValueOnce({ ok: true, person: person(other) }); p = await r.control.prepare(r.candidate(), r.ctx);
    await expect(r.control.apply(p.ref, { confirmation: p.trust!.challenge, credentials: r.credentials }, r.ctx)).rejects.toMatchObject({ code: "denied" });
    expect(r.createDirectory).not.toHaveBeenCalled(); expect(r.commit).not.toHaveBeenCalled();
  });
  it("refuses a non-configured actor or an async current proof before network inspection", async () => {
    const r = fixture();
    await expect(r.control.prepare(r.candidate(), { ...r.ctx, actor: { ...r.ctx.actor, kind: "hub-administrator", person: other } })).rejects.toMatchObject({ code: "denied" });
    await expect(r.control.prepare(r.candidate(), { ...r.ctx, current: () => Promise.reject(Error("no async authority")) as unknown as boolean })).rejects.toMatchObject({ code: "denied" });
    await new Promise<void>(resolve => setImmediate(resolve)); expect(r.probeTls).not.toHaveBeenCalled();
  });
  it.each([-1, 0, 300_000])("checks clock AFTER the final synchronous authority callback, advance=%s", async advance => {
    const r = fixture(); let armed = false;
    r.ctx.current = () => { if (armed) { armed = false; r.tick(advance); } return true; };
    r.commit.mockImplementation((_ref, _actor, proof) => { armed = true; expect(proof()).toBe(true); return { receiptId: randomUUID(), directoryEpoch: 1 }; });
    if (advance) await expect(r.save()).rejects.toMatchObject({ code: "expired" });
    else expect(await r.save()).toMatchObject({ directoryEpoch: 1 });
  });
  it.each(["invalid-credentials", "not-eligible", "unavailable"] as const)("keeps the old state when trusted reauth answers %s", async reason => {
    const r = fixture(); r.old.signIn.mockResolvedValue({ ok: false, reason });
    await expect(r.save()).rejects.toMatchObject({ code: reason === "unavailable" ? "unavailable" : "denied" });
    expect(r.createDirectory).not.toHaveBeenCalled(); expect(r.commit).not.toHaveBeenCalled();
  });
  it.each(["wrong-key", "gone", "disabled", "unavailable"] as const)("rejects candidate immutable admin %s", async mode => {
    const r = fixture(); r.next.checkEligibility.mockResolvedValue(mode === "wrong-key" ? { eligible: true, person: person(other) } : { eligible: false, reason: mode });
    await expect(r.save()).rejects.toMatchObject({ code: mode === "unavailable" ? "unavailable" : "denied" });
    expect(r.commit).not.toHaveBeenCalled(); expect(r.next.close).toHaveBeenCalledOnce();
  });
  it.each(["unknown", "different-guid", "missing-reader"])("refuses configured group continuity %s", async mode => {
    const r = fixture();
    if (mode === "unknown") r.next.checkPolicyGroup.mockResolvedValue({ ok: false, reason: "unknown" });
    if (mode === "different-guid") r.next.checkPolicyGroup.mockResolvedValue({ ok: true, group: { key: other, dn: group.dn } });
    if (mode === "missing-reader") r.createDirectory.mockReturnValue({ ...r.next, checkPolicyGroup: undefined } as never);
    await expect(r.save()).rejects.toMatchObject({ code: "unavailable" }); expect(r.commit).not.toHaveBeenCalled();
  });
  it("never reuses a successful candidate test at save time", async () => {
    const r = fixture(), p = await r.control.prepare(r.candidate(), r.ctx);
    await r.control.test(p.ref, p.trust!.challenge, r.ctx);
    r.next.checkEligibility.mockResolvedValue({ eligible: false, reason: "disabled" });
    await expect(r.control.apply(p.ref, { confirmation: p.trust!.challenge, credentials: r.credentials }, r.ctx)).rejects.toMatchObject({ code: "denied" });
    expect(r.commit).not.toHaveBeenCalled(); expect(r.next.close).toHaveBeenCalledTimes(2);
  });
  it("rechecks the inspected leaf before sending the candidate service password", async () => {
    const r = fixture(), p = await r.control.prepare(r.candidate(), r.ctx); r.probeTls.mockResolvedValue("B".repeat(64));
    await expect(r.control.apply(p.ref, { confirmation: p.trust!.challenge, credentials: r.credentials }, r.ctx)).rejects.toMatchObject({ code: "trust" });
    expect(r.createDirectory).not.toHaveBeenCalled(); expect(r.commit).not.toHaveBeenCalled();
  });
  it.each(["expiry", "backward", "session", "epoch", "image", "close"])("fences %s while old-directory authentication is physically held", async mode => {
    const r = fixture(), held = deferred<Awaited<ReturnType<HubDirectory["signIn"]>>>(), entered = deferred<void>();
    r.old.signIn.mockImplementation(async () => { entered.resolve(); return held.promise; });
    const p = await r.control.prepare(r.candidate(), r.ctx), result = r.control.apply(p.ref, { credentials: r.credentials, confirmation: p.trust!.challenge }, r.ctx).catch(e => e);
    await entered.promise;
    if (mode === "expiry") r.tick(300_000); if (mode === "backward") r.tick(-1); if (mode === "session") r.live(false);
    if (mode === "epoch") r.source.epoch++; if (mode === "image") r.source.image = "b".repeat(64); if (mode === "close") r.control.close();
    held.resolve({ ok: true, person: person() });
    expect(await result).toMatchObject({ code: ["expiry", "backward"].includes(mode) ? "expired" : ["epoch", "image"].includes(mode) ? "stale" : "denied" });
    expect(r.createDirectory).not.toHaveBeenCalled(); expect(r.commit).not.toHaveBeenCalled();
  });
  it("captures nested inputs and callbacks before awaits, without accepting a replacement actor or candidate", async () => {
    const r = fixture(), held = deferred<string>(), entered = deferred<void>();
    r.probeTls.mockImplementationOnce(async () => { entered.resolve(); return held.promise; });
    const c = r.candidate(), ctx = { ...r.ctx, actor: structuredClone(r.ctx.actor) }, promise = r.control.prepare(c, ctx); await entered.promise;
    c.directory.url = "ldaps://substituted.example.test"; c.bindPassword = "replacement";
    if (ctx.actor.kind === "hub-administrator") ctx.actor.person = other;
    ctx.current = () => false; held.resolve("A".repeat(64)); const p = await promise;
    await expect(r.control.apply(p.ref, { confirmation: p.trust!.challenge, credentials: r.credentials }, ctx)).rejects.toMatchObject({ code: "denied" });
    await r.control.apply(p.ref, { confirmation: p.trust!.challenge, credentials: r.credentials }, r.ctx);
    expect(r.createDirectory.mock.calls[0]![0].url).toBe("ldaps://new.example.test"); expect(r.createDirectory.mock.calls[0]![1].bindPassword).toBe("\ufeff candidate service \n");
  });
  it("a recent SERVER sign-in still requires fresh old-directory eligibility and expires at five minutes", async () => {
    const r = fixture(); r.deps.recentAuthentication = () => r.time() - 299_999;
    const p = await r.control.prepare(r.candidate(), r.ctx);
    await r.control.apply(p.ref, { confirmation: p.trust!.challenge }, r.ctx);
    expect(r.old.signIn).not.toHaveBeenCalled(); expect(r.old.checkEligibility).toHaveBeenCalledOnce();
    r.deps.recentAuthentication = () => r.time() - 300_000;
    const q = await r.control.prepare(r.candidate(), r.ctx);
    await expect(r.control.apply(q.ref, { confirmation: q.trust!.challenge }, r.ctx)).rejects.toMatchObject({ code: "reauthentication" });
  });
  it.each(["image", "epoch", "unchanged"] as const)("binds cached password authentication to its source: %s", async change => {
    const r = fixture(); await r.save(); expect(r.old.signIn).toHaveBeenCalledOnce();
    if (change === "image") r.source.image = "b".repeat(64);
    if (change === "epoch") r.source.epoch++;
    const p = await r.control.prepare(r.candidate(), r.ctx);
    const result = r.control.apply(p.ref, { confirmation: p.trust!.challenge }, r.ctx);
    if (change === "unchanged") {
      await expect(result).resolves.toMatchObject({ directoryEpoch: 1 });
      expect(r.old.checkEligibility).toHaveBeenCalledOnce(); expect(r.commit).toHaveBeenCalledTimes(2);
    } else {
      await expect(result).rejects.toMatchObject({ code: "reauthentication" });
      expect(r.old.checkEligibility).not.toHaveBeenCalled(); expect(r.commit).toHaveBeenCalledOnce();
    }
    expect(r.old.signIn).toHaveBeenCalledOnce(); // No implicit new authentication, whether reuse was allowed or refused.
  });
  it("D3 host recovery never authenticates against an unavailable old directory or invents an admin session", async () => {
    const r = fixture(); r.old.signIn.mockRejectedValue(Error("outage"));
    const ctx = { ...r.ctx, actor: { kind: "host-owner" as const, sessionId: "owned-D3-session", requestId: randomUUID() } };
    const p = await r.control.prepare(r.candidate(), ctx); await r.control.apply(p.ref, { confirmation: p.trust!.challenge }, ctx);
    expect(r.old.signIn).not.toHaveBeenCalled(); expect(r.prepared.mock.calls[0]![1]).toEqual(ctx.actor); expect(r.next.checkEligibility).toHaveBeenCalled();
  });
  it("refuses personal credentials on host recovery without forwarding them or reaching the writer", async () => {
    const r = fixture(), ctx = { ...r.ctx, actor: { kind: "host-owner" as const, sessionId: "owned-D3-session", requestId: randomUUID() } };
    const p = await r.control.prepare(r.candidate(), ctx);
    await expect(r.control.apply(p.ref, { confirmation: p.trust!.challenge, credentials: r.credentials }, ctx)).rejects.toMatchObject({ code: "invalid" });
    expect(r.old.signIn).not.toHaveBeenCalled(); expect(r.createDirectory).not.toHaveBeenCalled(); expect(r.commit).not.toHaveBeenCalled();
    await expect(r.control.apply(p.ref, { confirmation: p.trust!.challenge }, ctx)).rejects.toMatchObject({ code: "expired" });
  });
  it("an expired OLD sealed CA does not prevent D3 preparing its replacement", async () => {
    const certs = directoryCertificates();
    try {
      const r = fixture(); r.source.config.caPem = certs.ca; r.tick(3 * 24 * 60 * 60_000);
      const c = r.candidate(); delete c.directory.caPem;
      const ctx = { ...r.ctx, actor: { kind: "host-owner" as const, sessionId: "owned-D3-session", requestId: randomUUID() } };
      expect((await r.control.prepare(c, ctx)).trust).toMatchObject({ systemRoots: true, caFingerprints: [] });
      expect(r.createDirectory).not.toHaveBeenCalled();
    } finally { certs.cleanup(); }
  });
  it.each([0, 1])("bounds a recent authentication through a held candidate read, advance=%s", async advance => {
    const r = fixture(), held = deferred<Awaited<ReturnType<HubDirectory["checkEligibility"]>>>(), entered = deferred<void>();
    r.deps.recentAuthentication = () => r.time() - 299_999;
    r.next.checkEligibility.mockImplementationOnce(async () => { entered.resolve(); return held.promise; });
    const p = await r.control.prepare(r.candidate(), r.ctx), result = r.control.apply(p.ref, { confirmation: p.trust!.challenge }, r.ctx).catch(e => e);
    await entered.promise; r.tick(advance); held.resolve({ eligible: true, person: person() });
    expect(await result).toMatchObject(advance ? { code: "expired" } : { directoryEpoch: 1 });
    expect(r.commit).toHaveBeenCalledTimes(advance ? 0 : 1);
  });
  it("shares the composition's total32 admission across different administrator identities", async () => {
    const r = fixture(), held = deferred<string>(), entered = deferred<void>(); let reads = 0;
    const controls = Array.from({ length: 33 }, (_, n) => {
      const key = { ...who, objectId: `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111` };
      const source = { ...r.source, administrator: key };
      const control = createHubDirectorySettingsProof({ ...r.deps, source: () => source,
        probeTls: async () => { if (++reads === 32) entered.resolve(); return held.promise; } });
      cleanups.push(() => control.close());
      return { control, ctx: { ...r.ctx, actor: { ...r.ctx.actor, kind: "hub-administrator" as const, person: key } } };
    });
    const pending = controls.slice(0, 32).map(c => c.control.prepare(r.candidate(), c.ctx)); await entered.promise;
    await expect(controls[32]!.control.prepare(r.candidate(), controls[32]!.ctx)).rejects.toMatchObject({ code: "unavailable" }); expect(reads).toBe(32);
    held.resolve("A".repeat(64)); await Promise.all(pending);
    await expect(controls[32]!.control.prepare(r.candidate(), controls[32]!.ctx)).resolves.toHaveProperty("ref");
  });
  it("uses the shared four-read cap and retains a cancelled physical read until it AND close settle", async () => {
    const r = fixture(), held = deferred<Awaited<ReturnType<HubDirectory["checkEligibility"]>>>(), closed = deferred<void>();
    let entered = 0; const allEntered = deferred<void>();
    r.next.checkEligibility.mockImplementation(async () => { if (++entered === 4) allEntered.resolve(); return held.promise; });
    r.next.close.mockImplementation(() => closed.promise);
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const contexts = controllers.map(controller => ({ ...r.ctx, signal: controller.signal }));
    const pending: Promise<unknown>[] = [];
    // Prepare every draft before occupying the cap; normal startup is not serialized to hide admission.
    const pages = [];
    for (let i = 0; i < 5; i++) pages.push(await r.control.prepare(r.candidate(), r.ctx));
    for (let i = 0; i < 4; i++) pending.push(r.control.apply(pages[i]!.ref, { credentials: r.credentials, confirmation: pages[i]!.trust!.challenge }, contexts[i]!).catch(e => e));
    await allEntered.promise;
    const blocked = r.control.apply(pages[4]!.ref, { credentials: r.credentials, confirmation: pages[4]!.trust!.challenge }, r.ctx);
    await expect(blocked).rejects.toMatchObject({ code: "unavailable" }); expect(entered).toBe(4);
    controllers.forEach(controller => controller.abort());
    held.resolve({ eligible: true, person: person() }); await vi.waitFor(() => expect(r.next.close).toHaveBeenCalledTimes(4));
    await expect(r.control.prepare(r.candidate(), r.ctx)).rejects.toMatchObject({ code: "unavailable" }); // closing still owns all four slots
    closed.resolve(); await Promise.all(pending); expect(r.commit).not.toHaveBeenCalled();
    r.next.checkEligibility.mockResolvedValue({ eligible: true, person: person() }); r.next.close.mockResolvedValue();
    expect(await r.save()).toMatchObject({ directoryEpoch: 1 });
  });
  it("limits password attempts independently of ordinary eligibility admission", async () => {
    const r = fixture(); r.old.signIn.mockResolvedValue({ ok: false, reason: "invalid-credentials" });
    for (let n = 0; n < 5; n++) await expect(r.save()).rejects.toMatchObject({ code: "denied" });
    await expect(r.save()).rejects.toMatchObject({ code: "busy" }); expect(r.old.signIn).toHaveBeenCalledTimes(5);
  });
});

// The handle is server-only and separate from candidate/body data. The SQL participant verifies its private provenance.
it("passes the exact request-local rotation through the authority controller without serializing it into the candidate", async () => {
  const r = fixture(), p = await r.control.prepare(r.candidate(), r.ctx), rotation = Object.freeze({ discard() {} });
  await r.control.apply(p.ref, { credentials:r.credentials, confirmation:p.trust?.challenge }, r.ctx, rotation);
  expect(r.commit.mock.calls[0]?.[3]).toBe(rotation);
  expect(r.prepared.mock.calls[0]?.[0]).not.toHaveProperty("rotation");
});
