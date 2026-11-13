/** Actual directory SQL decision/role/session/floor logic; file images are inert hashes, not a Save route. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import { createHubDirectorySettingsDecision, HUB_DIRECTORY_SETTINGS_MIGRATION, type HubDirectoryDecisionRequest } from "../src/hub/settings-directory-decision.js";
import { inspectHubDirectoryDecisionProof, type HubDirectoryDecisionProof } from "../src/hub/directory-decision-proof.js";
import { createHubRoleAuthorizationClock } from "../src/hub/roles/clock.js";
import { createHubManagementAuthority } from "../src/hub/roles/authority.js";

async function world(roleProofs = false, bridge = false) {
  const w = await roleAuthorityWorld({ cutover: bridge }); HUB_DIRECTORY_SETTINGS_MIGRATION.up(w.db);
  let authority = w.authority, clock: ReturnType<typeof createHubRoleAuthorizationClock> | undefined;
  let clockHook: () => void = () => {};
  let decisionOptions: NonNullable<Parameters<typeof createHubManagementAuthority>[0]["directoryDecision"]> | undefined;
  if (bridge) {
    clock = createHubRoleAuthorizationClock({ db: w.db, hubId: w.hubId, root: w.root, realm: "corp", generation: "g1",
      transport: w.store, current: w.options.current, now: w.options.now });
    const actualClock = clock;
    decisionOptions = { db: w.db, hubId: w.hubId, assertAuthorizationTime(proof) { actualClock.assertDirectoryDecision(proof); clockHook(); } };
    authority = createHubManagementAuthority({ ...w.options, assertAuthorizationTime: clock.assertAuthorizationTime, directoryDecision: decisionOptions });
  }
  const decision = createHubDirectorySettingsDecision({ db: w.db, transport: w.store, hubId: w.hubId, roleProofs });
  const actor = await w.ctx.ctx.current(); if (actor.kind !== "directory") throw Error("fixture directory actor");
  const image = (v: string) => ({ configDigest: v.repeat(64), configSha: v.repeat(64), directorySha: v.repeat(64), manifestSha: v.repeat(64), bindSecretSha: v.repeat(64) });
  const input: HubDirectoryDecisionRequest = { id: randomUUID(), expected: decision.inspect(), before: image("a"), after: image("b"), generation: "g2", receiptSha: "c".repeat(64),
    actor: { kind: "hub-administrator", person: actor.person, sessionId: actor.sessionId, requestId: w.ctx.ctx.requestId }, at: 100, changes: ["search"], recipients: [{ kind: "host", sink: "owner" }] };
  return { ...w, authority, clock, decisionOptions, decision, input, onClock(hook: () => void) { clockHook = hook; } };
}

describe("S129 operation-owned directory transition", () => {
  it("retains the acting admin's proof through the decision's own canonical rebind and version advance", async () => {
    const w = await world(true, true), permit = await w.authority.require(w.ctx.ctx, "hub.admin");
    expect(() => w.decision.decide(w.input, () => { permit.assertDirectoryDecision!(w.decision.administrationProof()!); return 100; })).not.toThrow();
    expect(w.decision.inspect()).toMatchObject({ operationId: w.input.id, directoryEpoch: 1, authorizationVersion: w.input.expected.authorizationVersion + 1 });
    expect(JSON.parse((w.db.prepare("SELECT body FROM hub_group_policy").get() as { body: string }).body)).toEqual({ ...w.policy, generation: "g2", revision: w.policy.revision + 1 });
    expect(() => permit.assertCurrent()).toThrow();
  });
  it("keeps an ordinary permit strict after a directory transition", async () => {
    const w = await world(), permit = await w.authority.require(w.ctx.ctx, "hub.admin");
    // A kernel transaction control only; this inert callback is not a browser's administration proof.
    w.decision.decide(w.input, () => 100);
    expect(() => permit.assertCurrent()).toThrow();
  });
  it("keeps an ordinary permit strict after an unrelated authorization-version change", async () => {
    const w = await world(), permit = await w.authority.require(w.ctx.ctx, "hub.admin");
    w.advance(); expect(() => permit.assertCurrent()).toThrow();
  });
});

describe("S129 explicit administration decision authority", () => {
  it("does not expose a decision assertion without an explicit authority adapter", async () => {
    const w = await world(true), permit = await w.authority.require(w.ctx.ctx, "hub.admin");
    expect(permit.assertDirectoryDecision).toBeUndefined();
  });
  it("keeps the real clock generation-strict outside the explicitly supplied frame", async () => {
    const w = await world(true, true), permit = await w.authority.require(w.ctx.ctx, "hub.admin"); let calls = 0;
    w.decision.decide(w.input, () => {
      calls++; if (calls === 1) expect(() => w.clock!.assertAuthorizationTime()).not.toThrow();
      else expect(() => w.clock!.assertAuthorizationTime()).toThrow();
      permit.assertDirectoryDecision!(w.decision.administrationProof()!); return 100;
    });
    expect(calls).toBe(2); expect(() => w.clock!.assertAuthorizationTime()).toThrow();
  });
  it("does not let a clock selected for another generation consume the frame", async () => {
    const w = await world(true, true), foreign = createHubRoleAuthorizationClock({ db: w.db, hubId: w.hubId, root: w.root,
      realm: "corp", generation: "another-generation", transport: w.store, current: w.options.current, now: w.options.now });
    let calls = 0, refusals = 0;
    w.decision.decide(w.input, () => {
      calls++; try { foreign.assertDirectoryDecision(w.decision.administrationProof()!); } catch { refusals++; } return 100;
    });
    expect(calls).toBe(2); expect(refusals).toBe(2);
  });
  it("does not turn a different management permission into directory authority", async () => {
    const w = await world(true, true), permit = await w.authority.require(w.ctx.ctx, "join.manage"); let calls = 0;
    expect(() => w.decision.decide(w.input, () => {
      calls++; permit.assertDirectoryDecision!(w.decision.administrationProof()!); return 100;
    })).toThrow(); expect(calls).toBe(1);
  });
  it.each(["actor", "session", "request", "host", "policy", "version", "hub-binding", "clock-binding", "closed", "lifetime", "directory-method", "signed-out", "missing"] as const)(
    "refuses %s despite a structurally current SQL decision", async mode => {
      const w = await world(true, true), permit = await w.authority.require(w.ctx.ctx, "hub.admin");
      if (w.input.actor.kind !== "hub-administrator") throw Error("fixture actor");
      if (mode === "actor") w.input.actor.person = w.other;
      if (mode === "session") w.input.actor.sessionId = randomUUID();
      if (mode === "request") w.input.actor.requestId = randomUUID();
      if (mode === "host") w.input.actor = { kind: "host-owner", sessionId: w.input.actor.sessionId, requestId: w.input.actor.requestId };
      if (mode === "policy") w.save({ ...w.policy, rolesActive: false, revision: w.policy.revision + 1 });
      if (mode === "version") w.advance();
      if (mode === "hub-binding") w.decisionOptions!.hubId = randomUUID();
      if (mode === "clock-binding") w.decisionOptions!.assertAuthorizationTime = () => {};
      if (mode === "closed") w.authority.close();
      if (mode === "lifetime") w.stop();
      if (mode === "directory-method") w.directory.checkEligibility = async who => ({ eligible: true, person: w.person(who) });
      if (mode === "signed-out") w.sessions.signOut(w.ctx.token);
      w.input.expected = w.decision.inspect(); let calls = 0;
      expect(() => w.decision.decide(w.input, () => {
        calls++; permit.assertDirectoryDecision!(mode === "missing" ? null! : w.decision.administrationProof()!); return 100;
      })).toThrow();
      expect(calls).toBe(1); expect(w.decision.lookup(w.input.id)).toBeNull();
      expect(() => permit.assertCurrent()).toThrow(); // An observed failed assertion never revives this permit.
    });
  it.each(["wall", "elapsed", "assignment", "marker", "settled", "owner", "schema", "floor", "late-clock", "late-provider"] as const)(
    "refuses final-proof %s loss and rolls back the decision", async mode => {
      const w = await world(true, true);
      if (mode === "assignment") { w.policy.assignments[0]!.expiresAt = 150; w.save(w.policy); }
      w.input.expected = w.decision.inspect();
      const permit = await w.authority.require(w.ctx.ctx, "hub.admin"); let calls = 0, clockCalls = 0;
      w.onClock(() => {
        if (++clockCalls !== 2) return;
        if (mode === "late-clock") w.time(5000);
        if (mode === "late-provider") w.decisionOptions!.assertAuthorizationTime = () => {};
      });
      expect(() => w.decision.decide(w.input, () => {
        if (++calls === 2) {
          if (mode === "wall") w.time(5000);
          if (mode === "elapsed") w.elapsed(5000);
          if (mode === "assignment") w.time(50);
          if (mode === "marker") w.db.exec("DELETE FROM hub_role_cutover");
          if (mode === "settled") w.db.prepare("INSERT INTO hub_role_expiry_terms VALUES(?,?,?,?,?)").run(randomUUID(), randomUUID(), 200, randomUUID(), 200);
          if (mode === "owner") w.db.prepare("UPDATE hub_instance SET hub_id=?").run(randomUUID());
          if (mode === "schema") w.db.prepare("DELETE FROM hub_schema WHERE component='roles-expiry'").run();
          if (mode === "floor") w.floor();
        }
        permit.assertDirectoryDecision!(w.decision.administrationProof()!); return 100;
      })).toThrow();
      expect(calls).toBe(2); expect(w.db.prepare("SELECT id FROM hub_settings_operations").all()).toEqual([]);
      expect(w.db.prepare("SELECT body FROM hub_group_policy").get()).toEqual({ body: JSON.stringify(w.policy) });
    });
  it("keeps the HubCore mount/provider fence on the explicit permit method", async () => {
    const w = await world(true, true); w.core.deps.management = w.authority;
    const permit = await w.core.management(w.ctx.ctx, "hub.admin");
    if (!("assertDirectoryDecision" in permit) || !permit.assertDirectoryDecision) throw Error("fixture adapter");
    let calls = 0;
    expect(() => w.decision.decide(w.input, () => {
      if (++calls === 2) w.core.deps.management = { require: w.authority.require };
      permit.assertDirectoryDecision!(w.decision.administrationProof()!); return 100;
    })).toThrow();
    expect(calls).toBe(2); expect(w.db.prepare("SELECT id FROM hub_settings_operations").all()).toEqual([]);
  });
  it("cannot consume another database's otherwise valid same-request frame", async () => {
    const w = await world(true, true), other = await world(true, true), permit = await w.authority.require(w.ctx.ctx, "hub.admin");
    other.input.actor = structuredClone(w.input.actor); let calls = 0;
    expect(() => other.decision.decide(other.input, () => {
      calls++; permit.assertDirectoryDecision!(other.decision.administrationProof()!); return 100;
    })).toThrow(); expect(calls).toBe(1);
  });
  it("retires an explicit assertion after the successful owning callback returns", async () => {
    const w = await world(true, true), permit = await w.authority.require(w.ctx.ctx, "hub.admin"); let proof: HubDirectoryDecisionProof | null = null;
    w.decision.decide(w.input, () => { proof = w.decision.administrationProof(); permit.assertDirectoryDecision!(proof!); return 100; });
    expect(() => permit.assertDirectoryDecision!(proof!)).toThrow();
  });
});

describe("S129 exact synchronous decision frames", () => {
  it("exposes two distinct exact views only during their owning callback", async () => {
    const w = await world(true), proofs: HubDirectoryDecisionProof[] = [], phases: string[] = [];
    expect(w.decision.administrationProof()).toBeNull();
    w.decision.decide(w.input, () => {
      const proof = w.decision.administrationProof()!; proofs.push(proof);
      const view = inspectHubDirectoryDecisionProof(proof, { db: w.db, hubId: w.hubId, actor: w.input.actor });
      phases.push(view.phase);
      expect(view.before.policy.generation).toBe("g1");
      expect(view.current.policy.generation).toBe(view.phase === "initial" ? "g1" : "g2");
      expect(view.expected).toEqual(w.input.expected);
      return 100;
    });
    expect(phases).toEqual(["initial", "final"]); expect(proofs[0]).not.toBe(proofs[1]);
    expect(w.decision.administrationProof()).toBeNull();
    for (const proof of proofs) expect(() => inspectHubDirectoryDecisionProof(proof, { db: w.db, hubId: w.hubId })).toThrow();
  });
  it("leaves legacy callers on the existing source projection without a role frame", async () => {
    const w = await world(); let calls = 0;
    w.decision.decide(w.input, () => {
      calls++; expect(w.decision.administrationProof()).toBeNull();
      expect(w.decision.proofBasis()).toMatchObject({ expected: w.input.expected, policy: { generation: "g1" } }); return 100;
    });
    expect(calls).toBe(2); expect(w.decision.proofBasis()).toBeNull();
  });
  it.each(["throw", "thenable"] as const)("retires the frame on %s and rolls back the operation", async mode => {
    const w = await world(true); let proof: HubDirectoryDecisionProof | undefined;
    expect(() => w.decision.decide(w.input, () => {
      proof = w.decision.administrationProof()!;
      if (mode === "throw") throw Error("owned proof failure");
      return Promise.resolve(100) as unknown as number;
    })).toThrow();
    expect(proof).toBeDefined(); expect(w.decision.administrationProof()).toBeNull();
    expect(() => inspectHubDirectoryDecisionProof(proof!, { db: w.db, hubId: w.hubId })).toThrow();
    // A new transaction with the unchanged predecision image must not revive a retired initial frame.
    expect(() => w.db.transaction(() => inspectHubDirectoryDecisionProof(proof!, { db: w.db, hubId: w.hubId }))()).toThrow();
    expect(w.decision.lookup(w.input.id)).toBeNull();
  });
  it.each(["forged", "hub", "actor", "session", "request"] as const)("refuses a %s binding without granting another scope", async mode => {
    const w = await world(true); let calls = 0;
    w.decision.decide(w.input, () => {
      calls++; const proof = w.decision.administrationProof()!, binding = { db: w.db, hubId: w.hubId, actor: structuredClone(w.input.actor) };
      if (mode === "hub") binding.hubId = randomUUID();
      if (binding.actor.kind !== "hub-administrator") throw Error("fixture actor");
      if (mode === "actor") binding.actor.person = w.other;
      if (mode === "session") binding.actor.sessionId = randomUUID();
      if (mode === "request") binding.actor.requestId = randomUUID();
      expect(() => inspectHubDirectoryDecisionProof(mode === "forged" ? { directoryDecisionProof: true } : proof, binding)).toThrow();
      expect(inspectHubDirectoryDecisionProof(proof, { db: w.db, hubId: w.hubId, actor: w.input.actor }).phase).toBe(calls === 1 ? "initial" : "final");
      expect(() => w.decision.decide(w.input, () => 100)).toThrow();
      return 100;
    });
    expect(calls).toBe(2);
  });
  it.each(["policy", "transport", "head", "epoch", "operation", "reader"] as const)("refuses final-callback %s tampering and rolls back SQL", async mode => {
    const w = await world(true); let calls = 0, frameRefused = false; const original = w.store.read;
    try {
      expect(() => w.decision.decide(w.input, () => {
        calls++; if (calls === 1) return 100;
        if (mode === "policy") w.db.prepare("UPDATE hub_group_policy SET body=json_set(body,'$.rolesActive',json('false'))").run();
        if (mode === "transport") w.db.prepare("UPDATE hub_transport_state SET state=json_set(state,'$.nextLinkEpoch',1)").run();
        if (mode === "head") w.db.prepare("UPDATE hub_settings_head SET operation_id=?").run(randomUUID());
        if (mode === "epoch") w.db.prepare("UPDATE hub_directory_epoch SET epoch=epoch+1").run();
        if (mode === "operation") w.db.prepare("UPDATE hub_settings_operations SET body=json_set(body,'$.receiptSha',?)").run("d".repeat(64));
        if (mode === "reader") w.store.read = original.bind(w.store);
        try { inspectHubDirectoryDecisionProof(w.decision.administrationProof()!, { db: w.db, hubId: w.hubId }); }
        catch { frameRefused = true; }
        return 100;
      })).toThrow();
    } finally { w.store.read = original; }
    expect(calls).toBe(2);
    expect(frameRefused).toBe(true);
    expect(w.db.prepare("SELECT id FROM hub_settings_operations").all()).toEqual([]);
    expect(w.db.prepare("SELECT body FROM hub_group_policy").get()).toEqual({ body: JSON.stringify(w.policy) });
    // The external floor may advance on rollback: never treat the transport as healthy after this refusal.
  });
});
