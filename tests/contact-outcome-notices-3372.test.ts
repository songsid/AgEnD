import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { DeliveryOutbox, SYSTEM_NOTICE_KIND } from "../src/delivery-outbox.js";
import { ContactAuthStore, type ContactRequest } from "../src/contact-auth-store.js";
import { getLocale, setLocale } from "../src/locale.js";
const originalLocale = getLocale();
const cleanup: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); setLocale(originalLocale); for (const close of cleanup.splice(0)) close(); });
function rig() {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-11-19T00:00:00Z"));
  const dir = mkdtempSync(join(tmpdir(), "contact-outcome-"));
  const outbox = new DeliveryOutbox(join(dir, "outbox.db"));
  cleanup.push(() => { outbox.close(); rmSync(dir, { recursive: true, force: true }); });
  const fm: any = Object.assign(Object.create(FleetManager.prototype), {
    deliveryOutbox: outbox, logger: { error: vi.fn() }, lifecycle: { daemons: new Map() },
    expireReplyObligations: vi.fn(), tickDispatcherLiveness: vi.fn(), scheduleDeliveryOutboxPump: vi.fn(),
    emitSseEvent: vi.fn(), needsYouItems: () => [], getDaemonBootId: () => "fake-boot", hubAgentToken: () => "fake-generation",
    adapters: new Map(), worlds: new Map(), getInstanceAdapterId: () => undefined,
    fleetConfig: { instances: {}, defaults: {} }, hubContactRestricted: () => false,
  });
  const actor = { platform: "host" as const, adapterId: "host", userId: "operator", label: "Operator" };
  const input: ContactRequest = { operationId: "fake-op", source: "room", target: "worker", sourceGeneration: "fake-generation",
    targetGeneration: "fake-generation", verb: "delegate_task", origin: { kind: "unknown", people: [], receiptIds: [], chain: ["room"] },
    message: "Synthetic request", correlationId: "fake-correlation", resultRecipient: "room", payload: { type: "fleet_inbound", content: "Synthetic request" } };
  const held = outbox.contactAuthorizations.hold(input);
  const notices = () => outbox.listPending().filter(row => row.kind === SYSTEM_NOTICE_KIND);
  return { fm, outbox, held, actor, input, notices };
}
it.each(["en", "zh-TW"] as const)("decline notifies the source once in %s, never the target", locale => {
  setLocale(locale); const r = rig();
  r.fm.decideContactAuthorization(r.held.id, { revision: 1, decision: "decline" }, r.actor);
  expect(r.notices()).toHaveLength(1);
  r.fm.sweepReplyObligations(); r.fm.sweepReplyObligations();
  const [notice] = r.notices();
  expect(r.notices()).toHaveLength(1);
  expect(notice.targetInstance).toBe("room");
  expect(notice.payload.content).toContain(`#${r.held.id}`);
  expect(notice.payload.content).toContain("worker");
  expect(notice.payload.content).toContain(locale === "en" ? "declined" : "已拒絕");
  expect(notice.sourceInstance).toBe("agend-system");
  expect(notice.payload).not.toHaveProperty("contactTicket");
  expect(notice.payload.meta).not.toHaveProperty("authority");
  expect(notice.payload.meta).not.toHaveProperty("request_kind");
  expect(r.outbox.contactAuthorizations.approvedReturn("worker", "room", r.input.correlationId)).toEqual([]);
  expect(r.outbox.contactAuthorizations.approvedReturn("worker", "room", notice.correlationId!)).toEqual([]);
});
it.each(["en", "zh-TW"] as const)("expiry is detected by the periodic sweep without any page read in %s", locale => {
  setLocale(locale); const r = rig();
  const timer = setInterval(() => r.fm.sweepReplyObligations(), 30_000);
  cleanup.push(() => clearInterval(timer));
  vi.advanceTimersByTime(30 * 60_000 - 1);
  expect(r.notices()).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(r.notices()).toHaveLength(1);
  expect(r.notices()[0].payload.content).toContain(locale === "en" ? "expired" : "已到期");
  expect(r.notices()[0].payload.content).toContain(`#${r.held.id}`);
  expect(r.notices()[0].payload.content).toContain("worker");
  vi.advanceTimersByTime(90_000);
  expect(r.notices()).toHaveLength(1);
});
it("approval emits no declined/expired notice after its original deadline (M-3716: only its own approval notice)", () => {
  const r = rig();
  r.fm.decideContactAuthorization(r.held.id, { revision: 1, decision: "approve-once" }, r.actor);
  vi.advanceTimersByTime(31 * 60_000); r.fm.sweepReplyObligations();
  expect(r.notices()).toHaveLength(1);
  expect(r.notices()[0].sourceKey).toBe(`contact-approval:${r.held.id}`);
  expect(r.notices()[0].payload.content).not.toMatch(/declined|expired/);
});
it("a page-expired ticket is still notified once by the sweep and store recreation cannot replay it", () => {
  const r = rig(); vi.advanceTimersByTime(31 * 60_000);
  expect(r.outbox.contactAuthorizations.get(r.held.id)?.state).toBe("expired");
  r.fm.sweepReplyObligations(); expect(r.notices()).toHaveLength(1);
  (r.outbox as any).contactAuthStore = new ContactAuthStore((r.outbox as any).db);
  r.fm.sweepReplyObligations(); expect(r.notices()).toHaveLength(1);
});
it("notice admission and its marker roll back together, then retry once", () => {
  const r = rig(); vi.advanceTimersByTime(31 * 60_000);
  expect(() => r.outbox.contactAuthorizations.notifyOutcomes(ticket => {
    r.outbox.admitSystemNotice(ticket.source, `contact-outcome:${ticket.id}`, "Synthetic status");
    throw Error("fake-storage-failure");
  })).toThrow("fake-storage-failure");
  expect(r.notices()).toEqual([]);
  r.fm.sweepReplyObligations(); expect(r.notices()).toHaveLength(1);
  // Even after transport retention removes its row, a restart must not create a fresh notice.
  (r.outbox as any).db.prepare("DELETE FROM deliveries WHERE kind=?").run(SYSTEM_NOTICE_KIND);
  (r.outbox as any).contactAuthStore = new ContactAuthStore((r.outbox as any).db);
  r.fm.sweepReplyObligations(); expect(r.notices()).toEqual([]);
});
it("does not replay pre-upgrade terminal tickets but still sweeps an existing pending ticket", () => {
  const r = rig();
  const other = r.outbox.contactAuthorizations.hold({ ...r.input, operationId: "fake-second" });
  r.outbox.contactAuthorizations.decide(r.held.id, { revision: 1, decision: "decline" }, r.actor,
    { canDecide: () => true, current: () => true, admit: () => { throw Error("unexpected"); } });
  (r.outbox as any).db.exec("DROP TABLE contact_auth_outcome_notices");
  (r.outbox as any).contactAuthStore = new ContactAuthStore((r.outbox as any).db);
  r.fm.sweepReplyObligations(); expect(r.notices()).toEqual([]);
  vi.advanceTimersByTime(31 * 60_000); r.fm.sweepReplyObligations();
  expect(r.notices()).toHaveLength(1);
  expect(r.notices()[0].payload.content).toContain(`#${other.id}`);
});
it("the actual Fleet outbox interval detects expiry with no page or manual sweep", () => {
  const r = rig(); const directory = mkdtempSync(join(tmpdir(), "contact-sweep-"));
  const fm: any = new FleetManager(directory);
  fm.fleetConfig = { defaults: {}, instances: {} };
  fm.scheduleDeliveryOutboxPump = vi.fn(); fm.initializeWorkingRecovery = vi.fn();
  fm.createWakeCoordinator = () => ({ start: vi.fn(), kick: vi.fn() });
  fm.ensureDeliveryOutbox();
  const outbox: DeliveryOutbox = fm.deliveryOutbox;
  cleanup.push(() => { clearInterval(fm.replyObligationTimer); outbox.close(); rmSync(directory, { recursive: true, force: true }); });
  const ticket = outbox.contactAuthorizations.hold(r.input);
  vi.advanceTimersByTime(30 * 60_000);
  const notices = outbox.listPending().filter(row => row.kind === SYSTEM_NOTICE_KIND);
  expect(notices).toHaveLength(1);
  expect(notices[0].payload.content).toContain(`#${ticket.id}`);
});
