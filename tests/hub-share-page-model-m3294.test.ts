import { expect, it } from "vitest";
import { rowAvailability, reconcileSharing, shareRows } from "/ui/js/hub-my-agents-model.js";
const row = { instance: "docs", displayName: "Documents", shareable: true, general: false, kind: "agent", exposure: null };
const fleet = { id: "fleet", connected: true, catalogSupported: true, catalog: { enabled: true, requests: true, at: 100, agents: [row] } };
it("Select all excludes General, retains Classic rooms and does not treat a private catalog pointer as publication truth", () => {
  const rows = shareRows({ ...fleet, catalog: { ...fleet.catalog, agents: [row, { ...row, instance: "general", general: true }, { ...row, instance: "room", kind: "classic-room" }] } }, []);
  expect(rows.filter((x: any) => !x.general && !rowAvailability(fleet, x, { state: "allow" }, 0))).toHaveLength(2);
  expect(shareRows({ ...fleet, catalog: { ...fleet.catalog, agents: [{ ...row, exposure: { id: "x", revision: 1, state: "published" } }] } }, [])[0].shared).toBe(false);
});
it("keeps offline/version/switch/permission/cap limits distinct and still permits stopping under a publication denial", () => {
  expect(rowAvailability({ ...fleet, connected: false }, row, { state: "allow" }, 0)).toBe("offline");
  expect(rowAvailability({ ...fleet, catalogSupported: false }, row, { state: "allow" }, 0)).toBe("old");
  expect(rowAvailability({ ...fleet, catalog: { ...fleet.catalog, enabled: false } }, row, { state: "allow" }, 0)).toBe("off");
  expect(rowAvailability(fleet, row, { state: "deny" }, 0)).toBe("denied");
  expect(rowAvailability(fleet, row, { state: "unknown" }, 0)).toBe("unknown");
  expect(rowAvailability(fleet, row, { state: "allow" }, 64)).toBe("limit");
  expect(rowAvailability(fleet, { ...row, shared: true }, { state: "deny" }, 64)).toBeNull();
});
it("a lost answer stays uncertain with the same frozen intent; only an accepted snapshot settles success", () => {
  const op = { input: { idempotencyKey: "fixed", fleetId: "fleet", share: ["docs"], stop: [] }, at: 100, rows: [{ instance: "docs", before: null }], response: { state: "queued" } };
  expect(reconcileSharing(op, [fleet], [], 30_101).rows[0].state).toBe("uncertain");
  const result = { ...op, response: { state: "complete", result: { results: [{ instance: "docs", ok: true, after: { id: "x", revision: 1, state: "published" } }] } } };
  expect(reconcileSharing(result, [fleet], [], 200).rows[0].state).toBe("pending");
  expect(reconcileSharing(result, [fleet], [{ id: "x", fleetId: "fleet", revision: 1, state: "published" }], 200).rows[0].state).toBe("done");
  expect(op.input.idempotencyKey).toBe("fixed");
});
it("partial refusals stay local and expiration requires a fresh report before clearing the pending tick", () => {
  const op = { input: { fleetId: "fleet", share: ["docs"], stop: [] }, at: 100, rows: [{ instance: "docs", before: null }], response: { state: "expired" } };
  expect(reconcileSharing(op, [fleet], [], 600_101).rows[0].state).toBe("uncertain");
  expect(reconcileSharing(op, [{ ...fleet, catalog: { ...fleet.catalog, at: 600_102 } }], [], 600_103).rows[0].state).toBe("closed");
});
it("a fresh unchanged stop after expiration clears the draft, and a local changed pointer without a Hub snapshot never counts as shared", () => {
 const current = { id: "x", fleetId: "fleet", revision: 1, state: "published" };
 const op = { input: { fleetId: "fleet", share: [], stop: ["x"] }, at: 100, rows: [{ id: "x", before: { id: "x", revision: 1 } }], response: { state: "expired" } };
 expect(reconcileSharing(op, [{ ...fleet, catalog: { ...fleet.catalog, at: 1000 } }], [current], 1001).rows[0].state).toBe("closed");
 const sent = { ...op, response: { state: "complete", result: { results: [{ exposureId: "x", ok: true, after: { id: "x", revision: 2, state: "withdrawn" } }] } } };
 expect(reconcileSharing(sent, [fleet], [current], 1001).rows[0].state).toBe("pending");
 expect(reconcileSharing(sent, [fleet], [], 1001).rows[0].state).toBe("done");
});
