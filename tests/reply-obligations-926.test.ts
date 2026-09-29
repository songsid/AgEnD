/**
 * #926 phase 1: a `requires_reply` request that reached its owner leaves a
 * durable obligation, and only the owner's own answer on the same
 * correlation_id closes it. Both 9/24 losses were replies never sent — a
 * verdict left as terminal text, a turn killed by a restart — so nothing in
 * the fleet remembered the reply was owed. Every case uses the real outbox.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryOutbox } from "../src/delivery-outbox.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function freshOutbox(): { outbox: DeliveryOutbox; path: string } {
  const root = mkdtempSync(join(tmpdir(), "agend-926-"));
  roots.push(root);
  const path = join(root, "delivery-outbox.db");
  return { outbox: new DeliveryOutbox(path, "manager"), path };
}

let seq = 0;
interface Msg { from: string; to: string; cid: string; requiresReply?: boolean; kind?: string }
function admit(outbox: DeliveryOutbox, m: Msg) {
  const n = ++seq;
  return outbox.admit({
    operationId: `op-${n}`, sourceKey: `key-${n}`, sourceInstance: m.from, sourceDaemonBootId: `${m.from}-boot`,
    targetInstance: m.to, kind: m.kind ?? "fleet_inbound", correlationId: m.cid,
    payload: { type: m.kind ?? "fleet_inbound", content: `message ${n}`, meta: m.requiresReply === undefined ? {} : { requires_reply: String(m.requiresReply) } },
  }).delivery;
}

/** Drive a row through the real claim → begin → complete transitions. */
function deliver(outbox: DeliveryOutbox, deliveryId: string, outcome: "delivered" | "failed" | "uncertain" = "delivered") {
  for (;;) {
    const claimed = outbox.claimNext("manager", name => `${name}-boot`, new Set());
    expect(claimed).toBeTruthy();
    const boot = `${claimed!.targetInstance}-boot`;
    expect(outbox.begin(claimed!.deliveryId, boot, claimed!.attemptNo, {
      backend: "codex", windowId: "@w", transcriptPath: null, transcriptOffset: null, transcriptSessionId: null, submissionMode: "idle_submit",
    })).toBe("begun");
    // A failed/uncertain earlier row queued its outcome notice to the sender;
    // deliver that (it never asks for a reply) and keep going to ours.
    const mine = claimed!.deliveryId === deliveryId;
    expect(outbox.complete(claimed!.deliveryId, boot, claimed!.attemptNo, mine ? outcome : "delivered", "test")).toBe(true);
    if (mine) return;
  }
}

const request = { from: "leader", to: "reviewer", cid: "cid-review-924", requiresReply: true };

describe("reply obligations open on delivery (#926)", () => {
  it("opens when a requires_reply request is delivered — not at admission or begin", () => {
    const { outbox } = freshOutbox();
    const row = admit(outbox, request);
    expect(outbox.openReplyObligations("reviewer")).toEqual([]);
    deliver(outbox, row.deliveryId);
    expect(outbox.openReplyObligations("reviewer")).toEqual([expect.objectContaining({
      correlationId: "cid-review-924", requesterInstance: "leader", ownerInstance: "reviewer",
      requestDeliveryId: row.deliveryId, state: "open", nudgedAt: null, overdueNotifiedAt: null,
    })]);
    outbox.close();
  });

  it("opens nothing for a request that did not ask for a reply, a broadcast, or a failed/uncertain delivery", () => {
    const { outbox } = freshOutbox();
    for (const [m, outcome] of [
      [{ ...request, requiresReply: undefined }, "delivered"],
      [{ ...request, requiresReply: false }, "delivered"],
      [{ ...request, kind: "broadcast" }, "delivered"],
      [request, "failed"],
      [request, "uncertain"],
    ] as const) {
      deliver(outbox, admit(outbox, m as Msg).deliveryId, outcome);
    }
    expect(outbox.openReplyObligations("reviewer")).toEqual([]);
    outbox.close();
  });

  it("opens on a reconciled delivery too", () => {
    const { outbox } = freshOutbox();
    const row = admit(outbox, request);
    const claimed = outbox.claimNext("manager", name => `${name}-boot`, new Set())!;
    outbox.begin(row.deliveryId, "reviewer-boot", claimed.attemptNo, {
      backend: "codex", windowId: "@w", transcriptPath: null, transcriptOffset: null, transcriptSessionId: null, submissionMode: "idle_submit",
    });
    (outbox as any).db.prepare("UPDATE deliveries SET reconciliation_pending=1 WHERE delivery_id=?").run(row.deliveryId);
    expect(outbox.reconcileAttempt(row.deliveryId, "reviewer-boot", claimed.attemptNo, "delivered", "transcript marker")).toBe(true);
    expect(outbox.openReplyObligations("reviewer")).toHaveLength(1);
    outbox.close();
  });
});

describe("only the owner's answer closes it (#926)", () => {
  it("closes when the owner sends the requester a message on the same correlation_id, at admission", () => {
    const { outbox } = freshOutbox();
    deliver(outbox, admit(outbox, request).deliveryId);
    const answer = admit(outbox, { from: "reviewer", to: "leader", cid: "cid-review-924" });
    expect(outbox.openReplyObligations("reviewer")).toEqual([]);
    expect(outbox.getReplyObligation("cid-review-924", "leader", "reviewer")).toMatchObject({ state: "answered", answeredDeliveryId: answer.deliveryId });
    outbox.close();
  });

  it("stays open for the requester re-asking, another correlation_id, or an answer sent to someone else", () => {
    const { outbox } = freshOutbox();
    deliver(outbox, admit(outbox, request).deliveryId);
    admit(outbox, { from: "leader", to: "reviewer", cid: "cid-review-924" });          // wrong direction
    admit(outbox, { from: "reviewer", to: "leader", cid: "cid-something-else" });      // wrong cid
    admit(outbox, { from: "reviewer", to: "sol", cid: "cid-review-924" });             // wrong recipient
    admit(outbox, { from: "reviewer", to: "leader", cid: "cid-review-924", kind: "broadcast" });
    expect(outbox.openReplyObligations("reviewer")).toHaveLength(1);
    outbox.close();
  });

  it("counts an answer admitted before the request finished its submission proof", () => {
    const { outbox } = freshOutbox();
    const row = admit(outbox, request);
    const claimed = outbox.claimNext("manager", name => `${name}-boot`, new Set())!;
    outbox.begin(row.deliveryId, "reviewer-boot", claimed.attemptNo, {
      backend: "codex", windowId: "@w", transcriptPath: null, transcriptOffset: null, transcriptSessionId: null, submissionMode: "idle_submit",
    });
    // The owner answers while its daemon is still confirming the paste…
    const answer = admit(outbox, { from: "reviewer", to: "leader", cid: "cid-review-924" });
    // …and only then does the request reach delivered.
    outbox.complete(row.deliveryId, "reviewer-boot", claimed.attemptNo, "delivered", "proof");
    expect(outbox.getReplyObligation("cid-review-924", "leader", "reviewer")).toMatchObject({ state: "answered", answeredDeliveryId: answer.deliveryId });
    outbox.close();
  });

  it("re-opens when the requester asks again on the same correlation_id after an answer", () => {
    const { outbox } = freshOutbox();
    deliver(outbox, admit(outbox, request).deliveryId);
    const first = outbox.getReplyObligation("cid-review-924", "leader", "reviewer")!;
    deliver(outbox, admit(outbox, { from: "reviewer", to: "leader", cid: "cid-review-924" }).deliveryId);
    const again = admit(outbox, request);
    deliver(outbox, again.deliveryId);
    expect(outbox.getReplyObligation("cid-review-924", "leader", "reviewer")).toMatchObject({
      state: "open", requestDeliveryId: again.deliveryId, openedAt: first.openedAt, answeredAt: null,
    });
    outbox.close();
  });
});

describe("the obligation is durable and visible (#926)", () => {
  it("survives the process: a reopened outbox still knows the reply is owed", () => {
    const { outbox, path } = freshOutbox();
    deliver(outbox, admit(outbox, request).deliveryId);
    outbox.close();
    const reopened = new DeliveryOutbox(path, "manager-after-restart");
    expect(reopened.openReplyObligations("reviewer")).toEqual([expect.objectContaining({ correlationId: "cid-review-924", state: "open" })]);
    reopened.close();
  });

  it("shows on the request in delivery_status, and reads as none on a database from before the table", () => {
    const { outbox, path } = freshOutbox();
    const row = admit(outbox, request);
    deliver(outbox, row.deliveryId);
    const item = outbox.queryStatusForInstance("leader", { correlationId: "cid-review-924" }).items[0]!;
    expect(item.reply_obligation).toMatchObject({ state: "open", nudged_at: null, answered_at: null });
    outbox.close();
    const raw = new Database(path);
    raw.exec("DROP TABLE reply_obligations");
    raw.close();
    expect(DeliveryOutbox.queryStatusReadOnly(path, { deliveryId: row.deliveryId }).items[0]!.reply_obligation).toBeNull();
  });
});
