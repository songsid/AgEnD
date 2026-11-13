/** Actual SQL/session/cutover and decision; fictional directory, inert staged-file images. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import { createHubRoleAuthorizationClock } from "../src/hub/roles/clock.js";
import { createHubManagementAuthority } from "../src/hub/roles/authority.js";
import type { HubDirectoryDecisionProof } from "../src/hub/directory-decision-proof.js";
import { bindHubDirectoryAdministration, assertHubDirectoryAdministration } from "../src/hub/roles/directory-authority.js";
import { createHubDirectorySettingsDecision, HUB_DIRECTORY_SETTINGS_MIGRATION, type HubDirectoryDecisionRequest } from "../src/hub/settings-directory-decision.js";

async function world() {
  const w = await roleAuthorityWorld({ cutover: true }); HUB_DIRECTORY_SETTINGS_MIGRATION.up(w.db);
  const clock = createHubRoleAuthorizationClock({ db: w.db, hubId: w.hubId, root: w.root, realm: "corp", generation: "g1",
    transport: w.store, current: w.options.current, now: w.options.now });
  const authority = createHubManagementAuthority({ ...w.options, assertAuthorizationTime: clock.assertAuthorizationTime,
    directoryDecision: { db: w.db, hubId: w.hubId, assertAuthorizationTime: clock.assertDirectoryDecision } });
  const decision = createHubDirectorySettingsDecision({ db: w.db, transport: w.store, hubId: w.hubId, roleProofs: true });
  const person = await w.ctx.ctx.current(); if (person.kind !== "directory") throw Error("fixture actor");
  const actor = { kind: "hub-administrator" as const, person: person.person, sessionId: person.sessionId, requestId: w.ctx.ctx.requestId };
  const source = { directory: w.directory, administrator: w.root, image: "a".repeat(64), epoch: 0, decisionProof: decision.administrationProof };
  const permit = await authority.require(w.ctx.ctx, "hub.admin"), handle = bindHubDirectoryAdministration(permit, actor, source);
  const image = (s: string) => ({ configDigest: s.repeat(64), configSha: s.repeat(64), directorySha: s.repeat(64), manifestSha: s.repeat(64), bindSecretSha: s.repeat(64) });
  const input: HubDirectoryDecisionRequest = { id: randomUUID(), expected: decision.inspect(), before: image("a"), after: image("b"),
    generation: "g2", receiptSha: "c".repeat(64), actor, at: 100, changes: ["search"], recipients: [{ kind: "host", sink: "owner" }] };
  return { ...w, authority, clock, decision, actor, source, permit, handle, input };
}

describe("S129 administration witness through the exact decision", () => {
  it("retains the same opaque witness across the legitimate final SQL rebind", async () => {
    const w = await world(); let calls = 0;
    expect(() => w.decision.decide(w.input, () => {
      calls++; assertHubDirectoryAdministration(w.handle, w.actor, w.source); return 100;
    })).not.toThrow(); expect(calls).toBe(2);
    expect(w.decision.inspect().operationId).toBe(w.input.id);
    expect(() => assertHubDirectoryAdministration(w.handle, w.actor, w.source)).toThrow();
  });
  it("keeps the existing source without a decision getter strict", async () => {
    const w = await world(), { decisionProof: _unused, ...source } = w.source;
    const handle = bindHubDirectoryAdministration(w.permit, w.actor, source);
    assertHubDirectoryAdministration(handle, w.actor, source);
    expect(() => w.decision.decide(w.input, () => { assertHubDirectoryAdministration(handle, w.actor, source); return 100; })).toThrow();
  });
  it("does not turn an unrelated version change into a decision exception", async () => {
    const w = await world(); assertHubDirectoryAdministration(w.handle, w.actor, w.source);
    w.advance(); w.input.expected = w.decision.inspect(); let calls = 0;
    expect(() => w.decision.decide(w.input, () => { calls++; assertHubDirectoryAdministration(w.handle, w.actor, w.source); return 100; })).toThrow();
    expect(calls).toBe(1);
  });
});

describe("S129 witness getter and provider ownership", () => {
  it("refuses a replaced getter and never revives the observed stale witness", async () => {
    const w = await world(), original = w.source.decisionProof;
    w.source.decisionProof = () => null;
    expect(() => assertHubDirectoryAdministration(w.handle, w.actor, w.source)).toThrow();
    w.source.decisionProof = original;
    expect(() => assertHubDirectoryAdministration(w.handle, w.actor, w.source)).toThrow();
  });
  it.each(["forged", "undefined", "promise", "rejected"] as const)("refuses a getter returning %s", async mode => {
    const w = await world(); let armed = false;
    const source = { ...w.source, decisionProof(): HubDirectoryDecisionProof | null {
      if (!armed) return null;
      if (mode === "forged") return { directoryDecisionProof: true };
      if (mode === "promise") return Promise.resolve(null) as never;
      if (mode === "rejected") return Promise.reject(Error("owned rejected frame")) as never;
      return undefined as never;
    } };
    const handle = bindHubDirectoryAdministration(w.permit, w.actor, source); armed = true;
    expect(() => assertHubDirectoryAdministration(handle, w.actor, source)).toThrow();
    await Promise.resolve();
  });
  it.each(["image", "getter"] as const)("rechecks the %s binding after the getter callback", async mode => {
    const w = await world(); let armed = false;
    const source = { ...w.source, decisionProof(): HubDirectoryDecisionProof | null {
      if (armed) {
        if (mode === "image") source.image = "d".repeat(64);
        else source.decisionProof = () => null;
      }
      return null;
    } };
    const handle = bindHubDirectoryAdministration(w.permit, w.actor, source); armed = true;
    expect(() => assertHubDirectoryAdministration(handle, w.actor, source)).toThrow();
  });
  it("rechecks the source after the retained permit callback", async () => {
    const w = await world(); let armed = false;
    const source = { ...w.source, decisionProof: () => null };
    const permit = { ...w.permit, assertCurrent() { w.permit.assertCurrent(); if (armed) source.image = "d".repeat(64); } };
    const handle = bindHubDirectoryAdministration(permit, w.actor, source); armed = true;
    expect(() => assertHubDirectoryAdministration(handle, w.actor, source)).toThrow();
  });
  it("refuses a substituted explicit permit method before consuming a frame", async () => {
    const w = await world(), permit = { ...w.permit };
    const handle = bindHubDirectoryAdministration(permit, w.actor, w.source);
    permit.assertDirectoryDecision = () => {};
    expect(() => assertHubDirectoryAdministration(handle, w.actor, w.source)).toThrow();
  });
  it("does not consume a frame through a permit without the explicit adapter", async () => {
    const w = await world(), permit = { ...w.permit }; delete permit.assertDirectoryDecision;
    const handle = bindHubDirectoryAdministration(permit, w.actor, w.source); let calls = 0;
    expect(() => w.decision.decide(w.input, () => {
      calls++; assertHubDirectoryAdministration(handle, w.actor, w.source); return 100;
    })).toThrow(); expect(calls).toBe(1);
  });
  it("refuses an actual frame from another database through the unchanged getter", async () => {
    const w = await world(), foreign = await world(); let frame: HubDirectoryDecisionProof | null = null;
    const source = { ...w.source, decisionProof: () => frame }, handle = bindHubDirectoryAdministration(w.permit, w.actor, source);
    foreign.input.actor = structuredClone(w.actor); let calls = 0;
    expect(() => foreign.decision.decide(foreign.input, () => {
      calls++; frame = foreign.decision.administrationProof(); assertHubDirectoryAdministration(handle, w.actor, source); return 100;
    })).toThrow(); expect(calls).toBe(1);
  });
});
