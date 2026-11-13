/** Actual role/session/transport/SQLite authority; no mounted source or live directory. */
import { describe, expect, it } from "vitest";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";
import { HubCore } from "../src/hub/http/core.js";
import { hubTxDatabase } from "../src/hub/db.js";

async function world() {
  const w = await roleAuthorityWorld(), deps = { ...w.core.deps, management: w.authority };
  const core = new HubCore(deps, hubTxDatabase);
  return { ...w, deps, core };
}
describe("S129 directory preparation belongs to its actual Core", () => {
  it("retains a valid slow operation and publishes a fresh proof under the same Core", async () => {
    const w = await world(), p = await w.core.directoryPreparation(w.ctx.ctx);
    w.time(6000); expect(() => p.assertCurrent()).not.toThrow();
    const permit = await p.authorize(); expect(permit.actor.person).toEqual(w.admin);
    expect(() => permit.assertCurrent()).not.toThrow();
  });
  it("refuses an original preparation after the Core provider is replaced", async () => {
    const w = await world(), p = await w.core.directoryPreparation(w.ctx.ctx);
    w.deps.management = { ...w.authority };
    expect(() => p.assertCurrent()).toThrow();
  });
  it("fences the actual fresh proof after the Core provider is replaced", async () => {
    const w = await world(), p = await w.core.directoryPreparation(w.ctx.ctx), permit = await p.authorize();
    w.deps.management = { ...w.authority };
    expect(() => permit.assertCurrent()).toThrow();
  });
  it("does not fabricate a preparation without a management provider", async () => {
    const w = await world(), { management: _management, ...bare } = w.deps, core = new HubCore(bare, hubTxDatabase);
    await expect(core.directoryPreparation(w.ctx.ctx)).rejects.toMatchObject({ code: "unavailable" });
  });
});
