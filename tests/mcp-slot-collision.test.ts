import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Daemon } from "../src/daemon.js";
import { IpcServer } from "../src/channel/ipc-bridge.js";

/**
 * "MCP died" false alarm on a live instance (codex rd1-sd5-server, 2026-09-05).
 *
 * channel.mcp.pid is a SINGLE last-writer-wins slot, but an instance can have
 * several mcp-server processes at once: a CLI-driven replacement, a codex
 * multi_agent sub-agent's server, a Claude Code child session's server. Each
 * overwrites the slot at start and may only unlink it if the content is its
 * own pid. Kill the last writer (or let the CLI tear it down) and the slot
 * reads DEAD for as long as anything else lives — while a sibling keeps
 * serving every agend tool. The daemon then alarmed and, at the next idle
 * edge, restarted a healthy instance.
 *
 * The fix moves the authority to the IPC layer: every serving mcp-server holds
 * a connection to channel.sock and has announced our session in mcp_ready.
 * A live connection is proof of life; the pid slot is only the first opinion.
 * Re-verification is deterministic and LLM-free (socket ping/pong).
 */
let instanceDir: string;
const dirs: string[] = [];
const children: ChildProcess[] = [];
const servers: IpcServer[] = [];

beforeEach(() => {
  instanceDir = mkdtempSync(join(tmpdir(), "agend-mcpslot-"));
  dirs.push(instanceDir);
});
afterEach(async () => {
  for (const c of children.splice(0)) { try { c.kill("SIGKILL"); } catch { /* gone */ } }
  for (const s of servers.splice(0)) { try { await s.close(); } catch { /* closed */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

const PID_FILE = () => join(instanceDir, "channel.mcp.pid");
const DEAD_PID = 0x7ffffff0;
const LIVE_PID = process.pid;

function makeDaemon(backend = "codex") {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const daemon = new Daemon("img", {
    working_directory: "/tmp",
    backend,
    restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
    context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 },
    hang_detector: { enabled: false, timeout_minutes: 10, idle_debounce_ms: 10 },
    log_level: "silent",
  } as any, instanceDir, false, { getReadyPattern: () => /^> /m } as any, undefined,
    { child: () => logger } as any);
  const died: any[] = [];
  const restarts: any[] = [];
  const recovered: any[] = [];
  const sent: any[] = [];
  daemon.on("mcp_died", e => died.push(e));
  daemon.on("mcp_restart_requested", e => restarts.push(e));
  daemon.on("mcp_recovered", e => recovered.push(e));
  (daemon as any).ipcServer = {
    send: vi.fn((_sock: unknown, msg: unknown) => { sent.push(msg); return true; }),
    broadcast: vi.fn(),
  };
  return { daemon: daemon as any, died, restarts, recovered, sent, logger };
}

/** A fake IPC socket as the daemon sees it after mcp_ready. */
function fakeSocket() {
  return { destroyed: false, on: vi.fn(), destroy() { this.destroyed = true; } } as any;
}
function connect(daemon: any, sessionName: string, pid: number) {
  const sock = fakeSocket();
  daemon.handleMcpReady({ type: "mcp_ready", sessionName, pid }, sock);
  return sock;
}

const tick = (d: any) => d.checkMcpServerAlive();
const idleEdge = (d: any) =>
  d.applyInstanceStateSnapshot({ state: "idle", stateChangedAt: 0, unchangedForMs: 1000 });

describe("pid slot says dead while a live MCP connection serves this instance", () => {
  it("1. no alarm, no restart; the slot is repaired to the live pid and the server is pinged", () => {
    const { daemon, died, restarts, sent } = makeDaemon();
    connect(daemon, "img", LIVE_PID);               // sibling A, still serving
    writeFileSync(PID_FILE(), String(DEAD_PID));    // sibling B (last writer) was killed

    tick(daemon); tick(daemon); tick(daemon);       // several health ticks

    expect(died).toHaveLength(0);
    expect(restarts).toHaveLength(0);
    expect(daemon.mcpRestartPending).toBe(false);
    expect(readFileSync(PID_FILE(), "utf8")).toBe(String(LIVE_PID));
    const pings = sent.filter(m => m.type === "ping");
    expect(pings.length).toBeGreaterThan(0);
    expect(typeof pings[0].requestId).toBe("number");
    idleEdge(daemon);
    expect(restarts).toHaveLength(0);
  });

  it("2. the connection must belong to OUR session — an external session's socket is not proof of life", () => {
    const { daemon, died } = makeDaemon();
    connect(daemon, "external-other-4242", LIVE_PID);
    writeFileSync(PID_FILE(), String(DEAD_PID));

    tick(daemon);                                   // codex: one-tick hold
    expect(died).toHaveLength(0);
    tick(daemon);                                   // still dead, nothing of ours connected
    expect(died).toHaveLength(1);
    expect(readFileSync(PID_FILE(), "utf8")).toBe(String(DEAD_PID)); // never repaired from a foreign pid
  });

  it("3. a destroyed socket does not count: real death with zero live connections still alarms", () => {
    const { daemon, died } = makeDaemon();
    const sock = connect(daemon, "img", LIVE_PID);
    writeFileSync(PID_FILE(), String(DEAD_PID));
    sock.destroy();                                 // the peer went away, close event pending

    tick(daemon); tick(daemon);
    expect(died).toHaveLength(1);
  });

  it("4. non-codex backends alarm on the first tick when nothing is connected, exactly as before", () => {
    const { daemon, died } = makeDaemon("claude-code");
    writeFileSync(PID_FILE(), String(DEAD_PID));
    tick(daemon);
    expect(died).toHaveLength(1);
  });

  it("5. no pong within 2s only warns — the open connection is the decision, no alarm", () => {
    vi.useFakeTimers();
    const { daemon, died, logger } = makeDaemon();
    connect(daemon, "img", LIVE_PID);
    writeFileSync(PID_FILE(), String(DEAD_PID));
    tick(daemon);
    vi.advanceTimersByTime(2_500);
    expect(died).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/did not answer ping/));
  });

  it("6. a pong settles the waiter and records the pid", () => {
    vi.useFakeTimers();
    const { daemon, sent, logger } = makeDaemon();
    const sock = connect(daemon, "img", LIVE_PID);
    writeFileSync(PID_FILE(), String(DEAD_PID));
    tick(daemon);
    const ping = sent.find(m => m.type === "ping");
    daemon.handleMcpPong({ type: "pong", requestId: ping.requestId, pid: 4242 }, sock);
    vi.advanceTimersByTime(2_500);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/did not answer ping/));
    expect(daemon.socketPids.get(sock)).toBe(4242);
    expect(daemon.mcpPingWaiters.size).toBe(0);
  });
});

describe("recovery after an alarm already went out", () => {
  it("7. our mcp_ready after an alarm retracts it once, repairs the slot and stands down the restart", () => {
    const { daemon, died, restarts, recovered } = makeDaemon();
    writeFileSync(PID_FILE(), String(DEAD_PID));
    tick(daemon); tick(daemon);
    expect(died).toHaveLength(1);
    expect(daemon.mcpRestartPending).toBe(true);

    connect(daemon, "img", LIVE_PID);               // a server for us (re)connects
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ name: "img", source: "mcp_ready", pid: LIVE_PID });
    expect(daemon.mcpRestartPending).toBe(false);
    expect(readFileSync(PID_FILE(), "utf8")).toBe(String(LIVE_PID));

    idleEdge(daemon);
    expect(restarts).toHaveLength(0);
    tick(daemon);                                   // slot is live now: quiet
    expect(recovered).toHaveLength(1);
    expect(died).toHaveLength(1);
  });

  it("8. a tool_call from our connected server is proof of life and retracts the alarm", () => {
    const { daemon, died, recovered } = makeDaemon();
    const sock = connect(daemon, "img", LIVE_PID);
    // The connection is dropped from bookkeeping (as if pid-only logic never
    // saw it), the alarm fires, then a tool call arrives on a live socket.
    daemon.socketSessionNames.delete(sock);
    writeFileSync(PID_FILE(), String(DEAD_PID));
    tick(daemon); tick(daemon);
    expect(died).toHaveLength(1);

    daemon.socketSessionNames.set(sock, "img");
    daemon.handleToolCall({ type: "tool_call", tool: "reply", requestId: "r1", args: {} }, sock);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].source).toBe("tool_call");
    expect(daemon.mcpRestartPending).toBe(false);
  });

  it("9. an external session's tool_call is NOT proof of our life", () => {
    const { daemon, died, recovered } = makeDaemon();
    const sock = connect(daemon, "external-other-1", LIVE_PID);
    writeFileSync(PID_FILE(), String(DEAD_PID));
    tick(daemon); tick(daemon);
    expect(died).toHaveLength(1);
    daemon.handleToolCall({ type: "tool_call", tool: "reply", requestId: "r1", args: {} }, sock);
    expect(recovered).toHaveLength(0);
    expect(daemon.mcpRestartPending).toBe(true);
  });

  it("10. pid slot coming back alive after an alarm also retracts it", () => {
    const { daemon, died, recovered } = makeDaemon();
    writeFileSync(PID_FILE(), String(DEAD_PID));
    tick(daemon); tick(daemon);
    expect(died).toHaveLength(1);
    writeFileSync(PID_FILE(), String(LIVE_PID));
    tick(daemon);
    expect(recovered).toHaveLength(1);
    expect(recovered[0].source).toBe("pid");
    tick(daemon);
    expect(recovered).toHaveLength(1);              // once
  });

  it("11. no alarm, no retraction: proof of life with nothing pending is silent", () => {
    const { daemon, recovered } = makeDaemon();
    writeFileSync(PID_FILE(), String(LIVE_PID));
    connect(daemon, "img", LIVE_PID);
    tick(daemon);
    expect(recovered).toHaveLength(0);
  });
});

describe("the restart chokepoint and the deferred report consult the IPC layer too", () => {
  it("12. a restart armed while nothing was connected stands down at the idle edge once a connection exists", () => {
    const { daemon, died, restarts } = makeDaemon();
    writeFileSync(PID_FILE(), String(DEAD_PID));
    tick(daemon);                                   // codex hold, revival armed
    expect(daemon.mcpRestartPending).toBe(true);
    expect(died).toHaveLength(0);

    // The connection appears without going through handleMcpReady's stand-down
    // (bookkeeping only), so the chokepoint's own re-verify is what is tested.
    const sock = fakeSocket();
    daemon.socketSessionNames.set(sock, "img");
    idleEdge(daemon);
    expect(daemon.mcpRestartPending).toBe(false);
    expect(restarts).toHaveLength(0);
  });

  it("13. the grace window re-verifies at the IPC layer", () => {
    vi.useFakeTimers();
    const { daemon, restarts } = makeDaemon();
    writeFileSync(PID_FILE(), String(DEAD_PID));
    tick(daemon);
    daemon.instanceState = "busy";
    idleEdge(daemon);                               // opens the grace window
    const sock = fakeSocket();
    daemon.socketSessionNames.set(sock, "img");     // connection lands inside the grace
    vi.advanceTimersByTime(Daemon.MCP_REPLACEMENT_GRACE_MS + 50);
    expect(restarts).toHaveLength(0);
    expect(daemon.mcpRestartPending).toBe(false);
  });

  it("14. the deferred death report is dropped when a connection is live", () => {
    const { daemon, died } = makeDaemon();
    writeFileSync(PID_FILE(), String(DEAD_PID));
    tick(daemon);                                   // hold → mcpDeathDeferredForPid set
    expect(daemon.mcpDeathDeferredForPid).toBe(DEAD_PID);
    const sock = fakeSocket();
    daemon.socketSessionNames.set(sock, "img");
    daemon.reportDeferredMcpDeath();
    expect(died).toHaveLength(0);
    expect(daemon.mcpDeathDeferredForPid).toBeNull();
  });

  it("15. ...and still reported when nothing is connected", () => {
    const { daemon, died } = makeDaemon();
    writeFileSync(PID_FILE(), String(DEAD_PID));
    tick(daemon);
    daemon.reportDeferredMcpDeath();
    expect(died).toHaveLength(1);
  });
});

/**
 * sol M1: the last writer exiting CLEANLY unlinks its own slot (guarded exit
 * handler), so the slot goes MISSING while a sibling still serves. Missing
 * must go through the same IPC reconciliation as dead — otherwise the slot is
 * never repaired and the survivor's later real death is invisible forever.
 */
describe("missing pid slot with a live sibling (clean exit of the last writer)", () => {
  /** A real process we can kill, so the repaired slot can later turn dead for real. */
  const spawnSleeper = async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    await new Promise(r => setTimeout(r, 50));
    return child;
  };

  it("17. missing slot + live same-session socket: repaired, pinged, no alarm; then the survivor really dies → alarm", async () => {
    const { daemon, died, sent } = makeDaemon();
    const survivor = await spawnSleeper();
    const sock = connect(daemon, "img", survivor.pid!);
    expect(existsSync(PID_FILE())).toBe(false);     // B exited cleanly and unlinked

    tick(daemon); tick(daemon);
    expect(died).toHaveLength(0);
    expect(readFileSync(PID_FILE(), "utf8")).toBe(String(survivor.pid));
    expect(sent.some(m => m.type === "ping")).toBe(true);

    survivor.kill("SIGKILL");
    await new Promise<void>(r => survivor.on("exit", () => r()));
    sock.destroy();                                 // its IPC connection is gone too
    tick(daemon); tick(daemon);                     // codex hold, then alarm
    expect(died).toHaveLength(1);
    expect(died[0].pid).toBe(survivor.pid);
  });

  it("18. missing slot + no connection stays silent (never started / nothing to watch), as before", () => {
    const { daemon, died, sent } = makeDaemon("claude-code");
    tick(daemon); tick(daemon);
    expect(died).toHaveLength(0);
    expect(daemon.mcpRestartPending).toBe(false);
    expect(sent).toHaveLength(0);
    expect(existsSync(PID_FILE())).toBe(false);
  });

  it("19. missing slot + only an external session's socket stays silent and is not repaired from it", () => {
    const { daemon, died } = makeDaemon("claude-code");
    connect(daemon, "external-other-1", LIVE_PID);
    tick(daemon); tick(daemon);
    expect(died).toHaveLength(0);
    expect(existsSync(PID_FILE())).toBe(false);
  });
});

/**
 * The reproduction with real processes: two real mcp-server processes for one
 * instance dir sharing one pid slot, connected to a real IpcServer that feeds
 * the daemon's handlers. Kill the last writer with SIGKILL (no unlink, no
 * cleanup) — the slot reads dead, the sibling keeps serving, the daemon must
 * not alarm; and the sibling must answer the socket-layer ping.
 */
describe("real mcp-server processes (integration)", () => {
  const spawnMcp = (sockPath: string) => {
    const child = spawn(process.execPath, ["dist/channel/mcp-server.js"], {
      env: { ...process.env, AGEND_SOCKET_PATH: sockPath, AGEND_INSTANCE_NAME: "img" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    return child;
  };
  const until = async (pred: () => boolean, ms = 5_000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error("timeout");
      await new Promise(r => setTimeout(r, 50));
    }
  };

  it("16. SIGKILL of the slot owner: dead slot, live sibling, no alarm, pong received, slot repaired", async () => {
    // Unix socket paths are capped at ~107 bytes; use a short dir.
    const shortDir = mkdtempSync("/tmp/agend-mcp-");
    dirs.push(shortDir);
    instanceDir = shortDir;
    const { daemon, died, restarts, logger } = makeDaemon();
    const sockPath = join(shortDir, "channel.sock");
    const server = new IpcServer(sockPath);
    servers.push(server);
    await server.listen();
    daemon.ipcServer = server;
    server.on("message", (msg: Record<string, unknown>, socket: any) => {
      if (msg.type === "mcp_ready") daemon.handleMcpReady(msg, socket);
      else if (msg.type === "pong") daemon.handleMcpPong(msg, socket);
    });

    const a = spawnMcp(sockPath);
    await until(() => daemon.liveMcpSockets().length === 1);
    const b = spawnMcp(sockPath);
    await until(() => daemon.liveMcpSockets().length === 2);
    await until(() => readFileSync(PID_FILE(), "utf8").trim() === String(b.pid));

    b.kill("SIGKILL");
    await new Promise<void>(r => b.on("exit", () => r()));
    await until(() => daemon.liveMcpSockets().length === 1);
    expect(readFileSync(PID_FILE(), "utf8").trim()).toBe(String(b.pid)); // the contradiction

    tick(daemon); tick(daemon); tick(daemon);
    expect(died).toHaveLength(0);
    expect(restarts).toHaveLength(0);
    expect(daemon.mcpRestartPending).toBe(false);
    expect(readFileSync(PID_FILE(), "utf8").trim()).toBe(String(a.pid)); // repaired to the survivor
    await until(() => daemon.mcpPingWaiters.size === 0);                  // pongs arrived
    expect(logger.warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/did not answer ping/));

    // Now the survivor really dies: zero connections → this IS a death.
    a.kill("SIGKILL");
    await until(() => daemon.liveMcpSockets().length === 0);
    tick(daemon); tick(daemon);
    expect(died).toHaveLength(1);
  }, 30_000);

  it("20. clean exit of the slot owner (stdin EOF → unlink): missing slot, live sibling, repaired; survivor's real death still alarms", async () => {
    const shortDir = mkdtempSync("/tmp/agend-mcp-");
    dirs.push(shortDir);
    instanceDir = shortDir;
    const { daemon, died, restarts } = makeDaemon();
    const sockPath = join(shortDir, "channel.sock");
    const server = new IpcServer(sockPath);
    servers.push(server);
    await server.listen();
    daemon.ipcServer = server;
    server.on("message", (msg: Record<string, unknown>, socket: any) => {
      if (msg.type === "mcp_ready") daemon.handleMcpReady(msg, socket);
      else if (msg.type === "pong") daemon.handleMcpPong(msg, socket);
    });

    const a = spawnMcp(sockPath);
    await until(() => daemon.liveMcpSockets().length === 1);
    const b = spawnMcp(sockPath);
    await until(() => daemon.liveMcpSockets().length === 2);
    await until(() => readFileSync(PID_FILE(), "utf8").trim() === String(b.pid));

    b.stdin.end();                                  // the CLI closes B's pipe: clean exit path
    await new Promise<void>(r => b.on("exit", () => r()));
    await until(() => daemon.liveMcpSockets().length === 1);
    await until(() => !existsSync(PID_FILE()));     // B unlinked its own slot → MISSING

    tick(daemon); tick(daemon);
    expect(died).toHaveLength(0);
    expect(restarts).toHaveLength(0);
    expect(readFileSync(PID_FILE(), "utf8").trim()).toBe(String(a.pid)); // repaired to the survivor

    a.kill("SIGKILL");
    await until(() => daemon.liveMcpSockets().length === 0);
    tick(daemon); tick(daemon);
    expect(died).toHaveLength(1);                   // the survivor's real death is visible again
    expect(died[0].pid).toBe(a.pid);
  }, 30_000);
});
