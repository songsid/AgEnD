import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Daemon,
  detectMalformedClaudeToolCall,
} from "../src/daemon.js";
import {
  InstanceLifecycle,
  type IncidentEventSource,
  type LifecycleContext,
} from "../src/instance-lifecycle.js";
import type { Logger } from "../src/logger.js";

const logger = pino({ level: "silent" }) as Logger;
const dirs: string[] = [];
const MARKER = "(Reply using the reply tool — do NOT respond with direct text)";
const MALFORMED_PANE = [
  "older output",
  MARKER,
  "<function_calls>",
  '<invoke name="reply">',
  '<parameter name="text">Recovered **answer** 🎉',
  "with a second line.</parameter>",
  "</invoke>",
  "</function_calls>",
  "❯",
].join("\n");

type AnyDaemon = Daemon & Record<string, any>;

function makeDaemon(backend = "claude-code") {
  const dir = mkdtempSync(join(tmpdir(), "agend-malformed-tool-"));
  dirs.push(dir);
  const daemon = new Daemon("worker", {
    backend,
    working_directory: dir,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
  } as any, dir, true, undefined, undefined, logger) as AnyDaemon;
  const broadcast = vi.fn();
  daemon.ipcServer = { broadcast, send: vi.fn() };
  daemon.lastChatId = "chat-1";
  daemon.lastThreadId = "thread-1";
  daemon.lastAdapterId = "discord-main";
  return { daemon, broadcast };
}

function idleSnapshot() {
  const now = Date.now();
  return { state: "idle", unchangedForMs: 0, observedAt: now, stateChangedAt: now } as any;
}

function recoveryCalls(broadcast: ReturnType<typeof vi.fn>) {
  return broadcast.mock.calls
    .map(call => call[0])
    .filter(message => String(message.fleetRequestId ?? "").startsWith("malformedreply_"));
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("detectMalformedClaudeToolCall", () => {
  it("extracts and sanitizes the text argument from a dangling XML tool call", () => {
    const detected = detectMalformedClaudeToolCall(MALFORMED_PANE, { inboundMarker: MARKER });

    expect(detected?.text).toBe("Recovered **answer** 🎉\nwith a second line.");
    expect(detected?.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detects closing-tag residue even when the opening text parameter scrolled away", () => {
    const detected = detectMalformedClaudeToolCall(`${MARKER}\nanswer tail\n</invoke>\n❯`, { inboundMarker: MARKER });

    expect(detected).not.toBeNull();
    expect(detected?.text).toBeNull();
  });

  it("ignores ordinary pane output without the specific Claude closing tags", () => {
    expect(detectMalformedClaudeToolCall(`${MARKER}\nNormal final answer.\n❯`, { inboundMarker: MARKER })).toBeNull();
  });

  it("redacts credentials from recovered text", () => {
    const pane = `${MARKER}\n<parameter name="text">Authorization: Bearer sk-TEST-SECRET</parameter>`;
    const detected = detectMalformedClaudeToolCall(pane, { inboundMarker: MARKER });

    expect(detected?.text).toContain("[REDACTED]");
    expect(detected?.text).not.toContain("sk-TEST-SECRET");
  });
});

describe("Claude malformed tool-call idle-edge recovery", () => {
  it("relays extracted reply text once and emits an operator audit event", () => {
    const { daemon, broadcast } = makeDaemon();
    const warning = vi.fn();
    daemon.on("malformed_tool_call", warning);
    daemon.markTurnStarted({ chat_id: "chat-1", correlation_id: "cid-648" }, MARKER);
    daemon.instanceState = "working";

    daemon.applyInstanceStateSnapshot(idleSnapshot(), MALFORMED_PANE);

    expect(recoveryCalls(broadcast)).toHaveLength(1);
    expect(recoveryCalls(broadcast)[0]).toMatchObject({
      tool: "reply",
      adapterId: "discord-main",
      args: {
        chat_id: "chat-1",
        thread_id: "thread-1",
        text: "Recovered **answer** 🎉\nwith a second line.",
      },
    });
    expect(warning).toHaveBeenCalledWith({ name: "worker", correlationId: "cid-648", recovered: true });
  });

  it("warns but does not send when no text parameter can be extracted", () => {
    const { daemon, broadcast } = makeDaemon();
    const warning = vi.fn();
    daemon.on("malformed_tool_call", warning);
    daemon.markTurnStarted({ chat_id: "chat-1" }, MARKER);
    daemon.instanceState = "working";

    daemon.applyInstanceStateSnapshot(idleSnapshot(), `${MARKER}\nanswer tail\n</function_calls>\n❯`);

    expect(recoveryCalls(broadcast)).toHaveLength(0);
    expect(warning).toHaveBeenCalledWith({ name: "worker", correlationId: undefined, recovered: false });
  });

  it("does not recover after a successful reply tool call", () => {
    const { daemon, broadcast } = makeDaemon();
    daemon.markTurnStarted({ chat_id: "chat-1" }, MARKER);
    daemon.handleToolCall({ tool: "reply", args: { text: "already sent" }, requestId: 7 }, {} as any);
    daemon.pendingIpcRequests.get("tool_1_7")!({ result: { messageId: "m1" } });
    daemon.instanceState = "working";

    daemon.applyInstanceStateSnapshot(idleSnapshot(), MALFORMED_PANE);

    expect(recoveryCalls(broadcast)).toHaveLength(0);
  });

  it("never runs for non-Claude backends", () => {
    const { daemon, broadcast } = makeDaemon("codex");
    daemon.markTurnStarted({ chat_id: "chat-1" }, MARKER);
    daemon.instanceState = "working";

    daemon.applyInstanceStateSnapshot(idleSnapshot(), MALFORMED_PANE);

    expect(recoveryCalls(broadcast)).toHaveLength(0);
  });

  it("does not recover the same stale pane fragment twice", () => {
    const { daemon, broadcast } = makeDaemon();
    for (let turn = 0; turn < 2; turn++) {
      daemon.markTurnStarted({ chat_id: "chat-1" }, MARKER);
      daemon.instanceState = "working";
      daemon.applyInstanceStateSnapshot(idleSnapshot(), MALFORMED_PANE);
    }

    expect(recoveryCalls(broadcast)).toHaveLength(1);
  });
});

describe("malformed tool-call lifecycle notification", () => {
  it("records the event and warns the operator topic", () => {
    const insert = vi.fn();
    const notifyInstanceTopic = vi.fn();
    const context = {
      fleetConfig: { defaults: {}, instances: { worker: { backend: "claude-code" } } },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      eventLog: { insert },
      isClassicInstance: () => false,
      isPlannedRestart: () => false,
      notifyInstanceTopic,
      webhookEmit() {},
      clearCancelButton() {},
      checkModelFailover() {},
      setTopicIcon() {},
      restartSingleInstance: async () => {},
    } as unknown as LifecycleContext;
    const lifecycle = new InstanceLifecycle(context);
    const source = Object.assign(new EventEmitter(), { requestPauseWhenIdle() {} }) as IncidentEventSource & EventEmitter;
    lifecycle.attachIncidentHandlers("worker", source);

    source.emit("malformed_tool_call", { name: "worker", correlationId: "cid-648", recovered: true });

    expect(insert).toHaveBeenCalledWith("worker", "malformed_tool_call", {
      correlationId: "cid-648",
      recovered: true,
    });
    expect(notifyInstanceTopic).toHaveBeenCalledWith("worker", expect.stringContaining("malformed Claude tool call"));
  });
});
