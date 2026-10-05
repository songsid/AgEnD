import { appendFileSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeliveryOutbox } from "./delivery-outbox.js";
import { queueResumePolicyForAttempt } from "./delivery-queue-evidence.js";
import { finishTargetReconciliation, scanTranscriptForDeliveryMarker, transcriptDeltaDeliveryMarker, transcriptDeltaHasDeliveryMarker } from "./delivery-reconciliation.js";

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
  backend?: string;
  kind?: string;
  payloadContent?: string;
  submissionMode?: "idle_submit" | "native_queue_handoff" | "steer" | "raw_paste";
  queueResumePolicy?: "not_applicable" | "unknown" | "may_resume" | "does_not_resume";
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
    kind: options.kind ?? "fleet_inbound",
    payload: { type: options.kind === "raw_paste" ? "raw_paste" : "fleet_inbound", content: options.payloadContent ?? "work", meta: {} },
  }).delivery;
  const claimed = outbox.claimNext("manager-1", () => "target-boot-1", new Set())!;
  expect(outbox.begin(row.deliveryId, "target-boot-1", claimed.attemptNo, {
    backend: options.backend ?? "claude-code",
    backendVersion: null,
    windowId: options.windowId === undefined ? "@old-worker" : options.windowId,
    transcriptPath: options.transcriptPath ?? null,
    transcriptOffset: options.transcriptOffset ?? null,
    transcriptSessionId: options.transcriptPath ?? null,
    submissionMode: options.submissionMode ?? "idle_submit",
    queueResumePolicy: options.queueResumePolicy
      ?? queueResumePolicyForAttempt(options.backend ?? "claude-code", null, options.submissionMode ?? "idle_submit"),
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

  describe("Claude Code's paste wrapper (#1205)", () => {
    const claudeUser = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
    const wrapped = (body: string, wrapper = '\n\n<pasted_content id="45bc">\n') => claudeUser(`${wrapper}${body}`);

    it("accepts the CLI's own `<pasted_content>` wrapper in front of the marker, as every real Claude entry has it", () => {
      expect(transcriptDeltaHasDeliveryMarker(wrapped(`${marker}\n[from:worker] work`), "claude-code", id)).toBe(true);
      expect(transcriptDeltaHasDeliveryMarker(wrapped(`${marker}\n[from:worker] work`, '<pasted_content id="0a1b">\r\n'), "claude-code", id)).toBe(true);
    });

    it("accepts only that exact wrapper: other text, another tag or a different id shape in front still disqualify", () => {
      for (const front of ['\n\nsome words\n', '<pasted_content>\n', '<pasted_content id="ZZ">\n', '<other id="45bc">\n', '<pasted_content id="45bc">\nquoted: ', '<pasted_content id="45bc">',
        'a quoted line\n\n<pasted_content id="45bc">\n', '[from:worker] see below\n<pasted_content id="45bc">\n']) {
        expect(transcriptDeltaHasDeliveryMarker(wrapped(`${marker}\nwork`, front), "claude-code", id)).toBe(false);
      }
    });

    it("the marker must still lead the body inside the wrapper: a quote or a later mention does not count", () => {
      expect(transcriptDeltaHasDeliveryMarker(wrapped(`[from:worker] ${marker}`), "claude-code", id)).toBe(false);
      expect(transcriptDeltaHasDeliveryMarker(wrapped(`[from:worker] quoting\n${marker}\nwork`), "claude-code", id)).toBe(false);
      // …nor another delivery's marker leading the body.
      expect(transcriptDeltaHasDeliveryMarker(wrapped("[agend-delivery-id:00000000-0000-4000-8000-000000000042]\nwork"), "claude-code", id)).toBe(false);
    });

    it("the wrapper is Claude Code's alone: Codex entries are not given the allowance", () => {
      const entry = JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: `\n\n<pasted_content id="45bc">\n${marker}\nwork` }] },
      });
      expect(transcriptDeltaHasDeliveryMarker(entry, "codex", id)).toBe(false);
    });

    it("applies to the first user text item, wrapped, like the unwrapped form", () => {
      const entry = JSON.stringify({
        type: "user",
        message: { role: "user", content: [
          { type: "text", text: "preceding content" },
          { type: "text", text: `\n\n<pasted_content id="45bc">\n${marker}\nwork` },
        ] },
      });
      expect(transcriptDeltaHasDeliveryMarker(entry, "claude-code", id)).toBe(false);
    });

    it("tells a consumed message from one the CLI has only queued", () => {
      const queued = JSON.stringify({ type: "queue-operation", operation: "enqueue", content: `<pasted_content id="45bc">\n${marker}\nwork` });
      expect(transcriptDeltaDeliveryMarker(queued, "claude-code", id)).toBe("queued");
      expect(transcriptDeltaDeliveryMarker(`${queued}\n${wrapped(`${marker}\nwork`)}`, "claude-code", id)).toBe("user");
      // A queued entry is not a user message: the restart reconciler, which asks for "user", does not take it.
      expect(transcriptDeltaHasDeliveryMarker(queued, "claude-code", id)).toBe(false);
      // Only an enqueue, only from Claude, only with the marker leading.
      const removed = JSON.stringify({ type: "queue-operation", operation: "remove", content: `${marker}\nwork` });
      expect(transcriptDeltaDeliveryMarker(removed, "claude-code", id)).toBeNull();
      expect(transcriptDeltaDeliveryMarker(queued, "codex", id)).toBeNull();
      expect(transcriptDeltaDeliveryMarker(JSON.stringify({ type: "queue-operation", operation: "enqueue", content: `${marker}\nwork` }), "codex", id)).toBeNull();
      expect(transcriptDeltaDeliveryMarker(JSON.stringify({ type: "queue-operation", operation: "enqueue", content: `quoted ${marker}` }), "claude-code", id)).toBeNull();
    });
  });

  describe("scanTranscriptForDeliveryMarker", () => {
    const entry = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
    function transcript(initial: string) {
      const root = mkdtempSync(join(tmpdir(), "agend-scan-"));
      roots.push(root);
      const path = join(root, "session.jsonl");
      writeFileSync(path, initial);
      return path;
    }

    it("reads only what was written past the checkpoint", async () => {
      const old = entry(`${marker}\nold copy`);
      const path = transcript(old);
      expect(await scanTranscriptForDeliveryMarker(path, statSync(path).size, "claude-code", id)).toBe("no-match");
      appendFileSync(path, entry(`${marker}\nwork`));
      expect(await scanTranscriptForDeliveryMarker(path, old.length, "claude-code", id)).toBe("user");
      expect(await scanTranscriptForDeliveryMarker(path, statSync(path).size, "claude-code", id)).toBe("no-match");
    });

    it("a half-written last line is not proof, and the next look finds it whole", async () => {
      const path = transcript("");
      const line = entry(`${marker}\nwork`);
      appendFileSync(path, line.slice(0, 30));
      expect(await scanTranscriptForDeliveryMarker(path, 0, "claude-code", id)).toBe("no-match");
      appendFileSync(path, line.slice(30));
      expect(await scanTranscriptForDeliveryMarker(path, 0, "claude-code", id)).toBe("user");
    });

    it("`unavailable` means it could not judge — no file, a file shorter than the checkpoint, a backend with no format — never `no-match`", async () => {
      const path = transcript(entry("some earlier turn"));
      const size = statSync(path).size;
      truncateSync(path, 5);
      expect(await scanTranscriptForDeliveryMarker(path, size, "claude-code", id)).toBe("unavailable");
      rmSync(path);
      expect(await scanTranscriptForDeliveryMarker(path, 0, "claude-code", id)).toBe("unavailable");
      expect(await scanTranscriptForDeliveryMarker(transcript(entry(`${marker}\nwork`)), 0, "grok", id)).toBe("unavailable");
    });
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

  describe("a restart does not replay a Claude Code delivery that its transcript shows (#1205)", () => {
    /** The old CLI is gone and its pid dead: the one situation in which a complete transcript WITHOUT the marker authorises a replay. */
    const reconcile = async (body: (deliveryId: string) => string) => {
      const root = mkdtempSync(join(tmpdir(), "agend-reconciliation-wrapped-"));
      roots.push(root);
      const transcriptPath = join(root, "session.jsonl");
      writeFileSync(transcriptPath, "");
      const h = makeAttempt({ enterStarted: true, backend: "claude-code", submissionMode: "idle_submit", transcriptPath, transcriptOffset: 0 });
      // Exactly the shape Claude Code 2.1.284–2.1.289 wrote for every delivery in the live outbox.
      writeFileSync(transcriptPath, `${JSON.stringify({
        type: "user",
        message: { role: "user", content: `\n\n<pasted_content id="45bc">\n${body(h.row.deliveryId)}` },
      })}\n`);
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        const err = new Error("no such process") as NodeJS.ErrnoException;
        err.code = "ESRCH";
        throw err;
      });
      try {
        const result = await finishTargetReconciliation(h.outbox, {
          targetInstance: "worker",
          sessionName: "test-session",
          savedWindowId: "@old-worker",
          attempts: [{ candidate: h.candidate, paneWindowId: "@old-worker", panePid: 424242, pane: "", paneCaptureError: null }],
        }, true);
        return { result, state: h.outbox.get(h.row.deliveryId)?.state };
      } finally {
        kill.mockRestore();
        h.outbox.close();
      }
    };

    it("the delivered message is found in its transcript as the CLI really writes it — delivered, not retried", async () => {
      const { result, state } = await reconcile(deliveryId => `[agend-delivery-id:${deliveryId}]\n[from:worker] work`);
      expect(result).toMatchObject({ delivered: 1, retry: 0, uncertain: 0, safeToStart: true });
      expect(state).toBe("delivered");
    });

    it("control: a complete transcript that really lacks the marker is still retried — the replay path this test stands on", async () => {
      const { result, state } = await reconcile(() => "[agend-delivery-id:00000000-0000-4000-8000-000000000042]\n[from:worker] other");
      expect(result).toMatchObject({ delivered: 0, retry: 1, uncertain: 0 });
      expect(state).toBe("retry_wait");
    });

    it("a marker that is only quoted inside the wrapped body is not the delivery: still retried", async () => {
      const { result } = await reconcile(deliveryId => `[from:worker] quoting [agend-delivery-id:${deliveryId}] in prose`);
      expect(result).toMatchObject({ delivered: 0, retry: 1 });
    });
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

  it("retries a stable transcript miss for an idle submit after the old CLI exits", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-reconciliation-idle-miss-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    writeFileSync(transcriptPath, "");
    const h = makeAttempt({
      enterStarted: true,
      backend: "codex",
      submissionMode: "idle_submit",
      transcriptPath,
      transcriptOffset: 0,
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("no such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    try {
      const result = await finishTargetReconciliation(h.outbox, {
        targetInstance: "worker",
        sessionName: "test-session",
        savedWindowId: "@old-worker",
        attempts: [{ candidate: h.candidate, paneWindowId: "@old-worker", panePid: 424242, pane: "", paneCaptureError: null }],
      }, true);
      expect(result).toMatchObject({ delivered: 0, retry: 1, uncertain: 0, safeToStart: true });
      expect(h.outbox.get(h.row.deliveryId)).toMatchObject({ state: "retry_wait", reconciliationPending: false });
    } finally {
      kill.mockRestore();
      h.outbox.close();
    }
  });

  it("retries raw_paste only when the exact bytes remain at the end of the pre-kill composer", async () => {
    const raw = "  /compact\n--keep-space  ";
    const h = makeAttempt({
      enterStarted: false,
      kind: "raw_paste",
      payloadContent: raw,
      submissionMode: "raw_paste",
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("no such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    try {
      const result = await finishTargetReconciliation(h.outbox, {
        targetInstance: "worker",
        sessionName: "test-session",
        savedWindowId: "@old-worker",
        attempts: [{
          candidate: h.candidate,
          paneWindowId: "@old-worker",
          panePid: 424242,
          pane: `old transcript\n❯ ${raw}`,
          paneCaptureError: null,
        }],
      }, true);
      expect(result).toMatchObject({ delivered: 0, retry: 1, uncertain: 0, safeToStart: true });
      expect(h.outbox.get(h.row.deliveryId)).toMatchObject({ state: "retry_wait" });
    } finally {
      kill.mockRestore();
      h.outbox.close();
    }
  });

  it("keeps raw_paste uncertain when W1 says no Enter but the exact composer bytes are absent", async () => {
    const raw = "/compact";
    const h = makeAttempt({
      enterStarted: false,
      kind: "raw_paste",
      payloadContent: raw,
      submissionMode: "raw_paste",
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("no such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    try {
      const result = await finishTargetReconciliation(h.outbox, {
        targetInstance: "worker",
        sessionName: "test-session",
        savedWindowId: "@old-worker",
        attempts: [{
          candidate: h.candidate,
          paneWindowId: "@old-worker",
          panePid: 424242,
          pane: "CLI resumed with a clean prompt",
          paneCaptureError: null,
        }],
      }, true);
      expect(result).toMatchObject({ delivered: 0, retry: 0, uncertain: 1, safeToStart: true });
      expect(h.outbox.get(h.row.deliveryId)).toMatchObject({ state: "uncertain" });
    } finally {
      kill.mockRestore();
      h.outbox.close();
    }
  });

  it("does not treat a raw command ending in newline as exact composer evidence", async () => {
    const raw = "/compact\n";
    const h = makeAttempt({
      enterStarted: false,
      kind: "raw_paste",
      payloadContent: raw,
      submissionMode: "raw_paste",
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("no such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    try {
      const result = await finishTargetReconciliation(h.outbox, {
        targetInstance: "worker",
        sessionName: "test-session",
        savedWindowId: "@old-worker",
        attempts: [{
          candidate: h.candidate,
          paneWindowId: "@old-worker",
          panePid: 424242,
          pane: `old transcript\n❯ ${raw}\n`,
          paneCaptureError: null,
        }],
      }, true);
      expect(result).toMatchObject({ delivered: 0, retry: 0, uncertain: 1, safeToStart: true });
      expect(h.outbox.get(h.row.deliveryId)).toMatchObject({ state: "uncertain" });
    } finally {
      kill.mockRestore();
      h.outbox.close();
    }
  });

  it("keeps a transcript miss uncertain when the old CLI pid is unknown", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-reconciliation-unknown-pid-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    writeFileSync(transcriptPath, "");
    const h = makeAttempt({
      enterStarted: true,
      backend: "codex",
      submissionMode: "idle_submit",
      transcriptPath,
      transcriptOffset: 0,
    });
    const result = await finishTargetReconciliation(h.outbox, {
      targetInstance: "worker",
      sessionName: "test-session",
      savedWindowId: "@old-worker",
      attempts: [{ candidate: h.candidate, paneWindowId: "@old-worker", panePid: null, pane: "", paneCaptureError: null }],
    }, true);
    expect(result).toMatchObject({ delivered: 0, retry: 0, uncertain: 1, safeToStart: true });
    expect(h.outbox.get(h.row.deliveryId)).toMatchObject({ state: "uncertain", reconciliationPending: false });
    h.outbox.close();
  });

  it.each([
    ["Codex native queue", "codex", "native_queue_handoff" as const, "unknown" as const],
    ["Claude steering", "claude-code", "steer" as const, "may_resume" as const],
  ])("keeps %s uncertain when transcript has no marker and queue resume is not ruled out", async (_label, backend, submissionMode, queueResumePolicy) => {
    const root = mkdtempSync(join(tmpdir(), "agend-reconciliation-queue-unknown-"));
    roots.push(root);
    const transcriptPath = join(root, "session.jsonl");
    writeFileSync(transcriptPath, "");
    const h = makeAttempt({
      enterStarted: true,
      backend,
      submissionMode,
      queueResumePolicy,
      transcriptPath,
      transcriptOffset: 0,
    });
    const result = await finishTargetReconciliation(h.outbox, {
      targetInstance: "worker",
      sessionName: "test-session",
      savedWindowId: "@old-worker",
      attempts: [{ candidate: h.candidate, paneWindowId: "@old-worker", panePid: 424242, pane: "", paneCaptureError: null }],
    }, true);
    expect(result).toMatchObject({ delivered: 0, retry: 0, uncertain: 1, safeToStart: true });
    expect(h.outbox.get(h.row.deliveryId)).toMatchObject({ state: "uncertain", reconciliationPending: false });
    h.outbox.close();
  });

  it("allows transcript absence to retry only for an exact policy that proves resume cannot replay a queue item", async () => {
    const root = mkdtempSync(join(tmpdir(), "agend-reconciliation-queue-ephemeral-"));
    roots.push(root);
    const transcriptPath = join(root, "rollout.jsonl");
    writeFileSync(transcriptPath, "");
    const h = makeAttempt({
      enterStarted: true,
      backend: "codex",
      submissionMode: "native_queue_handoff",
      queueResumePolicy: "does_not_resume",
      transcriptPath,
      transcriptOffset: 0,
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("no such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    });
    try {
      const result = await finishTargetReconciliation(h.outbox, {
        targetInstance: "worker",
        sessionName: "test-session",
        savedWindowId: "@old-worker",
        attempts: [{ candidate: h.candidate, paneWindowId: "@old-worker", panePid: 424242, pane: "", paneCaptureError: null }],
      }, true);
      expect(result).toMatchObject({ delivered: 0, retry: 1, uncertain: 0, safeToStart: true });
      expect(h.outbox.get(h.row.deliveryId)).toMatchObject({ state: "retry_wait" });
    } finally {
      kill.mockRestore();
      h.outbox.close();
    }
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
