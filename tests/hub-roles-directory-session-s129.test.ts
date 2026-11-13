/** Actual SQL/session/role proof, fictional directory; no public route or token logged. */
import { describe, expect, it } from "vitest";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import { createHubRoleAuthorizationClock } from "../src/hub/roles/clock.js";
import { createHubManagementAuthority } from "../src/hub/roles/authority.js";
import { bindHubDirectoryAdministration, type HubDirectoryAdministration, type HubDirectoryAdministrationBinding } from "../src/hub/roles/directory-authority.js";
import { createHubDirectorySettingsDecision, HUB_DIRECTORY_SETTINGS_MIGRATION } from "../src/hub/settings-directory-decision.js";
import { recentHubDirectoryAuthentication, prepareHubDirectorySessionRotation } from "../src/hub/session-directory-transition.js";

type Administration = { witness: HubDirectoryAdministration; source: HubDirectoryAdministrationBinding };
type Actor = Parameters<typeof recentHubDirectoryAuthentication>[1];
const recent = recentHubDirectoryAuthentication as (...args: [...Parameters<typeof recentHubDirectoryAuthentication>, administration?: Administration]) => number | null;
const prepare = prepareHubDirectorySessionRotation as (...args: [...Parameters<typeof prepareHubDirectorySessionRotation>, administration?: Administration]) => ReturnType<typeof prepareHubDirectorySessionRotation>;
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
  return { ...w, authority, decision, browser, actor, administration };
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
});
