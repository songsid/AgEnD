/** Owner Settings policy in the private Hub DB. The sealed config supplies the initial values only. */
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { parseHubRetention, type HubRetentionPolicy, type HubRetentionView } from "../hub-retention-policy.js";
import type { HubMigration } from "./db.js";
import type { HubAuditStore } from "./audit/index.js";

export interface HubRetentionControl {
  read(): HubRetentionView;
  update(input: unknown, current: () => boolean): HubRetentionView;
}
export function retentionMigration(hubId: string, initial: HubRetentionPolicy): HubMigration {
  const policy = parseHubRetention({ ...initial, revision: 1 });
  return { component: "s5-retention", version: 1, up(db) {
    db.exec(`CREATE TABLE hub_retention(singleton INTEGER PRIMARY KEY CHECK(singleton=1), hub_id TEXT NOT NULL,
      content_days INTEGER NOT NULL CHECK(content_days BETWEEN 1 AND 3650),
      event_days INTEGER NOT NULL CHECK(event_days BETWEEN 1 AND 3650), revision INTEGER NOT NULL CHECK(revision>=1));`);
    db.prepare("INSERT INTO hub_retention VALUES(1, ?, ?, ?, 1)").run(hubId, policy.contentDays, policy.eventDays);
  } };
}
export function createHubRetentionControl(options: {
  db: Database.Database; hubId: string; audit: Pick<HubAuditStore, "appendInTransaction">; current(): boolean; now(): number;
}): HubRetentionControl {
  const { db } = options;
  const assert = (current: () => boolean = () => true) => { if (!options.current() || !current()) throw Error("unavailable"); };
  const read = (): HubRetentionView => {
    assert();
    const row = db.prepare("SELECT hub_id, content_days, event_days, revision FROM hub_retention WHERE singleton=1").get() as
      { hub_id: string; content_days: number; event_days: number; revision: number } | undefined;
    if (!row || row.hub_id !== options.hubId) throw Error("retention_unavailable");
    return parseHubRetention({ contentDays: row.content_days, eventDays: row.event_days, revision: row.revision });
  };
  read(); // Missing/corrupt state never resets to a longer initial retention.
  return { read, update(input, current) {
    const next = parseHubRetention(input);
    return db.transaction(() => {
      assert(current);
      const before = read();
      if (before.revision !== next.revision || before.revision >= Number.MAX_SAFE_INTEGER) throw Error("conflict");
      if (before.contentDays === next.contentDays && before.eventDays === next.eventDays) return before;
      const revision = before.revision + 1;
      const result: unknown = options.audit.appendInTransaction({ id: randomUUID(), sequence: revision, at: options.now(), requestId: randomUUID(),
        actor: { kind: "local-host" }, action: "retention.changed", result: "completed", policyVersion: revision,
        reasonCode: `content-${next.contentDays}-events-${next.eventDays}` }, db);
      if (result && typeof (result as { then?: unknown }).then === "function") throw Error("retention_audit_unavailable");
      assert(current);
      db.prepare("UPDATE hub_retention SET content_days=?, event_days=?, revision=? WHERE singleton=1").run(next.contentDays, next.eventDays, revision);
      return { contentDays: next.contentDays, eventDays: next.eventDays, revision };
    }).immediate();
  } };
}
