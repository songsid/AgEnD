/**
 * M-3716 (the user, 11-25): a held requester learns the outcome. After an admin approved a held request
 * (a ClassicBot room → another agent) the room only saw the target's reply. Now: one approval notice once the delivery settles
 * (by whom, when, delivered / queued / not confirmed), and the requester can read its OWN held requests with
 * delivery_status { held_requests: true }, never another agent's.
 */
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { DeliveryOutbox, SYSTEM_NOTICE_KIND } from "../src/delivery-outbox.js";
import { ContactAuthStore, CONTACT_APPROVAL_NOTICE_WAIT_MS } from "../src/contact-auth-store.js";
import { ContactHeldError } from "../src/contact-auth-service.js";
import { outboundHandlers } from "../src/outbound-handlers.js";
import { DeliveryStatusArgs } from "../src/outbound-schemas.js";
import { getLocale, setLocale, t } from "../src/locale.js";

const originalLocale = getLocale();
const cleanup: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); setLocale(originalLocale); for (const close of cleanup.splice(0)) close(); });

const ROOM = "classic-limit-room", TARGET = "worker";
const operator = { platform: "host" as const, adapterId: "host", userId: "operator", label: "Operator" };
const discordAdmin = { platform: "discord" as const, adapterId: "fake-adapter", userId: "100", label: "Fake Admin" };

function rig() {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-11-25T01:20:00Z"));
  const dir = mkdtempSync(join(tmpdir(), "contact-held-outcome-"));
  const outbox = new DeliveryOutbox(join(dir, "outbox.db"));
  cleanup.push(() => { outbox.close(); rmSync(dir, { recursive: true, force: true }); });
  const fm: any = Object.assign(Object.create(FleetManager.prototype), {
    deliveryOutbox: outbox, logger: { error: vi.fn(), warn: vi.fn() }, lifecycle: { daemons: new Map() },
    expireReplyObligations: vi.fn(), tickDispatcherLiveness: vi.fn(), scheduleDeliveryOutboxPump: vi.fn(),
    emitSseEvent: vi.fn(), needsYouItems: () => [], getDaemonBootId: () => "fake-boot", hubAgentToken: () => "fake-generation",
    adapters: new Map(), worlds: new Map(), getInstanceAdapterId: () => undefined,
    fleetConfig: { instances: { [TARGET]: {} }, defaults: {} }, hubContactRestricted: () => false,
    // A restricted ClassicBot room is the requester, as in the live case.
    classicChannels: { getAll: () => [{ instanceName: ROOM, restrictedMode: true, displayName: "Limit room" }], isAdmin: () => false },
  });
  const ask = (operationId = "fake-op") => {
    try {
      fm.contactService().requireApplication({ operationId, source: ROOM, target: TARGET, verb: "delegate_task",
        message: "Synthetic request", correlationId: `fake-cid-${operationId}`, resultRecipient: ROOM,
        payload: { type: "fleet_inbound", content: "Synthetic request" } });
    } catch (err) { if (err instanceof ContactHeldError) return err; throw err; }
    throw Error("expected the request to be held");
  };
  const notices = () => outbox.listPending().filter(row => row.kind === SYSTEM_NOTICE_KIND);
  const deliver = (id: string, state = "delivered") => {
    const ticket = outbox.contactAuthorizations.get(id)!;
    (outbox as any).db.prepare("UPDATE deliveries SET state=? WHERE delivery_id=?").run(state, ticket.deliveryId);
  };
  const status = (caller: string, args: Record<string, unknown> = { held_requests: true }) => new Promise<{ result: any; error: any }>(resolve => {
    outboundHandlers.get("delivery_status")!(fm, args, (result: any, error: any) => resolve({ result, error }), { instanceName: caller } as any);
  });
  return { fm, outbox, ask, notices, deliver, status };
}

it.each(["en", "zh-TW"] as const)("a ClassicBot requester is told who approved it, when, and that the target has it (%s)", locale => {
  setLocale(locale); const r = rig();
  const held = r.ask();
  expect(held.result.message).toBe(t("contact.refusedUnknown"));
  expect(held.result.message).toContain("held_requests");
  const id = held.result.authorization_id;
  vi.setSystemTime(new Date("2026-11-25T01:29:59Z"));
  r.fm.decideContactAuthorization(id, { revision: 1, decision: "approve-once" }, operator);
  // Still queued for the target: nothing yet (the delivery has not settled).
  r.fm.sweepReplyObligations();
  expect(r.notices()).toEqual([]);
  r.deliver(id);
  r.fm.sweepReplyObligations(); r.fm.sweepReplyObligations();
  expect(r.notices()).toHaveLength(1);
  const [notice] = r.notices();
  expect(notice.targetInstance).toBe(ROOM);
  expect(notice.sourceInstance).toBe("agend-system");
  expect(notice.payload.content).toBe(t("contact.noticeApproved_delivered", id.slice(0, 9), TARGET, t("contactProposal.host"), "2026-11-25 01:29 UTC"));
  expect(notice.payload.content).toContain(locale === "en" ? "delivered to worker" : "已送達 worker");
  expect(notice.payload.content).toContain(locale === "en" ? "Do not send it again" : "請勿重送");
  // Status only: no ticket badge or authority rides on it.
  expect(notice.payload).not.toHaveProperty("contactTicket");
  expect(notice.payload.meta).not.toHaveProperty("authority");
});

it("names a Discord approver by label and platform", () => {
  const r = rig(); const id = r.ask().result.authorization_id;
  r.outbox.contactAuthorizations.decide(id, { revision: 1, decision: "approve-once" }, discordAdmin,
    { canDecide: () => true, current: () => true, admit: (request, ticketId) => r.fm.contactService().host.admit(request, ticketId) });
  // A real outbox row, still queued (Prism #4452: no fabricated delivery id).
  expect(r.outbox.get(r.outbox.contactAuthorizations.get(id)!.deliveryId!)?.state).toBe("queued");
  r.fm.sweepReplyObligations();
  expect(r.notices()).toEqual([]);
  vi.advanceTimersByTime(CONTACT_APPROVAL_NOTICE_WAIT_MS);
  r.fm.sweepReplyObligations();
  expect(r.notices()).toHaveLength(1);
  expect(r.notices()[0].payload.content).toContain("approved by Fake Admin (Discord)");
  expect(r.notices()[0].payload.content).toContain("queued for worker");
});

it("still queued after the wait: approved-and-queued, once; a later delivery adds nothing", () => {
  const r = rig(); const id = r.ask().result.authorization_id;
  r.fm.decideContactAuthorization(id, { revision: 1, decision: "approve-once" }, operator);
  vi.advanceTimersByTime(CONTACT_APPROVAL_NOTICE_WAIT_MS - 1); r.fm.sweepReplyObligations();
  expect(r.notices()).toEqual([]);
  vi.advanceTimersByTime(1); r.fm.sweepReplyObligations();
  expect(r.notices()).toHaveLength(1);
  expect(r.notices()[0].payload.content).toContain("queued for worker");
  r.deliver(id); r.fm.sweepReplyObligations();
  expect(r.notices()).toHaveLength(1);
});

it("a standing rule's approval is not announced: the send itself returned it", () => {
  const r = rig(); const id = r.ask().result.authorization_id;
  r.fm.decideContactAuthorization(id, { revision: 1, decision: "approve-once" }, operator);
  (r.outbox as any).db.prepare("UPDATE contact_auth_tickets SET ticket_json=json_set(ticket_json,'$.grantId','fake-grant') WHERE id=?").run(id);
  r.deliver(id); vi.advanceTimersByTime(CONTACT_APPROVAL_NOTICE_WAIT_MS); r.fm.sweepReplyObligations();
  expect(r.notices()).toEqual([]);
});

it("a missing or pruned delivery row is never promised as queued: not confirmed, at once", async () => {
  const r = rig(); const id = r.ask().result.authorization_id;
  r.fm.decideContactAuthorization(id, { revision: 1, decision: "approve-once" }, operator);
  (r.outbox as any).db.prepare("DELETE FROM deliveries WHERE delivery_id=?").run(r.outbox.contactAuthorizations.get(id)!.deliveryId);
  const row = (await r.status(ROOM)).result.requests[0];
  expect(row.state).toBe("not-confirmed");
  expect(row.next).toContain("no longer on record");
  r.fm.sweepReplyObligations();
  expect(r.notices()).toHaveLength(1);
  expect(r.notices()[0].payload.content).toContain("not confirmed");
  expect(r.notices()[0].payload.content).not.toContain("queued");
});

it("a real in-flight row reads as approved-queued; a rule approval keeps its provenance apart from the delivery state", async () => {
  const r = rig();
  const queued = r.ask("fake-queued").result.authorization_id;
  r.fm.decideContactAuthorization(queued, { revision: 1, decision: "approve-once" }, operator);
  const rule = r.ask("fake-rule").result.authorization_id;
  r.fm.decideContactAuthorization(rule, { revision: 1, decision: "approve-once" }, operator);
  (r.outbox as any).db.prepare("UPDATE contact_auth_tickets SET ticket_json=json_set(ticket_json,'$.grantId','fake-grant') WHERE id=?").run(rule);
  const rows = () => r.status(ROOM).then(s => Object.fromEntries(s.result.requests.map((row: any) => [row.ticket_id, row])));
  let now = await rows();
  expect(now[queued]).toMatchObject({ state: "approved-queued", decided_by: "host operator" });
  expect(now[rule]).toMatchObject({ state: "approved-queued", approved_by_rule: true });
  expect(now[rule]).not.toHaveProperty("decided_by");
  r.deliver(rule);
  now = await rows();
  expect(now[rule]).toMatchObject({ state: "delivered", approved_by_rule: true });
  r.deliver(rule, "failed");
  expect((await rows())[rule].state).toBe("not-confirmed");
});

it("a failed delivery is announced as not confirmed and points at held_requests", () => {
  const r = rig(); const id = r.ask().result.authorization_id;
  r.fm.decideContactAuthorization(id, { revision: 1, decision: "approve-once" }, operator);
  r.deliver(id, "failed"); r.fm.sweepReplyObligations();
  expect(r.notices()).toHaveLength(1);
  expect(r.notices()[0].payload.content).toContain("not confirmed");
  expect(r.notices()[0].payload.content).toContain("held_requests: true");
});

it("decline keeps its own notice and never adds an approval notice", () => {
  const r = rig(); const id = r.ask().result.authorization_id;
  r.fm.decideContactAuthorization(id, { revision: 1, decision: "decline" }, operator);
  vi.advanceTimersByTime(CONTACT_APPROVAL_NOTICE_WAIT_MS * 2); r.fm.sweepReplyObligations();
  expect(r.notices()).toHaveLength(1);
  expect(r.notices()[0].payload.content).toBe(t("contact.noticeDeclined", id, TARGET));
});

it("approvals from before the upgrade are not replayed; a new one is announced", () => {
  const r = rig(); const old = r.ask("fake-old").result.authorization_id;
  r.fm.decideContactAuthorization(old, { revision: 1, decision: "approve-once" }, operator);
  (r.outbox as any).db.exec("DROP TABLE contact_auth_approval_notices");
  (r.outbox as any).contactAuthStore = new ContactAuthStore((r.outbox as any).db);
  r.deliver(old); vi.advanceTimersByTime(CONTACT_APPROVAL_NOTICE_WAIT_MS); r.fm.sweepReplyObligations();
  expect(r.notices()).toEqual([]);
  const fresh = r.ask("fake-new").result.authorization_id;
  r.fm.decideContactAuthorization(fresh, { revision: 1, decision: "approve-once" }, operator);
  r.deliver(fresh); r.fm.sweepReplyObligations();
  expect(r.notices()).toHaveLength(1);
  expect(r.notices()[0].payload.content).toContain(`#${fresh.slice(0, 9)}`);
  // A store recreation (restart) does not repeat it.
  (r.outbox as any).contactAuthStore = new ContactAuthStore((r.outbox as any).db);
  r.fm.sweepReplyObligations();
  expect(r.notices()).toHaveLength(1);
});

it("held_requests lists only the caller's own requests, with who and when, and writes nothing", async () => {
  const r = rig();
  const pending = r.ask("fake-pending").result.authorization_id;
  const approved = r.ask("fake-approved").result.authorization_id;
  r.fm.decideContactAuthorization(approved, { revision: 1, decision: "approve-once" }, operator);
  r.deliver(approved);
  const before = (r.outbox as any).db.prepare("SELECT id,ticket_json FROM contact_auth_tickets ORDER BY id").all();
  const own = await r.status(ROOM);
  expect(own.error).toBeFalsy();
  const rows = own.result.requests;
  expect(rows.map((row: any) => row.ticket_id).sort()).toEqual([pending, approved].sort());
  const done = rows.find((row: any) => row.ticket_id === approved);
  expect(done).toMatchObject({ short_id: approved.slice(0, 9), to: TARGET, state: "delivered", decided_by: "host operator", decided_at: "2026-11-25T01:20:00.000Z" });
  const waiting = rows.find((row: any) => row.ticket_id === pending);
  expect(waiting).toMatchObject({ state: "pending", expires_at: expect.any(String) });
  expect(waiting.next).toContain("Do not send it again");
  // No message text or people: the requester's own context has those.
  expect(JSON.stringify(own.result)).not.toContain("Synthetic request");
  // The target (or anyone else) never sees the room's requests.
  expect((await r.status(TARGET)).result).toEqual({ requests: [], note: expect.any(String) });
  // An expired pending request reads as expired without a write.
  vi.advanceTimersByTime(31 * 60_000);
  expect((await r.status(ROOM)).result.requests.find((row: any) => row.ticket_id === pending).state).toBe("expired");
  expect((r.outbox as any).db.prepare("SELECT id,ticket_json FROM contact_auth_tickets ORDER BY id").all()).toEqual(before);
});

it("held_requests is used alone and names no other agent", () => {
  expect(DeliveryStatusArgs.safeParse({ held_requests: true }).success).toBe(true);
  expect(DeliveryStatusArgs.safeParse({ held_requests: true, delivery_id: "x" }).success).toBe(false);
  expect(DeliveryStatusArgs.safeParse({ held_requests: true, agent: ROOM }).success).toBe(false);
  expect(DeliveryStatusArgs.safeParse({ held_requests: false }).success).toBe(false);
});
