// M-3770 slice 2.5, wiring part 3 (Fable's part 3 follow-ups): the trial's outbox refuses every admission, so the
// internal callers that admit must keep their state whole and say "updating": a contact approval rolls back with its
// delivery (the ticket stays pending, the card stays, the person is told to try again in a moment); the outcome sweep
// waits for the commit; a paired runtime's finished result is not reconciled (nor its row completed) until then.
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { FleetManager } from "../src/fleet-manager.js";
import { DeliveryOutbox, SYSTEM_NOTICE_KIND } from "../src/delivery-outbox.js";
import { type ContactRequest } from "../src/contact-auth-store.js";
import { handleContactAuthorizationApi } from "../src/contact-auth-api.js";
import { nativeDecisionFailure } from "../src/request-contact-native.js";
import { updateTrialRefusal, type QuiescenceGate } from "../src/update-quiescence.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
/** The trial's hold as the outbox sees it (the barrier's own refusesAdmission is covered in update-trial-m3770). */
const trialGate = (): QuiescenceGate => ({ armed: () => true, holdOutboxClaim: () => true, holdSchedule: () => true, holdTaskClaim: () => true,
  noteAdmission: () => undefined, commitTurn: () => false, refusesAdmission: () => true });

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "trial-contact-"));
  const outbox = new DeliveryOutbox(join(dir, "outbox.db"));
  cleanup.push(() => { outbox.close(); rmSync(dir, { recursive: true, force: true }); });
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const fm: any = Object.assign(Object.create(FleetManager.prototype), {
    deliveryOutbox: outbox, logger, lifecycle: { daemons: new Map() }, shuttingDown: false,
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
  return { fm, outbox, held, actor, logger };
}

it("an approval pressed during the trial rolls back with its refused delivery: the ticket stays pending, nothing is queued; it applies after the commit", () => {
  const r = rig();
  r.outbox.setQuiescence(trialGate());
  let caught: unknown;
  try { r.fm.decideContactAuthorization(r.held.id, { revision: 1, decision: "approve-once" }, r.actor); } catch (err) { caught = err; }
  expect(caught).toMatchObject({ code: "update-trial" });
  expect(r.outbox.contactAuthorizations.get(r.held.id)).toMatchObject({ state: "pending", revision: 1 });
  expect(r.outbox.contactAuthorizations.get(r.held.id)?.deliveryId).toBeUndefined();
  expect(r.outbox.listPending()).toEqual([]);
  r.outbox.setQuiescence(null);                                                                    // the commit's hold coming down
  const approved = r.fm.decideContactAuthorization(r.held.id, { revision: 1, decision: "approve-once" }, r.actor);
  expect(approved.state).toBe("approved");
  expect(r.outbox.listPending().some(row => row.deliveryId === approved.deliveryId)).toBe(true);
});

it("the outcome sweep waits for the commit: a decline in the trial queues no notice and logs no error; the notice goes once after", () => {
  const r = rig();
  const notices = () => r.outbox.listPending().filter(row => row.kind === SYSTEM_NOTICE_KIND);
  r.outbox.setQuiescence(trialGate());
  r.fm.decideContactAuthorization(r.held.id, { revision: 1, decision: "decline" }, r.actor);
  r.fm.sweepContactAuthorizationOutcomes();
  expect(notices()).toEqual([]);
  expect(r.logger.error).not.toHaveBeenCalled();
  r.outbox.setQuiescence(null);
  r.fm.sweepContactAuthorizationOutcomes();
  r.fm.sweepContactAuthorizationOutcomes();
  expect(notices()).toHaveLength(1);
});

it("the native card says updating (the card stays) — not the generic failure", () => {
  expect(nativeDecisionFailure(updateTrialRefusal())).toBe("updating");
  expect(nativeDecisionFailure(new Error("conflict"))).toBe("changed");
  expect(nativeDecisionFailure(new Error("boom"))).toBe("failed");
});

it("the web approval answers 503 updating with Retry-After, not a generic unavailable", async () => {
  const ended = new Promise<{ status: number; headers: Record<string, string>; body: string }>(resolve => {
    let status = 0, headers: Record<string, string> = {};
    const res: any = { destroyed: false, writableEnded: false,
      writeHead: (s: number, h: Record<string, string>) => { status = s; headers = h; },
      end: (b: string) => { res.writableEnded = true; resolve({ status, headers, body: b }); } };
    const actor = { platform: "host", adapterId: "host", userId: "operator", label: "Operator" };
    const host: any = { contactActor: () => actor, decideContactAuthorization: () => { throw updateTrialRefusal(); } };
    const req: any = Object.assign(Readable.from([Buffer.from(JSON.stringify({ revision: 1, decision: "approve-once" }))]), { method: "POST", headers: { "content-type": "application/json" } });
    const id = "R" + "0".repeat(8) + "-0000-0000-0000-" + "0".repeat(12);
    expect(handleContactAuthorizationApi(req, res, new URL(`http://x/ui/api/contact-authorizations/${id}/decision`), host)).toBe(true);
  });
  const r = await ended;
  expect(r.status).toBe(503);
  expect(r.headers["Retry-After"]).toBe("10");
  expect(JSON.parse(r.body)).toEqual({ error: "updating" });
});

it("a paired runtime's finished result is not reconciled in the trial — its row isn't completed and nothing is remembered — and is after", () => {
  const r = rig();
  r.outbox.setQuiescence(trialGate());
  const get = vi.spyOn(r.outbox, "get");
  r.fm.reconciledRemoteResults = new Set();
  r.fm.reconcileRemoteDelivery("m1", { id: "d1", finishedAt: "2026-11-27T00:00:00Z", outcomeConfirmed: true, status: "completed" });
  expect(get).not.toHaveBeenCalled();
  expect(r.fm.reconciledRemoteResults.size).toBe(0);
  r.outbox.setQuiescence(null);
  r.fm.reconcileRemoteDelivery("m1", { id: "d1", finishedAt: "2026-11-27T00:00:00Z", outcomeConfirmed: true, status: "completed" });
  expect(get).toHaveBeenCalledWith("d1");
});
