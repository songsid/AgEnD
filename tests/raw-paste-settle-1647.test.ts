/**
 * #1647: a silent schedule's raw paste that landed was settled `uncertain` and raised a Needs-you item. The live outbox
 * named the causes the log never showed: kiro (`raw-paste-submit-proof:no-positive-acceptance-proof`, one residue look
 * right after Enter while kiro still repaints its composer) and claude-code (`post-submit-proof:stranded`, the same race).
 *
 * - A paste the CLI took settles it `delivered`: kiro's own input row (the text gone, or kiro's busy marker in its place,
 *   with output after the Enter — looked at more than once, within the budget from the Enter, under the write's fence);
 *   claude-code's transcript (a user message that IS the pasted text, past the write checkpoint — its transcript is this
 *   instance's alone). Not codex: its rollout is chosen by working directory, so its raw paste stays uncertain.
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
import { FleetManager } from "../src/fleet-manager.js";
import { KiroBackend } from "../src/backend/kiro.js";

const roots: string[] = [];
const daemons: any[] = [];
const realSetImmediate = setImmediate;
/** Real timers, captured before any test fakes them: the transcript wait reads a real file through libuv. */
const realSetTimeout = setTimeout;
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
/** A user message of the paste's text AND an image: not the plain-text raw paste, though its text is the same. */
const claudeTextAndImage = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] } }) + "\n";
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
  it("the whole message must be the paste: a message of several text blocks whose first is the paste is not (#1663 P1-1)", () => {
    const blocks = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: PATROL }, { type: "text", text: "another request" }] } }) + "\n";
    expect(transcriptDeltaHasRawText(blocks, "claude-code", PATROL)).toBe(false);
    const codexTwo = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: PATROL }, { type: "input_text", text: "another request" }] } }) + "\n";
    expect(transcriptDeltaHasRawText(codexTwo, "codex", PATROL)).toBe(false);
    const single = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: PATROL }] } }) + "\n";
    expect(transcriptDeltaHasRawText(single, "claude-code", PATROL)).toBe(true);   // one block: the message
    const codexSingle = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: PATROL }] } }) + "\n";
    expect(transcriptDeltaHasRawText(codexSingle, "codex", PATROL)).toBe(true);
  });
  it("text plus an image (or any other block) is not a plain text paste, whatever its text says (#1663 r2 P1-1)", () => {
    expect(transcriptDeltaHasRawText(claudeTextAndImage(PATROL), "claude-code", PATROL)).toBe(false);
    const codexImage = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: PATROL }, { type: "input_image", image_url: "data:image/png;base64,AA==" }] } }) + "\n";
    expect(transcriptDeltaHasRawText(codexImage, "codex", PATROL)).toBe(false);
    const claudeImageFirst = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }, { type: "text", text: PATROL }] } }) + "\n";
    expect(transcriptDeltaHasRawText(claudeImageFirst, "claude-code", PATROL)).toBe(false);
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
  /**
   * 250 ms of fake time per step, then real time for the file reads that step started (a loaded CI runner needs more
   * than a few event-loop turns for libuv to finish them). Stops as soon as the row settles.
   */
  const pump = async (steps: number) => {
    for (let i = 0; i < steps && !settled(); i++) {
      await vi.advanceTimersByTimeAsync(250);
      for (let turn = 0; turn < 20; turn++) await new Promise<void>(r => realSetImmediate(r));
      await new Promise<void>(r => realSetTimeout(r, 5));
    }
  };
  return { daemon, outbox, row, tmux, transcript, state, evidence, settled, run, pump };
}

/** The real KiroBackend (legacy UI: prompt row `N% !>` with the typed text on it, spinner as the last row while busy). */
const KIRO_COMPAT = { version: "kiro-cli 2.29.0", supportsLegacyUi: true, supportsTui: true, supportsV3: true, agentEngines: ["v2", "v1", "v3"], supportsEffortFlag: true, source: "version" as const };
const kiroBackend = (dir: string) => new KiroBackend(dir, KIRO_COMPAT);
const KIRO_READY = "Kiro is ready.\n\n2% !> ";

describe("kiro (no transcript): its own input row, looked at more than once, settles a raw paste", () => {
  /** The live race: output at once, the composer repainted late — so the confirmation's one residue look sees the paste. */
  function kiro(controlClient?: Record<string, unknown>) {
    const h = rawPasteHarness({ backend: kiroBackend, controlClient: { hasOutputSince: vi.fn(() => true), ...controlClient } });
    vi.spyOn(h.daemon, "confirmSubmittedAfterEnter").mockResolvedValue(false);
    /** The pane before the paste is the empty prompt (the delivery gate's view); `after` is what it shows once pasted. */
    let pasted = false;
    h.tmux.pasteBuffer.mockImplementation(async () => { pasted = true; return true; });
    const paneAfterPaste = (after: () => string) => h.tmux.capturePane.mockImplementation(async () => pasted ? after() : KIRO_READY);
    const isPasted = () => pasted;
    /** Hold only the looks AFTER the paste (the delivery gate's pre-write look answers at once). */
    const holdResidueAfterPaste = (answer: () => Promise<"present" | "absent" | "unknown">) => {
      const real = h.daemon.pasteResidue.bind(h.daemon);
      vi.spyOn(h.daemon, "pasteResidue").mockImplementation((formatted: unknown) => pasted ? answer() : real(formatted));
    };
    return { ...h, paneAfterPaste, isPasted, holdResidueAfterPaste };
  }

  it("the text leaves the input row a moment later (the real pasteResidue on the pane): delivered, one paste, one Enter", async () => {
    const h = kiro();
    let entered = false;
    h.tmux.sendSpecialKey.mockImplementation(async () => { setTimeout(() => { entered = true; }, 600); return true; });
    h.paneAfterPaste(() => entered ? KIRO_READY : `${KIRO_READY}${PATROL}`);
    h.run();
    await h.pump(100);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("raw-paste-left-input-after-output");
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
  });

  it("kiro's own busy marker replaces the composer (pasteResidue's rule): delivered", async () => {
    const h = kiro();
    let entered = false;
    h.tmux.sendSpecialKey.mockImplementation(async () => { setTimeout(() => { entered = true; }, 600); return true; });
    h.paneAfterPaste(() => entered ? `${KIRO_READY}${PATROL}\n⠋ Thinking...` : `${KIRO_READY}${PATROL}`);
    h.run();
    await h.pump(100);
    expect(h.state()).toBe("delivered");
  });

  it("a repaint the state machine reads as `working` is not evidence: the text still in the row → uncertain (#1663 P1-3)", async () => {
    const h = kiro();
    h.paneAfterPaste(() => `${KIRO_READY}${PATROL}`);
    h.tmux.sendSpecialKey.mockImplementation(async () => {
      setTimeout(() => h.daemon.applyInstanceStateSnapshot({ state: "working", unchangedForMs: 0 }, `${KIRO_READY}${PATROL}`), 600);
      return true;
    });
    h.run();
    await h.pump(100);
    expect(h.state()).toBe("uncertain");
    expect(h.outbox.get(h.row.deliveryId)?.lastError).toBe("raw-paste-submit-proof:no-positive-acceptance-proof");
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
  });

  it("the text in the row for the whole budget: uncertain with the pane's reason — no second Enter, no second paste", async () => {
    const h = kiro();
    h.paneAfterPaste(() => `${KIRO_READY}${PATROL}`);
    h.run();
    await h.pump(100);
    expect(h.state()).toBe("uncertain");
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
  });

  it("the text left the row but nothing printed after the Enter (a wiped paste): not taken — uncertain", async () => {
    const h = kiro({ hasOutputSince: vi.fn(() => false) });
    h.tmux.capturePane.mockResolvedValue(KIRO_READY);
    h.run();
    await h.pump(100);
    expect(h.state()).toBe("uncertain");
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
  });

  it("an answer that lands after the budget from the Enter proves nothing (#1663 P2-1)", async () => {
    const h = kiro();
    // The first look is held 6 s: past CONFIRM_BUSY_POLLS×POLL + POST_ENTER_PROOF_WINDOW_MS from the Enter.
    h.paneAfterPaste(() => `${KIRO_READY}${PATROL}`);
    h.holdResidueAfterPaste(() => new Promise(r => setTimeout(() => r("absent"), 6_000)));
    h.run();
    await h.pump(100);
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(h.state()).toBe("uncertain");
  });

  it("entering the look after the budget already ran out: nothing is accepted (#1663 P2-1)", async () => {
    const h = kiro();
    h.tmux.capturePane.mockResolvedValue(KIRO_READY);
    (h.daemon.confirmSubmittedAfterEnter as any).mockImplementation(() => new Promise(r => setTimeout(() => r(false), 6_000)));
    h.run();
    await h.pump(100);
    expect(h.state()).toBe("uncertain");
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
  });

  it("a stop during a held look: the late 'absent' is not this write's proof — never delivered (#1663 P2-2)", async () => {
    const h = kiro();
    h.paneAfterPaste(() => `${KIRO_READY}${PATROL}`);
    h.holdResidueAfterPaste(() => new Promise(r => setTimeout(() => {
      h.daemon.fenceDeliveryWritesForStop();
      r("absent");
    }, 500)));
    h.run();
    await h.pump(100);
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
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

  it("claude-code: the entry arrives after the pane window (the second fleet's 8 s): delivered by its own transcript", async () => {
    const backendName = "claude-code";
    const h = cli(backendName);
    h.tmux.sendSpecialKey.mockImplementation(async () => { setTimeout(() => appendFileSync(h.transcript, entry(backendName)), 6_000); return true; });
    h.run();
    await h.pump(200);
    expect(h.state()).toBe("delivered");
    expect(h.evidence()).toBe("transcript-turn-user-entry-raw-paste-text");
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
  });

  it("claude-code: no entry for the whole wait (only the previous run's, before the checkpoint): uncertain with the pane's reason", async () => {
    const h = cli("claude-code");
    h.run();
    await h.pump(200);
    expect(h.state()).toBe("uncertain");
    expect(h.outbox.get(h.row.deliveryId)?.lastError).toMatch(/^post-submit-proof:unproven; no-transcript-turn \(no-match\)$/);
    expect(h.tmux.pasteBuffer).toHaveBeenCalledTimes(1);
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
  });

  it("codex: its rollout is chosen by working directory (another instance can write the same text there) — even a matching entry proves nothing: uncertain with the pane's reason (#1663 P1-2)", async () => {
    const h = cli("codex");
    const prove = vi.spyOn(h.daemon, "proveDeliveryFromTranscript");
    h.tmux.sendSpecialKey.mockImplementation(async () => { setTimeout(() => appendFileSync(h.transcript, entry("codex")), 2_000); return true; });
    h.run();
    await h.pump(200);
    expect(h.state()).toBe("uncertain");
    expect(h.outbox.get(h.row.deliveryId)?.lastError).toBe("post-submit-proof:unproven");
    expect(prove).not.toHaveBeenCalled();
    expect(h.tmux.sendSpecialKey).toHaveBeenCalledTimes(1);
  });

  it("claude-code: a text+image message with the paste's text, at Enter+6 s, is not the paste: uncertain (#1663 r2 P1-1)", async () => {
    const h = cli("claude-code");
    h.tmux.sendSpecialKey.mockImplementation(async () => { setTimeout(() => appendFileSync(h.transcript, claudeTextAndImage(PATROL)), 6_000); return true; });
    h.run();
    await h.pump(200);
    expect(h.state()).toBe("uncertain");
    expect(h.outbox.get(h.row.deliveryId)?.lastError).toMatch(/^post-submit-proof:unproven; no-transcript-turn \(no-match\)$/);
  });

  it("another message in the transcript is not the paste: uncertain", async () => {
    const h = cli("claude-code");
    h.tmux.sendSpecialKey.mockImplementation(async () => { setTimeout(() => appendFileSync(h.transcript, claudeUser("someone else's words")), 2_000); return true; });
    h.run();
    await h.pump(200);
    expect(h.state()).toBe("uncertain");
  });

  it("the transcript unreadable for the whole wait: uncertain, never the output-edge 'delivered'", async () => {
    const h = cli("claude-code");
    h.tmux.sendSpecialKey.mockImplementation(async () => { setTimeout(() => writeFileSync(h.transcript, ""), 500); return true; });   // truncated below the checkpoint
    h.run();
    await h.pump(200);
    expect(h.state()).toBe("uncertain");
    expect(h.outbox.get(h.row.deliveryId)?.lastError).toMatch(/no-transcript-turn \(unavailable\)$/);
  });

  it("codex inside the pane window: a matching rollout entry is not read as this paste's proof either (#1663 P1-2)", async () => {
    const backend = { binaryName: "codex", getBottomReadyPattern: () => /^❯ ?$/m, readInputRow: () => "" };
    const h = rawPasteHarness({ backend, backendName: "codex" });
    h.tmux.pasteBuffer.mockImplementation(async () => { appendFileSync(h.transcript, codexUser(PATROL)); return true; });
    h.run();
    await h.pump(200);
    expect(h.state()).not.toBe("delivered");
    expect(h.evidence() ?? "").not.toContain("transcript");
  });

  it("inside the pane window, the proofs read the transcript for the pasted TEXT (not a marker it never carries)", async () => {
    const backend = { binaryName: "claude", getBottomReadyPattern: () => /^❯ ?$/m, readInputRow: () => "" };
    const h = rawPasteHarness({ backend, backendName: "claude-code" });
    const prove = vi.spyOn(h.daemon, "proveDeliveryFromTranscript");
    h.tmux.pasteBuffer.mockImplementation(async () => { appendFileSync(h.transcript, claudeUser(PATROL)); return true; });
    h.run();
    await h.pump(200);
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

describe("the fleet's notice for an unconfirmed delivery: the cause in the log; a silent schedule says what it is", () => {
  it("a silent schedule: the silent-schedule notice with its cause; a human message: today's notice — both log the cause", () => {
    setLocale("en");
    const fm: any = new FleetManager(tmp());
    fm.ensureDeliveryOutbox();
    try {
      const outbox = fm.deliveryOutbox as DeliveryOutbox;
      const notice = vi.spyOn(fm, "notifyFleetError").mockReturnValue(true);
      const logged = vi.spyOn(fm.logger, "error");
      vi.spyOn(fm, "scheduleDeliveryOutboxPump").mockImplementation(() => {});   // this test settles the rows itself
      const settle = (kind: string, sourceKey: string, reason: string) => {
        const row = outbox.admit({ operationId: `op-${kind}`, sourceKey, sourceInstance: "fleet", sourceDaemonBootId: "b",
          targetInstance: "worker", kind: kind as any, payload: { type: kind, content: "x", meta: {} } }).delivery;
        // The first uncertain row queues an outcome notice back to its source ("fleet"): leave that lane out.
        const claimed = outbox.claimNext(fm.managerBootId, () => "worker-boot", new Set(["fleet"]))!;
        expect(claimed.deliveryId).toBe(row.deliveryId);
        expect(outbox.begin(row.deliveryId, "worker-boot", claimed.attemptNo, {
          backend: "kiro-cli", backendVersion: null, windowId: "@w", transcriptPath: null, transcriptOffset: null,
          transcriptSessionId: null, submissionMode: kind === "raw_paste" ? "raw_paste" : "idle_submit", queueResumePolicy: "unknown",
        } as any)).toBe("begun");
        expect(outbox.complete(row.deliveryId, "worker-boot", claimed.attemptNo, "uncertain", reason)).toBe(true);
        return row.deliveryId;
      };
      const silent = settle("raw_paste", "schedule:98b718d7:run:worker:raw_paste", "raw-paste-submit-proof:no-positive-acceptance-proof");
      expect(notice).toHaveBeenCalledTimes(1);
      expect(notice.mock.calls[0]![0]).toContain("A silent schedule's paste into worker could not be confirmed (raw-paste-submit-proof:no-positive-acceptance-proof)");
      expect(logged.mock.calls.find(c => (c[0] as any)?.deliveryId === silent)?.[0]).toMatchObject({
        cause: "raw-paste-submit-proof:no-positive-acceptance-proof", silentSchedule: true });
      const human = settle("fleet_inbound", "mcp:source:op:worker:fleet_inbound", "post-submit-proof:unproven");
      expect(notice).toHaveBeenCalledTimes(2);
      expect(notice.mock.calls[1]![0]).toContain("Delivery to worker could not be confirmed");
      const humanLog = logged.mock.calls.find(c => (c[0] as any)?.deliveryId === human)?.[0] as any;
      expect(humanLog).toMatchObject({ cause: "post-submit-proof:unproven" });
      expect(humanLog.silentSchedule).toBeUndefined();
      expect(outbox.needsAttention("2000-01-01T00:00:00.000Z").map(d => d.deliveryId)).toEqual([human]);
    } finally {
      clearInterval(fm.replyObligationTimer);
      fm.wakeCoordinator?.stop?.();
      fm.deliveryOutbox?.close?.();
    }
  });
});
