import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import pino from "pino";
import { describe, expect, it, afterEach, vi } from "vitest";
import { Daemon, extractProxyReplyText } from "../src/daemon.js";
import { InstanceLifecycle, type LifecycleContext, type IncidentEventSource } from "../src/instance-lifecycle.js";
import type { Logger } from "../src/logger.js";
import { mcpServerState } from "../src/mcp-liveness.js";

/**
 * Dead-MCP proxy reply (codex reply-drift, part 3 of 3).
 *
 * With the MCP server dead, the agent finishes its turn but the reply tool is
 * gone — the answer exists only on screen and the channel hears nothing. At the
 * idle edge that ends such a turn, the daemon (whose IPC route to the fleet
 * manager does not pass through the dead MCP server) relays the pane's final
 * text itself, marked ⚠️ as a proxy reply. The trigger is deterministic: MCP
 * verifiably dead AND an inbound started the turn AND no channel tool succeeded
 * during it AND the pane holds non-trivial text.
 */

vi.mock("../src/mcp-liveness.js", () => ({
  mcpServerState: vi.fn(() => ({ state: "unknown" })),
}));
const liveness = vi.mocked(mcpServerState);

const rootLogger = pino({ level: "silent" }) as Logger;

type AnyDaemon = Daemon & Record<string, any>;

function makeDaemon(overrides: Record<string, unknown> = {}): { daemon: AnyDaemon; dir: string; broadcast: ReturnType<typeof vi.fn> } {
  const dir = mkdtempSync(join(tmpdir(), "agend-proxy-reply-"));
  const daemon = new Daemon("proxy-test", {
    working_directory: dir,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    log_level: "silent",
    mcp_proxy_reply: true, // the feature is opt-in; behavior tests opt in explicitly
    ...overrides,
  } as any, dir, true, undefined, undefined, rootLogger) as AnyDaemon;
  const broadcast = vi.fn();
  daemon.ipcServer = { broadcast, send: vi.fn() };
  daemon.lastChatId = "chat-1";
  daemon.lastThreadId = "thread-9";
  daemon.lastAdapterId = "discord-main";
  return { daemon, dir, broadcast };
}

function idleSnapshot() {
  const now = Date.now();
  return { state: "idle", unchangedForMs: 0, observedAt: now, stateChangedAt: now } as any;
}

const INBOUND_MARKER = "(Reply using the reply tool — do NOT respond with direct text)";
const INBOUND = `[user:han via discord, id:123] status?\n${INBOUND_MARKER}`;
const PANE = [
  "some earlier scrollback",
  "[user:han via discord, id:123] status?",
  INBOUND_MARKER,
  "",
  "⏺ All tests pass and PR #42 is ready for review.",
  "I could not reply because my tools are unavailable.",
  "──────────────────────────────",
  "❯",
  "",
].join("\n");

/** Extract the proxy broadcasts (ignore any other fleet_outbound traffic). */
function proxyCalls(broadcast: ReturnType<typeof vi.fn>) {
  return broadcast.mock.calls
    .map(c => c[0])
    .filter((m: any) => m.type === "fleet_outbound" && String(m.fleetRequestId).startsWith("proxyreply_"));
}

// ── extractProxyReplyText: pane → relayable answer ──────────────────────────

describe("extractProxyReplyText", () => {
  it("cuts at the inbound marker and drops chrome, keeping only the agent's answer", () => {
    const text = extractProxyReplyText(PANE, { inboundMarker: INBOUND_MARKER });
    expect(text).toBe("⏺ All tests pass and PR #42 is ready for review.\nI could not reply because my tools are unavailable.");
  });

  it("returns null when nothing but prompt, separators and dots remain", () => {
    const pane = ["msg tail", INBOUND_MARKER, "", "────", "❯", ". .", ""].join("\n");
    expect(extractProxyReplyText(pane, { inboundMarker: INBOUND_MARKER })).toBeNull();
  });

  it("drops the ready-prompt line by pattern, not just bare symbols", () => {
    const pane = [INBOUND_MARKER, "The answer is 42.", "agend v2 ❯ ready"].join("\n");
    const text = extractProxyReplyText(pane, { inboundMarker: INBOUND_MARKER, readyPattern: /❯ ready/ });
    expect(text).toBe("The answer is 42.");
  });

  it("ignores a marker too short to be distinctive instead of slicing at a false match", () => {
    const pane = ["ok, here is the answer", "final line"].join("\n");
    expect(extractProxyReplyText(pane, { inboundMarker: "ok" })).toContain("here is the answer");
  });

  it("redacts secrets the same way stuck diagnostics do", () => {
    const pane = [INBOUND_MARKER, "Deployed. Authorization: Bearer sk-FAKE-TOKEN-FOR-TEST used for the call."].join("\n");
    const text = extractProxyReplyText(pane, { inboundMarker: INBOUND_MARKER });
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("sk-FAKE-TOKEN-FOR-TEST");
  });

  it("keeps the tail when over the size budget — the end of the turn is the answer", () => {
    const pane = Array.from({ length: 30 }, (_, i) => `line ${i} of a very long answer body`).join("\n");
    const text = extractProxyReplyText(pane, { maxChars: 120 });
    expect(text!.length).toBeLessThanOrEqual(120);
    expect(text).toContain("line 29");
    expect(text).not.toContain("line 0 ");
  });
});

// ── daemon: idle edge → proxy reply, under the exact trigger conditions ─────

describe("daemon: dead MCP at turn end with no reply → proxy reply", () => {
  let dir: string;
  afterEach(() => {
    liveness.mockReset();
    liveness.mockReturnValue({ state: "unknown" } as any);
    rmSync(dir, { recursive: true, force: true });
  });

  it("relays the pane text via fleet_outbound reply, with ⚠️ marker, correlation id and the daemon's chat context", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon, broadcast } = made;
    liveness.mockReturnValue({ state: "dead", pid: 1 } as any);
    const proxied = vi.fn();
    daemon.on("mcp_proxy_reply", proxied);
    daemon.markTurnStarted({ chat_id: "chat-1", correlation_id: "cid-42" }, INBOUND);
    daemon.instanceState = "working";

    daemon.applyInstanceStateSnapshot(idleSnapshot(), PANE);

    const calls = proxyCalls(broadcast);
    expect(calls).toHaveLength(1);
    const msg = calls[0];
    expect(msg.tool).toBe("reply");
    expect(msg.adapterId).toBe("discord-main");
    expect(msg.args.chat_id).toBe("chat-1");
    expect(msg.args.thread_id).toBe("thread-9");
    expect(msg.args.text).toMatch(/^⚠️ \[MCP unavailable — proxy reply\]\n\n/);
    expect(msg.args.text).toContain("PR #42 is ready for review");
    expect(msg.args.text).toContain("(correlation_id: cid-42)");
    // The inbound echo was cut — only the agent's own output is relayed.
    expect(msg.args.text).not.toContain("[user:han");
    expect(proxied).toHaveBeenCalledWith({ name: "proxy-test", correlationId: "cid-42" });
  });

  it("fires at most once per turn — a second idle edge without a new inbound stays silent", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon, broadcast } = made;
    liveness.mockReturnValue({ state: "dead", pid: 1 } as any);
    daemon.markTurnStarted({ chat_id: "chat-1" }, INBOUND);
    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idleSnapshot(), PANE);
    expect(proxyCalls(broadcast)).toHaveLength(1);

    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idleSnapshot(), PANE);
    expect(proxyCalls(broadcast)).toHaveLength(1);
  });

  it("a successful reply during the turn stands the proxy down — the agent spoke for itself", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon, broadcast } = made;
    liveness.mockReturnValue({ state: "dead", pid: 1 } as any);
    daemon.markTurnStarted({ chat_id: "chat-1" }, INBOUND);

    // Agent's reply goes out through handleToolCall and the fleet responds OK.
    daemon.handleToolCall({ tool: "reply", args: { text: "done" }, requestId: 7 }, {} as any);
    daemon.pendingIpcRequests.get("tool_1_7")!({ result: { messageId: "m1" } });

    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idleSnapshot(), PANE);
    expect(proxyCalls(broadcast)).toHaveLength(0);
  });

  it("a FAILED reply does not stand it down — only verified delivery counts", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon, broadcast } = made;
    liveness.mockReturnValue({ state: "dead", pid: 1 } as any);
    daemon.markTurnStarted({ chat_id: "chat-1" }, INBOUND);

    daemon.handleToolCall({ tool: "reply", args: { text: "done" }, requestId: 8 }, {} as any);
    daemon.pendingIpcRequests.get("tool_1_8")!({ result: null, error: "adapter send failed" });

    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idleSnapshot(), PANE);
    expect(proxyCalls(broadcast)).toHaveLength(1);
  });

  it("MCP alive: never triggers", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon, broadcast } = made;
    liveness.mockReturnValue({ state: "alive", pid: 1 } as any);
    daemon.markTurnStarted({ chat_id: "chat-1" }, INBOUND);
    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idleSnapshot(), PANE);
    expect(proxyCalls(broadcast)).toHaveLength(0);
  });

  it("MCP unknown (not started / clean exit): never triggers", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon, broadcast } = made;
    liveness.mockReturnValue({ state: "unknown" } as any);
    daemon.markTurnStarted({ chat_id: "chat-1" }, INBOUND);
    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idleSnapshot(), PANE);
    expect(proxyCalls(broadcast)).toHaveLength(0);
  });

  it("a turn with no inbound message has nothing to reply to", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon, broadcast } = made;
    liveness.mockReturnValue({ state: "dead", pid: 1 } as any);
    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idleSnapshot(), PANE);
    expect(proxyCalls(broadcast)).toHaveLength(0);
  });

  it("a trivial pane (prompt and chrome only) is not relayed", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon, broadcast } = made;
    liveness.mockReturnValue({ state: "dead", pid: 1 } as any);
    const proxied = vi.fn();
    daemon.on("mcp_proxy_reply", proxied);
    daemon.markTurnStarted({ chat_id: "chat-1" }, INBOUND);
    daemon.instanceState = "working";
    const trivialPane = ["[user:han via discord, id:123] status?", INBOUND_MARKER, "", "❯", ""].join("\n");

    daemon.applyInstanceStateSnapshot(idleSnapshot(), trivialPane);

    expect(proxyCalls(broadcast)).toHaveLength(0);
    expect(proxied).not.toHaveBeenCalled();
  });

  it("is OFF by default — raw pane text can carry secrets past the regex redaction", () => {
    const made = makeDaemon({ mcp_proxy_reply: undefined }); dir = made.dir;
    const { daemon, broadcast } = made;
    liveness.mockReturnValue({ state: "dead", pid: 1 } as any);
    daemon.markTurnStarted({ chat_id: "chat-1" }, INBOUND);
    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idleSnapshot(), PANE);
    expect(proxyCalls(broadcast)).toHaveLength(0);
  });

  it("mcp_proxy_reply: false stays off", () => {
    const made = makeDaemon({ mcp_proxy_reply: false }); dir = made.dir;
    const { daemon, broadcast } = made;
    liveness.mockReturnValue({ state: "dead", pid: 1 } as any);
    daemon.markTurnStarted({ chat_id: "chat-1" }, INBOUND);
    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idleSnapshot(), PANE);
    expect(proxyCalls(broadcast)).toHaveLength(0);
  });

  it("a cross-instance turn (from_instance) never arms the proxy — its reply would land in the wrong topic", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon, broadcast } = made;
    liveness.mockReturnValue({ state: "dead", pid: 1 } as any);
    daemon.markTurnStarted({ from_instance: "agend-leader", chat_id: "", correlation_id: "cid-task" }, INBOUND);
    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idleSnapshot(), PANE);
    expect(proxyCalls(broadcast)).toHaveLength(0);
  });

  it("an inbound without a chat_id (schedule/unknown source) never arms the proxy either", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon, broadcast } = made;
    liveness.mockReturnValue({ state: "dead", pid: 1 } as any);
    daemon.markTurnStarted({}, INBOUND);
    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idleSnapshot(), PANE);
    expect(proxyCalls(broadcast)).toHaveLength(0);
  });

  it("the proxy reply goes out BEFORE the #485 revival restart request tears the pane down", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon, broadcast } = made;
    liveness.mockReturnValue({ state: "dead", pid: 1 } as any);
    const order: string[] = [];
    broadcast.mockImplementation((m: any) => {
      if (String(m.fleetRequestId ?? "").startsWith("proxyreply_")) order.push("proxy");
    });
    daemon.on("mcp_restart_requested", () => order.push("restart"));

    daemon.instanceState = "working";
    daemon.checkMcpServerAlive(); // arms the idle-gated revival restart (#485)
    daemon.markTurnStarted({ chat_id: "chat-1", correlation_id: "cid-9" }, INBOUND);
    daemon.applyInstanceStateSnapshot(idleSnapshot(), PANE);

    expect(order).toEqual(["proxy", "restart"]);
  });

  it("a new inbound starts a clean slate — the previous turn's reply does not mute the next turn's proxy", () => {
    const made = makeDaemon(); dir = made.dir;
    const { daemon, broadcast } = made;
    liveness.mockReturnValue({ state: "dead", pid: 1 } as any);

    // Turn 1: agent replied.
    daemon.markTurnStarted({ chat_id: "chat-1" }, INBOUND);
    daemon.handleToolCall({ tool: "reply", args: { text: "done" }, requestId: 9 }, {} as any);
    daemon.pendingIpcRequests.get("tool_1_9")!({ result: { messageId: "m1" } });
    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idleSnapshot(), PANE);
    expect(proxyCalls(broadcast)).toHaveLength(0);

    // Turn 2: new inbound, no reply.
    daemon.markTurnStarted({ chat_id: "chat-1" }, INBOUND);
    daemon.instanceState = "working";
    daemon.applyInstanceStateSnapshot(idleSnapshot(), PANE);
    expect(proxyCalls(broadcast)).toHaveLength(1);
  });
});

// ── lifecycle: audit trail ───────────────────────────────────────────────────

describe("lifecycle: mcp_proxy_reply is recorded in the event log", () => {
  it("inserts an event with the correlation id", () => {
    const insert = vi.fn();
    const ctx = {
      fleetConfig: { instances: { worker: { backend: "codex" } }, defaults: {} },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      eventLog: { insert },
      isPlannedRestart: () => false,
      notifyInstanceTopic() {},
      webhookEmit() {},
      clearCancelButton() {},
      checkModelFailover() {},
      setTopicIcon() {},
      restartSingleInstance: async () => {},
    } as unknown as LifecycleContext;
    const lifecycle = new InstanceLifecycle(ctx);
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle() {} }) as unknown as IncidentEventSource & EventEmitter;
    lifecycle.attachIncidentHandlers("worker", daemon);

    daemon.emit("mcp_proxy_reply", { name: "worker", correlationId: "cid-7" });

    expect(insert).toHaveBeenCalledWith("worker", "mcp_proxy_reply", { correlationId: "cid-7" });
  });
});
