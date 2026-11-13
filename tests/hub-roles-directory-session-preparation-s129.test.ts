/** Actual Core/session/role preparation and SQL; fictional directory and source material only. */
import { describe, expect, it } from "vitest";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import { createHubRoleAuthorizationClock } from "../src/hub/roles/clock.js";
import { createHubManagementAuthority } from "../src/hub/roles/authority.js";
import { assertHubDirectoryActor, bindHubDirectoryAdministration, bindHubDirectoryPreparation } from "../src/hub/roles/directory-authority.js";
import { recentHubDirectoryAuthentication, prepareHubDirectorySessionRotation, type HubDirectorySessionPreparation } from "../src/hub/session-directory-transition.js";

async function world() {
  const w = await roleAuthorityWorld({ cutover: true });
  const clock = createHubRoleAuthorizationClock({ db: w.db, hubId: w.hubId, root: w.root, realm: "corp", generation: "g1", transport: w.store,
    current: w.options.current, now: w.options.now });
  const authority = createHubManagementAuthority({ ...w.options, assertAuthorizationTime: clock.assertAuthorizationTime });
  w.core.deps.management = authority;
  const p = await w.core.directoryPreparation(w.ctx.ctx), actor = { kind: "hub-administrator" as const, person: p.actor.person,
    sessionId: p.actor.sessionId, requestId: w.ctx.ctx.requestId };
  const source = { directory: w.directory, administrator: w.root, image: "a".repeat(64), epoch: 0, decisionProof: () => null };
  const proof: HubDirectorySessionPreparation = { preparation: bindHubDirectoryPreparation(p, actor, source), source };
  return { ...w, authority, p, actor, source, proof };
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
});
