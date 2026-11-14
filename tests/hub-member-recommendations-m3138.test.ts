import { afterEach, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { HubMemberRecommendations, HUB_MEMBER_RECOMMENDATION_MIGRATION } from "../src/hub/member/recommendations.js";
import type { HubMemberLink } from "../src/hub/client.js";
const dbs: Database.Database[] = [];
afterEach(() => dbs.splice(0).forEach(db => db.close()));
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function world() {
  const db = new Database(":memory:"); dbs.push(db); HUB_MEMBER_RECOMMENDATION_MIGRATION.up(db);
  let mounted = true, connected = true;
  const lookup = vi.fn(async (_v: string): Promise<"found" | "not-found" | "unavailable"> => "found");
  const changed = vi.fn(), send = vi.fn(async (_f: unknown) => {});
  const options = { db, hubId: randomUUID(), hubName: "hub.test", version: "2.4.0-beta.3", now: () => 1_800_000_000_000,
    current: () => mounted, lookup, changed };
  const receiver = new HubMemberRecommendations(options);
  const link = { current: () => connected, features: new Set(["fleet-recommend-v1"]), linkEpoch: 1, send } as unknown as HubMemberLink;
  const recommendation = (revision = 1, version: string | null = "2.4.0-beta.4") => ({ revision, version, setAt: 1_799_999_999_000 });
  return { db, receiver, link, lookup, changed, send, options, recommendation, disconnect: () => { connected = false; }, unmount: () => { mounted = false; } };
}
it("verifies newer advice once, persists it before ACK, and restores it without network in a selected member database", async () => {
  const w = world(); w.receiver.receive(w.recommendation(), w.link); expect(w.receiver.view()).toBeNull(); await settle();
  expect(w.lookup).toHaveBeenCalledWith("2.4.0-beta.4");
  expect(w.receiver.view()).toMatchObject({ hubId: w.options.hubId, hubName: "hub.test", version: "2.4.0-beta.4", revision: 1 });
  expect(w.send.mock.calls[0]![0]).toMatchObject({ type: "fleet.recommendation-ack", payload: { revision: 1, status: "offered" } });
  w.receiver.receive(w.recommendation(), w.link); await settle(); expect(w.lookup).toHaveBeenCalledTimes(1); expect(w.changed).toHaveBeenCalledTimes(1);
  w.disconnect(); expect(w.receiver.view()).not.toBeNull();
  const restored = new HubMemberRecommendations(w.options); expect(restored.view()).toEqual(w.receiver.view());
  expect(w.lookup).toHaveBeenCalledTimes(1); w.receiver.close(); expect(w.receiver.view()).toBeNull();
});
it.each(["not-found", "unavailable"] as const)("does not offer or ACK a version that npm reports as %s; exact replay retries", async result => {
  const w = world(); w.lookup.mockResolvedValueOnce(result); w.receiver.receive(w.recommendation(), w.link); await settle();
  expect(w.receiver.view()).toBeNull(); expect(w.send).not.toHaveBeenCalled();
  w.receiver.receive(w.recommendation(), w.link); await settle(); expect(w.receiver.view()?.revision).toBe(1); expect(w.send).toHaveBeenCalledTimes(1);
});
it("clears on a newer none/current policy, ignores older revisions, and refuses altered same-revision data", async () => {
  const w = world(); w.receiver.receive(w.recommendation(), w.link); await settle();
  w.receiver.receive(w.recommendation(2, null), w.link); await settle(); expect(w.receiver.view()).toBeNull();
  expect(w.send.mock.calls.at(-1)![0]).toMatchObject({ payload: { status: "cleared" } });
  w.receiver.receive(w.recommendation(), w.link); await settle(); expect(w.send).toHaveBeenCalledTimes(2);
  expect(() => w.receiver.receive(w.recommendation(2, "9.0.0"), w.link)).toThrow("conflict");
  w.receiver.receive(w.recommendation(3, "2.4.0-beta.2"), w.link); await settle();
  expect(w.send.mock.calls.at(-1)![0]).toMatchObject({ payload: { status: "current" } }); expect(w.lookup).toHaveBeenCalledTimes(1);
});
it("a new revision wins over an older npm lookup in flight, without delaying receive", async () => {
  const w = world(); let release!: (value: "found") => void; w.lookup.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  expect(w.receiver.receive(w.recommendation(), w.link)).toBeUndefined();
  w.receiver.receive(w.recommendation(2, null), w.link); release("found"); await settle();
  expect(w.receiver.view()).toBeNull(); expect(w.send).toHaveBeenCalledTimes(1);
  expect(w.send.mock.calls[0]![0]).toMatchObject({ payload: { revision: 2, status: "cleared" } });
});
it("rechecks selected pairing and current link after npm, and never commits after teardown", async () => {
  const w = world(); let release!: (value: "found") => void; w.lookup.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  w.receiver.receive(w.recommendation(), w.link); w.unmount(); release("found"); await settle();
  expect(w.receiver.view()).toBeNull(); expect(w.send).not.toHaveBeenCalled();
  expect(w.db.prepare("SELECT verified FROM hub_member_version_recommendation").get()).toEqual({ verified: 0 });
});
it("recovers a dropped ACK by reusing durable verification on the replacement link", async () => {
  const w = world(); w.send.mockRejectedValueOnce(Error("lost ACK")); w.receiver.receive(w.recommendation(), w.link); await settle();
  const send = vi.fn(async () => {}), next = { ...w.link, linkEpoch: 2, send };
  w.receiver.receive(w.recommendation(), next); await settle();
  expect(w.lookup).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1); expect(w.changed).toHaveBeenCalledTimes(1);
});
it("accepts nothing without the negotiated receiver offer", async () => {
  const w = world(); w.receiver.receive(w.recommendation(), { ...w.link, features: new Set() }); await settle();
  expect(w.lookup).not.toHaveBeenCalled(); expect(w.db.prepare("SELECT * FROM hub_member_version_recommendation").all()).toEqual([]);
});
