import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { InteractivePromptDetector } from "../src/daemon.js";
import {
  InstanceLifecycle,
  type IncidentEventSource,
  type LifecycleContext,
} from "../src/instance-lifecycle.js";

describe("InteractivePromptDetector", () => {
  it.each([
    ["[sudo] password for han:", "sudo_password"],
    ["Password:", "password"],
    ["Continue installation? [Y/n]", "confirmation"],
    ["Proceed (y/N):", "confirmation"],
    ["Are you sure you want to continue connecting (yes/no/[fingerprint])?", "confirmation"],
    ["Press Enter to continue...", "press_enter"],
  ] as const)("emits %s only after ten seconds without output", (prompt, kind) => {
    const detector = new InteractivePromptDetector(10_000);
    const pane = `old output\n${prompt}`;

    expect(detector.observe(pane, 1_000, 900)).toBeNull();
    expect(detector.observe(pane, 10_999, 900)).toBeNull();
    expect(detector.observe(pane, 11_000, 900)).toMatchObject({ kind, prompt });
    // A stable prompt alerts once rather than every five-second monitor tick.
    expect(detector.observe(pane, 16_000, 900)).toBeNull();
  });

  it("restarts the stability window when pane output moves", () => {
    const detector = new InteractivePromptDetector(10_000);
    const pane = "Install package? [Y/n]";

    expect(detector.observe(pane, 1_000, 900)).toBeNull();
    expect(detector.observe(pane, 10_000, 9_500)).toBeNull();
    expect(detector.observe(pane, 19_499, 9_500)).toBeNull();
    expect(detector.observe(pane, 20_000, 9_500)).toMatchObject({ kind: "confirmation" });
  });

  it("only scans the last five sanitized pane lines", () => {
    const detector = new InteractivePromptDetector(10_000);
    const pane = ["Password:", "one", "two", "three", "four", "five", "six"].join("\n");
    expect(detector.observe(pane, 1_000, 500)).toBeNull();
    expect(detector.observe(pane, 20_000, 500)).toBeNull();
  });

  it("requires the prompt to remain visible between observations", () => {
    const detector = new InteractivePromptDetector(10_000);
    expect(detector.observe("Proceed? (yes/no)", 1_000, 500)).toBeNull();
    expect(detector.observe("agent is still working", 6_000, 5_500)).toBeNull();
    expect(detector.observe("Proceed? (yes/no)", 20_000, 19_500)).toBeNull();
    expect(detector.observe("Proceed? (yes/no)", 30_000, 19_500)).toMatchObject({ kind: "confirmation" });
  });
});

describe("interactive prompt incident routing", () => {
  it("notifies General rather than the blocked instance", () => {
    const notifyInstanceTopic = vi.fn();
    const eventInsert = vi.fn();
    const ctx = {
      fleetConfig: {
        defaults: {},
        instances: {
          general: { general_topic: true },
          worker: {},
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      eventLog: { insert: eventInsert },
      isPlannedRestart: () => false,
      notifyInstanceTopic,
      setTopicIcon: vi.fn(),
      webhookEmit: vi.fn(),
      clearCancelButton: vi.fn(),
      checkModelFailover: vi.fn(),
    } as unknown as LifecycleContext;
    const lifecycle = new InstanceLifecycle(ctx);
    const daemon = Object.assign(new EventEmitter(), {
      requestPauseWhenIdle: vi.fn(),
    }) as IncidentEventSource & EventEmitter;
    lifecycle.attachIncidentHandlers("worker", daemon);

    daemon.emit("interactive_prompt", {
      name: "worker",
      kind: "sudo_password",
      prompt: "[sudo] password for han:",
    });

    expect(eventInsert).toHaveBeenCalledWith("worker", "interactive_prompt", { kind: "sudo_password" });
    expect(notifyInstanceTopic).toHaveBeenCalledTimes(1);
    expect(notifyInstanceTopic).toHaveBeenCalledWith(
      "general",
      expect.stringMatching(/worker.*sudo password.*tmux attach/s),
    );
  });
});
