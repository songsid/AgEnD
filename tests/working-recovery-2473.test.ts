import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryOutbox } from "../src/delivery-outbox.js";
import { WorkingStateJournal, type WorkingStateSnapshot } from "../src/working-state-journal.js";
import { WorkingRecoveryCoordinator, WorkingRecoveryStore, decideWorkingRecovery, recoveryKey, buildWorkingRecoveryPrompt,
  type RecoveryEpisode, type RecoveryLive, type RecoveryCard } from "../src/working-recovery.js";

const dirs: string[] = [], close: Array<() => void> = [];
afterEach(() => { close.splice(0).forEach(fn => fn()); dirs.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
const snapshot = (over: Partial<WorkingStateSnapshot> = {}): WorkingStateSnapshot => ({ version: 1, managerBootId: "old-run", observedAt: 1,
  reason: "before_stop", lastActivityAt: 1, observation: { owner: { bootId: "old", spawnGeneration: 1, launchAttempt: 1, launchFenceEpoch: 0 },
    backend: "claude-code", configuration: "a".repeat(64), executionState: "working", processStatus: "running", backgroundWork: false,
    sessionId: "owned-session", backendTurnId: null, turn: null }, references: [{ kind: "task", id: "task-a", version: 3, status: "claimed" }],
  totalReferences: 1, unavailable: [], ...over });
const live = (): RecoveryLive => ({ owner: "new-launch", configuration: "a".repeat(64), sessionId: "owned-session", idle: true,
  paused: false, stopped: false, legacyPending: false, legacyCovered: false, nativeWork: false, cancelled: false, background: false });
const card = (): RecoveryCard => ({ uuid: "task-a", assignee: "worker", version: 3, status: "claimed" });
const episode = (s = snapshot()): RecoveryEpisode => ({ instance: "worker", key: recoveryKey("worker", s), group: s.managerBootId,
  snapshot: s, outcome: "deferred", reason: "awaiting_stability", deliveryId: null });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agend-working-recovery-")); dirs.push(dir);
  const db = new Database(join(dir, "outbox.db")); close.push(() => db.close());
  const journal = new WorkingStateJournal(db), store = new WorkingRecoveryStore(db);
  journal.observe("worker", snapshot()); store.discover("worker", snapshot());
  let now = 0, active = true, storm = false, level = "normal", enabled = true;
  const state = live(), current = card(), cards: Record<string, RecoveryCard> = { "task-a": current }, admissions: string[] = [], summaries: string[] = [], logs: string[] = [];
  const coordinator = new WorkingRecoveryCoordinator({ store, now: () => now, active: () => active, storm: () => storm,
    pressure: () => ({ level, sampledAt: now, recovering: false } as any), enabled: () => enabled, live: () => state,
    card: id => cards[id], laneFree: () => true, admit: row => store.admit(row, () => { admissions.push(row.key); return "delivery-a"; }),
    summary: (group, rows) => store.summary(group, () => { summaries.push(`${group}:${rows.map(r => r.outcome).join(",")}`); }),
    log: (row, outcome, reason) => logs.push(`${row.key}:${outcome}:${reason}`),
  });
  return { store, db, journal, coordinator, state, current, cards, admissions, summaries, logs,
    time: (n: number) => { now = n; }, pressure: (s: string) => { level = s; }, enabled: (v: boolean) => { enabled = v; },
    active: (v: boolean) => { active = v; }, storm: (v: boolean) => { storm = v; } };
}

describe("stable, durable, pressure-paced working recovery", () => {
  it("does not commit unchanged deferred decisions on every stable tick", () => {
    const f = fixture(); f.enabled(false); f.coordinator.ready(); f.coordinator.tick(); f.time(120_000); f.coordinator.tick();
    const changes = () => (f.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const before = changes();
    for (let n = 0; n < 100; n++) { f.time(121_000 + n * 1000); f.coordinator.tick(); }
    expect(changes() - before).toBe(0);
    expect(f.store.get("worker")?.reason).toBe("opted_out");
  });
  it("a confirmed continuation forms a new episode after a second interruption, but repeated boots do not", () => {
    const f = fixture(); f.db.exec("CREATE TABLE deliveries(delivery_id TEXT PRIMARY KEY,state TEXT)");
    f.coordinator.ready(); f.coordinator.tick(); f.time(120_000); f.coordinator.tick();
    f.db.prepare("INSERT INTO deliveries VALUES('delivery-a','delivered')").run();
    const first = f.store.get("worker")!.key;
    const previous = snapshot();
    const resumed = snapshot({ managerBootId: "run-2", observation: { ...previous.observation, recoveryDeliveryId: "delivery-a" } as any });
    f.store.discover("worker", resumed);
    f.coordinator.reset(); f.coordinator.ready(); f.coordinator.tick(); f.time(240_000); f.coordinator.tick();
    expect(f.store.get("worker")!.key).not.toBe(first);
    expect(f.admissions).toHaveLength(2); expect(f.summaries).toHaveLength(2);
    f.store.discover("worker", { ...resumed, managerBootId: "run-3" });
    f.time(360_000); f.coordinator.tick(); expect(f.admissions).toHaveLength(2);
  });
  it("keeps an ambiguous continuation fenced when a replacement loses its interval marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-recovery-ambiguous-")); dirs.push(dir);
    const path = join(dir, "outbox.db");
    let outbox = new DeliveryOutbox(path, "boot-1");
    const base = snapshot();
    const resumed = { ...base, observation: { ...base.observation, recoveryDeliveryId: "previous-confirmed" } };
    outbox.observeWorkingState("worker", resumed);
    outbox.workingRecovery.discover("worker", resumed);
    const original = outbox.workingRecovery.get("worker")!;
    expect(outbox.admitWorkingRecovery(original, "continue once")).toBe(true);
    const row = outbox.claimNext("boot-1", () => "daemon-1", new Set())!;
    expect(outbox.begin(row.deliveryId, "daemon-1", row.attemptNo)).toBe("begun");
    expect(outbox.markEnterStarted(row.deliveryId, "daemon-1", row.attemptNo)).toBe(true);
    outbox.close(); // kill after possible input, before acknowledgment
    outbox = new DeliveryOutbox(path, "boot-2"); close.push(() => outbox.close());
    outbox.recoverForBoot("boot-2");
    outbox.observeWorkingState("worker", { ...base, reason: "before_spawn", observation: { ...base.observation, sessionId: null } });
    const replacement = outbox.observeWorkingState("worker", base)!;
    expect(recoveryKey("worker", replacement.current)).toBe(original.key);
    outbox.complete(row.deliveryId, "daemon-1", row.attemptNo, "uncertain");
    // Even a changed/missing marker from an older writer cannot replace an uncertain episode.
    outbox.workingRecovery.discover("worker", base);
    expect(outbox.workingRecovery.get("worker")?.key).toBe(original.key);
    expect(outbox.admitWorkingRecovery(outbox.workingRecovery.get("worker")!, "duplicate")).toBe(false);
    expect(outbox.claimNext("boot-2", () => "daemon-2", new Set())).toBeUndefined();
    expect(outbox.get(row.deliveryId)?.state).toBe("uncertain");
  });
  it("names an explicit prior requested action once, without inventing an OOM cause from a process death", () => {
    const f = fixture(); expect(f.store.beginRun("run-a", 123, 1)).toBe("unknown_interruption");
    f.store.requested("foreign-run", "update"); expect(f.store.beginRun("run-b", 124, 2)).toBe("unknown_interruption");
    f.store.requested("run-b", "manual_restart"); expect(f.store.beginRun("run-c", 125, 3)).toBe("manual_restart");
    expect(f.store.beginRun("run-d", 126, 4)).toBe("unknown_interruption");
    f.store.requested("run-d", "update"); f.store.clearRequested("foreign-run");
    expect(f.store.beginRun("run-e", 127, 5)).toBe("update");
    f.store.requested("run-e", "manual_restart"); f.store.clearRequested("run-e");
    expect(f.store.beginRun("run-f", 128, 6)).toBe("unknown_interruption");
    expect(buildWorkingRecoveryPrompt(snapshot().references, "manual_restart", true)).toContain("observed cause: unknown interruption; prior requested action: manual_restart");
  });
  it("requires final READY, two continuous run minutes and thirty continuous normal seconds", () => {
    const f = fixture(); f.time(300_000); f.coordinator.tick(); expect(f.admissions).toEqual([]);
    f.coordinator.ready(); f.coordinator.tick(); f.time(419_999); f.coordinator.tick(); expect(f.admissions).toEqual([]);
    f.pressure("elevated"); f.time(420_000); f.coordinator.tick(); expect(f.admissions).toEqual([]);
    f.pressure("normal"); f.time(500_000); f.coordinator.tick(); f.time(529_999); f.coordinator.tick(); expect(f.admissions).toEqual([]);
    f.time(530_000); f.coordinator.tick(); expect(f.admissions).toHaveLength(1); expect(f.summaries).toEqual(["old-run:admitted"]);
    f.time(900_000); f.coordinator.tick(); expect(f.admissions).toHaveLength(1); expect(f.summaries).toHaveLength(1);
  });
  it("a restart loop resets stability without consuming its candidate", () => {
    const f = fixture();
    for (let run = 0; run < 3; run++) { f.coordinator.ready(); f.coordinator.tick(); f.time((run + 1) * 50_000); f.coordinator.tick(); f.coordinator.reset(); }
    expect(f.admissions).toHaveLength(0); expect(f.store.get("worker")?.outcome).toBe("deferred");
    f.coordinator.ready(); f.coordinator.tick(); f.time(270_000); f.coordinator.tick(); expect(f.admissions).toHaveLength(1);
  });
  it("an opt-out and storm defer without losing the episode, including a hot opt-out before paste", () => {
    const f = fixture(); f.coordinator.ready(); f.coordinator.tick(); f.time(120_000); f.enabled(false); f.coordinator.tick();
    expect(f.store.get("worker")?.reason).toBe("opted_out"); expect(f.admissions).toHaveLength(0);
    f.enabled(true); f.storm(true); f.coordinator.tick(); f.storm(false); f.coordinator.tick(); f.time(150_000); f.coordinator.tick();
    expect(f.admissions).toHaveLength(1); const key = f.store.get("worker")!.key;
    expect(f.coordinator.accepts("worker", key)).toBe(true); f.enabled(false); expect(f.coordinator.accepts("worker", key)).toBe(false);
    expect(f.summaries).toHaveLength(1); // deferred summary is not sent again on later progress
  });
  it("paces distinct instances by five seconds and never clears deferred work", () => {
    const f = fixture(); f.store.discover("other", snapshot({ references: [{ kind: "task", id: "task-b", version: 3, status: "claimed" }] }));
    f.cards["task-b"] = { ...card(), uuid: "task-b", assignee: "other" };
    f.coordinator.ready(); f.coordinator.tick(); f.time(120_000); f.coordinator.tick();
    expect(f.admissions).toHaveLength(1);
    expect(f.summaries).toEqual([]);
    expect(f.store.list().filter(row => row.outcome === "deferred")).toHaveLength(1);
    f.time(124_999); f.coordinator.tick(); expect(f.admissions).toHaveLength(1);
    f.time(125_000); f.coordinator.tick(); expect(f.admissions).toHaveLength(2);
    expect(f.summaries).toEqual(["old-run:admitted,admitted"]);
  });
  it("rolls back a failed atomic admission and preserves the prior snapshot", () => {
    const f = fixture(), row = f.store.get("worker")!;
    const before = f.journal.get("worker");
    expect(() => f.store.admit(row, () => {
      f.db.prepare("INSERT INTO working_recovery_receipts VALUES(?,'admitted','partial insert')").run(row.key);
      throw Error("injected insert failure");
    })).toThrow("injected insert");
    expect(f.db.prepare("SELECT 1 FROM working_recovery_receipts WHERE episode_key=?").get(row.key)).toBeUndefined();
    expect(f.store.get("worker")?.outcome).toBe("deferred"); expect(f.journal.get("worker")).toEqual(before);
    expect(f.store.admit(row, () => "one")).toBe(true); expect(f.store.admit(row, () => { throw Error("duplicate"); })).toBe(false);
  });
  it("paces physical dispatch of rows retained from an earlier process and serializes held writers", () => {
    const f = fixture(); f.cards["task-b"] = { ...card(), uuid: "task-b", assignee: "other" };
    f.store.discover("other", snapshot({ references: [{ kind: "task", id: "task-b", version: 3, status: "claimed" }] }));
    for (const row of f.store.list()) f.store.admit(row, () => `delivery-${row.instance}`);
    const a = f.store.get("worker")!, b = f.store.get("other")!;
    expect(f.coordinator.reserveDispatch(a.instance, a.key)).toBeNull();
    f.coordinator.ready(); f.coordinator.tick(); f.time(120_000);
    const release = f.coordinator.reserveDispatch(a.instance, a.key)!; expect(release).toBeTypeOf("function");
    expect(f.coordinator.accepts(a.instance, a.key)).toBe(true);
    f.time(125_000); expect(f.coordinator.reserveDispatch(b.instance, b.key)).toBeNull();
    release(); const otherRelease = f.coordinator.reserveDispatch(b.instance, b.key)!; expect(otherRelease).toBeTypeOf("function");
    otherRelease(); f.time(129_999); expect(f.coordinator.canDispatch(a.instance, a.key)).toBe(false);
    f.time(130_000); expect(f.coordinator.canDispatch(a.instance, a.key)).toBe(true);
  });
  it("cancellation is durable and scoped independently from a pause or outbox cancelled-notice state", () => {
    const f = fixture(); f.store.cancel("worker", "a".repeat(64), "owned-session");
    f.coordinator.ready(); f.coordinator.tick(); f.time(120_000); f.coordinator.tick();
    expect(f.admissions).toHaveLength(0); expect(f.store.get("worker")?.reason).toBe("cancelled");
  });
});

describe("authority and legacy coexistence", () => {
  it("known background work defers, unknown background is advisory, unknown session ownership still defers", () => {
    expect(decideWorkingRecovery(episode(), { ...live(), background: true }, true, card)).toEqual({ outcome: "deferred", reason: "background_running" });
    expect(decideWorkingRecovery(episode(), { ...live(), background: null }, true, card)).toMatchObject({ outcome: "ready", advisory: true });
    expect(decideWorkingRecovery(episode(), live(), true, card)).toMatchObject({ outcome: "ready", advisory: false });
    expect(decideWorkingRecovery(episode(), { ...live(), background: null, sessionId: null }, true, card)).toEqual({ outcome: "deferred", reason: "session_unknown" });
    const text = buildWorkingRecoveryPrompt(snapshot().references, "unknown_interruption", true);
    expect(text).toContain("background state is unknown"); expect(text).toContain("jobs, processes, worktrees, receipts");
    expect(text).toContain("only unfinished work"); expect(text).toContain("report normally");
    expect(text).toContain("Never restart a command or re-send a delegation blindly");
    expect(buildWorkingRecoveryPrompt(snapshot().references, "manual_restart", false)).not.toContain("background state is unknown");
  });
  it.each(["paused", "stopped", "legacyPending", "legacyCovered", "nativeWork", "cancelled"] as const)("never drives through %s", key => {
    const current = { ...live(), [key]: true }; expect(decideWorkingRecovery(episode(), current, true, card).outcome).not.toBe("ready");
  });
  it.each(["done", "cancelled", "open", "review", "blocked"])("does not execute a %s card", status => {
    expect(decideWorkingRecovery(episode(), live(), true, () => ({ ...card(), status })).outcome).not.toBe("ready");
  });
  it("does not borrow another assignee, stale version, unknown/changed session, or configuration", () => {
    expect(decideWorkingRecovery(episode(), live(), true, () => null)).toEqual({ outcome: "deferred", reason: "task_store_unavailable" });
    expect(decideWorkingRecovery(episode(), live(), true, () => undefined)).toEqual({ outcome: "excluded", reason: "no_unfinished_task" });
    expect(decideWorkingRecovery(episode(), live(), true, () => ({ ...card(), assignee: "other" })).outcome).toBe("excluded");
    expect(decideWorkingRecovery(episode(), live(), true, () => ({ ...card(), version: 4 })).outcome).toBe("excluded");
    for (const sessionId of [null, "other"]) expect(decideWorkingRecovery(episode(), { ...live(), sessionId }, true, card).outcome).not.toBe("ready");
    expect(decideWorkingRecovery(episode(), { ...live(), configuration: "b".repeat(64) }, true, card).outcome).toBe("excluded");
  });
  it("legacy-covered turns and mixed tasks/owed replies remain with #1209/#926; waiting alone does not drive", () => {
    const s = snapshot(); s.observation.turn = { generation: 1, deliveryId: "old", correlationId: "corr", messageId: "msg", cancelled: false, completionDelivered: false };
    expect(decideWorkingRecovery(episode(s), live(), true, card)).toEqual({ outcome: "excluded", reason: "legacy_owned" });
    const owed = snapshot({ references: [...snapshot().references, { kind: "owed", correlationId: "corr", requester: "peer", owner: "worker", deliveryId: "d" }], totalReferences: 2 });
    expect(decideWorkingRecovery(episode(owed), live(), true, card)).toEqual({ outcome: "excluded", reason: "legacy_owned" });
    owed.references = [{ kind: "waiting", correlationId: "corr", requester: "worker", owner: "peer", deliveryId: "d" }]; owed.totalReferences = 1;
    expect(decideWorkingRecovery(episode(owed), live(), true, card).outcome).toBe("excluded");
  });
  it("a crash-loop fresh launch can inspect task state, while a deliberate fresh choice cannot", () => {
    expect(decideWorkingRecovery(episode(), { ...live(), sessionId: "fresh-loop", crashLoopFresh: true }, true, card).outcome).toBe("ready");
    expect(decideWorkingRecovery(episode(), { ...live(), freshChoice: true }, true, card).outcome).toBe("excluded");
  });
});

describe("real outbox episode admission across process replacement", () => {
  it("keeps a pre-input continuation deferred past ordinary TTL without weakening normal delivery expiry", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-recovery-ttl-")); dirs.push(dir);
    const outbox = new DeliveryOutbox(join(dir, "outbox.db"), "boot"); close.push(() => outbox.close());
    outbox.observeWorkingState("worker", snapshot()); outbox.workingRecovery.discover("worker", snapshot());
    outbox.admitWorkingRecovery(outbox.workingRecovery.get("worker")!, "one continuation");
    const db = (outbox as any).db as Database.Database;
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString(); db.prepare("UPDATE deliveries SET created_at=?").run(old);
    expect(outbox.expireStale()).toBe(0); expect(outbox.nextExpiryAt()).toBeNull();
    for (let i = 0; i < 12; i++) {
      const row = outbox.claimNext("boot", () => "daemon", new Set())!;
      expect(outbox.retryBeforeBegin(row.deliveryId, "daemon", row.attemptNo, "draft still present", 0)).toBe(true);
      expect(outbox.get(row.deliveryId)?.state).toBe("retry_wait");
    }
    const row = outbox.claimNext("boot", () => "daemon", new Set())!;
    expect(outbox.begin(row.deliveryId, "daemon", row.attemptNo)).toBe("begun");
    expect(outbox.markEnterStarted(row.deliveryId, "daemon", row.attemptNo)).toBe(true);
    outbox.complete(row.deliveryId, "daemon", row.attemptNo, "uncertain");
    expect(outbox.claimNext("next-boot", () => "next-daemon", new Set())).toBeUndefined();
    outbox.admitSystemNotice("other", "ordinary", "ordinary notice", new Date(old));
    db.prepare("UPDATE deliveries SET created_at=? WHERE kind='system_notice'").run(new Date(Date.now() - 100 * 86_400_000).toISOString());
    expect(outbox.nextExpiryAt()).not.toBeNull(); expect(outbox.expireStale()).toBe(1);
  });
  it("commits one local continuation and receipt together; a begun/uncertain write is never re-admitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-recovery-outbox-")); dirs.push(dir); const path = join(dir, "outbox.db");
    let outbox = new DeliveryOutbox(path, "boot-1");
    outbox.observeWorkingState("worker", snapshot()); outbox.workingRecovery.discover("worker", snapshot());
    const row = outbox.workingRecovery.get("worker")!;
    expect(outbox.admitWorkingRecovery(row, "one continuation")).toBe(true); expect(outbox.admitWorkingRecovery(row, "one continuation")).toBe(false);
    const claimed = outbox.claimNext("boot-1", () => "daemon-1", new Set())!;
    expect(claimed.kind).toBe("working_recovery"); expect(outbox.begin(claimed.deliveryId, "daemon-1", 1)).toBe("begun");
    expect(outbox.markEnterStarted(claimed.deliveryId, "daemon-1", 1)).toBe(true); outbox.close();
    outbox = new DeliveryOutbox(path, "boot-2"); close.push(() => outbox.close()); outbox.recoverForBoot("boot-2");
    expect(outbox.admitWorkingRecovery(outbox.workingRecovery.get("worker")!, "different")).toBe(false);
    expect(outbox.claimNext("boot-2", () => "daemon-2", new Set())).toBeUndefined();
    expect(outbox.get(claimed.deliveryId)?.state).toBe("reconciliation_pending");
  });
});


describe("2026-10-25 real update shapes", () => {
  it("old claimed/blocked cards cannot create an episode for an idle instance", () => {
    const f = fixture(), idle = snapshot(); idle.observation = { ...idle.observation, executionState: "idle" };
    f.store.discover("idle-worker", idle, "replacement-manager");
    expect(f.store.get("idle-worker")).toBeNull();
    expect(decideWorkingRecovery(episode(idle), live(), true, card)).toEqual({ outcome: "excluded", reason: "not_working_at_interruption" });
  });
  it("an idle stop keeps an admitted or ambiguous delivery fenced", () => {
    const f = fixture(); f.store.admit(f.store.get("worker")!, () => "ambiguous-delivery");
    const before = f.store.get("worker"), idle = snapshot();
    idle.observation = { ...idle.observation, executionState: "idle" };
    f.store.discover("worker", idle, "replacement-manager");
    expect(f.store.get("worker")).toEqual(before);
  });
  it("an authoritative idle shutdown retires an earlier deferred working candidate", () => {
    const f = fixture(), idle = snapshot(); idle.observation = { ...idle.observation, executionState: "idle" };
    expect(f.store.get("worker")).not.toBeNull();
    f.store.discover("worker", idle, "replacement-manager");
    expect(f.store.get("worker")).toBeNull();
    expect(f.admissions).toEqual([]);
  });
  it("already persisted idle episodes are excluded without input or a summary", () => {
    const f = fixture(), idle = snapshot(); idle.observation = { ...idle.observation, executionState: "idle" };
    f.db.prepare("UPDATE working_recovery_episodes SET snapshot_json=?,episode_key=? WHERE instance_name='worker'")
      .run(JSON.stringify(idle), recoveryKey("worker", idle));
    f.coordinator.ready(); f.coordinator.tick(); f.time(120_000); f.coordinator.tick();
    expect(f.store.get("worker")).toBeNull();
    expect(f.logs.some(line => line.endsWith("excluded:not_working_at_interruption"))).toBe(true);
    expect(f.admissions).toEqual([]); expect(f.summaries).toEqual([]);
    f.store.discover("worker", snapshot(), "genuine-work");
    expect(f.store.get("worker")).toMatchObject({ outcome: "deferred", reason: "awaiting_stability" });
  });
  it("an old excluded idle row does not fence later genuine work with the same task version", () => {
    const f = fixture(), idle = snapshot(); idle.observation = { ...idle.observation, executionState: "idle" };
    const key = recoveryKey("worker", idle);
    f.db.prepare("UPDATE working_recovery_episodes SET snapshot_json=?,episode_key=?,outcome='excluded',reason='native_reengaged' WHERE instance_name='worker'")
      .run(JSON.stringify(idle), key);
    f.db.prepare("INSERT INTO working_recovery_receipts VALUES(?,'excluded','native_reengaged')").run(key);
    f.store.discover("worker", snapshot(), "genuine-work");
    expect(f.store.get("worker")).toMatchObject({ key, outcome: "deferred", reason: "awaiting_stability", group: "genuine-work" });
  });
  it.each(["review", "blocked", "done", "cancelled", "open"])("skips a %s sibling card while continuing the unchanged claimed card", status => {
    const ref = { kind: "task", id: "finished-old-card", version: 3, status: "review" } as const;
    for (const references of [[...snapshot().references, ref], [ref, ...snapshot().references]]) {
      const s = snapshot({ references, totalReferences: 2 });
      expect(decideWorkingRecovery(episode(s), live(), true, id => id === ref.id
        ? { uuid: id, version: 99, assignee: "worker", status } : card()))
        .toMatchObject({ outcome: "ready", tasks: [snapshot().references[0]] });
    }
  });
  it("a deferred episode keeps its key but gets this boot's one summary after an earlier summary", () => {
    const f = fixture(); f.enabled(false); f.coordinator.ready(); f.coordinator.tick(); f.time(120_000); f.coordinator.tick();
    const previous = f.store.get("worker")!; expect(f.summaries).toHaveLength(1);
    f.store.discover("worker", previous.snapshot, "new-manager");
    expect(f.store.get("worker")).toMatchObject({ key: previous.key, group: "new-manager", outcome: "deferred" });
    f.coordinator.tick(); f.coordinator.tick(); expect(f.summaries).toHaveLength(2);
    expect(f.summaries[1]).toContain("new-manager:"); expect(f.admissions).toEqual([]);
  });
});
