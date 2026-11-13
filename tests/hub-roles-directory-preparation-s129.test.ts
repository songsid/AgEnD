/** Actual role policy, sessions, transport and physical admission; fictional directory. */
import { describe, expect, it } from "vitest";
import { roleAuthorityWorld } from "./support/hub-role-authority-rig.js";

describe("S129 long directory preparation", () => {
  it("retains operation identity beyond the old five-second permit and acquires a fresh effect proof", async () => {
    const w = await roleAuthorityWorld(), preparation = await w.authority.prepareDirectory(w.ctx.ctx);
    w.time(6000); w.elapsed(6000);
    expect(() => preparation.assertCurrent()).not.toThrow();
    const before = w.eligible.mock.calls.length, permit = await preparation.authorize();
    expect(w.eligible.mock.calls.length).toBeGreaterThan(before);
    expect(permit.actor.person).toEqual(w.admin); expect(permit.permission).toBe("hub.admin");
    expect(permit.expiresAt).toBe(11100); expect(() => permit.assertCurrent()).not.toThrow();
  });
  it("keeps ordinary effect proofs at five seconds", async () => {
    const w = await roleAuthorityWorld(), permit = await w.authority.require(w.ctx.ctx, "hub.admin");
    w.time(5000); expect(() => permit.assertCurrent()).toThrow();
  });
  it("does not grant directory preparation to an ordinary signed-in person", async () => {
    const w = await roleAuthorityWorld(), person = await w.browser(w.other);
    await expect(w.authority.prepareDirectory(person.ctx)).rejects.toMatchObject({ code: "denied" });
  });
});
