import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { IDLE_UPDATE_MIGRATION } from "../src/update-idle.js";
import { HUB_MEMBER_UPDATES_MIGRATION, HubMemberUpdates, type MemberUpdatesOptions } from "../src/hub/member/updates.js";
import type { HubMemberLink } from "../src/hub/client.js";
const closes: (() => void)[] = [];
afterEach(() => { closes.splice(0).reverse().forEach(f => f()); vi.useRealTimers(); });
function world() {
  const db = new Database(":memory:"); IDLE_UPDATE_MIGRATION.up(db); HUB_MEMBER_UPDATES_MIGRATION.up(db); closes.push(() => db.close());
  let now = 1_800_000_000_000, allowedIdle = false;
  const sent: unknown[] = [], notices: unknown[] = [];
  const launch = vi.fn<MemberUpdatesOptions["launch"]>(async (_r, control) => control.claim());
  const options: MemberUpdatesOptions = { db, binding: "selected-pairing-A", version: "2.3.5", hubName: "Team Hub", current: () => true,
    service: () => true, idle: () => allowedIdle, now: () => now, lookup: vi.fn(async () => "found" as const), canInstall: vi.fn(async () => true),
    launch, notify: n => { notices.push(n); return true; } };
  let alive = true;
  const link = { current: () => alive, features: new Set(["fleet-update-v1"]), linkEpoch: 1,
    send: async (f: unknown) => { sent.push(f); } } as unknown as HubMemberLink;
  const value = new HubMemberUpdates(options); closes.push(() => value.close());
  const request = () => ({ id: randomUUID(), version: "2.4.0", requestedAt: now, expiresAt: now + 7 * 86_400_000, requestedBy: { name: "Alex" } });
  return { db, options, value, link, sent, notices, launch, request, idle: (v: boolean) => { allowedIdle = v; }, advance: (ms: number) => { now += ms; }, disconnect: () => { alive = false; } };
}
it("waits for idle after verifying an opted-in request and emits the owner notice before its single launch", async () => {
  const w = world(); w.value.setConsent(true); const request = w.request();
  w.value.receive(request, w.link);
  await vi.waitFor(() => expect(w.notices).toHaveLength(1));
  expect(w.launch).not.toHaveBeenCalled(); expect(w.value.view(request.id)).toMatchObject({ state: "waiting", version: request.version });
  w.idle(true); await w.value.tick(); expect(w.launch).toHaveBeenCalledTimes(1);
  expect(w.value.view(request.id)).toMatchObject({ state: "updating" });
  w.value.receive(request, w.link); await w.value.tick(); expect(w.launch).toHaveBeenCalledTimes(1);
});
it("settles a claimed update after restart without launching it again or holding later requests busy", async () => {
  const w = world(); w.value.setConsent(true); w.idle(true); const request = w.request();
  w.value.receive(request, w.link); await vi.waitFor(() => expect(w.launch).toHaveBeenCalledTimes(1)); w.value.close();
  const next = new HubMemberUpdates({ ...w.options, version: request.version }); closes.push(() => next.close());
  await next.start(); expect(next.view(request.id)).toMatchObject({ state: "done", currentVersion: request.version });
  expect(w.launch).toHaveBeenCalledTimes(1);
  const later = { ...w.request(), version: "2.5.0" }; next.receive(later, w.link);
  await vi.waitFor(() => expect(w.launch).toHaveBeenCalledTimes(2));
});

it.each([
  ["permission", "owner-disabled"], ["service", "not-service"], ["current", "already-current"],
  ["missing", "version-not-found"], ["network", "npm-unavailable"], ["install", "no-permission"],
] as const)("refuses %s before launch", async (change, reason) => {
  const w = world(); w.value.setConsent(true); w.idle(true);
  if (change === "permission") w.value.setConsent(false);
  if (change === "service") w.options.service = () => false;
  if (change === "missing" || change === "network") w.options.lookup = async () => change === "missing" ? "not-found" : "unavailable";
  if (change === "install") w.options.canInstall = async () => false;
  const request = { ...w.request(), ...(change === "current" ? { version: w.options.version } : {}) };
  w.value.receive(request, w.link); await w.value.tick();
  expect(w.value.view(request.id)).toMatchObject({ state: "refused" });
  expect(w.sent.at(-1)).toMatchObject({ payload: { reasonCode: reason } }); expect(w.launch).not.toHaveBeenCalled();
});
it("does not admit after permission changes during npm verification", async () => {
  const w = world(); w.value.setConsent(true); w.idle(true);
  let finish!: (v: "found") => void;
  w.options.lookup = vi.fn(() => new Promise<"found">(resolve => { finish = resolve; }));
  const request = w.request(); w.value.receive(request, w.link);
  await vi.waitFor(() => expect(w.options.lookup).toHaveBeenCalledTimes(1));
  w.value.setConsent(false); finish("found"); await w.value.tick();
  expect(w.sent.at(-1)).toMatchObject({ payload: { state: "refused", reasonCode: "owner-disabled" } }); expect(w.launch).not.toHaveBeenCalled();
});
it("persists cancellation before a delayed request and after admission without launching", async () => {
  const w = world(); w.value.setConsent(true); const first = w.request();
  w.value.cancel({ id: first.id, version: first.version }, w.link);
  w.value.receive(first, w.link); w.idle(true); await w.value.tick();
  expect(w.value.view(first.id)).toMatchObject({ state: "cancelled" }); expect(w.launch).not.toHaveBeenCalled();
  w.idle(false); const next = w.request(); w.value.receive(next, w.link); await w.value.tick();
  w.value.cancel({ id: next.id, version: next.version }); w.idle(true); await w.value.tick();
  expect(w.value.view(next.id)).toMatchObject({ state: "cancelled" }); expect(w.launch).not.toHaveBeenCalled();
});
it("requires a durable owner notice, expires after24h, and never revives an expired replay", async () => {
  const w = world(); w.value.setConsent(true); w.idle(true); w.options.notify = () => false;
  const request = w.request(); w.value.receive(request, w.link); await w.value.tick(); expect(w.launch).not.toHaveBeenCalled();
  w.advance(86_400_000); await w.value.tick();
  expect(w.sent.at(-1)).toMatchObject({ payload: { state: "expired", reasonCode: "busy-24h" } });
  w.options.notify = () => true; w.value.receive(request, w.link); await w.value.tick(); expect(w.launch).not.toHaveBeenCalled();
});
it("replays a durable status after reconnect without another npm check or launch, and binds its ACK", async () => {
  const w = world(); w.value.setConsent(true); const request = w.request(); w.value.receive(request, w.link); await w.value.tick();
  expect(w.options.lookup).toHaveBeenCalledTimes(1); const status = (w.sent.at(-1) as any).payload;
  w.value.close(); w.disconnect();
  const next = new HubMemberUpdates(w.options); closes.push(() => next.close());
  const sent = vi.fn(async () => {}), link = { ...w.link, current: () => true, linkEpoch: 2, send: sent } as unknown as HubMemberLink;
  next.connected(link); await next.start(); expect(sent).toHaveBeenCalled(); expect(w.options.lookup).toHaveBeenCalledTimes(1);
  next.acknowledge({ id: request.id, version: request.version, sequence: status.sequence }, link);
  const n = sent.mock.calls.length; w.advance(31_000); await next.tick(); expect(sent).toHaveBeenCalledTimes(n);
});
it("keeps consent and retained request views bound to the exact pairing", async () => {
  const w = world(); w.value.setConsent(true); const request = w.request(); w.value.receive(request, w.link); await w.value.tick(); w.value.close();
  const next = new HubMemberUpdates({ ...w.options, binding: "new-pairing" }); closes.push(() => next.close());
  expect(next.consent().on).toBe(false); expect(next.view(request.id)).toBeNull(); await next.start(); expect(w.launch).not.toHaveBeenCalled();
});
it("settles a crashed claim as failed, including its current version, and reports a verified rollback before notice", async () => {
  const w = world(); w.value.setConsent(true); w.idle(true); const request = w.request(); w.value.receive(request, w.link);
  await vi.waitFor(() => expect(w.launch).toHaveBeenCalledTimes(1)); w.value.close();
  const next = new HubMemberUpdates(w.options); closes.push(() => next.close()); await next.start();
  expect(next.view(request.id)).toMatchObject({ state: "failed", currentVersion: "2.3.5" });
  expect(w.notices.at(-1)).toMatchObject({ state: "failed", currentVersion: "2.3.5" });
  const newer = w.request(); next.receive(newer, w.link); await vi.waitFor(() => expect(w.launch).toHaveBeenCalledTimes(2));
  next.complete(newer.id, "rolled-back", "2.3.5");
  expect(w.notices.at(-1)).toMatchObject({ state: "rolled-back", currentVersion: "2.3.5" });
});

it("allows a verified owner's explicit Update now to skip idle, with the same final current check", async () => {
  const w = world(); w.value.setConsent(true); const request = w.request(); w.value.receive(request, w.link); await w.value.tick();
  expect(await w.value.updateNow(request.id, () => true)).toBe(true); expect(w.launch).toHaveBeenCalledTimes(1);
  expect(w.value.manualCandidate(request.id)).toBe(request.version);
});
it("does not claim an owner's immediate start after its local session is revoked during preparation", async () => {
  const w = world(); w.value.setConsent(true); const request = w.request(); w.value.receive(request, w.link); await w.value.tick();
  let release!: () => void, current = true, claimed = false;
  w.options.launch = vi.fn(async (_row, control) => { await new Promise<void>(resolve => { release = resolve; }); claimed = control.claim(); return claimed; });
  const start = w.value.updateNow(request.id, () => current);
  await vi.waitFor(() => expect(w.options.launch).toHaveBeenCalledTimes(1)); current = false; release();
  expect(await start).toBe(false); expect(claimed).toBe(false);
});
it("refuses while another updater is active and rejects changed request reuse", async () => {
  const w = world(); w.value.setConsent(true); w.options.busy = () => true; const request = w.request(); w.value.receive(request, w.link); await w.value.tick();
  expect(w.sent.at(-1)).toMatchObject({ payload: { state: "refused", reasonCode: "update-running" } });
  expect(() => w.value.receive({ ...request, version: "2.5.0" }, w.link)).toThrow(); expect(w.launch).not.toHaveBeenCalled();
});
it("does not admit a request whose seven-day deadline passes during registry verification", async () => {
  const w = world(); w.value.setConsent(true); w.idle(true);
  let finish!: (v: "found") => void;
  w.options.lookup = vi.fn(() => new Promise<"found">(resolve => { finish = resolve; }));
  const request = w.request(); w.value.receive(request, w.link);
  await vi.waitFor(() => expect(w.options.lookup).toHaveBeenCalledTimes(1)); w.advance(7 * 86_400_000); finish("found"); await w.value.tick();
  expect(w.value.view(request.id)?.state).toBe("expired"); expect(w.sent.at(-1)).toMatchObject({ payload: { reasonCode: "offline-7d" } }); expect(w.launch).not.toHaveBeenCalled(); expect(w.notices).toHaveLength(0);
});
it("lets the owner withdraw stored consent while the selected pairing is held, without permitting a stale grant", () => {
  const w = world(); w.value.setConsent(true); w.options.current = () => false;
  expect(w.value.consent()).toEqual({ on: true, available: true });
  expect(w.value.setConsent(false).on).toBe(false); expect(() => w.value.setConsent(true)).toThrow();
});
it("cancels an accepted waiting request when its owner withdraws consent before the Fleet becomes idle", async () => {
  const w = world(); w.value.setConsent(true); const request = w.request(); w.value.receive(request, w.link); await w.value.tick();
  expect(w.value.view(request.id)?.state).toBe("waiting");
  w.value.setConsent(false); await w.value.tick(); w.idle(true); await w.value.tick();
  expect(w.value.view(request.id)?.state).toBe("cancelled");
  expect(w.sent.at(-1)).toMatchObject({ payload: { state: "cancelled", reasonCode: "owner-disabled" } }); expect(w.launch).not.toHaveBeenCalled();
});
it.each(["not-found", "unavailable"] as const)("does not offer a local update for a request this Fleet could not verify (%s)", async result => {
  const w = world(); w.value.setConsent(true); w.options.lookup = async () => result;
  const request = w.request(); w.value.receive(request, w.link); await w.value.tick();
  expect(w.value.view(request.id)?.state).toBe("refused"); expect(w.value.manualCandidate(request.id)).toBeNull();
  expect(await w.value.updateNow(request.id, () => true)).toBe(false); expect(w.launch).not.toHaveBeenCalled();
});
it("waits for the composing host's readiness proof before reporting a restarted target as done", async () => {
  const w = world(); w.value.setConsent(true); w.idle(true); const request = w.request(); w.value.receive(request, w.link);
  await vi.waitFor(() => expect(w.launch).toHaveBeenCalledTimes(1)); w.value.close();
  let ready = false;
  const next = new HubMemberUpdates({ ...w.options, version: request.version, outcome: () => ready ? { state: "done", currentVersion: request.version } : null });
  closes.push(() => next.close()); await next.start(); expect(next.view(request.id)?.state).toBe("updating");
  expect(w.launch).toHaveBeenCalledTimes(1); ready = true; await next.tick();
  expect(next.view(request.id)?.state).toBe("done"); expect(w.launch).toHaveBeenCalledTimes(1);
});
