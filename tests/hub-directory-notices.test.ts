/** Owned WAL/FULL SQLite and real audit/floor. Authority contexts are inert; no HTTP/UI or live-directory claim. */
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyHubMigrations, openHubDatabase } from "../src/hub/db.js";
import { createHubAudit, HUB_AUDIT_MIGRATION } from "../src/hub/audit/index.js";
import { HUB_HTTP_MIGRATIONS } from "../src/hub/http/schema.js";
import { groupPolicyMigration } from "../src/hub/group-policy/store.js";
import { HUB_TRANSPORT_MIGRATION, HubTransportStore } from "../src/hub/store.js";
import { HubFileVersionFloor } from "../src/hub/version-floor.js";
import { sha256, personKeyString } from "../src/hub/identity.js";
import { createHubDirectorySettingsDecision, HUB_DIRECTORY_SETTINGS_MIGRATION, type HubDirectoryDecisionRequest } from "../src/hub/settings-directory-decision.js";
import { createHubDirectoryNotices } from "../src/hub/settings-directory-notices.js";
import type { HubRequestContext, PersonKey } from "../src/hub/types.js";

const recipient = { realm: "fictional", objectId: "11111111-1111-4111-8111-111111111111" };
const outsider = { realm: "fictional", objectId: "22222222-2222-4222-8222-222222222222" };
const image = (n: number) => Object.fromEntries(["configDigest", "configSha", "directorySha", "manifestSha", "bindSecretSha"].map(k => [k, sha256(String(n))])) as HubDirectoryDecisionRequest["before"];
const cleanup: Array<() => void> = [];
const host = (current = () => true) => ({ requestId: randomUUID(), current });
function context(who: PersonKey = recipient, isCurrent = () => true): HubRequestContext {
  return { requestId: randomUUID(), isCurrent, requirePerson: async () => ({ ...who }),
    current: async () => ({ kind: "directory", person: { ...who }, sessionId: "fake-session" }),
    requireAdmin: async () => { throw new Error("no admin or group authority needed"); } };
}
function rig() {
  const home = mkdtempSync(join(tmpdir(), "hub-directory-notices-")); chmodSync(home, 0o700);
  const hubId = randomUUID(), key = randomBytes(32), floor = new HubFileVersionFloor(home, "hub/floors/test"); floor.initialize();
  let db = openHubDatabase(home, "hub/test.sqlite", { create: true }), live = true;
  let auditHook: (() => unknown) | undefined;
  let decision: ReturnType<typeof createHubDirectorySettingsDecision>, notices: ReturnType<typeof createHubDirectoryNotices>;
  function open() {
    applyHubMigrations(db, [HUB_AUDIT_MIGRATION, HUB_TRANSPORT_MIGRATION, ...HUB_HTTP_MIGRATIONS,
      groupPolicyMigration(hubId, recipient.realm, "generation-old"), HUB_DIRECTORY_SETTINGS_MIGRATION]);
    const audit = createHubAudit({ db, contentKey: key, now: () => 1000 });
    const transport = new HubTransportStore(db, { floor, appendAudit: (record, owning) => audit.appendInTransaction(record, owning) });
    if (!db.prepare("SELECT 1 FROM hub_transport_state").get()) transport.initialize();
    decision = createHubDirectorySettingsDecision({ db, transport, hubId });
    notices = createHubDirectoryNotices({ db, transport, hubId, hostSink: "owner-needs-you", now: () => 1000, current: () => live,
      audit: { appendInTransaction(record, owning) { audit.appendInTransaction(record, owning); const hook = auditHook; auditHook = undefined; return hook?.() as void; } } });
  }
  open();
  function enqueue(n = 1, people: PersonKey[] = [recipient], actor: HubDirectoryDecisionRequest["actor"] = { kind: "host-owner", sessionId: "old-host-session", requestId: randomUUID() }) {
    let id = "";
    for (let i = 0; i < n; i++) {
      const expected = decision.inspect(), count = expected.directoryEpoch;
      const request: HubDirectoryDecisionRequest = { id: randomUUID(), expected, before: image(count), after: image(count + 1),
        generation: `generation-${count + 1}`, receiptSha: "d".repeat(64), at: 1000,
        actor, changes: ["server", "secret"],
        recipients: [{ kind: "host", sink: "owner-needs-you" }, ...people.map(person => ({ kind: "person" as const, person }))] };
      decision.decide(request, () => {}); id = decision.notices().at(-1)!.id;
    }
    return id;
  }
  const result = { get db() { return db; }, get notices() { return notices; }, get decision() { return decision; }, enqueue,
    states: (id: string) => db.prepare("SELECT kind,target,state FROM hub_settings_security_targets WHERE notice_id=? ORDER BY kind,target").all(id),
    auditOnce: (hook: () => unknown) => { auditHook = hook; }, stop: () => { live = false; },
    auditCount: () => (db.prepare("SELECT count(*) n FROM hub_audit").get() as { n: number }).n,
    restart: () => { notices.close(); db.close(); db = openHubDatabase(home, "hub/test.sqlite", { create: false }); open(); },
  };
  cleanup.push(() => { notices.close(); if (db.open) db.close(); key.fill(0); rmSync(home, { recursive: true, force: true }); expect(existsSync(home)).toBe(false); });
  return result;
}
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

describe("durable directory security notice recipients", () => {
  it("projects the original recipient only, without secret/config/session/recipient payloads or an implicit ACK", async () => {
    const r = rig(), id = r.enqueue(), before = r.states(id);
    const page = await r.notices.forSession(context());
    expect(page).toEqual({ v: 1, items: [{ id, operationId: r.decision.inspect().operationId, kind: "directory", phase: "applying",
      at: 1000, actor: { kind: "host-owner" }, changes: ["server", "secret"], acknowledged: false }], nextBefore: null });
    expect(r.states(id)).toEqual(before);
    expect(r.auditCount()).toBe(2);
    expect(await r.notices.forSession(context(outsider))).toEqual({ v: 1, items: [], nextBefore: null });
    await expect(r.notices.acknowledgeSession(context(outsider), id)).rejects.toThrow(/not-found/);
    expect(r.states(id)).toEqual(before);
  });
  it("keeps old unread rows accessible past 100 newer notices; ACK is exact and independent of the current page", async () => {
    const r = rig(), oldest = r.enqueue(); r.enqueue(104);
    const seen: string[] = []; let before: string | undefined;
    do {
      const page = await r.notices.forSession(context(), { limit: 20, before });
      expect(page.items.length).toBeLessThanOrEqual(20); seen.push(...page.items.map(n => n.id)); before = page.nextBefore ?? undefined;
    } while (before);
    expect(seen).toHaveLength(105); expect(new Set(seen).size).toBe(105); expect(seen.at(-1)).toBe(oldest);
    await r.notices.acknowledgeSession(context(), oldest);
    expect(r.states(oldest)).toEqual([{ kind: "host", target: "owner-needs-you", state: "queued" },
      { kind: "person", target: personKeyString(recipient), state: "delivered" }]);
    const audits = r.auditCount(); await r.notices.acknowledgeSession(context(), oldest); expect(r.auditCount()).toBe(audits);
    expect((await r.notices.forSession(context(), { limit: 100, unread: true })).items.every(n => !n.acknowledged)).toBe(true);
    r.restart();
    expect((await r.notices.forSession(context(), { limit: 100, before: seen[99] })).items.at(-1)).toMatchObject({ id: oldest, acknowledged: true });
    expect((await r.notices.forSession(context(), { before: seen[99], unread: true })).items.map(n => n.id)).not.toContain(oldest);
  });
  it("binds host ACK to the configured sink, independently of person ACK, across close/reopen", async () => {
    const r = rig(), id = r.enqueue(); r.notices.acknowledgeHost(host(), id); r.restart();
    expect(r.notices.forHost(host()).items[0]).toMatchObject({ id, acknowledged: true });
    expect((await r.notices.forSession(context())).items[0]).toMatchObject({ id, acknowledged: false });
    expect(r.notices.forHost(host(), { unread: true }).items).toEqual([]);
    expect(() => r.notices.forHost(host(() => false))).toThrow(/revoked/);
  });
  it("projects the immutable acting administrator without their browser session or request", async () => {
    const r = rig(), actor = { kind: "hub-administrator" as const, person: recipient, sessionId: "old-private-session", requestId: randomUUID() };
    r.enqueue(1, [recipient], actor);
    expect((await r.notices.forSession(context())).items[0]!.actor).toEqual({ kind: "hub-administrator", person: recipient });
  });
  it("never uses a caller-selected recipient or another recipient's cursor", async () => {
    const r = rig(), privateId = r.enqueue(1, [outsider]); r.enqueue();
    await expect(r.notices.forSession(context(), { before: privateId })).rejects.toThrow(/not-found/);
    await expect(r.notices.forSession(context(), { target: personKeyString(outsider) } as never)).rejects.toThrow(/invalid/);
    expect(() => r.notices.forHost(host(), { sink: "other" } as never)).toThrow(/invalid/);
    expect(() => r.notices.forHost(host(), { limit: 101 })).toThrow(/invalid/);
  });
  it("retains both original and forward-compensation notices with the same old recipients", async () => {
    const r = rig(), originalId = r.enqueue(), original = r.decision.operation(r.decision.inspect().operationId!);
    r.decision.compensate(original.id, { id: randomUUID(), expected: r.decision.inspect(), before: original.after, after: original.before,
      generation: original.previousGeneration, receiptSha: "e".repeat(64), actor: original.actor, at: 1001,
      changes: original.changes, recipients: original.recipients }, () => {});
    r.restart();
    const page = await r.notices.forSession(context());
    expect(page.items.map(n => n.kind)).toEqual(["directory-compensation", "directory"]);
    expect(page.items[1]!.id).toBe(originalId); expect(page.items.every(n => n.phase === "applying" && !n.acknowledged)).toBe(true);
  });
  it.each(["read", "ack"] as const)("late authority revocation during %s audit rolls back audit and ACK", async kind => {
    const r = rig(), id = r.enqueue(); let current = true; const ctx = context(recipient, () => current), before = r.auditCount();
    r.auditOnce(() => { current = false; });
    await expect(kind === "read" ? r.notices.forSession(ctx) : r.notices.acknowledgeSession(ctx, id)).rejects.toThrow(/revoked/);
    expect(r.auditCount()).toBe(before); expect(r.states(id).every(row => (row as { state: string }).state === "queued")).toBe(true);
  });
  it.each(["throw", "thenable", "retarget", "body", "operation", "head", "delete"] as const)("refuses %s at the required ACK audit with no publication", async fault => {
    const r = rig(), id = r.enqueue(), before = r.auditCount(), rows = r.states(id);
    r.auditOnce(() => {
      if (fault === "throw") throw new Error("audit failed");
      if (fault === "thenable") return Promise.resolve();
      if (fault === "retarget") r.db.prepare("UPDATE hub_settings_security_targets SET target=? WHERE kind='person'").run(personKeyString(outsider));
      if (fault === "body") r.db.prepare("UPDATE hub_settings_security_notices SET body=json_set(body,'$.changes',json('[\"ca\"]')) WHERE id=?").run(id);
      if (fault === "operation") r.db.prepare("UPDATE hub_settings_operations SET body=json_set(body,'$.at',1002)").run();
      if (fault === "head") r.db.prepare("UPDATE hub_group_policy SET body=json_set(body,'$.revision',json_extract(body,'$.revision')+1)").run();
      if (fault === "delete") r.db.prepare("DELETE FROM hub_settings_security_targets WHERE kind='person'").run();
    });
    await expect(r.notices.acknowledgeSession(context(), id)).rejects.toThrow();
    expect(r.auditCount()).toBe(before); expect(r.states(id)).toEqual(rows);
    expect((await r.notices.forSession(context())).items[0]).toMatchObject({ id, acknowledged: false, changes: ["server", "secret"] });
  });
  it("checks saved rows again after a disclosure audit, and checks even an already-ACKed row", async () => {
    const r = rig(), id = r.enqueue();
    r.auditOnce(() => { r.db.prepare("UPDATE hub_settings_security_targets SET state='delivered' WHERE kind='person'").run(); });
    await expect(r.notices.forSession(context())).rejects.toThrow(/conflict/);
    await r.notices.acknowledgeSession(context(), id);
    const before = r.auditCount(); let current = true;
    await expect(r.notices.acknowledgeSession(context(recipient, () => { const value = current; current = false; return value; }), id)).rejects.toThrow(/revoked/);
    expect(r.auditCount()).toBe(before);
  });
  it("captures request/proof/query before eligibility awaits and refuses a changed session on return", async () => {
    const r = rig(); r.enqueue(); let release!: (who: PersonKey) => void, live = true;
    const ctx = context(recipient, () => live), requestId = ctx.requestId;
    ctx.requirePerson = () => new Promise(resolve => { release = resolve; });
    const query = { limit: 1 }, pending = r.notices.forSession(ctx, query);
    Object.assign(ctx, { requestId: "changed", isCurrent: () => true }); query.limit = 101; live = false; release(recipient);
    await expect(pending).rejects.toThrow(/revoked/);
    expect(requestId).not.toBe(ctx.requestId);
  });
  it("uses the original query, actor methods and request id when the unchanged authority settles", async () => {
    const r = rig(); r.enqueue(2); let release!: (who: PersonKey) => void;
    const ctx = context(), requestId = ctx.requestId, query = { limit: 1 };
    ctx.requirePerson = () => new Promise(resolve => { release = resolve; });
    const pending = r.notices.forSession(ctx, query);
    Object.assign(ctx, { requestId: "replacement", current: async () => ({ kind: "directory", person: outsider, sessionId: "replacement" }) });
    query.limit = 101; release(recipient);
    expect((await pending).items).toHaveLength(1);
    expect(r.db.prepare("SELECT request_id FROM hub_audit ORDER BY sequence DESC LIMIT 1").get()).toEqual({ request_id: requestId });
  });
  it("permanent close refuses held eligibility continuations and later host calls", async () => {
    const r = rig(); r.enqueue(); let release!: (who: PersonKey) => void;
    const ctx = context(); ctx.requirePerson = () => new Promise(resolve => { release = resolve; });
    const pending = r.notices.forSession(ctx); r.notices.close(); release(recipient);
    await expect(pending).rejects.toThrow(/unavailable/);
    expect(() => r.notices.forHost(host())).toThrow(/unavailable/);
    let entered = 0; const later = context(); later.requirePerson = async () => { entered++; return recipient; };
    await expect(r.notices.forSession(later)).rejects.toThrow(/unavailable/); expect(entered).toBe(0);
  });
  it("refuses mismatched person, local-host impersonation, absent current proof, Stop, and nested transactions", async () => {
    const r = rig(); r.enqueue(); const ctx = context();
    ctx.current = async () => ({ kind: "directory", person: outsider, sessionId: "fake" });
    await expect(r.notices.forSession(ctx)).rejects.toThrow(/revoked/);
    ctx.current = async () => ({ kind: "local-host", sessionId: "fake", directoryBinding: recipient });
    await expect(r.notices.forSession(ctx)).rejects.toThrow(/revoked/);
    const noProof = context(); delete noProof.isCurrent; await expect(r.notices.forSession(noProof)).rejects.toThrow(/revoked/);
    expect(() => r.db.transaction(() => r.notices.forHost(host()))()).toThrow(/invalid/);
    r.stop(); await expect(r.notices.forSession(context())).rejects.toThrow(/unavailable/);
  });
  it.each(["missing-target", "forged-target", "notice-id", "operation-id", "payload", "operation-payload"] as const)("refuses a corrupt %s without disclosing or acknowledging", async fault => {
    const r = rig(), id = r.enqueue(), before = r.auditCount();
    if (fault === "missing-target") r.db.prepare("DELETE FROM hub_settings_security_targets WHERE kind='person'").run();
    if (fault === "forged-target") r.db.prepare("UPDATE hub_settings_security_targets SET target=? WHERE kind='person'").run(personKeyString(outsider));
    if (fault === "notice-id") r.db.prepare("UPDATE hub_settings_security_notices SET body=json_set(body,'$.id',?)").run(randomUUID());
    if (fault === "operation-id") r.db.prepare("UPDATE hub_settings_security_notices SET body=json_set(body,'$.operationId',?)").run(randomUUID());
    if (fault === "payload") r.db.prepare("UPDATE hub_settings_security_notices SET body=json_set(body,'$.password','must-not-escape')").run();
    if (fault === "operation-payload") r.db.prepare("UPDATE hub_settings_operations SET body=json_set(body,'$.changes',json('[\"ca\"]'))").run();
    const who = fault === "forged-target" ? outsider : recipient;
    if (fault === "missing-target") expect((await r.notices.forSession(context())).items).toEqual([]);
    else await expect(r.notices.forSession(context(who))).rejects.toThrow();
    await expect(r.notices.acknowledgeSession(context(who), id)).rejects.toThrow();
    expect(r.auditCount()).toBe(before + Number(fault === "missing-target"));
  });
});
