/** Session adapters retain original recipient access without granting operational permissions. */
import { describe, expect, it, vi } from "vitest";
import { createHubMemberAddressNotices } from "../src/hub/settings-member-address-notices.js";
import type { HubMemberAddressDecision } from "../src/hub/settings-member-address-decision.js";
import type { HubRequestContext } from "../src/hub/types.js";
const person = { realm: "corp", objectId: "11111111-1111-4111-8111-111111111111" };
function fixture() {
  let live = true, session = true;
  const read = vi.fn(() => ({ rows: [], before: null })), ack = vi.fn();
  const api = createHubMemberAddressNotices({ notices: read, acknowledge: ack } as unknown as HubMemberAddressDecision, () => live);
  const ctx = { requirePerson: vi.fn(async () => person), current: vi.fn(async () => ({ kind: "directory", person, sessionId: "session" })), isCurrent: () => session } as unknown as HubRequestContext;
  return { api, ctx, read, ack, retire: () => { session = false; }, fence: () => { live = false; } };
}
describe("#3429 durable notice session adapter", () => {
  it("uses only the session's freshly checked immutable person, without requiring current pair/group permission", async () => {
    const r = fixture(); await r.api.forSession(r.ctx, 300); await r.api.acknowledgeSession(r.ctx, "notice");
    expect(r.read).toHaveBeenCalledWith({ kind: "person", person }, expect.any(Function), 300);
    expect(r.ack).toHaveBeenCalledWith("notice", { kind: "person", person }, expect.any(Function));
  });
  it.each(["session", "mount", "person"])("a changed %s after authentication cannot reach read or ACK", async mode => {
    const r = fixture(); vi.spyOn(r.ctx, "current").mockImplementation(async () => {
      if (mode === "session") r.retire(); if (mode === "mount") r.fence();
      return { kind: "directory", person: mode === "person" ? { ...person, objectId: "22222222-2222-4222-8222-222222222222" } : person, sessionId: "session" } as Awaited<ReturnType<HubRequestContext["current"]>>;
    });
    await expect(r.api.forSession(r.ctx)).rejects.toThrow("revoked"); await expect(r.api.acknowledgeSession(r.ctx, "notice")).rejects.toThrow("revoked");
    expect(r.read).not.toHaveBeenCalled(); expect(r.ack).not.toHaveBeenCalled();
  });
});
