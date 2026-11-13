/** Actual directory SQL decision/role/session/floor logic; file images are inert hashes, not a Save route. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import { createHubDirectorySettingsDecision, HUB_DIRECTORY_SETTINGS_MIGRATION, type HubDirectoryDecisionRequest } from "../src/hub/settings-directory-decision.js";

async function world() {
  const w = await roleAuthorityWorld(); HUB_DIRECTORY_SETTINGS_MIGRATION.up(w.db);
  const decision = createHubDirectorySettingsDecision({ db: w.db, transport: w.store, hubId: w.hubId });
  const actor = await w.ctx.ctx.current(); if (actor.kind !== "directory") throw Error("fixture directory actor");
  const image = (v: string) => ({ configDigest: v.repeat(64), configSha: v.repeat(64), directorySha: v.repeat(64), manifestSha: v.repeat(64), bindSecretSha: v.repeat(64) });
  const input: HubDirectoryDecisionRequest = { id: randomUUID(), expected: decision.inspect(), before: image("a"), after: image("b"), generation: "g2", receiptSha: "c".repeat(64),
    actor: { kind: "hub-administrator", person: actor.person, sessionId: actor.sessionId, requestId: w.ctx.ctx.requestId }, at: 100, changes: ["search"], recipients: [{ kind: "host", sink: "owner" }] };
  return { ...w, decision, input };
}

describe("S129 operation-owned directory transition", () => {
  it("retains the acting admin's proof through the decision's own canonical rebind and version advance", async () => {
    const w = await world(), permit = await w.authority.require(w.ctx.ctx, "hub.admin");
    expect(() => w.decision.decide(w.input, () => { permit.assertCurrent(); return 100; })).not.toThrow();
    expect(w.decision.inspect()).toMatchObject({ operationId: w.input.id, directoryEpoch: 1, authorizationVersion: 1 });
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
