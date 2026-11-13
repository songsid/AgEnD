/** Actual Core/session/role preparation and SQL; fictional directory and source material only. */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { HubCore } from "../src/hub/http/core.js";
import { HubSessions } from "../src/hub/sessions.js";
import { hubTxDatabase } from "../src/hub/db.js";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import { createHubRoleAuthorizationClock } from "../src/hub/roles/clock.js";
import { createHubManagementAuthority } from "../src/hub/roles/authority.js";
import { assertHubDirectoryActor, assertHubDirectoryAdministration, bindHubDirectoryAdministration, bindHubDirectoryPreparation } from "../src/hub/roles/directory-authority.js";
import { recentHubDirectoryAuthentication, prepareHubDirectorySessionRotation, type HubDirectorySessionPreparation } from "../src/hub/session-directory-transition.js";
import { createHubDirectorySettingsDecision, HUB_DIRECTORY_SETTINGS_MIGRATION, type HubDirectoryDecisionRequest } from "../src/hub/settings-directory-decision.js";
import { createHubManagementPolicyReader } from "../src/hub/roles/read.js";

async function world(root = false) {
  const w = await roleAuthorityWorld({ cutover: true });
  HUB_DIRECTORY_SETTINGS_MIGRATION.up(w.db);
  const decision = createHubDirectorySettingsDecision({ db: w.db, hubId: w.hubId, transport: w.store, roleProofs: true });
  const clock = createHubRoleAuthorizationClock({ db: w.db, hubId: w.hubId, root: w.root, realm: "corp", generation: "g1", transport: w.store,
    current: w.options.current, now: w.options.now });
  const authority = createHubManagementAuthority({ ...w.options, assertAuthorizationTime: clock.assertAuthorizationTime,
    directoryDecision: { db: w.db, hubId: w.hubId, assertAuthorizationTime: clock.assertDirectoryDecision } });
  w.core.deps.management = authority;
  const ctx = root ? await w.browser(w.root) : w.ctx;
  const p = await w.core.directoryPreparation(ctx.ctx), actor = { kind: "hub-administrator" as const, person: p.actor.person,
    sessionId: p.actor.sessionId, requestId: ctx.ctx.requestId };
  const source = { directory: w.directory, administrator: w.root, image: "a".repeat(64), epoch: 0, decisionProof: decision.administrationProof };
  const proof: HubDirectorySessionPreparation = { preparation: bindHubDirectoryPreparation(p, actor, source), source };
  return { ...w, ctx, authority, clock, decision, p, actor, source, proof };
}
describe("S129 preparation-only session boundary", () => {
  it("reads the real auxiliary sign-in attestation after a slow bounded preparation", async () => {
    const w = await world(); w.time(90000); w.elapsed(90000);
    expect(() => recentHubDirectoryAuthentication(w.core, w.actor, w.proof)).not.toThrow();
    expect(recentHubDirectoryAuthentication(w.core, w.actor, w.proof)).toBe(100);
  });
  it("prepares only the real auxiliary token's rotation after that slow preparation", async () => {
    const w = await world(); w.time(90000); w.elapsed(90000);
    expect(() => prepareHubDirectorySessionRotation(w.core, w.ctx.token, w.actor, w.proof)).not.toThrow();
  });
  it("forwards preparation through the actual HubSessions entry points", async () => {
    const w = await world();
    expect(() => w.sessions.recentAuthentication(w.actor, w.proof)).not.toThrow();
    expect(w.sessions.recentAuthentication(w.actor, w.proof)).toBe(100);
    expect(() => w.sessions.prepareDirectoryRotation(w.ctx.token, w.actor, w.proof)).not.toThrow();
  });
  it("keeps a bare auxiliary identity outside both helpers", async () => {
    const w = await world();
    expect(recentHubDirectoryAuthentication(w.core, w.actor)).toBeNull();
    expect(() => prepareHubDirectorySessionRotation(w.core, w.ctx.token, w.actor)).toThrow();
  });
  it("keeps the configured root's old preparation contract", async () => {
    const w = await world(), browser = await w.browser(w.root), found = await browser.ctx.current();
    if (found.kind !== "directory") throw Error("owned root");
    const actor = { kind: "hub-administrator" as const, person: found.person, sessionId: found.sessionId, requestId: browser.ctx.requestId };
    expect(recentHubDirectoryAuthentication(w.core, actor)).toBe(100);
    expect(() => prepareHubDirectorySessionRotation(w.core, browser.token, actor)).not.toThrow();
  });
  it("does not lengthen an ordinary effect witness", async () => {
    const w = await world(), permit = await w.core.management(w.ctx.ctx, "hub.admin");
    if (!("permission" in permit)) throw Error("owned named proof");
    const proof = { witness: bindHubDirectoryAdministration(permit, w.actor, w.source), source: w.source };
    w.time(5000);
    expect(() => recentHubDirectoryAuthentication(w.core, w.actor, proof)).toThrow();
    expect(() => prepareHubDirectorySessionRotation(w.core, w.ctx.token, w.actor, proof)).toThrow();
  });
  it("does not turn preparation into ordinary effect authorization", async () => {
    const w = await world();
    expect(() => assertHubDirectoryActor({ actor: w.actor, preparation: w.proof.preparation }, w.source)).toThrow();
  });
  it.each(["forged", "person", "session", "request", "directory", "root", "epoch", "image", "frame", "wall-expired", "elapsed-expired",
    "cancel", "consumed", "role-loss", "signout", "core-provider", "clock-rollback"] as const)("refuses %s at both preparation-only entries", async mode => {
    const w = await world(), actor = structuredClone(w.actor), proof: HubDirectorySessionPreparation = { ...w.proof, source: { ...w.source } };
    if (mode === "forged") proof.preparation = { directoryPreparation: true };
    if (mode === "person") actor.person = w.other;
    if (mode === "session") actor.sessionId = randomUUID();
    if (mode === "request") actor.requestId = randomUUID();
    if (mode === "directory") proof.source.directory = {};
    if (mode === "root") proof.source.administrator = w.other;
    if (mode === "epoch") proof.source.epoch++;
    if (mode === "image") proof.source.image = "b".repeat(64);
    if (mode === "frame") proof.source.decisionProof = () => null;
    if (mode === "wall-expired") w.time(300000);
    if (mode === "elapsed-expired") w.elapsed(300000);
    if (mode === "cancel") w.p.retire();
    if (mode === "consumed") await w.p.authorize();
    if (mode === "role-loss") w.save({ ...w.policy, revision: 2, assignments: [] });
    if (mode === "signout") w.sessions.signOut(w.ctx.token);
    if (mode === "core-provider") w.core.deps.management = { ...w.authority };
    if (mode === "clock-rollback") w.time(-1);
    const audits = w.db.prepare("SELECT count(*) AS n FROM hub_audit").get();
    expect(() => recentHubDirectoryAuthentication(w.core, actor, proof)).toThrow();
    expect(() => prepareHubDirectorySessionRotation(w.core, w.ctx.token, actor, proof)).toThrow();
    expect(w.decision.inspect().operationId).toBeNull();
    expect(w.db.prepare("SELECT count(*) AS n FROM hub_audit").get()).toEqual(audits);
  });
  it("refuses mixed or empty proof envelopes even with valid opaque handles", async () => {
    const w = await world(), permit = await w.core.management(w.ctx.ctx, "hub.admin");
    if (!("permission" in permit)) throw Error("owned named proof");
    const witness = bindHubDirectoryAdministration(permit, w.actor, w.source);
    const mixed = { ...w.proof, witness }, empty = { source: w.source } as HubDirectorySessionPreparation;
    for (const proof of [mixed, empty]) {
      expect(() => recentHubDirectoryAuthentication(w.core, w.actor, proof)).toThrow();
      expect(() => prepareHubDirectorySessionRotation(w.core, w.ctx.token, w.actor, proof)).toThrow();
    }
  });
  it.each(["directory", "root", "epoch"] as const)("refuses a genuinely bound preparation from a foreign %s source", async mode => {
    const w = await world(), source = { ...w.source };
    const directory = mode === "directory" ? { ...w.directory } : w.directory, root = mode === "root" ? w.other : w.root;
    const authority = createHubManagementAuthority({ ...w.options, directory, root, assertAuthorizationTime: w.clock.assertAuthorizationTime });
    const prepared = await authority.prepareDirectory(w.ctx.ctx);
    source.directory = directory; source.administrator = root;
    if (mode === "epoch") source.epoch++;
    const proof = { preparation: bindHubDirectoryPreparation(prepared, w.actor, source), source };
    expect(() => recentHubDirectoryAuthentication(w.core, w.actor, proof)).toThrow();
    expect(() => prepareHubDirectorySessionRotation(w.core, w.ctx.token, w.actor, proof)).toThrow();
  });
  it("refuses another actual token while keeping the valid prepared token usable", async () => {
    const w = await world(), other = await w.browser(w.root);
    expect(() => prepareHubDirectorySessionRotation(w.core, other.token, w.actor, w.proof)).toThrow();
    expect(() => prepareHubDirectorySessionRotation(w.core, w.ctx.token, w.actor, w.proof)).not.toThrow();
  });
  it("keeps missing authentication attestation missing without creating or renewing it", async () => {
    const w = await world(); w.db.prepare("DELETE FROM hub_session_authentication WHERE session_id=?").run(w.actor.sessionId);
    expect(recentHubDirectoryAuthentication(w.core, w.actor, w.proof)).toBeNull();
    expect(w.db.prepare("SELECT * FROM hub_session_authentication WHERE session_id=?").get(w.actor.sessionId)).toBeUndefined();
  });
  it.each([false, true])("keeps fresh effect and successor authority mandatory for a preparation-marked rotation (root=%s)", async root => {
    const w = await world(root), rotation = prepareHubDirectorySessionRotation(w.core, w.ctx.token, w.actor, w.proof);
    w.time(90000); w.elapsed(90000);
    const effect = await w.p.authorize(), witness = bindHubDirectoryAdministration(effect, w.actor, w.source);
    const material = (letter: string) => Object.fromEntries(["configDigest", "configSha", "directorySha", "manifestSha", "bindSecretSha"]
      .map(key => [key, letter.repeat(64)])) as HubDirectoryDecisionRequest["before"];
    const request: HubDirectoryDecisionRequest = { id: randomUUID(), expected: w.decision.inspect(), before: material("a"), after: material("b"),
      generation: "g2", receiptSha: "c".repeat(64), actor: w.actor, at: w.options.now(), changes: ["server"], recipients: [{ kind: "host", sink: "owned" }] };
    const operation = w.decision.decide(request, () => assertHubDirectoryAdministration(witness, w.actor, w.source), rotation);
    const clock = createHubRoleAuthorizationClock({ db: w.db, hubId: w.hubId, root: w.root, realm: "corp", generation: "g2", transport: w.store,
      current: w.options.current, now: w.options.now });
    const management = createHubManagementAuthority({ ...w.options,
      policy: createHubManagementPolicyReader({ db: w.db, hubId: w.hubId, realm: "corp", generation: "g2", current: w.options.current }),
      assertAuthorizationTime: clock.assertAuthorizationTime });
    const successor = new HubSessions(new HubCore({ ...w.core.deps, management }, hubTxDatabase));
    expect(() => successor.completeDirectoryRotation(rotation, operation.id)).toThrow();
    const released = await successor.completeRoleDirectoryRotation(rotation, operation.id);
    expect(successor.session(released.token)?.person).toEqual(w.actor.person);
    expect(w.sessions.session(w.ctx.token)).toBeNull();
    expect(w.decision.operation(operation.id).actor).toEqual(w.actor);
    const policy = JSON.parse((w.db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }).body);
    expect(policy.assignments).toEqual(w.policy.assignments); expect(policy.denies).toEqual(w.policy.denies);
  });
});
