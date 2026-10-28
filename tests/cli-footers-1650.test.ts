/**
 * #1650 (baseline: the issue body): an instance in agent_mode: cli has no MCP server; the reply line the daemon adds
 * names the agend-agent commands (agent-cli-instructions.md) instead of MCP tools. #2785 (a): that line is now a
 * `reply required →` marker at the end of the meta row, present only when a reply is owed. The size check measures the
 * marker the receiver will get (its mode; the longer one before a broadcast knows its targets). The real envelope, the real Daemon's formatter, the real outbound handlers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crossInstanceReplyMarker, formatCrossInstanceInboundMessage, shellArg } from "../src/cross-instance-envelope.js";
import { execFileSync } from "node:child_process";
import { Daemon } from "../src/daemon.js";
import { outboundHandlers, setCrossInstanceRetryForTests } from "../src/outbound-handlers.js";

/** #2785 (a): an owed reply is a marker at the end of the meta row; no reply owed → no footer at all. */
const MCP_REQUIRED = "reply required → report_result cid-1";

describe("the cross-instance reply marker", () => {
  it("MCP mode (the default): report_result with the id, and nothing when no reply is owed", () => {
    expect([crossInstanceReplyMarker({ requires_reply: "true", correlation_id: "cid-1" }), crossInstanceReplyMarker({ correlation_id: "cid-1" }), crossInstanceReplyMarker({ requires_reply: "false", correlation_id: "cid-1" }, "mcp")])
      .toEqual([MCP_REQUIRED, "", ""]);
    expect(crossInstanceReplyMarker({ requires_reply: "true" })).toBe("reply required → send_to_instance");
    expect(formatCrossInstanceInboundMessage("hi", { from_instance: "lead", requires_reply: "true", correlation_id: "cid-1" }))
      .toBe("[from:lead] hi\n(" + MCP_REQUIRED + ")");
    expect(formatCrossInstanceInboundMessage("hi", { from_instance: "lead", correlation_id: "cid-1" })).toBe("[from:lead] hi\n(correlation_id: cid-1)");
  });
  it("CLI mode names the agend-agent command, with the sender and the correlation id filled in", () => {
    expect(crossInstanceReplyMarker({ from_instance: "lead", requires_reply: "true", correlation_id: "cid-7" }, "cli"))
      .toBe('reply required → agend-agent report lead "…" cid-7');
    expect(crossInstanceReplyMarker({ from_instance: "lead" }, "cli")).toBe("");
    const cli = formatCrossInstanceInboundMessage("hi", { from_instance: "lead", requires_reply: "true", correlation_id: "cid-7" }, "cli");
    expect([cli.includes("report_result"), cli.includes("send_to_instance"), cli.includes("agend-agent report lead")]).toEqual([false, false, true]);
  });
});

describe("the CLI marker's arguments survive a shell (#1653 review)", () => {
  /** What /bin/sh makes of a command line: its words, one per line. */
  const words = (cmdline: string) => {
    try { return execFileSync("/bin/sh", ["-c", `set -- ${cmdline}; printf '%s\\n' "$@"`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").slice(0, -1); }
    catch { return ["<the shell refused it>"]; }
  };
  it("shellArg keeps any value as one argument — spaces, $, backquotes, command substitution, quotes", () => {
    for (const v of ["cid-1", "review batch 7", "review-$task", "a'b", "$(printf INJECTED)", "`id`", "two  spaces", "q\"d", "it's \"x\""]) {
      expect(words(shellArg(v)), v).toEqual([v]);
    }
    expect([shellArg("cid-1791734461429-bnqfpp"), shellArg("lead")]).toEqual(["cid-1791734461429-bnqfpp", "lead"]);   // plain values read as before
  });
  it("the report command the marker suggests gives agend-agent the sender and the correlation id exactly", () => {
    for (const cid of ["review batch 7", "review-$task", "cid-control-1"]) {
      const marker = crossInstanceReplyMarker({ from_instance: "lead", requires_reply: "true", correlation_id: cid }, "cli");
      const cmd = /agend-agent report (.*)$/.exec(marker)![1]!;
      expect(words(cmd), cid).toEqual(["lead", "…", cid]);
    }
    // The sender too (an instance name is plain today; the marker does not rely on that).
    const odd = crossInstanceReplyMarker({ from_instance: "odd $name", requires_reply: "true", correlation_id: "c1" }, "cli");
    expect(words(/agend-agent report (.*)$/.exec(odd)![1]!)).toEqual(["odd $name", "…", "c1"]);
  });
});

describe("the real daemon's footer follows its agent_mode", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const daemon = (agentMode?: "cli" | "mcp") => {
    const dir = mkdtempSync(join(tmpdir(), "agend-1650-")); dirs.push(dir);
    return new Daemon("w", { working_directory: dir, restart_policy: { max_retries: 0, backoff: "linear", reset_after: 0 },
      context_guardian: { grace_period_ms: 600_000, max_age_hours: 0 }, log_level: "silent", ...(agentMode ? { agent_mode: agentMode } : {}) } as never,
      dir, true, undefined, undefined, pino({ level: "silent" }) as never) as any;
  };
  it("a user message: the reply tool in MCP mode, agend-agent reply in CLI mode", () => {
    const meta = { user: "alice", source: "telegram", user_id: "1" };
    expect(daemon()["formatInboundMessage"]("hi", meta)).toBe("[user:alice via telegram, id:1] hi\n(Reply using the reply tool — do NOT respond with direct text)");
    expect(daemon("mcp")["formatInboundMessage"]("hi", meta)).toBe("[user:alice via telegram, id:1] hi\n(Reply using the reply tool — do NOT respond with direct text)");
    expect(daemon("cli")["formatInboundMessage"]("hi", meta)).toBe('[user:alice via telegram, id:1] hi\n(Reply with agend-agent reply "…" — do NOT respond with direct text)');
  });
  it("a cross-instance message: the same marker as the envelope, in the daemon's own mode", () => {
    const meta = { from_instance: "lead", requires_reply: "true", correlation_id: "cid-1" };
    expect(daemon("cli")["formatInboundMessage"]("do x", meta)).toBe('[from:lead] do x\n(reply required → agend-agent report lead "…" cid-1)');
    expect(daemon()["formatInboundMessage"]("do x", meta)).toBe("[from:lead] do x\n(" + MCP_REQUIRED + ")");
    expect(daemon("cli")["formatInboundMessage"]("fyi", { from_instance: "lead", correlation_id: "cid-1" })).toBe("[from:lead] fyi\n(correlation_id: cid-1)");
  });
});

describe("the size check counts the marker the receiver will get", () => {
  beforeEach(() => setCrossInstanceRetryForTests({ retries: 2, intervalMs: 5 }));
  afterEach(() => setCrossInstanceRetryForTests(null));
  const ctx = (modes: Record<string, "cli" | undefined>) => ({
    fleetConfig: { defaults: { max_cross_instance_message_bytes: 20_000 }, instances: { sender: {}, ...Object.fromEntries(Object.entries(modes).map(([n, m]) => [n, m ? { agent_mode: m } : {}])) }, channel: undefined },
    adapter: null, logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    instanceIpcClients: new Map(Object.keys(modes).map(n => [n, { connected: true, send: vi.fn() }])),
    sessionRegistry: new Map(), lifecycle: { daemons: new Map(), isPaused: vi.fn(() => false) }, classicChannels: null,
    eventLog: { logActivity: vi.fn(), insert: vi.fn() }, deliverToInstance: vi.fn(() => new Promise<void>(() => {})),
    notifyInstanceTopic: vi.fn(), lastActivityMs: vi.fn(() => 0),
  } as any);
  const meta = { instanceName: "sender", requestId: 1 } as any;
  const send = async (c: any, target: string, summaryLen: number, tool = "send_to_instance") => {
    let error: string | undefined;
    // requires_reply: the marker — the only part that differs by mode — is there only when a reply is owed.
    const args = tool === "broadcast" ? { targets: [target], message: "small", task_summary: "x".repeat(summaryLen), requires_reply: true } : { instance_name: target, message: "small", task_summary: "x".repeat(summaryLen), requires_reply: true };
    await outboundHandlers.get(tool)!(c, args, (_r, e) => { error = e; }, meta);
    return error === undefined;
  };
  /** The longest task_summary an MCP target accepts. */
  async function mcpLimit(): Promise<number> {
    let lo = 0, hi = 20_000;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (await send(ctx({ t: undefined }), "t", mid)) lo = mid; else hi = mid - 1; }
    return lo;
  }
  it("what fits an MCP target is refused for a CLI target (its marker is longer), and a little less fits it", async () => {
    const limit = await mcpLimit();
    expect(await send(ctx({ t: undefined }), "t", limit)).toBe(true);
    expect(await send(ctx({ t: "cli" }), "t", limit)).toBe(false);
    expect(await send(ctx({ t: "cli" }), "t", limit - 64)).toBe(true);
  });
  it("a broadcast checks before it knows its targets: the longer marker counts", async () => {
    const limit = await mcpLimit();
    expect(await send(ctx({ t: undefined }), "t", limit, "broadcast")).toBe(false);
    expect(await send(ctx({ t: undefined }), "t", limit - 128, "broadcast")).toBe(true);
  });
});
