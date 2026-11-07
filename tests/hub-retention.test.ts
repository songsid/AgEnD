import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { HUB_RETENTION_DEFAULTS, parseHubRetention } from "../src/hub-retention-policy.js";
import { createHubRetentionControl, retentionMigration } from "../src/hub/retention.js";
import { isSettingsMutation, prepareSettingsEffect } from "../src/settings-effect.js";
import type { FleetConfig } from "../src/types.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() {
  const db = new Database(":memory:"); databases.push(db);
  const hubId = randomUUID(); let live = true;
  retentionMigration(hubId, { contentDays: 30, eventDays: 180 }).up(db);
  db.exec("CREATE TABLE audit(action TEXT)");
  const audit = { appendInTransaction: vi.fn((_record: unknown, database: Database.Database) => {
    expect(database).toBe(db); expect(db.inTransaction).toBe(true);
    db.prepare("INSERT INTO audit VALUES('retention.changed')").run();
  }) };
  const options = { db, hubId, audit, current: () => live, now: () => 1234 };
  return { db, audit, options, control: createHubRetentionControl(options), fence: () => { live = false; } };
}
describe("Hub retention policy", () => {
  it("offers suggestions only; refuses missing, extra, coerced, fractional, unbounded and unsafe values", () => {
    expect(HUB_RETENTION_DEFAULTS).toEqual({ contentDays: 7, eventDays: 30 });
    const p = { contentDays: 7, eventDays: 30, revision: 1 };
    for (const bad of [null, [], {}, { ...p, extra: true }, { ...p, contentDays: "7" }, { ...p, eventDays: 0 },
      { ...p, contentDays: 3651 }, { ...p, contentDays: 1.5 }, { ...p, revision: 0 }, { ...p, revision: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(() => parseHubRetention(bad)).toThrow("invalid_retention");
    }
    expect(parseHubRetention({ contentDays: 1, eventDays: 3650, revision: 1 })).toEqual({ contentDays: 1, eventDays: 3650, revision: 1 });
  });
  it("updates only the expected revision, with required same-transaction audit and no configuration reseal", () => {
    const s = setup();
    expect(s.control.read()).toEqual({ contentDays: 30, eventDays: 180, revision: 1 });
    expect(s.control.update({ contentDays: 7, eventDays: 30, revision: 1 }, () => true)).toEqual({ contentDays: 7, eventDays: 30, revision: 2 });
    expect(s.audit.appendInTransaction).toHaveBeenCalledOnce();
    expect(s.audit.appendInTransaction.mock.calls[0][0]).toMatchObject({ actor: { kind: "local-host" }, action: "retention.changed", policyVersion: 2 });
    expect(() => s.control.update({ contentDays: 60, eventDays: 90, revision: 1 }, () => true)).toThrow("conflict");
    expect(s.control.read()).toEqual({ contentDays: 7, eventDays: 30, revision: 2 });
    expect(createHubRetentionControl(s.options).read()).toEqual(s.control.read());
  });
  it("rolls back the policy and audit together on a required audit failure", () => {
    const s = setup();
    s.audit.appendInTransaction.mockImplementationOnce(() => { s.db.prepare("INSERT INTO audit VALUES('failed')").run(); throw Error("disk full"); });
    expect(() => s.control.update({ contentDays: 1, eventDays: 7, revision: 1 }, () => true)).toThrow("disk full");
    expect(s.control.read()).toEqual({ contentDays: 30, eventDays: 180, revision: 1 });
    expect(s.db.prepare("SELECT count(*) n FROM audit").get()).toEqual({ n: 0 });
  });
  it("preserves the revision and writes no audit when the policy is unchanged", () => {
    const s = setup(), before = s.control.read();
    expect(s.control.update(before, () => true)).toEqual(before);
    expect(s.control.read()).toEqual(before);
    expect(s.audit.appendInTransaction).not.toHaveBeenCalled();
    expect(s.db.prepare("SELECT count(*) n FROM audit").get()).toEqual({ n: 0 });
  });
  it("rejects asynchronous audit before committing a policy", () => {
    const s = setup();
    s.audit.appendInTransaction.mockImplementationOnce(() => Promise.resolve() as never);
    expect(() => s.control.update({ contentDays: 1, eventDays: 7, revision: 1 }, () => true)).toThrow("retention_audit_unavailable");
    expect(s.control.read().revision).toBe(1);
  });
  it("rechecks caller and generation inside the transaction, including reentrant audit revocation", () => {
    const s = setup(), input = { contentDays: 7, eventDays: 30, revision: 1 };
    expect(() => s.control.update(input, () => false)).toThrow("unavailable");
    let current = true;
    s.audit.appendInTransaction.mockImplementationOnce(() => { current = false; });
    expect(() => s.control.update(input, () => current)).toThrow("unavailable");
    expect(s.control.read().revision).toBe(1);
    s.fence(); expect(() => s.control.read()).toThrow("unavailable"); expect(() => s.control.update(input, () => true)).toThrow("unavailable");
  });
  it("does not reset missing or foreign policy state to the initialized defaults", () => {
    const s = setup();
    s.db.prepare("UPDATE hub_retention SET hub_id=?").run(randomUUID());
    expect(() => s.control.read()).toThrow("retention_unavailable");
    s.db.exec("DELETE FROM hub_retention");
    expect(() => createHubRetentionControl(s.options)).toThrow("retention_unavailable");
  });
  it("classifies every change for the existing owner confirmation with a duration-specific fingerprint", () => {
    const context = { config: { defaults: {}, instances: {} } as FleetConfig, classic: {} };
    const path = "/api/settings/hub/retention", input = { contentDays: 7, eventDays: 30, revision: 1 };
    expect(isSettingsMutation("PUT", path)).toBe(true);
    const a = prepareSettingsEffect("PUT", path, input, context).diff!;
    expect(a).toMatchObject({ section: "access", authority: { connections: [], primaryGeneral: true, unknown: false } });
    expect(a.summary.join(" ")).toContain("7 days"); expect(a.summary.join(" ")).toContain("30 days");
    expect(prepareSettingsEffect("PUT", path, { ...input, eventDays: 90 }, context).diff!.fingerprint).not.toBe(a.fingerprint);
    expect(() => prepareSettingsEffect("PUT", path, { ...input, eventDays: -1 }, context)).toThrow("invalid_retention");
  });
});
