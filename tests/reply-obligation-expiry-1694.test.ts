import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeliveryOutbox, REPLY_OBLIGATION_NOTICE_KIND } from "../src/delivery-outbox.js";
import { FleetManager } from "../src/fleet-manager.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { loadFleetConfig } from "../src/config.js";
import { setLocale } from "../src/locale.js";

const T0 = Date.parse("2026-10-12T00:00:00.000Z");
const HOUR = 3_600_000;
const roots: string[] = [];
const stores: DeliveryOutbox[] = [];
const managers: any[] = [];
let seq = 0;
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0); setLocale("en"); });
afterEach(() => {
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const fm of managers.splice(0)) if (fm.replyObligationTimer) clearInterval(fm.replyObligationTimer);
  for (const db of stores.splice(0)) if (db.isOpen) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() { const r = mkdtempSync(join(tmpdir(), "agend-reply-1694-")); roots.push(r); return r; }
function fleet(defaults: Record<string, unknown> = {}, dataDir = root()) {
  const fm = new FleetManager(dataDir) as any;
  fm.scheduleDeliveryOutboxPump = vi.fn();
  fm.fleetConfig = { defaults, instances: {} };
  fm.ensureDeliveryOutbox();
  fm.lifecycle.daemons.set("owner", { getInstanceState: () => "working" });
  const outbox = fm.deliveryOutbox as DeliveryOutbox;
  managers.push(fm); stores.push(outbox);
  return { fm, outbox, dataDir };
}
function ask(outbox: DeliveryOutbox, cid: string, at = T0, requester = "requester") {
  vi.setSystemTime(at);
  const n = ++seq;
  const d = outbox.admit({ operationId: `op-${n}`, sourceKey: `request-${n}`, sourceInstance: requester,
    sourceDaemonBootId: "requester-boot", targetInstance: "owner", kind: "fleet_inbound", correlationId: cid,
    payload: { type: "fleet_inbound", content: `request ${n}`, meta: { requires_reply: "true" } } }).delivery;
  const c = outbox.claimNext(outbox.managerBootId, () => "owner-boot", new Set())!;
  expect(c.deliveryId).toBe(d.deliveryId);
  outbox.begin(c.deliveryId, "owner-boot", c.attemptNo, { backend: "codex", windowId: "@inert", transcriptPath: null,
    transcriptOffset: null, transcriptSessionId: null, submissionMode: "idle_submit" });
  outbox.complete(c.deliveryId, "owner-boot", c.attemptNo, "delivered", "inert proof");
  return d.deliveryId;
}
function notices(outbox: DeliveryOutbox) {
  return (outbox as any).db.prepare("SELECT target_instance,correlation_id,payload_json,source_key FROM deliveries WHERE kind=? ORDER BY created_seq")
    .all(REPLY_OBLIGATION_NOTICE_KIND).map((r: any) => ({ target: r.target_instance, cid: r.correlation_id,
      text: JSON.parse(r.payload_json).content as string, key: r.source_key }));
}
const obligation = (outbox: DeliveryOutbox, cid: string, requester = "requester") => outbox.getReplyObligation(cid, requester, "owner");

function deliverNotice(outbox: DeliveryOutbox) {
  const c = outbox.claimNext(outbox.managerBootId, () => "owner-boot", new Set())!;
  expect(c.kind).toBe(REPLY_OBLIGATION_NOTICE_KIND);
  expect(outbox.begin(c.deliveryId, "owner-boot", c.attemptNo)).toBe("begun");
  expect(outbox.complete(c.deliveryId, "owner-boot", c.attemptNo, "delivered", "inert notice delivery")).toBe(true);
  return c.deliveryId;
}

describe("#1694 restart batches", () => {
  it.each(["en", "zh-TW"] as const)("12 open requests get one bounded restart notice and no original re-delivery (%s)", locale => {
    const { fm, outbox } = fleet();
    const originals = Array.from({ length: 12 }, (_, i) => ask(outbox, `cid-${String(i).padStart(2, "0")}`, T0 + i));
    const snapshots = originals.map(id => outbox.get(id));
    setLocale(locale); vi.setSystemTime(T0 + 60_000);
    fm.onDaemonReady("owner", "boot-restarted");
    const rows = notices(outbox);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target: "owner", cid: null });
    expect(rows[0].text).toContain("report_result");
    expect(rows[0].text).toContain("correlation_id=cid-00");
    expect(rows[0].text).toContain("correlation_id=cid-09");
    expect(rows[0].text).not.toContain("correlation_id=cid-10");
    expect(rows[0].text).toMatch(/\+2 /);
    expect(rows[0].text.split("\n").filter((s: string) => s.includes("correlation_id="))).toHaveLength(10);
    for (let i = 0; i < 12; i++) expect(obligation(outbox, `cid-${String(i).padStart(2, "0")}`)?.nudgedAt).toBe(new Date(T0 + 60_000).toISOString());
    expect(originals.map(id => outbox.get(id))).toEqual(snapshots);
  });

  it("deduplicates by the real daemon boot across repeat hooks and DB reopen; a new boot reminds again", () => {
    const initial = fleet(); ask(initial.outbox, "cid-fresh");
    vi.setSystemTime(T0 + 60_000); initial.fm.onDaemonReady("owner", "boot-1");
    vi.setSystemTime(T0 + 120_000); initial.fm.onDaemonReady("owner", "boot-1");
    expect(notices(initial.outbox)).toHaveLength(1);
    initial.outbox.close();
    const next = fleet({}, initial.dataDir);
    next.fm.onDaemonReady("owner", "boot-1");
    expect(notices(next.outbox)).toHaveLength(1);
    next.fm.onDaemonReady("owner", "boot-2");
    expect(notices(next.outbox)).toHaveLength(2);
  });

  it("renders malicious/oversized IDs as bounded single lines and points to full status", () => {
    const { fm, outbox } = fleet();
    ask(outbox, "cid\nforged=" + "界".repeat(10_000));
    fm.onDaemonReady("owner", "boot-bounded");
    const text = notices(outbox)[0].text;
    expect(Buffer.byteLength(text)).toBeLessThan(2048);
    expect(text.split("\n").filter((s: string) => s.includes("correlation_id="))).toHaveLength(1);
    expect(text).not.toContain("\nforged=");
    expect(text).toContain("delivery_status");
  });

  it("a repeated same-boot hook does not mark a later re-ask as reminded", () => {
    const { fm, outbox } = fleet(); ask(outbox, "cid-renewed");
    fm.onDaemonReady("owner", "one-boot");
    (outbox as any).db.prepare("UPDATE deliveries SET state='cancelled' WHERE kind=?").run(REPLY_OBLIGATION_NOTICE_KIND);
    ask(outbox, "cid-renewed", T0 + 120_000);
    fm.onDaemonReady("owner", "one-boot");
    expect(obligation(outbox, "cid-renewed")?.nudgedAt).toBeNull();
    fm.lifecycle.daemons.set("owner", { getInstanceState: () => "idle" });
    fm.sweepReplyObligations(new Date(T0 + 180_000));
    expect(notices(outbox)).toHaveLength(2);
    expect(notices(outbox)[1].text).toContain("Your turn ended");
  });

  it("same-boot proof survives notice retention and DB reopen without re-stamping a re-ask", async () => {
    const first = fleet({ reply_obligation_ttl_hours: 72 });
    const request = ask(first.outbox, "cid-retained");
    vi.setSystemTime(T0 + 60_000); first.fm.onDaemonReady("owner", "same-boot");
    const notice = deliverNotice(first.outbox);
    const nudge = obligation(first.outbox, "cid-retained")?.nudgedAt;
    vi.setSystemTime(T0 + 48 * HOUR);
    expect((await first.outbox.prune(1)).pruned).toBe(1);
    expect(first.outbox.get(notice)).toBeUndefined();
    expect(first.outbox.get(request)?.state).toBe("delivered");
    expect(obligation(first.outbox, "cid-retained")?.state).toBe("open");
    first.outbox.close();
    const next = fleet({ reply_obligation_ttl_hours: 72 }, first.dataDir);
    next.fm.onDaemonReady("owner", "same-boot");
    expect(notices(next.outbox)).toHaveLength(0);
    expect(obligation(next.outbox, "cid-retained")?.nudgedAt).toBe(nudge);
    ask(next.outbox, "cid-retained", T0 + 48 * HOUR + 1);
    next.fm.onDaemonReady("owner", "same-boot");
    expect(notices(next.outbox)).toHaveLength(0);
    expect(obligation(next.outbox, "cid-retained")?.nudgedAt).toBeNull();
    next.fm.onDaemonReady("owner", "new-boot");
    expect(notices(next.outbox)).toHaveLength(1);
    next.fm.onDaemonReady("owner", "same-boot");
    expect(notices(next.outbox)).toHaveLength(1);
  });

  it.each([
    ["ASCII", "a".repeat(300), "a".repeat(253) + "…"],
    ["CJK", "界".repeat(300), "界".repeat(84) + "…"],
    ["emoji", "😀".repeat(100), "😀".repeat(63) + "…"],
  ])("preview cuts complete %s code points within 256 UTF-8 bytes", (_name, cid, expected) => {
    const { fm, outbox } = fleet(); ask(outbox, cid);
    fm.onDaemonReady("owner", "utf8-boot");
    const shown = notices(outbox)[0].text.split("correlation_id=")[1].split("; asked=")[0];
    expect(shown).toBe(expected);
    expect(shown).not.toContain("�");
    expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(256);
  });

  it("checkpoint failure rolls back the notice and stamp; the same boot can retry once", () => {
    const { fm, outbox } = fleet(); ask(outbox, "cid-marker-fault");
    const fault = vi.spyOn(outbox as any, "recordReplyRestart").mockImplementation(() => { throw new Error("inert marker fault"); });
    fm.onDaemonReady("owner", "atomic-boot");
    expect(notices(outbox)).toEqual([]);
    expect(obligation(outbox, "cid-marker-fault")?.nudgedAt).toBeNull();
    expect((outbox as any).db.prepare("SELECT count(*) n FROM reply_restart_markers").get()).toEqual({ n: 0 });
    fault.mockRestore(); fm.onDaemonReady("owner", "atomic-boot");
    expect(notices(outbox)).toHaveLength(1);
    expect((outbox as any).db.prepare("SELECT count(*) n FROM reply_restart_markers").get()).toEqual({ n: 1 });
  });

  it("adopts an existing earlier batch into the checkpoint without re-stamping a re-ask", async () => {
    const { fm, outbox } = fleet({ reply_obligation_ttl_hours: 72 }); ask(outbox, "cid-earlier");
    fm.onDaemonReady("owner", "earlier-boot"); const notice = deliverNotice(outbox);
    // Model the earlier implementation: its notice survives, its checkpoint does not exist yet.
    (outbox as any).db.prepare("DELETE FROM reply_restart_markers").run();
    ask(outbox, "cid-earlier", T0 + 48 * HOUR);
    fm.onDaemonReady("owner", "earlier-boot");
    expect(notices(outbox)).toHaveLength(1);
    expect(obligation(outbox, "cid-earlier")?.nudgedAt).toBeNull();
    expect((outbox as any).db.prepare("SELECT reminded_at FROM reply_restart_markers").get())
      .toEqual({ reminded_at: new Date(T0).toISOString() });
    await outbox.prune(1);
    expect(outbox.get(notice)).toBeUndefined();
    fm.onDaemonReady("owner", "earlier-boot");
    expect(notices(outbox)).toEqual([]);
    expect(obligation(outbox, "cid-earlier")?.nudgedAt).toBeNull();
  });
});

describe("#1694 persisted TTL", () => {
  it.each(["en", "zh-TW"] as const)("expires at 24h before restart, excludes the old request, preserves the fresh request and notifies once (%s)", locale => {
    const { fm, outbox, dataDir } = fleet();
    setLocale(locale);
    const old = ask(outbox, "cid-old"); ask(outbox, "cid-fresh", T0 + 23 * HOUR);
    expect(outbox.markConsumed(old, "owner-boot", 1, "turn", "inert consumed proof")).toBe("marked");
    const snapshot = outbox.get(old);
    const log = vi.spyOn(fm.logger, "info");
    vi.setSystemTime(T0 + 24 * HOUR); fm.onDaemonReady("owner", "boot-1");
    expect(obligation(outbox, "cid-old")).toMatchObject({ state: "expired", expiredAt: new Date(T0 + 24 * HOUR).toISOString(), answeredAt: null });
    expect(outbox.openReplyObligations("owner").map(r => r.correlationId)).toEqual(["cid-fresh"]);
    expect(notices(outbox).filter((r: any) => r.target === "requester")).toHaveLength(1);
    expect(notices(outbox).find((r: any) => r.target === "requester")?.text).toContain("cid-old");
    expect(notices(outbox).find((r: any) => r.target === "requester")?.text).toContain(locale === "en" ? "has expired" : "已逾期");
    const reminder = notices(outbox).find((r: any) => r.target === "owner")!;
    expect(reminder).toBeDefined();
    expect(reminder.text).toContain("cid-fresh"); expect(reminder.text).not.toContain("cid-old");
    expect(log.mock.calls.filter((args: unknown[]) => args[1] === "Reply obligation expired")).toHaveLength(1);
    expect(outbox.get(old)).toEqual(snapshot);
    const status = DeliveryOutbox.queryStatusReadOnly(join(dataDir, "delivery-outbox.db"), { deliveryId: old });
    expect(status.items[0]?.reply_obligation).toMatchObject({ state: "expired", expired_at: new Date(T0 + 24 * HOUR).toISOString() });
    fm.sweepReplyObligations(); fm.onDaemonReady("owner", "boot-2");
    expect(notices(outbox).filter((r: any) => r.target === "requester")).toHaveLength(1);
    expect(log.mock.calls.filter((args: unknown[]) => args[1] === "Reply obligation expired")).toHaveLength(1);
    outbox.close();
    const reopened = fleet({}, dataDir); reopened.fm.sweepReplyObligations();
    expect(notices(reopened.outbox).filter((r: any) => r.target === "requester")).toHaveLength(1);
  });

  it("last_asked_at controls TTL: just before remains open; reminders do not extend it; re-asks do", () => {
    const { fm, outbox } = fleet(); ask(outbox, "cid-age");
    vi.setSystemTime(T0 + 23 * HOUR); fm.onDaemonReady("owner", "boot-before");
    fm.sweepReplyObligations(new Date(T0 + 24 * HOUR - 1));
    expect(obligation(outbox, "cid-age")?.state).toBe("open");
    fm.sweepReplyObligations(new Date(T0 + 24 * HOUR));
    expect(obligation(outbox, "cid-age")?.state).toBe("expired");
    // Empty the inert notice transport before a real re-ask delivery.
    (outbox as any).db.prepare("UPDATE deliveries SET state='cancelled' WHERE kind=?").run(REPLY_OBLIGATION_NOTICE_KIND);
    ask(outbox, "cid-age", T0 + 25 * HOUR);
    expect(obligation(outbox, "cid-age")).toMatchObject({ state: "open", expiredAt: null, overdueNotifiedAt: null });
    fm.sweepReplyObligations(new Date(T0 + 49 * HOUR - 1));
    expect(obligation(outbox, "cid-age")?.state).toBe("open");
    fm.sweepReplyObligations(new Date(T0 + 49 * HOUR));
    expect(obligation(outbox, "cid-age")?.state).toBe("expired");
    expect(notices(outbox).filter((r: any) => r.target === "requester")).toHaveLength(2);
  });

  it("a prior overdue notice is retained without a second expiration notice", () => {
    const { fm, outbox } = fleet(); ask(outbox, "cid-overdue");
    outbox.notifyOverdueReplyObligations({ now: new Date(T0 + HOUR), overdueMs: 60_000, ownerIdle: () => true });
    fm.sweepReplyObligations(new Date(T0 + 24 * HOUR));
    expect(obligation(outbox, "cid-overdue")?.state).toBe("expired");
    expect(notices(outbox).filter((r: any) => r.target === "requester")).toHaveLength(1);
  });

  it("a backward wall clock delays expiry, and the later forward boundary expires once", () => {
    const { fm, outbox } = fleet(); ask(outbox, "cid-clock");
    fm.sweepReplyObligations(new Date(T0 - HOUR));
    expect(obligation(outbox, "cid-clock")?.state).toBe("open");
    expect(notices(outbox)).toEqual([]);
    fm.sweepReplyObligations(new Date(T0 + 48 * HOUR));
    expect(obligation(outbox, "cid-clock")?.state).toBe("expired");
    fm.sweepReplyObligations(new Date(T0 + 49 * HOUR));
    expect(notices(outbox)).toHaveLength(1);
  });

  it("a second notice insertion failure rolls back both expirations and requester notices", () => {
    const { fm, outbox } = fleet(); ask(outbox, "cid-a"); ask(outbox, "cid-b");
    const original = (outbox as any).insertReplyObligationNotice.bind(outbox);
    let count = 0;
    const fault = vi.spyOn(outbox as any, "insertReplyObligationNotice").mockImplementation((...args: unknown[]) => {
      if (++count === 2) throw new Error("inert notice fault");
      return original(...args);
    });
    fm.sweepReplyObligations(new Date(T0 + 24 * HOUR));
    expect(outbox.openReplyObligations("owner")).toHaveLength(2);
    expect(notices(outbox)).toEqual([]);
    expect(obligation(outbox, "cid-a")?.expiredAt).toBeNull();
    fault.mockRestore();
    fm.sweepReplyObligations(new Date(T0 + 24 * HOUR));
    expect(outbox.openReplyObligations("owner")).toEqual([]);
    expect(notices(outbox)).toHaveLength(2);
  });

  it.each(["working", "stopped"])("the sweep expires a %s owner even with idle-overdue notices disabled", state => {
    const { fm, outbox } = fleet({ reply_overdue_minutes: 0 }); ask(outbox, "cid-busy");
    if (state === "stopped") fm.lifecycle.daemons.delete("owner");
    fm.sweepReplyObligations(new Date(T0 + 24 * HOUR));
    expect(obligation(outbox, "cid-busy")?.state).toBe("expired");
    expect(notices(outbox)).toHaveLength(1); expect(notices(outbox)[0].target).toBe("requester");
  });

  it("uses the configured TTL and fails safe on invalid raw values", () => {
    const short = fleet({ reply_obligation_ttl_hours: 2 }); ask(short.outbox, "cid-short");
    short.fm.sweepReplyObligations(new Date(T0 + 2 * HOUR - 1));
    expect(obligation(short.outbox, "cid-short")?.state).toBe("open");
    short.fm.sweepReplyObligations(new Date(T0 + 2 * HOUR));
    expect(obligation(short.outbox, "cid-short")?.state).toBe("expired");
    for (const value of [0, -1, "24", NaN, Infinity, Number.MAX_VALUE]) {
      const invalid = fleet({ reply_obligation_ttl_hours: value }); ask(invalid.outbox, "cid-invalid");
      invalid.fm.sweepReplyObligations(new Date(T0 + 24 * HOUR));
      expect(obligation(invalid.outbox, "cid-invalid")?.state, String(value)).toBe("expired");
    }
  });

  it("validates positive finite TTL hours", () => {
    const errors = (value: unknown) => validateFleetConfig({ defaults: { reply_obligation_ttl_hours: value }, instances: {} });
    for (const value of [0, -1, "24", NaN, Infinity, Number.MAX_VALUE]) expect(JSON.stringify(errors(value))).toContain("reply_obligation_ttl_hours");
    for (const value of [1, 24, 48, 0.5]) expect(errors(value).errors).toEqual([]);
  });

  it("raw YAML load reaches the actual restart TTL boundary, including invalid-value fallback", () => {
    for (const value of [2, 0, "two"]) {
      const { fm, outbox, dataDir } = fleet();
      const path = join(dataDir, "fleet.yaml");
      writeFileSync(path, JSON.stringify({ defaults: { reply_obligation_ttl_hours: value }, instances: {} }));
      fm.fleetConfig = loadFleetConfig(path);
      ask(outbox, "cid-yaml");
      const ttl = typeof value === "number" && value > 0 ? value * HOUR : 24 * HOUR;
      vi.setSystemTime(T0 + ttl - 1); fm.onDaemonReady("owner", "before");
      expect(obligation(outbox, "cid-yaml")?.state).toBe("open");
      vi.setSystemTime(T0 + ttl); fm.onDaemonReady("owner", "at-boundary");
      expect(obligation(outbox, "cid-yaml")?.state).toBe("expired");
      expect(notices(outbox).filter((r: any) => r.target === "requester")).toHaveLength(1);
    }
  });

  it("read-only status works before the expired_at column exists", () => {
    const { outbox, dataDir } = fleet(); const id = ask(outbox, "cid-old-reader");
    outbox.close(); const path = join(dataDir, "delivery-outbox.db");
    const old = new Database(path);
    old.exec("ALTER TABLE reply_obligations DROP COLUMN expired_at"); old.close();
    expect(DeliveryOutbox.queryStatusReadOnly(path, { deliveryId: id }).items[0]?.reply_obligation)
      .toMatchObject({ state: "open", expired_at: null });
  });

  it("retention removes the expired obligation together with its terminal request", async () => {
    const { fm, outbox } = fleet(); const id = ask(outbox, "cid-prune");
    fm.sweepReplyObligations(new Date(T0 + 24 * HOUR));
    expect(obligation(outbox, "cid-prune")?.state).toBe("expired");
    vi.setSystemTime(T0 + 31 * 24 * HOUR);
    expect((await outbox.prune(30)).pruned).toBeGreaterThan(0);
    expect(outbox.get(id)).toBeUndefined();
    expect(obligation(outbox, "cid-prune")).toBeUndefined();
  });

  it("does not infer an answer from a plain owner→requester send", () => {
    const { outbox } = fleet(); ask(outbox, "cid-real");
    outbox.admit({ operationId: "progress", sourceKey: "progress", sourceInstance: "owner", sourceDaemonBootId: "owner-boot",
      targetInstance: "requester", kind: "fleet_inbound", payload: { type: "fleet_inbound", content: "unrelated progress" } });
    expect(obligation(outbox, "cid-real")?.state).toBe("open");
  });

  it("turn-ended still emits one notice per ask after grace, including rows beyond the restart display cap", () => {
    const { outbox } = fleet();
    for (let i = 0; i < 12; i++) ask(outbox, `cid-${i}`);
    expect(outbox.remindReplyObligations("owner", { now: new Date(T0 + 59_999), graceMs: 60_000, reason: "turn-ended" })).toBe(0);
    expect(outbox.remindReplyObligations("owner", { now: new Date(T0 + 60_000), graceMs: 60_000, reason: "turn-ended" })).toBe(12);
    expect(notices(outbox)).toHaveLength(12);
    expect(outbox.remindReplyObligations("owner", { now: new Date(T0 + 120_000), graceMs: 60_000, reason: "turn-ended" })).toBe(0);
  });
});

describe("#1694 old schema migration", () => {
  function oldDb() {
    const path = join(root(), "old.db"); const db = new Database(path);
    db.exec(`CREATE TABLE reply_obligations (
      correlation_id TEXT NOT NULL, requester_instance TEXT NOT NULL, owner_instance TEXT NOT NULL,
      request_delivery_id TEXT NOT NULL, opened_at TEXT NOT NULL, last_asked_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('open','answered')), nudged_at TEXT, overdue_notified_at TEXT,
      answered_at TEXT, answered_delivery_id TEXT, PRIMARY KEY(correlation_id,requester_instance,owner_instance));`);
    db.prepare("INSERT INTO reply_obligations VALUES (?,?,?,?,?,?,'open',NULL,NULL,NULL,NULL)")
      .run("cid-old-schema", "requester", "owner", "request-old", new Date(T0).toISOString(), new Date(T0).toISOString());
    db.prepare("INSERT INTO reply_obligations VALUES (?,?,?,?,?,?,'answered',?,?,?,?)")
      .run("cid-answered", "requester", "owner", "request-answered", new Date(T0).toISOString(), new Date(T0).toISOString(), "nudge", "overdue", "answer-time", "answer-id");
    db.close(); return path;
  }
  it("preserves rows, widens the CHECK and remains readable/reopenable", () => {
    const path = oldDb(); const db = new DeliveryOutbox(path); stores.push(db);
    expect(obligation(db, "cid-old-schema")).toMatchObject({ state: "open", expiredAt: null, requestDeliveryId: "request-old" });
    expect(obligation(db, "cid-answered")).toMatchObject({ state: "answered", nudgedAt: "nudge", overdueNotifiedAt: "overdue", answeredAt: "answer-time", answeredDeliveryId: "answer-id" });
    expect((db as any).db.prepare("SELECT sql FROM sqlite_master WHERE name='reply_obligations'").get().sql).toContain("'expired'");
    expect((db as any).db.prepare("UPDATE reply_obligations SET state='expired' WHERE state='open'").run().changes).toBe(1);
    db.close(); const reopened = new DeliveryOutbox(path); stores.push(reopened);
    expect(obligation(reopened, "cid-old-schema")?.state).toBe("expired");
  });
  it("rolls back a migration failure after the old table was dropped", () => {
    const path = oldDb(); const original = Database.prototype.exec;
    vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
      if (sql.includes("ALTER TABLE reply_obligations_v1694 RENAME")) throw new Error("inert migration fault");
      return original.call(this, sql);
    });
    expect(() => new DeliveryOutbox(path)).toThrow("inert migration fault");
    vi.restoreAllMocks(); const raw = new Database(path); try {
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name='reply_obligations'").get()).toEqual({ name: "reply_obligations" });
      expect(raw.prepare("SELECT count(*) n FROM reply_obligations").get()).toEqual({ n: 2 });
      expect(raw.prepare("SELECT sql FROM sqlite_master WHERE name='reply_obligations'").get()).toMatchObject({ sql: expect.not.stringContaining("expired") });
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name='reply_obligations_v1694'").get()).toBeUndefined();
    } finally { raw.close(); }
  });
});
