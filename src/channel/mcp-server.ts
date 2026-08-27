#!/usr/bin/env node
/**
 * MCP Tool Server for agend.
 *
 * Runs as a SEPARATE process (CLI's child via --mcp-config).
 * Communicates with the daemon through a Unix socket IPC connection.
 * Provides standard MCP tools (reply, send_to_instance, etc.) — no
 * CLI-specific channel protocol. Works with any MCP-compatible CLI.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { basename, dirname, join } from "node:path";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { IpcClient } from "./ipc-bridge.js";
import { TOOLS } from "./mcp-tools.js";
import { buildMcpCoreInstructions } from "../instructions.js";
import { reconnectDelayMs } from "./reconnect-backoff.js";
import { mcpTimeoutMs } from "./ipc-timeouts.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SOCKET_PATH = process.env.AGEND_SOCKET_PATH ?? "";

// Per-tool ceilings come from the shared table so they stay strictly above the
// daemon's own budget for the same tool — otherwise this timer pre-empts the
// daemon's specific error message with a generic one. See ipc-timeouts.ts.

// ---------------------------------------------------------------------------
// Safety nets
// ---------------------------------------------------------------------------

// Parent death detection: primary mechanism is process.ppid polling (see main).
// On macOS, libuv/kqueue does not reliably emit stdin 'end' when the parent
// dies — the broken pipe causes a CPU spin instead. ppid polling is the only
// cross-platform reliable method. stdin listeners are kept as a fast path
// for Linux (where epoll may correctly emit EOF).

const PARENT_PID = process.ppid;

function isOrphaned(): boolean {
  return process.ppid === 1 || process.ppid !== PARENT_PID;
}

process.on("unhandledRejection", (err) => {
  process.stderr.write(`agend: unhandled rejection: ${err}\n`);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`agend: uncaught exception: ${err}\n`);
});

// ---------------------------------------------------------------------------
// IPC client with request-response
// ---------------------------------------------------------------------------

let ipc: IpcClient | null = null;
let ipcConnected = false;
let requestCounter = 0;
let reconnecting = false;
let reconnectAttempts = 0;
// Reconnect forever with exponential backoff instead of giving up. There used to
// be a 20 × 3s = 60s budget, but a fleet restart routinely takes longer (measured
// 142s on a fleet with ~2k tasks), and an MCP server that exits cannot be
// respawned mid-session by its client — the agent silently loses every agend tool
// until the user restarts the CLI. Idle retries cost ~nothing (one unix-socket
// connect attempt), and isOrphaned() still terminates us when our CLI goes away,
// so there is no process leak.
const pendingRequests = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

function setupIpcListeners(client: IpcClient): void {
  client.on("message", (msg: Record<string, unknown>) => {
    // The daemon broadcasts this on ANY stop — including the stop half of a
    // restart. Exiting here was the main way a long-lived client lost its tools
    // permanently: the daemon returned a minute later, but this process was gone
    // and the MCP client cannot respawn a server mid-session. Stay alive and let
    // the ensuing disconnect drive the backoff loop; if the fleet is stopped for
    // good, our own CLI exiting makes isOrphaned() end us.
    if (msg.type === "shutdown") {
      process.stderr.write("agend: daemon shutting down — will reconnect when it returns\n");
      ipcConnected = false;
      return;
    }

    if (typeof msg.requestId === "number" && pendingRequests.has(msg.requestId)) {
      const pending = pendingRequests.get(msg.requestId)!;
      pendingRequests.delete(msg.requestId);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(String(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
    }
  });

  client.on("disconnect", () => {
    ipcConnected = false;
    process.stderr.write("agend: IPC disconnected — will reconnect\n");
    // Reject all pending requests
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("IPC disconnected"));
      pendingRequests.delete(id);
    }
    scheduleReconnect();
  });
}

async function connectIpc(): Promise<void> {
  try {
    const client = new IpcClient(SOCKET_PATH!);
    await client.connect();
    ipc = client;
    ipcConnected = true;
    reconnecting = false;
    reconnectAttempts = 0;
    setupIpcListeners(client);
    // AGEND_INSTANCE_NAME: set by daemon via tmux env (internal sessions)
    // AGEND_SESSION_NAME: set in .mcp.json env (external sessions, optional custom name)
    // Fallback: unique name from working directory + PID (avoids collision when
    // multiple Claude Code sessions work on the same project)
    const sessionName = process.env.AGEND_INSTANCE_NAME
      ?? process.env.AGEND_SESSION_NAME
      ?? `external-${basename(process.cwd())}-${process.pid}`;
    client.send({ type: "mcp_ready", sessionName });
    process.stderr.write("agend: connected to daemon IPC\n");
  } catch (err) {
    process.stderr.write(`agend: failed to connect to daemon IPC: ${err}\n`);
    ipcConnected = false;
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnecting) return;
  if (isOrphaned()) {
    process.stderr.write("agend: orphaned (parent died) during reconnect — exiting\n");
    process.exit(0);
  }
  reconnectAttempts++;
  reconnecting = true;
  // 1s, 2s, 4s … capped at 30s: fast for a blip, calm through a long restart.
  const delay = reconnectDelayMs(reconnectAttempts);
  process.stderr.write(`agend: reconnecting in ${delay}ms (attempt ${reconnectAttempts})...\n`);
  setTimeout(() => {
    reconnecting = false;
    connectIpc();
  }, delay);
}

function ipcRequest(
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!ipcConnected || !ipc) {
      reject(new Error("Not connected to daemon IPC (retrying connection in background)"));
      return;
    }

    const timeoutMs = mcpTimeoutMs(tool);
    const requestId = ++requestCounter;
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`IPC request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, reject, timer });

    try {
      if (!ipc.send({ type: "tool_call", tool, args, requestId })) {
        throw new Error("IPC socket closed before the tool call was written");
      }
    } catch (err) {
      pendingRequests.delete(requestId);
      clearTimeout(timer);
      ipcConnected = false;
      const failedClient = ipc;
      ipc = null;
      void failedClient.close();
      scheduleReconnect();
      reject(new Error(`IPC send failed: ${err}`));
    }
  });
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MCP instructions — thin wrapper around shared buildFleetInstructions().
// Phase 1 (dual track): MCP instructions kept as fallback for backends that
// read the MCP instructions field. Content delegates to the shared module
// to avoid drift between MCP and additive system prompt paths.
// ---------------------------------------------------------------------------

function buildMcpInstructions(): string {
  // Compact on purpose: Claude Code truncates MCP instructions around 2KB, so
  // this carries only the non-negotiable contract. The full guidance
  // (workflow, decisions, custom prompt) rides the additive system-prompt
  // path, which every backend has and nothing truncates.
  return buildMcpCoreInstructions({
    instanceName: process.env.AGEND_INSTANCE_NAME ?? "unknown",
    workingDirectory: process.env.AGEND_WORKING_DIR ?? process.cwd(),
    runtimeIdentity: {
      kind: process.env.AGEND_INSTANCE_KIND === "classic" ? "classic" : "fleet-topic",
      backend: process.env.AGEND_BACKEND ?? "unknown",
      model: process.env.AGEND_MODEL ?? "default",
    },
  });
}

const mcp = new Server(
  { name: "agend", version: "0.3.0" },
  {
    capabilities: {
      tools: {},
    },
    instructions: buildMcpInstructions(),
  },
);

// --- Tool definitions (see mcp-tools.ts) ---

import { TOOL_SETS } from "./mcp-tools.js";
export { TOOLS } from "./mcp-tools.js";

const toolSet = process.env.AGEND_TOOL_SET;
let activeTools: typeof TOOLS;
if (!toolSet || toolSet === "full") {
  activeTools = TOOLS;
} else if (TOOL_SETS[toolSet]) {
  activeTools = TOOLS.filter(t => TOOL_SETS[toolSet].includes(t.name));
} else {
  process.stderr.write(`agend: ERROR — unknown AGEND_TOOL_SET "${toolSet}", valid: ${Object.keys(TOOL_SETS).join(", ")}. Using "full".\n`);
  activeTools = TOOLS;
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: activeTools }));

// --- Tool call handler ---

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  try {
    const result = await ipcRequest(req.params.name, args);
    if (result === undefined) {
      throw new Error(`Daemon returned no result for ${req.params.name}`);
    }
    const text =
      typeof result === "string" ? result : JSON.stringify(result);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!SOCKET_PATH) {
    process.stderr.write("agend: AGEND_SOCKET_PATH environment variable is required\n");
    process.exit(1);
  }

  // Start MCP stdio transport FIRST — must be ready before the CLI sends
  // the initialize request. IPC connection can happen in parallel.
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  // Parent death detection.
  // Primary: ppid polling — works on all platforms, immune to libuv/kqueue bugs.
  // Secondary: stdin end/close/error — may fire faster on Linux (epoll handles
  // broken pipes correctly), but fails on macOS (libuv CPU spin, no EOF emit).
  // mcp.onclose only fires on explicit transport.close(), kept for completeness.
  mcp.onclose = () => {
    process.stderr.write("agend: MCP transport closed — exiting\n");
    process.exit(0);
  };
  process.stdin.on("end", () => {
    process.stderr.write("agend: stdin EOF (parent exited) — exiting\n");
    process.exit(0);
  });
  process.stdin.on("close", () => {
    process.stderr.write("agend: stdin closed (parent exited) — exiting\n");
    process.exit(0);
  });
  process.stdin.on("error", () => {
    process.stderr.write("agend: stdin error (parent exited) — exiting\n");
    process.exit(0);
  });

  // Primary orphan detection: poll parent PID every 5 seconds.
  setInterval(() => {
    if (isOrphaned()) {
      process.stderr.write("agend: parent process died (ppid changed) — exiting\n");
      process.exit(0);
    }
  }, 5_000);

  // Write PID file so daemon can kill orphan MCP servers on crash respawn.
  // Derived from AGEND_SOCKET_PATH (e.g. ~/.agend/instances/foo/channel.sock).
  const pidFile = join(dirname(SOCKET_PATH), "channel.mcp.pid");
  writeFileSync(pidFile, String(process.pid));
  process.on("exit", () => {
    try {
      if (readFileSync(pidFile, "utf-8").trim() === String(process.pid)) unlinkSync(pidFile);
    } catch { /* already cleaned up */ }
  });

  // Connect to daemon IPC (will auto-reconnect on disconnect)
  await connectIpc();

  // Immediate orphan check — don't let an orphan announce itself to the daemon
  if (isOrphaned()) {
    process.stderr.write("agend: orphaned before ready — exiting\n");
    process.exit(0);
  }

  process.stderr.write("agend: MCP server running\n");
}

main().catch((err) => {
  process.stderr.write(`agend: fatal error: ${err}\n`);
  process.exit(1);
});
