/**
 * #1794: a quiet launch warning (a kiro agent switch that timed out or could not be recorded — nothing changes for
 * the user, nothing for them to do) stays in the event log behind the instance's Log tab, and is not posted to its
 * topic. Every other launch warning is still both. The real InstanceLifecycle handler, with inert topic and log.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { InstanceLifecycle, type LifecycleContext } from "../src/instance-lifecycle.js";
import { t } from "../src/locale.js";

function lifecycle() {
  const notifyInstanceTopic = vi.fn(() => true);
  const insert = vi.fn();
  const lc = new InstanceLifecycle({
    fleetConfig: { instances: { worker: { backend: "kiro-cli" } }, defaults: {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    eventLog: { insert },
    isPlannedRestart: () => false,
    notifyInstanceTopic,
    webhookEmit() {}, clearCancelButton() {}, checkModelFailover() {}, setTopicIcon() {},
    restartSingleInstance: vi.fn(async () => {}),
  } as unknown as LifecycleContext);
  const daemon = Object.assign(new EventEmitter(), { requestPauseWhenIdle() {} });
  lc.attachLaunchWarningHandler("worker", daemon as never);
  return { daemon, notifyInstanceTopic, insert };
}

describe("quiet launch warnings (#1794)", () => {
  it("the switch timeout: on the Log tab, not in the topic", () => {
    const { daemon, notifyInstanceTopic, insert } = lifecycle();
    const message = t("kiro.switch_timeout", 15);
    daemon.emit("backend_launch_warning", { name: "worker", message, quiet: true });
    expect(insert).toHaveBeenCalledWith("worker", "backend_launch_warning", { message });
    expect(notifyInstanceTopic).not.toHaveBeenCalled();
  });

  it("a warning the user must act on is still posted (positive control)", () => {
    const { daemon, notifyInstanceTopic, insert } = lifecycle();
    const message = t("kiro.shared_unreadable", "mcp.json");
    daemon.emit("backend_launch_warning", { name: "worker", message, quiet: false });
    daemon.emit("backend_launch_warning", { name: "worker", message: "no flag at all" });
    expect(insert).toHaveBeenCalledTimes(2);
    expect(notifyInstanceTopic).toHaveBeenCalledWith("worker", t("inst.backend_launch_warning", "worker", message));
    expect(notifyInstanceTopic).toHaveBeenCalledWith("worker", t("inst.backend_launch_warning", "worker", "no flag at all"));
  });

  it("only a literal true is quiet", () => {
    const { daemon, notifyInstanceTopic } = lifecycle();
    daemon.emit("backend_launch_warning", { name: "worker", message: "m", quiet: "yes" });
    expect(notifyInstanceTopic).toHaveBeenCalledOnce();
  });
});
