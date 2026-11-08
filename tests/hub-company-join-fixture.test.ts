/** Fixture readiness only; these do not claim the new registration protocol exists or is secure. */
import { afterEach, describe, expect, it, vi } from "vitest";
const dc = vi.hoisted(() => ({ port: 0, redirects: [] as number[] }));
vi.mock("node:tls", async original => {
  const real = await original<typeof import("node:tls")>();
  return { ...real, connect: (options: import("node:tls").ConnectionOptions) => {
    if (options.host === "127.0.0.1" && options.port === 636) {
      if (!dc.port) throw Error("No owned directory listener");
      dc.redirects.push(dc.port);
      return real.connect({ ...options, port: dc.port });
    }
    return real.connect(options);
  } };
});
import { existsSync } from "node:fs";
import { companyJoinRig } from "./support/hub-company-join-rig.js";

let rig: Awaited<ReturnType<typeof companyJoinRig>> | undefined;
afterEach(async () => { await rig?.close(); rig = undefined; dc.port = 0; dc.redirects.length = 0; });
async function world() { return rig = await companyJoinRig(port => { dc.port = port; }); }

describe("company-join isolated real-Hub/fake-LDAPS fixture", () => {
  it("uses verified TLS and actual AD binds; permits no empty-password or ineligible sign-in", async () => {
    const r = await world(), carol = await r.signIn("carol");
    expect(carol.cookie).toMatch(/^__Host-agend_hub_/);
    expect(r.wire.binds).toContain("CN=Carol,DC=example,DC=test");
    expect(dc.redirects.length).toBeGreaterThan(0);
    expect(dc.redirects.every(port => port === r.wire.port)).toBe(true);
    const before = r.wire.binds.length;
    expect((await r.call(null, "POST", "/hub/v1/session", { login: "carol", password: "" })).status).toBe(400);
    expect(r.wire.binds).toHaveLength(before);
    expect((await r.call(null, "POST", "/hub/v1/session", { login: "carol", password: "Wrong-dummy-password" })).status).toBe(403);
    expect((await r.call(null, "POST", "/hub/v1/session", { login: "eve", password: "Dummy-eve-only" })).status).toBe(403);
    expect((await r.call(carol, "GET", "/hub/v1/session")).body.signedIn).toBe(true);
    expect(r.deps.store.read().fleets).toEqual([]);
  });

  it("uses the real group editor for a connect-only rule; outsider sign-in grants no enrollment", async () => {
    const r = await world(), admin = await r.signIn("alice"), carol = await r.signIn("carol"), outsider = await r.signIn("dan");
    expect((await r.call(admin, "GET", "/hub/v1/admin/group-policy")).body.policy.state).toBe("never-enabled");
    await r.enable(admin, 1);
    expect((await r.call(carol, "GET", "/hub/v1/me/welcome")).body).toMatchObject({
      mode: "enabled", connect: { state: "allow", maxFleets: 1 }, chat: { state: "deny" }, publish: { state: "deny" },
    });
    expect((await r.call(outsider, "GET", "/hub/v1/me/welcome")).body.connect.state).toBe("deny");
    expect((await r.call(outsider, "POST", "/hub/v1/quick-pairing", { label: "Not permitted" })).status).toBe(403);
    expect(r.deps.store.read().pairings).toEqual([]);
    expect(r.deps.store.read().fleets).toEqual([]);
    expect(r.wire.searches.some(s => s.controls.some((c: { oid: string }) => c.oid === "1.2.840.113556.1.4.529"))).toBe(true);
  });

  it("can revoke eligibility after sign-in and keeps unknown membership distinct from permission", async () => {
    const r = await world(), admin = await r.signIn("alice"); await r.enable(admin);
    const carol = await r.signIn("carol");
    r.wire.state.mode = "unsupported";
    expect((await r.call(carol, "GET", "/hub/v1/me/welcome")).body.connect.state).toBe("unknown");
    expect((await r.call(carol, "POST", "/hub/v1/quick-pairing", { label: "Unknown" })).status).toBe(503);
    r.wire.state.mode = "ok";
    r.people.find(p => p.login === "carol")!.eligible = false;
    expect((await r.call(carol, "POST", "/hub/v1/quick-pairing", { label: "Disabled" })).status).toBe(401);
    expect(r.deps.store.read().pairings).toEqual([]);
    expect(r.deps.store.read().fleets).toEqual([]);
  });

  it("rejects cross-site/missing-CSRF writes before directory access and cleans all owned state", async () => {
    const r = await world(), admin = await r.signIn("alice"); await r.enable(admin);
    const carol = await r.signIn("carol"), before = r.wire.searches.length;
    expect((await r.call(carol, "POST", "/hub/v1/quick-pairing", { label: "CSRF" }, { "X-AgEnD-Hub-CSRF": "" })).status).toBe(403);
    expect((await r.call(carol, "POST", "/hub/v1/quick-pairing", { label: "Other origin" }, { Origin: "https://attacker.invalid" })).status).toBe(403);
    expect((await r.call(null, "POST", "/hub/v1/quick-pairing", { label: "Signed out" })).status).toBe(401);
    expect(r.wire.searches).toHaveLength(before);
    expect(r.deps.store.read().pairings).toEqual([]);
    await r.close(); expect(existsSync(r.home)).toBe(false); await r.close();
  });
});
