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
  let floor = 0, now = 1_800_000_000_000, live = true, enabled = true, available = true, lapsed = false;
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
  const options = { store, api, journal, current: () => live, enabled: () => enabled, now: () => now, lapsed: (agent: string) => lapsed && agent === "Docs",
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
    setLapsed: (v: boolean) => { lapsed = v; }, setNotice: (v: boolean) => { noticeResult = v; }, failFinal: (v: boolean) => { failFinal = v; } };
}
/** M-3543: the member side of Share again — a lapsed published agent republishes in place; a working share still does not. */
it("a published agent: a second share is refused (stale-list) unless its share lapsed; then it republishes, same id, next revision, new consent", async () => {
  const r = world();
  await r.processor.apply(randomUUID(), r.request(["Docs"]));
  const first = r.store.list().find(row => row.agent === "Docs")!.committed!;
  expect(first.exposure).toMatchObject({ state: "published", revision: 1 });
  const refused = await r.processor.apply(randomUUID(), r.request(["Docs"]));
  expect(refused.rows[0]!.outcome).toEqual({ ok: false, code: "stale-list" });
  r.setLapsed(true);
  const again = await r.processor.apply(randomUUID(), r.request(["Docs"]));
  expect(again.rows[0]!.outcome).toEqual({ ok: true });
  const after = r.store.list().find(row => row.agent === "Docs")!.committed!;
  expect(after.exposure).toMatchObject({ id: first.exposure.id, state: "published", revision: 2 });
  expect(after.consentId).not.toBe(first.consentId);
});
