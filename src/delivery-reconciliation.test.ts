import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryOutbox } from "./delivery-outbox.js";
import { finishTargetReconciliation, transcriptDeltaHasDeliveryMarker } from "./delivery-reconciliation.js";

const id = "00000000-0000-4000-8000-000000000041";
const marker = `[agend-delivery-id:${id}]`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeAttempt(options: {
  enterStarted: boolean;
  transcriptPath?: string | null;
  transcriptOffset?: number | null;
  windowId?: string | null;
} = { enterStarted: true }) {
  const root = mkdtempSync(join(tmpdir(), "agend-reconciliation-"));
  roots.push(root);
  const outbox = new DeliveryOutbox(join(root, "outbox.db"), "manager-1");
  const row = outbox.admit({
    operationId: "op-reconcile",
    sourceKey: "source:op-reconcile:worker",
    sourceInstance: "source",
    sourceDaemonBootId: "source-boot",
    targetInstance: "worker",
    kind: "fleet_inbound",
    payload: { type: "fleet_inbound", content: "work", meta: {} },
  }).delivery;
  const claimed = outbox.claimNext("manager-1", () => "target-boot-1", new Set())!;
  expect(outbox.begin(row.deliveryId, "target-boot-1", claimed.attemptNo, {
    backend: "claude-code",
    windowId: options.windowId === undefined ? "@old-worker" : options.windowId,
    transcriptPath: options.transcriptPath ?? null,
    transcriptOffset: options.transcriptOffset ?? null,
    transcriptSessionId: options.transcriptPath ?? null,
    submissionMode: "idle_submit",
  })).toBe("begun");
  if (options.enterStarted) expect(outbox.markEnterStarted(row.deliveryId, "target-boot-1", claimed.attemptNo)).toBe(true);
  expect(outbox.recoverForBoot("manager-2").reconciliationPending).toBe(1);
  return { outbox, row, candidate: outbox.getReconciliationCandidates("worker")[0]! };
}

describe("durable transcript marker reconciliation", () => {
  it("requires the exact marker at the beginning of a Claude user entry", () => {
    expect(transcriptDeltaHasDeliveryMarker(JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: `${marker}\n[from:worker] do the work` }] },
    }), "claude-code", id)).toBe(true);
  });

  it("requires the exact marker at the beginning of a Codex user entry", () => {
    expect(transcriptDeltaHasDeliveryMarker(JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: `${marker}\n[from:worker] do the work` }] },
    }), "codex", id)).toBe(true);
  });

  it("does not accept a marker after the first Claude user text item", () => {
    const entry = JSON.stringify({
      type: "user",
      message: { role: "user", content: [
        { type: "text", text: "preceding content" },
        { type: "text", text: `${marker}\n[from:worker] do the work` },
      ] },
    });
    expect(transcriptDeltaHasDeliveryMarker(entry, "claude-code", id)).toBe(false);
  });

  it("does not accept a marker after the first Codex user text item", () => {
    const entry = JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [
        { type: "input_text", text: "preceding content" },
        { type: "input_text", text: `${marker}\n[from:worker] do the work` },
      ] },
    });
    expect(transcriptDeltaHasDeliveryMarker(entry, "codex", id)).toBe(false);
  });

  it("does not accept quoted, embedded, assistant, system, or tool-result occurrences", () => {
    const entries = [
      { type: "user", message: { role: "user", content: [{ type: "text", text: `quoted: ${marker}` }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: marker }] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", text: marker }] } },
      { type: "response_item", payload: { type: "function_call_output", output: marker } },
    ].map(entry => JSON.stringify(entry)).join("\n");
    expect(transcriptDeltaHasDeliveryMarker(entries, "claude-code", id)).toBe(false);
    expect(transcriptDeltaHasDeliveryMarker(entries, "codex", id)).toBe(false);
  });

  it("fails closed for unknown transcript backends and malformed lines", () => {
    expect(transcriptDeltaHasDeliveryMarker(`not-json ${marker}`, "muse", id)).toBe(false);
    expect(transcriptDeltaHasDeliveryMarker("{ truncated", "claude-code", id)).toBe(false);
  });

  it("uses a persisted Claude user-entry marker as positive proof only after the old CLI exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-reconciliation-positive-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    const h = makeAttempt({ enterStarted: true, transcriptPath, transcriptOffset: 0 });
    writeFileSync(transcriptPath, `${JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: `[agend-delivery-id:${h.row.deliveryId}]\n[from:worker] work` }] },
    })}\n`);
    const result = await finishTargetReconciliation(h.outbox, {
      targetInstance: "worker",
      sessionName: "test-session",
      savedWindowId: "@old-worker",
      attempts: [{ candidate: h.candidate, paneWindowId: "@old-worker", panePid: null, pane: "", paneCaptureError: null }],
    }, true);
    expect(result).toMatchObject({ delivered: 1, retry: 0, uncertain: 0, safeToStart: true });
    expect(h.outbox.get(h.row.deliveryId)?.state).toBe("delivered");
    h.outbox.close();
  });

  it("retries composer-only marker evidence only when the write-ahead fence proves Enter never started", async () => {
    const h = makeAttempt({ enterStarted: false });
    const result = await finishTargetReconciliation(h.outbox, {
      targetInstance: "worker",
      sessionName: "test-session",
      savedWindowId: "@old-worker",
      attempts: [{
        candidate: h.candidate,
        paneWindowId: "@old-worker",
        panePid: null,
        pane: `${marker}\n› [from:worker] work`,
        paneCaptureError: null,
      }],
    }, true);
    expect(result).toMatchObject({ delivered: 0, retry: 1, uncertain: 0, safeToStart: true });
    expect(h.outbox.get(h.row.deliveryId)).toMatchObject({ state: "retry_wait", reconciliationPending: false });
    h.outbox.close();
  });

  it("does not read a positive transcript as proof until window retirement is confirmed", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-reconciliation-live-cli-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    const h = makeAttempt({ enterStarted: true, transcriptPath, transcriptOffset: 0 });
    writeFileSync(transcriptPath, `${JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: `[agend-delivery-id:${h.row.deliveryId}]\n[from:worker] work` }] },
    })}\n`);
    const result = await finishTargetReconciliation(h.outbox, {
      targetInstance: "worker",
      sessionName: "test-session",
      savedWindowId: "@old-worker",
      attempts: [{ candidate: h.candidate, paneWindowId: "@old-worker", panePid: process.pid, pane: "", paneCaptureError: null }],
    }, false);
    expect(result).toMatchObject({ delivered: 0, retry: 0, uncertain: 1, safeToStart: false });
    expect(h.outbox.get(h.row.deliveryId)?.state).toBe("uncertain");
    h.outbox.close();
  });

  it("keeps the target fenced when the tmux window is gone but its captured process is still alive", async () => {
    const h = makeAttempt({ enterStarted: true });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("permission denied") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    });
    try {
      const result = await finishTargetReconciliation(h.outbox, {
        targetInstance: "worker",
        sessionName: "test-session",
        savedWindowId: "@old-worker",
        attempts: [{ candidate: h.candidate, paneWindowId: "@old-worker", panePid: 424242, pane: "", paneCaptureError: null }],
      }, true);
      expect(result).toMatchObject({ delivered: 0, retry: 0, uncertain: 1, safeToStart: false });
      expect(h.outbox.get(h.row.deliveryId)?.state).toBe("uncertain");
    } finally {
      kill.mockRestore();
      h.outbox.close();
    }
  });

  it("keeps the target fenced when a pending attempt has no window identity", async () => {
    const h = makeAttempt({ enterStarted: true, windowId: null });
    const result = await finishTargetReconciliation(h.outbox, {
      targetInstance: "worker",
      sessionName: "test-session",
      savedWindowId: "@old-worker",
      attempts: [{ candidate: h.candidate, paneWindowId: null, panePid: null, pane: null, paneCaptureError: "old window id unavailable" }],
    }, true);
    expect(result).toMatchObject({ delivered: 0, retry: 0, uncertain: 1, safeToStart: false });
    expect(h.outbox.get(h.row.deliveryId)?.state).toBe("uncertain");
    h.outbox.close();
  });

  it("allows an ordinary start when no reconciliation rows exist even if retirement is unconfirmed", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-reconciliation-empty-"));
    roots.push(root);
    const outbox = new DeliveryOutbox(join(root, "outbox.db"), "manager-1");
    const result = await finishTargetReconciliation(outbox, {
      targetInstance: "worker",
      sessionName: "test-session",
      savedWindowId: "@old-worker",
      attempts: [],
    }, false);
    expect(result).toMatchObject({ delivered: 0, retry: 0, uncertain: 0, safeToStart: true });
    outbox.close();
  });
});
