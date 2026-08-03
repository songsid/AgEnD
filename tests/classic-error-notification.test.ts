import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  InstanceLifecycle,
  type IncidentEventSource,
  type LifecycleContext,
} from "../src/instance-lifecycle.js";

function makeLifecycle(classicNames: string[]) {
  const notifyInstanceTopic = vi.fn();
  const ctx = {
    fleetConfig: {
      defaults: { backend: "kiro-cli" },
      instances: {
        general: { general_topic: true },
        worker: { backend: "kiro-cli" },
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    eventLog: { insert: vi.fn() },
    isPlannedRestart: () => false,
    isClassicInstance: (name: string) => classicNames.includes(name),
    notifyInstanceTopic,
    setTopicIcon: vi.fn(),
    webhookEmit: vi.fn(),
    clearCancelButton: vi.fn(),
    checkModelFailover: vi.fn(),
    restartSingleInstance: vi.fn(async () => {}),
  } as unknown as LifecycleContext;
  const lifecycle = new InstanceLifecycle(ctx);
  const attach = (name: string) => {
    const daemon = Object.assign(new EventEmitter(), {
      requestPauseWhenIdle: vi.fn(),
    }) as IncidentEventSource & EventEmitter;
    lifecycle.attachIncidentHandlers(name, daemon);
    return daemon;
  };
  return { attach, notifyInstanceTopic };
}

describe("PTY error notification targets", () => {
  it("routes ClassicBot errors to General, not the user's classic channel", () => {
    const { attach, notifyInstanceTopic } = makeLifecycle(["classic-user-1234"]);
    const daemon = attach("classic-user-1234");

    daemon.emit("pty_error", {
      name: "classic-user-1234",
      type: "quota",
      action: "notify",
      message: "Individual quota reached",
    });

    expect(notifyInstanceTopic).toHaveBeenCalledTimes(1);
    expect(notifyInstanceTopic).toHaveBeenCalledWith(
      "general",
      expect.stringMatching(/classic-user-1234.*Individual quota reached/s),
    );
    expect(notifyInstanceTopic).not.toHaveBeenCalledWith("classic-user-1234", expect.anything());
  });

  it("keeps fleet-topic errors in that instance's own topic", () => {
    const { attach, notifyInstanceTopic } = makeLifecycle([]);
    const daemon = attach("worker");

    daemon.emit("pty_error", {
      name: "worker",
      type: "model_error",
      action: "notify",
      message: "Model unavailable",
    });

    expect(notifyInstanceTopic).toHaveBeenCalledTimes(1);
    expect(notifyInstanceTopic).toHaveBeenCalledWith(
      "worker",
      expect.stringMatching(/worker.*Model unavailable/s),
    );
  });

  it("routes ClassicBot auth errors to General through the deduplicated path", () => {
    const { attach, notifyInstanceTopic } = makeLifecycle(["classic-user-1234"]);
    const daemon = attach("classic-user-1234");

    daemon.emit("pty_error", {
      name: "classic-user-1234",
      type: "auth_error",
      action: "notify",
      message: "Login expired",
    });

    expect(notifyInstanceTopic).toHaveBeenCalledTimes(1);
    expect(notifyInstanceTopic).toHaveBeenCalledWith(
      "general",
      expect.stringMatching(/Login expired/s),
    );
  });
});
