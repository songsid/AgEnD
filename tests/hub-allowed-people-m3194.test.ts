/** Real admin boundary/search projection; directory and selected-policy ports are inert. */
import { describe, expect, it, vi } from "vitest";
import { createHubGroupAdminSearch } from "../src/hub/group-policy/admin-search.js";
import { initialGroupPolicy } from "../src/hub/group-policy/model.js";
import type { HubGroupPolicyStore } from "../src/hub/group-policy/store.js";
import type { HubActor, HubDirectory } from "../src/hub/types.js";
const admin = { realm: "example", objectId: "11111111-1111-4111-8111-111111111111" };
const selected = { person: { ...admin, objectId: "22222222-2222-4222-8222-222222222222" }, displayName: "Alex", login: "alex" };
function world() {
  let session = "session-1", allowed = true, image = initialGroupPolicy("example", "generation-1");
  const lookup = vi.fn(async () => ({ ok: true as const, people: [selected], truncated: false }));
  const groups = vi.fn(async () => ({ ok: true as const, groups: [], truncated: false }));
  const directory = { realm: "example", groupPolicy: "ad-direct-guid", searchGrantPeople: lookup, searchPolicyGroups: groups } as unknown as HubDirectory;
  const policy = { read: () => image, withDirectoryRead: async <T>(_who: unknown, work: () => Promise<T>) => work() } as HubGroupPolicyStore;
  const service = createHubGroupAdminSearch({ administrator: admin, directory, current: () => true, binding: () => ({ kind: "ready" }), policy: () => policy, now: () => 100 });
  const auth = vi.fn(async (): Promise<HubActor> => ({ kind: "directory", person: allowed ? admin : selected.person, sessionId: session }));
  const ctx = { requestId: "request-1", current: () => true, requireAdmin: auth };
  return { service, lookup, groups, ctx, auth, deny: () => { allowed = false; }, change: () => { session = "session-2"; }, mutate: () => { image = { ...image, revision: 2 }; } };
}
describe("T1 allowed-list person picker", () => {
  it("projects only bounded directory people and authenticates the exact admin again", async () => {
    const w = world(); expect(await w.service.searchPeople({ q: " alex " }, w.ctx)).toEqual({ ok: true, people: [selected], truncated: false });
    expect(w.lookup).toHaveBeenCalledWith("alex"); expect(w.auth).toHaveBeenCalledTimes(2);
  });
  it("refuses a nonadmin before any directory read", async () => {
    const w = world(); w.deny(); await expect(w.service.searchPeople({ q: "alex" }, w.ctx)).rejects.toThrow(); expect(w.lookup).not.toHaveBeenCalled();
  });
  it("withholds a foreign-realm suggestion", async () => {
    const w = world(); w.lookup.mockResolvedValue({ ok: true, people: [{ ...selected, person: { ...selected.person, realm: "other" } }], truncated: false });
    expect(await w.service.searchPeople({ q: "alex" }, w.ctx)).toEqual({ ok: false, reason: "unknown" });
  });
  it("refuses after the admin session or selected policy changes during lookup", async () => {
    for (const mode of ["session", "policy"] as const) {
      const w = world(); w.lookup.mockImplementation(async () => { if (mode === "session") w.change(); else w.mutate(); return { ok: true, people: [selected], truncated: false }; });
      await expect(w.service.searchPeople({ q: "alex" }, w.ctx)).rejects.toThrow();
    }
  });
  it("shares the existing group-search rate limit rather than adding another allowance", async () => {
    const w = world(); for (let n = 0; n < 30; n++) expect((await (n % 2 ? w.service.searchPeople : w.service.search)({ q: "alex" }, w.ctx)).ok).toBe(true);
    expect(await w.service.searchPeople({ q: "alex" }, w.ctx)).toEqual({ ok: false, reason: "limited" }); expect(w.lookup).toHaveBeenCalledTimes(15);
  });
});
