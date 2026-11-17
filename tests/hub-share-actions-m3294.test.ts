import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createHubMemberExposureApi } from "../src/hub/member/exposure-api.js";
import { HUB_EXPOSURE_MIGRATION, HubExposureStore } from "../src/hub/member/exposures.js";
import { memberAgentCatalog, type MemberCatalogAgent } from "../src/hub/member/agent-catalog.js";
import { HUB_MEMBER_SHARING_MIGRATION, HubMemberSharingJournal, HUB_SHARING_UNDO_MS, type SharingRecord } from "../src/hub/member/sharing-journal.js";
import { HubMemberSharing } from "../src/hub/member/sharing.js";
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function world() {
  const db = new Database(":memory:"); dbs.push(db);
  HUB_EXPOSURE_MIGRATION.up(db); HUB_MEMBER_SHARING_MIGRATION.up(db);
  let floor = 0, now = 1_800_000_000_000, live = true, enabled = true, available = true;
  let noticeResult = true, failFinal = false;
  const owner = { realm: "corp", objectId: randomUUID() }, fleetId = randomUUID();
  const agents: MemberCatalogAgent[] = ["Docs", "General", "Classic"].map((instance, i) => ({ instance, displayName: instance,
    description: "A helper", avatar: null, kind: i === 2 ? "classic-room" : "agent", general: i === 1, shareable: true, incarnation: String(i + 1).repeat(64) }));
  const store = new HubExposureStore(db, { binding: () => ({ owner, fleetId }), floor: { read: () => floor, raise: value => { floor = value; } },
    views: new Map(), audit: { appendInTransaction() {} } }); store.initialize();
  let snapshots = 0;
  const api = createHubMemberExposureApi({ store, agents: () => agents.map(row => ({ name: row.instance, display: row.displayName, ...(row.kind === "classic-room" ? { kind: "classic-room" as const } : {}) })),
    readinessCandidate: c => available ? { ok: true, policyDigest: c.exposure.policyDigest, exposureRevision: c.exposure.revision } : { ok: false, reasonCode: "provider-unavailable" },
    afterCommit: async () => { snapshots++; } });
  const journalOptions = { db, binding: "paired-binding", owner, fleetId, current: () => live, now: () => now,
    agentToken: (agent: string) => agents.find(row => row.instance === agent)?.incarnation ?? null };
  const journal = new HubMemberSharingJournal(journalOptions), notices = new Map<string, SharingRecord>();
  const options = { store, api, journal, current: () => live, enabled: () => enabled, now: () => now,
    agents: () => agents, catalog: () => memberAgentCatalog(enabled, agents), snapshot: async () => { snapshots++; },
    notice: async (record: SharingRecord) => {
      if (record.rows.every(row => row.outcome !== null) && failFinal) throw Error("notice disk unavailable");
      if (noticeResult) notices.set(record.noticeKey, structuredClone(record));
      return noticeResult;
    } };
  const processor = new HubMemberSharing(options);
  const request = (share = ["Docs"], stop: string[] = []) => ({ by: owner, catalogRevision: options.catalog().revision,
    share, stop, createdAt: now, expiresAt: now + 600_000 });
  return { db, store, api, journal, processor, options, agents, notices, request,
    get snapshots() { return snapshots; }, get now() { return now; }, setNow: (v: number) => { now = v; },
    setLive: (v: boolean) => { live = v; }, setEnabled: (v: boolean) => { enabled = v; }, setAvailable: (v: boolean) => { available = v; },
    setNotice: (v: boolean) => { noticeResult = v; }, failFinal: (v: boolean) => { failFinal = v; } };
}
it("uses the canonical writer for selected agents, including General and Classic, with one durable notice", async () => {
  const r = world(), id = randomUUID(), request = r.request(["Docs", "General", "Classic", "Missing"]);
  const record = await r.processor.apply(id, request);
  expect(record.rows.map(row => row.outcome)).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: false, code: "unknown-agent" }]);
  expect(r.api.list().every(row => row.contactLimit && row.state === "published")).toBe(true);
  expect(r.notices.size).toBe(1); expect(record.finalNoticeDurable).toBe(true);
  const revision = r.store.check();
  r.setEnabled(false); r.setNow(request.expiresAt + 1);
  expect((await r.processor.apply(id, request)).rows).toEqual(record.rows);
  expect(r.store.check()).toBe(revision); expect(r.notices.size).toBe(1);
  await expect(r.processor.apply(id, { ...request, share: ["Classic"] })).rejects.toMatchObject({ code: "conflict" });
});
it("never changes an exposure before the web notice is durable, and retries the same notice without extending Undo", async () => {
  const r = world(), id = randomUUID(), request = r.request(); r.setNotice(false);
  await expect(r.processor.apply(id, request)).rejects.toMatchObject({ code: "unavailable" });
  expect(r.store.snapshot().exposures).toEqual([]);
  r.setNotice(true); r.failFinal(true);
  await expect(r.processor.apply(id, request)).rejects.toThrow("notice disk unavailable");
  const saved = r.journal.read(id)!, revision = r.store.check();
  expect(saved.rows[0].outcome).toEqual({ ok: true }); expect(saved.finalNoticeDurable).toBe(false);
  r.failFinal(false); r.setNow(r.now + 30_000);
  const reopened = new HubMemberSharing({ ...r.options, journal: new HubMemberSharingJournal({
    db: r.db, binding: "paired-binding", owner: request.by, fleetId: saved.rows[0].after!.exposure.fleetId,
    current: r.options.current, now: r.options.now, agentToken: agent => r.agents.find(row => row.instance === agent)?.incarnation ?? null }) });
  const retried = await reopened.apply(id, request);
  expect(retried.undoUntil).toBe(saved.undoUntil); expect(r.store.check()).toBe(revision); expect(r.notices.size).toBe(1);
});
it("freezes stale-list and switched-off refusals so replay cannot become a new authorization", async () => {
  const r = world(), id = randomUUID(), request = { ...r.request(), catalogRevision: "f".repeat(64) };
  expect((await r.processor.apply(id, request)).rows[0].outcome).toEqual({ ok: false, code: "stale-list" });
  const off = randomUUID(), second = r.request(["General"]); r.setEnabled(false);
  expect((await r.processor.apply(off, second)).rows[0].outcome).toEqual({ ok: false, code: "switched-off" });
  r.setEnabled(true);
  expect((await r.processor.apply(off, second)).rows[0].outcome).toEqual({ ok: false, code: "switched-off" });
  expect(r.store.snapshot().exposures).toEqual([]);
});
it("Undo changes only the original unchanged incarnations and requires the current local administrator", async () => {
  const r = world(), record = await r.processor.apply(randomUUID(), r.request(["Docs", "Classic"]));
  await expect(r.processor.undo(record.noticeKey, "operator", () => false)).rejects.toMatchObject({ code: "denied" });
  r.agents[0] = { ...r.agents[0], incarnation: "f".repeat(64) };
  const undone = await r.processor.undo(record.noticeKey, "operator", () => true);
  expect(undone.rows.map(row => row.undoOutcome)).toEqual([{ ok: false, code: "stale-list" }, { ok: true }]);
  expect(r.api.list().map(row => row.state)).toEqual(["published", "withdrawn", "withdrawn"]);
  const revision = r.store.check();
  expect((await r.processor.undo(record.noticeKey, "operator", () => true)).undoId).toBe(undone.undoId);
  expect(r.store.check()).toBe(revision);
});
it("Undo-stop republishes with fresh consent and the previous contact limit; a later Settings change wins", async () => {
  const r = world(); r.api.publish({ agent: "Docs", dataViewId: "agent", tools: [], expectedRevision: 0, contactLimit: false });
  const original = r.store.list()[0].committed!, stopped = await r.processor.apply(randomUUID(), r.request([], [original.exposure.id]));
  expect(r.store.localExposure(original.exposure.id)).toBeNull();
  const undone = await r.processor.undo(stopped.noticeKey, "operator", () => true), restored = undone.rows[0].undoAfter!;
  expect(restored.contactLimit).toBe(false); expect(restored.consentId).not.toBe(original.consentId);
  expect(restored.exposure.revision).toBe(3); expect(restored.exposure.id).toBe(original.exposure.id);
  const again = await r.processor.apply(randomUUID(), r.request([], [restored.exposure.id]));
  r.api.publish({ agent: "Docs", dataViewId: "agent", tools: [], expectedRevision: 4, contactLimit: true });
  const later = r.store.list()[0].committed!;
  expect((await r.processor.undo(again.noticeKey, "operator", () => true)).rows[0].undoOutcome).toEqual({ ok: false, code: "stale-list" });
  expect(r.store.list()[0].committed).toEqual(later);
});
it("enforces the 24-hour boundary and readiness while keeping withdrawal fences intact", async () => {
  const r = world(), record = await r.processor.apply(randomUUID(), r.request());
  r.setNow(record.noticeAt! + HUB_SHARING_UNDO_MS);
  await expect(r.processor.undo(record.noticeKey, "operator", () => true)).rejects.toMatchObject({ code: "expired" });
  r.setAvailable(false);
  const refused = await r.processor.apply(randomUUID(), r.request(["Classic"]));
  expect(refused.rows[0].outcome).toEqual({ ok: false, code: "not-shareable" });
  expect(r.api.list().find(row => row.agent === "Classic")!.state).toBe("withdrawn");
});
