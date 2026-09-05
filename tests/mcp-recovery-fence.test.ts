import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { setAuthCheckRunnerForTests } from "../src/login-flows.js";

/**
 * sol B1 on fix/mcp-liveness-ipc-reverify: the mcp_died handler awaits an
 * auth probe (up to 5s) before notifying, while mcp_recovered notifies at
 * once. Without a fence the user sees "retracted" and THEN the stale red
 * alarm, and a storm-suppressed death would produce a retraction of a notice
 * that never went out. The lifecycle keeps a per-instance incident generation:
 * a recovery bumps it, a death handler that finds its generation stale sends
 * nothing, and a retraction is only sent when a death notice really reached
 * the user.
 */
afterEach(() => setAuthCheckRunnerForTests(null));

function lifecycle(opts: { storm?: boolean; planned?: boolean; undeliverable?: boolean } = {}) {
  const notices: string[] = [];
  const events: string[] = [];
  // Production notifyInstanceTopic returns false when no adapter/route can
  // carry the notice (#693); `undeliverable` mimics that.
  const notifyInstanceTopic = vi.fn((_n: string, text: string) => { notices.push(text); return opts.undeliverable ? false : undefined; });
  const ctx = {
    fleetConfig: { instances: { worker: { backend: "codex" } }, defaults: {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    eventLog: { insert: (_n: string, type: string) => { events.push(type); } },
    isPlannedRestart: () => opts.planned === true,
    stormWindow: opts.storm ? { isActive: () => true } : undefined,
    stormSuppressed: opts.storm ? () => true : undefined,
    notifyInstanceTopic,
    webhookEmit: vi.fn(),
    clearCancelButton: vi.fn(),
    checkModelFailover() {},
    restartSingleInstance: async () => {},
    getInstanceDir: (n: string) => `/nonexistent/${n}`,
  } as unknown as LifecycleContext;
  const lc = new InstanceLifecycle(ctx);
  const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle: vi.fn() });
  lc.attachIncidentHandlers("worker", daemon as any);
  return { daemon, notices, events, notifyInstanceTopic };
}

/** An auth probe we release by hand. */
function deferredProbe() {
  let release!: (r: { code: number; output: string }) => void;
  setAuthCheckRunnerForTests(() => new Promise(r => { release = r; }));
  return { valid: () => release({ code: 0, output: "Logged in" }), invalid: () => release({ code: 1, output: "Not logged in" }) };
}
const settle = () => new Promise(r => setTimeout(r, 20));

describe("mcp_died / mcp_recovered ordering fence", () => {
  it("1. died → probe pending → recovered → probe resolves valid: NOTHING is sent (no late red, no orphan green)", async () => {
    const probe = deferredProbe();
    const { daemon, notices, events } = lifecycle();
    daemon.emit("mcp_died", { name: "worker", pid: 1, autoRestart: true });
    await settle();
    daemon.emit("mcp_recovered", { name: "worker", source: "mcp_ready", pid: 2 });
    await settle();
    probe.valid();
    await settle();
    expect(notices).toEqual([]);
    expect(events).toEqual(["mcp_died", "mcp_recovered"]);  // the log still records both
  });

  it("2. died → probe pending → recovered → probe resolves INVALID: the stale auth notice is fenced too", async () => {
    const probe = deferredProbe();
    const { daemon, notices } = lifecycle();
    daemon.emit("mcp_died", { name: "worker", pid: 1, autoRestart: true });
    await settle();
    daemon.emit("mcp_recovered", { name: "worker", source: "connection", pid: 2 });
    await settle();
    probe.invalid();
    await settle();
    expect(notices).toEqual([]);
  });

  it("3. death notice already sent → recovery retracts it: exactly [red, green], and a second recovery adds nothing", async () => {
    const probe = deferredProbe();
    const { daemon, notices } = lifecycle();
    daemon.emit("mcp_died", { name: "worker", pid: 1, autoRestart: true });
    probe.valid();
    await settle();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("MCP server 已終止");
    daemon.emit("mcp_recovered", { name: "worker", source: "tool_call", pid: 2 });
    await settle();
    expect(notices).toHaveLength(2);
    expect(notices[1]).toMatch(/仍在服務|serving again/);
    daemon.emit("mcp_recovered", { name: "worker", source: "tool_call", pid: 2 });
    await settle();
    expect(notices).toHaveLength(2);
  });

  it("4. storm-suppressed death → recovery sends no retraction of a notice nobody saw", async () => {
    const probe = deferredProbe();
    const { daemon, notices, events } = lifecycle({ storm: true });
    daemon.emit("mcp_died", { name: "worker", pid: 1, autoRestart: true });
    probe.valid();
    await settle();
    expect(notices).toEqual([]);
    daemon.emit("mcp_recovered", { name: "worker", source: "mcp_ready", pid: 2 });
    await settle();
    expect(notices).toEqual([]);
    expect(events).toEqual(["mcp_died", "mcp_recovered"]);
  });

  it("5. planned-restart-suppressed death → no retraction either", async () => {
    const probe = deferredProbe();
    const { daemon, notices } = lifecycle({ planned: true });
    daemon.emit("mcp_died", { name: "worker", pid: 1, autoRestart: true });
    probe.valid();
    await settle();
    daemon.emit("mcp_recovered", { name: "worker", source: "mcp_ready", pid: 2 });
    await settle();
    expect(notices).toEqual([]);
  });

  it("5b. death notice attempted but NOT dispatched (no adapter/route → false) → no retraction", async () => {
    const probe = deferredProbe();
    const { daemon, notices } = lifecycle({ undeliverable: true });
    daemon.emit("mcp_died", { name: "worker", pid: 1, autoRestart: true });
    probe.valid();
    await settle();
    expect(notices).toHaveLength(1);                 // the attempt happened...
    expect(notices[0]).toContain("MCP server 已終止");
    daemon.emit("mcp_recovered", { name: "worker", source: "mcp_ready", pid: 2 });
    await settle();
    expect(notices).toHaveLength(1);                 // ...but nobody saw it, so nothing to retract
  });

  it("6. recovery with no prior death at all is silent", async () => {
    setAuthCheckRunnerForTests(async () => ({ code: 0, output: "Logged in" }));
    const { daemon, notices } = lifecycle();
    daemon.emit("mcp_recovered", { name: "worker", source: "mcp_ready", pid: 2 });
    await settle();
    expect(notices).toEqual([]);
  });

  it("7. a fresh death after a retraction is reported again (the fence resets per incident)", async () => {
    setAuthCheckRunnerForTests(async () => ({ code: 0, output: "Logged in" }));
    const { daemon, notices } = lifecycle();
    daemon.emit("mcp_died", { name: "worker", pid: 1, autoRestart: true });
    await settle();
    daemon.emit("mcp_recovered", { name: "worker", source: "mcp_ready", pid: 2 });
    await settle();
    daemon.emit("mcp_died", { name: "worker", pid: 2, autoRestart: true });
    await settle();
    expect(notices).toHaveLength(3);
    expect(notices[2]).toContain("MCP server 已終止");
  });
});
