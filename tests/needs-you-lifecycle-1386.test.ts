/**
 * #1386 §4.2: the lifecycle tells the fleet at once when an instance's attention state changes — its interaction
 * observation (instance_interaction), or a pause — so "Needs you" does not wait for its 10 s tick.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { InstanceLifecycle } from "../src/instance-lifecycle.js";

function lifecycle(onAttentionChanged = vi.fn()) {
  const lc = new InstanceLifecycle({
    fleetConfig: { instances: { worker: { backend: "codex" } }, defaults: {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} }, eventLog: null,
    isPlannedRestart: () => false, notifyInstanceTopic: vi.fn(), offerBackendLogin: vi.fn(async () => {}),
    webhookEmit: vi.fn(), clearCancelButton: vi.fn(), checkModelFailover() {}, restartSingleInstance: async () => {},
    getInstanceDir: (n: string) => `/nonexistent/${n}`, stopStatuslineWatcher: vi.fn(), startStatuslineWatcher: vi.fn(),
    onAttentionChanged,
  } as any);
  return { lc, onAttentionChanged };
}

describe("the lifecycle relays attention changes", () => {
  it("instance_interaction from the daemon", () => {
    const { lc, onAttentionChanged } = lifecycle();
    const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle: vi.fn() });
    lc.attachIncidentHandlers("worker", daemon as any);
    daemon.emit("instance_interaction", { name: "worker", interaction: { phase: "waiting" } });
    expect(onAttentionChanged).toHaveBeenCalledWith("worker");
  });

  it("a pause, whether it took or was refused", async () => {
    const { lc, onAttentionChanged } = lifecycle();
    const daemon = { isPaused: false, pause: vi.fn(async () => { daemon.isPaused = true; }) };
    (lc as any).daemons.set("worker", daemon);
    await lc.pause("worker", "auth");
    expect(onAttentionChanged).toHaveBeenCalledWith("worker");
    onAttentionChanged.mockClear();
    const refusing = { isPaused: false, pause: vi.fn(async () => { throw new Error("not idle"); }) };
    (lc as any).daemons.set("worker", refusing);
    await expect(lc.pause("worker", "operator")).rejects.toThrow("not idle");
    expect(onAttentionChanged).toHaveBeenCalledWith("worker");
  });
});
