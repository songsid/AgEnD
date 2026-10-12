/**
 * #1647: a silent schedule's raw paste that landed was settled `uncertain` and raised a Needs-you item. The live outbox
 * named the causes the log never showed: kiro (`raw-paste-submit-proof:no-positive-acceptance-proof`, one residue look
 * right after Enter while kiro still repaints its composer) and claude-code (`post-submit-proof:stranded`, the same race).
 *
 * - A turn that starts on the paste settles it `delivered`: kiro's own pane (its execution state's edge into `working`
 *   after the Enter), claude-code/codex's transcript (a user entry that IS the pasted text, past the write checkpoint).
 * - Without one, it stays `uncertain` with the pane's reason. Never a second paste, never a second Enter.
 * - A silent schedule's row is never a Needs-you item; a human-originated row still is.
 *
 * Real Daemon, real DeliveryOutbox, stub tmux, real transcript files; nothing starts a CLI or a tmux server.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Daemon } from "../src/daemon.js";
import { DeliveryOutbox, isSilentScheduleDelivery } from "../src/delivery-outbox.js";
import { scanTranscriptForDeliveryMarker, transcriptDeltaHasRawText } from "../src/delivery-reconciliation.js";
import { t, setLocale } from "../src/locale.js";

const roots: string[] = [];
const daemons: any[] = [];
const realSetImmediate = setImmediate;
afterEach(() => {
  for (const daemon of daemons.splice(0)) daemon.fenceDeliveryWritesForStop?.();
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "agend-1647-")); roots.push(d); return d; };
const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as any;

/** A silent schedule's text, as the coordinator's patrol pastes it every run. */
const PATROL = "[巡邏] 檢查 Task Board：卡住超過 30 分鐘的卡片要催；沒有就靜默。";
/** Claude Code's persisted shapes (2.1.29x): a short paste as the plain body, a long one inside both wrapper tags. */
const claudeUser = (body: string) => JSON.stringify({ type: "user", message: { role: "user", content: body } }) + "\n";
const claudeWrapped = (body: string) => claudeUser(`\n\n<pasted_content id="9ac7">\n${body}\n</pasted_content id="9ac7">\n`);
const codexUser = (text: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }) + "\n";

describe("transcriptDeltaHasRawText: the raw paste's own user entry", () => {
  it("claude-code: the plain body, and a long paste inside both wrapper tags", () => {
    expect(transcriptDeltaHasRawText(claudeUser(PATROL), "claude-code", PATROL)).toBe(true);
    expect(transcriptDeltaHasRawText(claudeWrapped(PATROL), "claude-code", PATROL)).toBe(true);
  });
  it("codex: the rollout's user input_text", () => {
    expect(transcriptDeltaHasRawText(codexUser(PATROL), "codex", PATROL)).toBe(true);
  });
  it("whitespace the paste or the CLI changed does not matter", () => {
    expect(transcriptDeltaHasRawText(claudeUser(`  ${PATROL.replace("；", "；\n")}\n`), "claude-code", PATROL)).toBe(true);
  });
  it("not the paste: another text, a quote inside a longer message, a tool result, a queued entry, an assistant echo", () => {
    expect(transcriptDeltaHasRawText(claudeUser("another message"), "claude-code", PATROL)).toBe(false);
    expect(transcriptDeltaHasRawText(claudeUser(`please look at this: ${PATROL}`), "claude-code", PATROL)).toBe(false);
    expect(transcriptDeltaHasRawText(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: PATROL }] } }) + "\n", "claude-code", PATROL)).toBe(false);
    expect(transcriptDeltaHasRawText(JSON.stringify({ type: "queue-operation", operation: "enqueue", content: PATROL }) + "\n", "claude-code", PATROL)).toBe(false);
    expect(transcriptDeltaHasRawText(JSON.stringify({ type: "assistant", message: { role: "assistant", content: PATROL } }) + "\n", "claude-code", PATROL)).toBe(false);
    expect(transcriptDeltaHasRawText(claudeUser(PATROL), "claude-code", "")).toBe(false);
  });
  it("only past the checkpoint: the same words from the previous run are before it", async () => {
    const dir = tmp(), path = join(dir, "session.jsonl");
    writeFileSync(path, claudeUser(PATROL));                       // yesterday's run
    const checkpoint = statSync(path).size;
    expect(await scanTranscriptForDeliveryMarker(path, checkpoint, "claude-code", { rawText: PATROL })).toBe("no-match");
    appendFileSync(path, claudeUser(PATROL));                      // today's
    expect(await scanTranscriptForDeliveryMarker(path, checkpoint, "claude-code", { rawText: PATROL })).toBe("user");
  });
});

describe("a silent schedule's raw paste is never a Needs-you item; a human-originated row still is", () => {
  function insert(db: Database.Database, id: string, kind: string, sourceKey: string, state: string, seq: number) {
    const at = `2026-10-12T00:00:${String(seq).padStart(2, "0")}.000Z`;
    db.prepare(`INSERT INTO deliveries (delivery_id, operation_id, source_key, source_instance, source_daemon_boot_id, target_instance,
      kind, payload_json, state, attempt_no, created_seq, created_at, updated_at, accepted_at, finished_at)
      VALUES (?, ?, ?, 's', 'b', 't', ?, '{}', ?, 1, ?, ?, ?, ?, ?)`).run(id, `op-${id}`, sourceKey, kind, state, seq, at, at, at, at);
  }
  it("uncertain or failed silent-schedule pastes are left out; a human message, a raw command not from a schedule, stay", () => {
    const path = join(tmp(), "outbox.db");
    new DeliveryOutbox(path).close?.();
    const db = new Database(path);
    insert(db, "silent-uncertain", "raw_paste", "schedule:98b718d7:2026-10-11T15%3A30%3A00.000Z:coordinator:raw_paste", "uncertain", 1);
    insert(db, "silent-failed", "raw_paste", "schedule:98b718d7:2026-10-11T15%3A35%3A00.000Z:coordinator:raw_paste", "failed", 2);
    insert(db, "human-uncertain", "fleet_inbound", "source:op:worker:fleet_inbound", "uncertain", 3);
    insert(db, "raw-command-uncertain", "raw_paste", "command:clear:worker:raw_paste", "uncertain", 4);
    db.close();
    const box = new DeliveryOutbox(path);
    expect(box.needsAttention("2026-10-11T00:00:00.000Z").map(d => d.deliveryId)).toEqual(["raw-command-uncertain", "human-uncertain"]);
    box.close?.();
  });
  it("isSilentScheduleDelivery: a raw paste under a schedule source key, nothing else", () => {
    expect(isSilentScheduleDelivery({ kind: "raw_paste", sourceKey: "schedule:x:run:t:raw_paste" })).toBe(true);
    expect(isSilentScheduleDelivery({ kind: "fleet_inbound", sourceKey: "schedule:x:run:t:raw_paste" })).toBe(false);
    expect(isSilentScheduleDelivery({ kind: "raw_paste", sourceKey: "command:clear" })).toBe(false);
    expect(isSilentScheduleDelivery({ kind: "raw_paste", sourceKey: null })).toBe(false);
  });
  it("the leader notice for one names the cause, and says it is not re-sent", () => {
    setLocale("en");
    const notice = t("delivery.fleet_uncertain_silent_schedule", "coordinator", "schedule:op", "d1", "raw-paste-submit-proof:no-positive-acceptance-proof");
    expect(notice).toContain("raw-paste-submit-proof:no-positive-acceptance-proof");
    expect(notice).toContain("not re-sent");
    expect(notice).toContain("delivery_id=d1");
    setLocale("zh-TW");
    expect(t("delivery.fleet_uncertain_silent_schedule", "coordinator", "schedule:op", "d1", "cause-x")).toContain("cause-x");
    setLocale("en");
  });
});

/** A real Daemon with a durable raw-paste attempt and a stub pane. */
function rawPasteHarness(opts: { backend: Record<string, unknown> | ((dir: string) => unknown); backendName?: string; controlClient?: Record<string, unknown> }) {
  vi.useFakeTimers();
  const root = tmp();
  const instanceDir = join(root, "instances", "worker");
  const transcript = join(root, "session.jsonl");
  const outbox = new DeliveryOutbox(join(root, "delivery-outbox.db"), "manager-test");
  const backend = typeof opts.backend === "function" ? opts.backend(instanceDir) : opts.backend;
  const daemon: any = new Daemon("worker", {
    working_directory: root, log_level: "error", backend: opts.backendName ?? "kiro-cli",
    restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
    context_guardian: { max_age_hours: 4, grace_period_ms: 600_000 },
  }, instanceDir, false, backend as any, {
    getObservationResetAt: () => 0, getLastOutputAt: () => undefined, isIdle: () => true, waitUntilIdle: vi.fn(async () => true),
    hasOutputSince: vi.fn(() => false), ...opts.controlClient,
  } as any, logger);
  daemons.push(daemon);
  daemon.setDeliveryOutboxPort(outbox);
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(join(instanceDir, "window-id"), "@worker");
  const row = outbox.admit({
    operationId: "schedule:98b718d7:run", sourceKey: "schedule:98b718d7:run:worker:raw_paste", sourceInstance: "fleet",
    sourceDaemonBootId: "sb", targetInstance: "worker", kind: "raw_paste", payload: { type: "raw_paste", content: PATROL },
  }).delivery;
  const claimed = outbox.claimNext("manager-test", () => daemon.bootId, new Set())!;
  writeFileSync(transcript, claudeUser(PATROL));   // the previous run's copy, before the checkpoint
  daemon.transcriptMonitor = { reconciliationCheckpoint: async () => ({ path: transcript, offset: statSync(transcript).size, sessionId: "s" }) };
  const tmux = {
    capturePane: vi.fn(async () => "❯ "),
    capturePaneWithHistory: vi.fn(async () => "❯ "),
    pasteBuffer: vi.fn(async () => true),
    sendSpecialKey: vi.fn(async () => true),
    getLastPasteError: vi.fn(),
    isLastPasteFailureRecoverable: vi.fn(() => true),
    getWindowId: () => "@worker",
  };
  daemon.tmux = tmux;
  vi.spyOn(daemon, "wake").mockResolvedValue(undefined);
  vi.spyOn(daemon, "waitForInputTransientToClear").mockResolvedValue(true);
  vi.spyOn(daemon, "paneReadinessForDelivery").mockResolvedValue("ready");
  vi.spyOn(daemon, "probeBlockingDialog").mockResolvedValue({ state: "clear" });
  vi.spyOn(daemon, "hasPositiveDeliveryInput").mockResolvedValue(true);
  vi.spyOn(daemon, "waitForPaneReadyForDelivery").mockResolvedValue(true);
  const state = () => outbox.get(row.deliveryId)?.state;
  const evidence = (): string | null => ((outbox as any).db.prepare("SELECT evidence FROM delivery_attempts WHERE delivery_id=?").get(row.deliveryId) as any)?.evidence ?? null;
  const settled = () => !["delivering", "submission_started"].includes(state() ?? "");
  const run = () => daemon.queueRawPaste(PATROL, daemon.deliveryEpoch, false, { deliveryId: row.deliveryId, attemptNo: claimed.attemptNo, submissionMode: "raw_paste" });
  const pump = async (steps: number) => {
    for (let i = 0; i < steps && !settled(); i++) {
      await vi.advanceTimersByTimeAsync(250);
      for (let turn = 0; turn < 20; turn++) await new Promise<void>(r => realSetImmediate(r));
    }
  };
  return { daemon, outbox, row, tmux, transcript, state, evidence, settled, run, pump };
}

const kiroBackend = { binaryName: "kiro-cli", getBottomReadyPattern: () => /^❯ ?$/m, dropsEnterWhileBusy: () => true };

describe("kiro (no transcript): the pane's own turn start settles a raw paste", () => {
  /** The live race: output at once, the composer repainted late — so the one residue look still sees the paste. */
  function kiro(controlClient?: Record<string, unknown>) {
    const h = rawPasteHarness({ backend: kiroBackend, controlClient });
    vi.spyOn(h.daemon, "confirmSubmittedAfterEnter").mockResolvedValue(false);
    const residue = vi.spyOn(h.daemon, "pasteResidue").mockResolvedValue("present");
    return { ...h, residue };
  }

  it("the execution state goes idle → working after the Enter (through the real snapshot path): delivered, one paste, one Enter", async () => {
    const h = kiro();
    h.tmux.sendSpecialKey.mockImplementation(async () => {
      setTimeout(() => h.daemon.applyInstanceStateSnapshot({ state: "working", unchangedForMs: 0 }, "⠋ Thinking..."), 600);
      return true;
    });
    h.run();
    await h.pump(40);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("raw-paste-pane-turn-start");
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
  });

  it("no turn start and the text still in the box for the whole window: uncertain with the pane's reason — no second Enter", async () => {
    const h = kiro();
    h.run();
    await h.pump(40);
    expect(h.state()).toBe("uncertain");
    expect(h.outbox.get(h.row.deliveryId)?.lastError).toBe("raw-paste-submit-proof:no-positive-acceptance-proof");
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
  });

  it("a working edge from BEFORE the Enter is not this paste's turn: uncertain", async () => {
    const h = kiro();
    h.daemon.applyInstanceStateSnapshot({ state: "working", unchangedForMs: 0 }, "⠋ Thinking...");
    h.run();
    await h.pump(40);
    expect(h.state()).toBe("uncertain");
  });

  it("the text leaves the input row (a later look) with output after the Enter: delivered", async () => {
    const h = kiro({ hasOutputSince: vi.fn(() => true) });
    h.residue.mockResolvedValueOnce("present").mockResolvedValue("absent");
    h.run();
    await h.pump(40);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("raw-paste-left-input-after-output");
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
  });

  it("the text left the row but nothing printed after the Enter (a wiped paste): not taken — uncertain", async () => {
    const h = kiro({ hasOutputSince: vi.fn(() => false) });
    h.residue.mockResolvedValue("absent");
    h.run();
    await h.pump(40);
    expect(h.state()).toBe("uncertain");
  });
});

describe("claude-code / codex: the transcript's turn for the pasted text settles a raw paste", () => {
  /** The pane proof fails the way the live cases did (stranded/unproven); only the transcript can settle it. */
  function cli(backendName: "claude-code" | "codex") {
    const backend = { binaryName: backendName === "codex" ? "codex" : "claude", getBottomReadyPattern: () => /^❯ ?$/m, readInputRow: () => "" };
    const h = rawPasteHarness({ backend, backendName });
    vi.spyOn(h.daemon, "confirmAfterEnter").mockResolvedValue(false);
    vi.spyOn(h.daemon, "lateCodexSubmissionProof").mockResolvedValue("unproven");
    return h;
  }
  const entry = (backendName: "claude-code" | "codex") => backendName === "codex" ? codexUser(PATROL) : claudeWrapped(PATROL);

  it.each(["claude-code", "codex"] as const)("%s: the entry arrives after the pane window (the second fleet's 8 s): delivered by the transcript", async backendName => {
    const h = cli(backendName);
    h.tmux.sendSpecialKey.mockImplementation(async () => { setTimeout(() => appendFileSync(h.transcript, entry(backendName)), 6_000); return true; });
    h.run();
    await h.pump(80);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("transcript-turn-user-entry-raw-paste-text");
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
  });

  it.each(["claude-code", "codex"] as const)("%s: no entry for the whole wait (only the previous run's, before the checkpoint): uncertain with the pane's reason", async backendName => {
    const h = cli(backendName);
    h.run();
    await h.pump(80);
    expect(h.state()).toBe("uncertain");
    expect(h.outbox.get(h.row.deliveryId)?.lastError).toMatch(/^post-submit-proof:unproven; no-transcript-turn \(no-match\)$/);
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
  });

  it("another message in the transcript is not the paste: uncertain", async () => {
    const h = cli("claude-code");
    h.tmux.sendSpecialKey.mockImplementation(async () => { setTimeout(() => appendFileSync(h.transcript, claudeUser("someone else's words")), 2_000); return true; });
    h.run();
    await h.pump(80);
    expect(h.state()).toBe("uncertain");
  });

  it("the transcript unreadable for the whole wait: uncertain, never the output-edge 'delivered'", async () => {
    const h = cli("claude-code");
    h.tmux.sendSpecialKey.mockImplementation(async () => { setTimeout(() => writeFileSync(h.transcript, ""), 500); return true; });   // truncated below the checkpoint
    h.run();
    await h.pump(80);
    expect(h.state()).toBe("uncertain");
    expect(h.outbox.get(h.row.deliveryId)?.lastError).toMatch(/no-transcript-turn \(unavailable\)$/);
  });

  it("inside the pane window, the proofs read the transcript for the pasted TEXT (not a marker it never carries)", async () => {
    const backend = { binaryName: "claude", getBottomReadyPattern: () => /^❯ ?$/m, readInputRow: () => "" };
    const h = rawPasteHarness({ backend, backendName: "claude-code" });
    const prove = vi.spyOn(h.daemon, "proveDeliveryFromTranscript");
    h.tmux.pasteBuffer.mockImplementation(async () => { appendFileSync(h.transcript, claudeUser(PATROL)); return true; });
    h.run();
    await h.pump(80);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("positive submission proof; transcript-turn-user-entry-raw-paste-text");
    expect(prove).not.toHaveBeenCalled();
  });
});

describe("delivery_status: a submission proof that failed reads as 'could not confirm', not a generic error", () => {
  it("the public summary of `raw-paste-submit-proof:…` is the unconfirmed text", () => {
    setLocale("en");
    const path = join(tmp(), "outbox.db");
    const box = new DeliveryOutbox(path, "m");
    const row = box.admit({ operationId: "op", sourceKey: "schedule:x:r:t:raw_paste", sourceInstance: "fleet", sourceDaemonBootId: "b",
      targetInstance: "t", kind: "raw_paste", payload: { type: "raw_paste", content: "x" } }).delivery;
    (box as any).db.prepare("UPDATE deliveries SET state='uncertain', last_error='raw-paste-submit-proof:no-positive-acceptance-proof' WHERE delivery_id=?").run(row.deliveryId);
    const status = JSON.stringify(box.queryStatusForInstance("fleet", { deliveryId: row.deliveryId }));
    expect(status).toContain(t("delivery.error_unconfirmed"));
    expect(status).not.toContain(t("delivery.error_recorded"));
    box.close?.();
  });
});
