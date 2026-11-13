/** Actual SQL/session/role proof, fictional directory; no public route or token logged. */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createHubGroupPolicyStore } from "../src/hub/group-policy/store.js";
import { HubCore } from "../src/hub/http/core.js";
import { HubSessions } from "../src/hub/sessions.js";
import { hubTxDatabase } from "../src/hub/db.js";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import { createHubRoleAuthorizationClock } from "../src/hub/roles/clock.js";
import { createHubManagementAuthority } from "../src/hub/roles/authority.js";
import { bindHubDirectoryAdministration, type HubDirectoryAdministration, type HubDirectoryAdministrationBinding } from "../src/hub/roles/directory-authority.js";
import { createHubDirectorySettingsDecision, HUB_DIRECTORY_SETTINGS_MIGRATION } from "../src/hub/settings-directory-decision.js";
import { recentHubDirectoryAuthentication, prepareHubDirectorySessionRotation, completeHubRoleDirectorySessionRotation } from "../src/hub/session-directory-transition.js";
import { assertHubDirectoryAdministration } from "../src/hub/roles/directory-authority.js";
import type { HubDirectoryDecisionRequest } from "../src/hub/settings-directory-decision.js";

type Administration = { witness: HubDirectoryAdministration; source: HubDirectoryAdministrationBinding };
type Actor = Parameters<typeof recentHubDirectoryAuthentication>[1];
const recent = recentHubDirectoryAuthentication, prepare = prepareHubDirectorySessionRotation;
function held() { let enter!: () => void, release!: () => void; return { entered: new Promise<void>(r => { enter = r; }), wait: new Promise<void>(r => { release = r; }), enter: () => enter(), release: () => release() }; }
async function world(root = false) {
  const w = await roleAuthorityWorld({ cutover: true }); HUB_DIRECTORY_SETTINGS_MIGRATION.up(w.db);
  const decision = createHubDirectorySettingsDecision({ db: w.db, transport: w.store, hubId: w.hubId, roleProofs: true });
  const clock = createHubRoleAuthorizationClock({ db: w.db, hubId: w.hubId, root: w.root, realm: "corp", generation: "g1", transport: w.store,
    current: w.options.current, now: w.options.now });
  const authority = createHubManagementAuthority({ ...w.options, assertAuthorizationTime: clock.assertAuthorizationTime,
    directoryDecision: { db: w.db, hubId: w.hubId, assertAuthorizationTime: clock.assertDirectoryDecision } });
  const browser = root ? await w.browser(w.root) : w.ctx, found = await browser.ctx.current();
  if (found.kind !== "directory") throw Error("owned actor");
  const actor: Actor = { kind: "hub-administrator", person: found.person, sessionId: found.sessionId, requestId: browser.ctx.requestId };
  const source: HubDirectoryAdministrationBinding = { directory: w.directory, administrator: w.root, epoch: 0, image: "a".repeat(64), decisionProof: decision.administrationProof };
  const administration = { witness: bindHubDirectoryAdministration(await authority.require(browser.ctx, "hub.admin"), actor, source), source };
  const commit = () => {
    const rotation = prepare(w.core, browser.token, actor, administration);
    const image = (s: string) => Object.fromEntries(["configDigest", "configSha", "directorySha", "manifestSha", "bindSecretSha"].map(k => [k, s.repeat(64)])) as HubDirectoryDecisionRequest["before"];
    const request: HubDirectoryDecisionRequest = { id: randomUUID(), expected: decision.inspect(), before: image("a"), after: image("b"), generation: "g2",
      receiptSha: "c".repeat(64), actor, at: w.options.now(), changes: ["server"], recipients: [{ kind: "host", sink: "owned" }] };
    const operation = decision.decide(request, () => assertHubDirectoryAdministration(administration.witness, actor, source), rotation);
    return { rotation, operation };
  };
  const next = () => {
    const clock = createHubRoleAuthorizationClock({ db: w.db, hubId: w.hubId, root: w.root, realm: "corp", generation: "g2", transport: w.store,
      current: w.options.current, now: w.options.now });
    const pool = createHubGroupPolicyStore({ db: w.db, hubId: w.hubId, realm: "corp", generation: "g2", directory: w.directory, audit: w.audit,
      current: w.options.current, now: w.options.now, reads: w.pool, roles: { root: w.root, assertAuthorizationTime: clock.assertAuthorizationTime } });
    const authority = createHubManagementAuthority({ ...w.options, policy: () => pool.canonical!(), reads: pool, assertAuthorizationTime: clock.assertAuthorizationTime });
    const core = new HubCore({ ...w.core.deps, management: authority }, hubTxDatabase);
    return { core, authority, sessions: new HubSessions(core) };
  };
  return { ...w, authority, decision, signInBrowser: w.browser, browser, actor, administration, commit, next };
}

describe("S129 auxiliary directory session preparation", () => {
  it("reads actual recent sign-in attestation for an auxiliary admin with an opaque named proof", async () => {
    const w = await world(); expect(recent(w.core, w.actor, w.administration)).toBe(100);
  });
  it("prepares the actual auxiliary browser's exact token-bound rotation with that proof", async () => {
    const w = await world();
    expect(() => prepare(w.core, w.browser.token, w.actor, w.administration)).not.toThrow();
  });
  it("keeps a bare auxiliary identity outside both session helpers", async () => {
    const w = await world();
    expect(recent(w.core, w.actor)).toBeNull();
    expect(() => prepare(w.core, w.browser.token, w.actor)).toThrow();
  });
  it("keeps the root's legacy attestation and rotation contract", async () => {
    const w = await world(true);
    expect(recent(w.core, w.actor)).toBe(100);
    expect(() => prepare(w.core, w.browser.token, w.actor)).not.toThrow();
  });
  it("forwards the opaque proof through the actual HubSessions methods", async () => {
    const w = await world();
    expect(w.sessions.recentAuthentication(w.actor, w.administration)).toBe(100);
    expect(() => w.sessions.prepareDirectoryRotation(w.browser.token, w.actor, w.administration)).not.toThrow();
  });
  it.each(["forged", "person", "session", "request", "directory", "root", "epoch", "image", "expired", "role-loss"] as const)(
    "refuses %s at both preparation entry points", async mode => {
      const w = await world(), actor = structuredClone(w.actor), proof: Administration = { ...w.administration, source: { ...w.administration.source } };
      if (mode === "forged") proof.witness = { directoryAdministration: true };
      if (mode === "person") actor.person = w.root;
      if (mode === "session") actor.sessionId = randomUUID();
      if (mode === "request") actor.requestId = randomUUID();
      if (mode === "directory") proof.source.directory = {};
      if (mode === "root") proof.source.administrator = w.other;
      if (mode === "epoch") proof.source.epoch++;
      if (mode === "image") proof.source.image = "b".repeat(64);
      if (mode === "expired") w.time(5000);
      if (mode === "role-loss") w.save({ ...w.policy, revision: 2, assignments: [] });
      expect(() => recent(w.core, actor, proof)).toThrow();
      expect(() => prepare(w.core, w.browser.token, actor, proof)).toThrow();
      expect(w.db.prepare("SELECT id FROM hub_settings_operations").all()).toEqual([]);
    });
  it("does not substitute another real browser token for the bound actor's token", async () => {
    const w = await world(), other = await w.signInBrowser(w.root);
    expect(() => prepare(w.core, other.token, w.actor, w.administration)).toThrow();
  });
  it.each(["directory", "root", "epoch"] as const)("refuses an actual witness rebound to a foreign %s source", async mode => {
    const w = await world(), source = { ...w.administration.source };
    if (mode === "directory") source.directory = {};
    if (mode === "root") source.administrator = w.other;
    if (mode === "epoch") source.epoch++;
    const proof = { source, witness: bindHubDirectoryAdministration(await w.authority.require(w.browser.ctx, "hub.admin"), w.actor, source) };
    expect(() => recent(w.core, w.actor, proof)).toThrow();
    expect(() => prepare(w.core, w.browser.token, w.actor, proof)).toThrow();
  });
});

describe("S129 successor release under the new role generation", () => {
  it("releases only through fresh hub.admin for the actual successor and never grants root self-use", async () => {
    const w = await world(), { rotation, operation } = w.commit(), n = w.next();
    w.eligible.mockClear();
    const released = await n.sessions.completeRoleDirectoryRotation(rotation, operation.id);
    expect(w.eligible).toHaveBeenCalledExactlyOnceWith(w.admin);
    expect(n.sessions.session(released.token)?.person).toEqual(w.admin);
    expect(n.sessions.recentAuthentication({ ...w.actor, sessionId: n.sessions.session(released.token)!.sessionId })).toBeNull();
    expect(() => w.sessions.completeDirectoryRotation(rotation, operation.id)).toThrow();
    await expect(n.sessions.completeRoleDirectoryRotation(rotation, operation.id)).rejects.toThrow();
    const policy = JSON.parse((w.db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }).body);
    expect(policy.assignments).toEqual(w.policy.assignments); expect(policy.denies).toEqual(w.policy.denies);
  });
  it("will not release a witness-prepared root through the legacy completion path", async () => {
    const w = await world(true), { rotation, operation } = w.commit(), n = w.next();
    expect(() => n.sessions.completeDirectoryRotation(rotation, operation.id)).toThrow();
    await expect(n.sessions.completeRoleDirectoryRotation(rotation, operation.id)).resolves.toHaveProperty("maxAgeMs");
  });
  it("refuses the old mounted session generation before a directory read", async () => {
    const w = await world(), { rotation, operation } = w.commit(); w.core.deps.management = w.authority; w.eligible.mockClear();
    await expect(w.sessions.completeRoleDirectoryRotation(rotation, operation.id)).rejects.toThrow();
    expect(w.eligible).not.toHaveBeenCalled();
  });
  it.each(["permission", "eligibility", "wrong-operation", "missing-authority"] as const)("permanently refuses %s at successor release", async mode => {
    const w = await world(), { rotation, operation } = w.commit(), n = w.next();
    if (mode === "permission") w.save({ ...w.policy, generation: "g2", revision: 3, assignments: [] });
    if (mode === "eligibility") w.eligible.mockResolvedValue({ eligible: false, reason: "unavailable" });
    if (mode === "missing-authority") n.core.deps.management = undefined;
    await expect(n.sessions.completeRoleDirectoryRotation(rotation, mode === "wrong-operation" ? randomUUID() : operation.id)).rejects.toThrow();
    await expect(n.sessions.completeRoleDirectoryRotation(rotation, operation.id)).rejects.toThrow();
  });
  it("requires the exact successor even when a different real root session is supplied", async () => {
    const w = await world(), { rotation, operation } = w.commit(), n = w.next(), root = await n.sessions.signIn(w.root.objectId, "synthetic");
    const context = n.sessions.context({ headers: { cookie: `__Host-agend_hub_${w.hubId}=${root.token}` } } as never);
    await expect(completeHubRoleDirectorySessionRotation(n.core, rotation, operation.id, () => context)).rejects.toThrow();
  });
  it("allows one physical fresh read and refuses a second release without cancelling the first", async () => {
    const w = await world(), { rotation, operation } = w.commit(), n = w.next(), h = held(), extra = held(); let calls = 0;
    w.eligible.mockClear();
    w.eligible.mockImplementation(async who => { if (++calls > 1) extra.enter(); h.enter(); await h.wait; return { eligible: true, person: w.person(who) }; });
    const first = n.sessions.completeRoleDirectoryRotation(rotation, operation.id); await h.entered;
    const second = n.sessions.completeRoleDirectoryRotation(rotation, operation.id);
    try {
      expect(await Promise.race([second.then(() => "released", () => "refused"), extra.entered.then(() => "extra-read")])).toBe("refused");
      expect(w.eligible).toHaveBeenCalledOnce();
    } finally { h.release(); await Promise.allSettled([first, second]); }
    await expect(first).resolves.toHaveProperty("maxAgeMs");
  });
  it("rejects a changed persisted successor declaration before another directory read", async () => {
    const w = await world(), { rotation, operation } = w.commit(), n = w.next();
    w.db.prepare("UPDATE hub_settings_operations SET body=? WHERE id=?").run(JSON.stringify({ ...operation,
      browserSession: { ...operation.browserSession, sessionId: randomUUID() } }), operation.id);
    w.eligible.mockClear();
    await expect(n.sessions.completeRoleDirectoryRotation(rotation, operation.id)).rejects.toThrow();
    expect(w.eligible).not.toHaveBeenCalled();
  });
  it("re-proves the role after the fresh directory read and before publishing the token", async () => {
    const w = await world(), { rotation, operation } = w.commit(), n = w.next(); let proved = false, changed = false;
    const require = n.core.management.bind(n.core);
    n.core.management = async (ctx, permission) => { const permit = await require(ctx, permission); proved = true; return permit; };
    n.core.deps.now = () => {
      if (proved && !changed) { changed = true; w.save({ ...w.policy, generation: "g2", revision: 3, assignments: [] }); }
      return w.options.now();
    };
    await expect(n.sessions.completeRoleDirectoryRotation(rotation, operation.id)).rejects.toThrow();
    expect(changed).toBe(true);
  });
  it.each(["cancel", "policy", "provider", "deadline", "signout", "root", "config", "directory", "uow"] as const)("retires %s during fresh successor authorization", async mode => {
    const w = await world(), { rotation, operation } = w.commit();
    if (mode === "deadline") w.time(299_995); // Old permit expired; the new proof is acquired just before rotation expiry.
    const n = w.next(), h = held();
    w.eligible.mockImplementation(async who => { h.enter(); await h.wait; return { eligible: true, person: w.person(who) }; });
    const first = n.sessions.completeRoleDirectoryRotation(rotation, operation.id); await h.entered;
    if (mode === "cancel") rotation.discard();
    if (mode === "policy") w.save({ ...w.policy, generation: "g2", revision: 3, assignments: [] });
    if (mode === "provider") n.core.deps.management = undefined;
    if (mode === "root") (n.core.deps.config as { administrator: typeof w.root }).administrator = w.other; // Owned hostile mutation of a readonly boundary.
    if (mode === "config") n.core.deps.config = { ...n.core.deps.config };
    if (mode === "directory") n.core.deps.directory = { ...w.directory };
    if (mode === "uow") n.core.deps.uow = { ...n.core.deps.uow };
    if (mode === "deadline") w.time(10);
    if (mode === "signout") w.db.prepare("UPDATE hub_sessions SET state='ended' WHERE directory_epoch=1").run();
    h.release(); await expect(first).rejects.toThrow();
    await expect(n.sessions.completeRoleDirectoryRotation(rotation, operation.id)).rejects.toThrow();
  });
});
