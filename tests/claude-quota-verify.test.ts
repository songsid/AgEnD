import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  InstanceLifecycle,
  claudeQuotaVerdictFromUsage,
  verifyClaudeQuotaStatus,
  type ClaudeQuotaVerdict,
  type LifecycleContext,
} from "../src/instance-lifecycle.js";

function percentUsage(used: number, hint?: string) {
  return {
    status: "ok" as const,
    ...(hint ? { hint } : {}),
    metrics: [{ label: "Weekly", type: "percent" as const, used, windowMs: 7 * 86400_000 }],
  };
}

function lifecycle(verifier: () => Promise<ClaudeQuotaVerdict>, names = ["worker"]) {
  const notifyInstanceTopic = vi.fn();
  const clearCancelButton = vi.fn();
  const ctx = {
    fleetConfig: {
      instances: Object.fromEntries(names.map(name => [name, { backend: "claude-code" }])),
      defaults: {},
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    eventLog: null,
    isPlannedRestart: () => false,
    notifyInstanceTopic,
    webhookEmit: vi.fn(),
    clearCancelButton,
    checkModelFailover() {},
    restartSingleInstance: async () => {},
    getInstanceDir: (name: string) => `/nonexistent/${name}`,
    verifyClaudeQuota: verifier,
  } as unknown as LifecycleContext;
  const instanceLifecycle = new InstanceLifecycle(ctx);
  const daemons = names.map(name => {
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle: vi.fn() });
    instanceLifecycle.attachIncidentHandlers(name, daemon as any);
    return daemon;
  });
  return { daemons, notifyInstanceTopic, clearCancelButton };
}

const quotaError = (name: string) => ({
  name,
  type: "quota",
  action: "pause",
  message: "Insufficient API credits",
});

describe("Claude quota second opinion", () => {
  it("classifies live percent and dollar limits conservatively", () => {
    expect(claudeQuotaVerdictFromUsage(percentUsage(42))).toBe("available");
    expect(claudeQuotaVerdictFromUsage(percentUsage(100))).toBe("exhausted");
    expect(claudeQuotaVerdictFromUsage({
      status: "ok",
      metrics: [{ label: "Extra usage", type: "dollars", used: 10, limit: 10 }],
    })).toBe("exhausted");
    expect(claudeQuotaVerdictFromUsage({ status: "error", error: "offline", metrics: [] })).toBe("unknown");
    expect(claudeQuotaVerdictFromUsage({ status: "ok", metrics: [] })).toBe("unknown");
  });

  it("does not treat provider fallback to a local statusline as live proof", () => {
    expect(claudeQuotaVerdictFromUsage(percentUsage(12, "from general's statusline, just now")))
      .toBe("unknown");
  });

  it("turns a timed-out usage probe into the conservative unknown verdict", async () => {
    const never = () => new Promise<ReturnType<typeof percentUsage>>(() => {});
    await expect(verifyClaudeQuotaStatus(never, 5)).resolves.toBe("unknown");
  });

  it("ignores stale pane quota text when live usage has capacity", async () => {
    const { daemons, notifyInstanceTopic, clearCancelButton } = lifecycle(async () => "available");
    daemons[0].emit("pty_error", quotaError("worker"));
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(notifyInstanceTopic).not.toHaveBeenCalled();
    expect(clearCancelButton).not.toHaveBeenCalled();
    expect(daemons[0].requestPauseWhenIdle).not.toHaveBeenCalled();
  });

  it.each(["exhausted", "unknown"] as const)(
    "pauses conservatively when the live verdict is %s",
    async verdict => {
      const { daemons, notifyInstanceTopic } = lifecycle(async () => verdict);
      daemons[0].emit("pty_error", quotaError("worker"));

      await vi.waitFor(() => expect(notifyInstanceTopic).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(daemons[0].requestPauseWhenIdle).toHaveBeenCalledTimes(1));
    },
  );

  it("joins simultaneous Claude quota alerts to one in-flight live check", async () => {
    let release!: (verdict: ClaudeQuotaVerdict) => void;
    const verifier = vi.fn(() => new Promise<ClaudeQuotaVerdict>(resolve => { release = resolve; }));
    const { daemons } = lifecycle(verifier, ["w1", "w2", "w3"]);

    daemons[0].emit("pty_error", quotaError("w1"));
    daemons[1].emit("pty_error", quotaError("w2"));
    daemons[2].emit("pty_error", quotaError("w3"));
    await vi.waitFor(() => expect(verifier).toHaveBeenCalledTimes(1));
    release("available");
    await new Promise(resolve => setTimeout(resolve, 20));

    for (const daemon of daemons) expect(daemon.requestPauseWhenIdle).not.toHaveBeenCalled();
  });
});
