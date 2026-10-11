/**
 * #1650 (baseline: the issue body): an instance in agent_mode: cli has no MCP server; the footers the daemon adds to
 * every message name the agend-agent commands (agent-cli-instructions.md) instead of MCP tools. MCP mode is unchanged
 * byte for byte. The size check measures the footer the receiver will get (its mode; the longer one before a broadcast
 * knows its targets). The real envelope, the real Daemon's formatter, the real outbound handlers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { crossInstanceReplyFooter, formatCrossInstanceInboundMessage, shellArg } from "../src/cross-instance-envelope.js";
import { execFileSync } from "node:child_process";
import { Daemon } from "../src/daemon.js";
import { outboundHandlers, setCrossInstanceRetryForTests } from "../src/outbound-handlers.js";

const MCP_REQUIRED = "\n(A reply IS required: use report_result with the correlation_id above — or send_to_instance. Not direct text.)";
const MCP_OPTIONAL = "\n(If you need to reply, use send_to_instance tool, NOT direct text. If there is nothing to add, you may stay silent.)";

describe("the cross-instance footer", () => {
  it("MCP mode is exactly what it was (the default)", () => {
    expect([crossInstanceReplyFooter({ requires_reply: "true" }), crossInstanceReplyFooter({}), crossInstanceReplyFooter({}, "mcp")]).toEqual([MCP_REQUIRED, MCP_OPTIONAL, MCP_OPTIONAL]);
    expect(formatCrossInstanceInboundMessage("hi", { from_instance: "lead", requires_reply: "true", correlation_id: "cid-1" }))
      .toBe("[from:lead] hi\n(correlation_id: cid-1)" + MCP_REQUIRED);
  });
  it("CLI mode names the agend-agent commands, with the sender and the correlation id filled in", () => {
    expect(crossInstanceReplyFooter({ from_instance: "lead", requires_reply: "true", correlation_id: "cid-7" }, "cli"))
      .toBe('\n(A reply IS required: agend-agent report lead "…" cid-7 — or agend-agent send lead "…". Not direct text.)');
    expect(crossInstanceReplyFooter({ from_instance: "lead" }, "cli"))
      .toBe('\n(If you need to reply, use agend-agent send lead "…", NOT direct text. If there is nothing to add, you may stay silent.)');
    const cli = formatCrossInstanceInboundMessage("hi", { from_instance: "lead", requires_reply: "true", correlation_id: "cid-7" }, "cli");
    expect([cli.includes("report_result"), cli.includes("send_to_instance"), cli.includes("agend-agent report lead")]).toEqual([false, false, true]);
  });
});

describe("the CLI footer's arguments survive a shell (#1653 review)", () => {
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
  it("the report command the footer suggests gives agend-agent the sender and the correlation id exactly", () => {
    for (const cid of ["review batch 7", "review-$task", "cid-control-1"]) {
      const footer = crossInstanceReplyFooter({ from_instance: "lead", requires_reply: "true", correlation_id: cid }, "cli");
      const cmd = /agend-agent report (.*) — or/.exec(footer)![1]!;
      expect(words(cmd), cid).toEqual(["lead", "…", cid]);
    }
    // The sender too (an instance name is plain today; the footer does not rely on that).
    const odd = crossInstanceReplyFooter({ from_instance: "odd $name", requires_reply: "true", correlation_id: "c1" }, "cli");
    expect(words(/agend-agent report (.*) — or/.exec(odd)![1]!)).toEqual(["odd $name", "…", "c1"]);
    expect(words(/agend-agent send (.*) "…"\. Not/.exec(odd)![1]!)).toEqual(["odd $name"]);
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
  it("a cross-instance message: the same footers as the envelope, in the daemon's own mode", () => {
    const meta = { from_instance: "lead", requires_reply: "true", correlation_id: "cid-9" };
    expect(daemon("cli")["formatInboundMessage"]("do x", meta).endsWith('agend-agent report lead "…" cid-9 — or agend-agent send lead "…". Not direct text.)')).toBe(true);
    expect(daemon()["formatInboundMessage"]("do x", meta).endsWith(MCP_REQUIRED)).toBe(true);
  });
});

describe("the size check counts the footer the receiver will get", () => {
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
    const args = tool === "broadcast" ? { targets: [target], message: "small", task_summary: "x".repeat(summaryLen) } : { instance_name: target, message: "small", task_summary: "x".repeat(summaryLen) };
    await outboundHandlers.get(tool)!(c, args, (_r, e) => { error = e; }, meta);
    return error === undefined;
  };
  /** The longest task_summary an MCP target accepts. */
  async function mcpLimit(): Promise<number> {
    let lo = 0, hi = 20_000;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (await send(ctx({ t: undefined }), "t", mid)) lo = mid; else hi = mid - 1; }
    return lo;
  }
  it("what fits an MCP target is refused for a CLI target (its footer is longer), and a little less fits it", async () => {
    const limit = await mcpLimit();
    expect(await send(ctx({ t: undefined }), "t", limit)).toBe(true);
    expect(await send(ctx({ t: "cli" }), "t", limit)).toBe(false);
    expect(await send(ctx({ t: "cli" }), "t", limit - 64)).toBe(true);
  });
  it("a broadcast checks before it knows its targets: the longer footer counts", async () => {
    const limit = await mcpLimit();
    expect(await send(ctx({ t: undefined }), "t", limit, "broadcast")).toBe(false);
    expect(await send(ctx({ t: undefined }), "t", limit - 128, "broadcast")).toBe(true);
  });
});
