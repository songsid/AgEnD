import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAuthCheckRunnerForTests } from "../src/login-flows.js";
import { CodexBackend } from "../src/backend/codex.js";
import { setLocale } from "../src/locale.js";

afterEach(() => {
  setAuthCheckRunnerForTests(null);
  setLocale("en");
});
import {
  InstanceLifecycle,
  type IncidentEventSource,
  type LifecycleContext,
} from "../src/instance-lifecycle.js";

function makeLifecycle(classicNames: string[]) {
  const notifyInstanceTopic = vi.fn();
  const dataDir = mkdtempSync(join(tmpdir(), "agend-incident-"));
  const ctx = {
    fleetConfig: {
      defaults: { backend: "kiro-cli" },
      instances: {
        general: { general_topic: true },
        worker: { backend: "kiro-cli" },
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    dataDir,
    getInstanceDir: (name: string) => join(dataDir, "instances", name),
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
  return { attach, notifyInstanceTopic, ctx, dataDir };
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

  it("localizes a Codex capacity incident and pauses the affected instance", async () => {
    setLocale("zh-TW");
    const { attach, notifyInstanceTopic, ctx } = makeLifecycle([]);
    (ctx as any).fleetConfig.instances.worker.backend = "codex";
    const daemon = attach("worker");
    const capacity = new CodexBackend("/tmp/codex-capacity-notify-test")
      .getErrorPatterns()
      .find(({ pattern }) => pattern.test("⚠ Selected model is at capacity. Please try a different model."));

    expect(capacity).toBeDefined();
    daemon.emit("pty_error", { name: "worker", ...capacity });

    await vi.waitFor(() => expect(daemon.requestPauseWhenIdle).toHaveBeenCalledTimes(1));
    expect(notifyInstanceTopic).toHaveBeenCalledWith(
      "worker",
      expect.stringMatching(/服務擁擠.*手動重送訊息.*\/model/s),
    );
    expect((ctx as any).clearCancelButton).toHaveBeenCalledWith("worker");
  });

  it("reports Claude's live fallback model when a configured model is unavailable", () => {
    const { attach, notifyInstanceTopic, ctx, dataDir } = makeLifecycle([]);
    (ctx as any).fleetConfig.instances.worker.backend = "claude-code";
    const instanceDir = join(dataDir, "instances", "worker");
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "statusline.json"), JSON.stringify({
      model: { id: "claude-sonnet-5", display_name: "Sonnet 5" },
    }));
    const daemon = attach("worker");

    daemon.emit("pty_error", {
      name: "worker",
      type: "model_error",
      action: "notify",
      message: "Selected Claude model unavailable",
    });

    expect(notifyInstanceTopic).toHaveBeenCalledWith(
      "worker",
      expect.stringMatching(/currently using Sonnet 5 \(claude-sonnet-5\).*\/model/s),
    );
  });

  it("routes ClassicBot auth errors to General through the deduplicated path", async () => {
    // Auth errors now get a token-free second opinion before any alert; an
    // invalid result proceeds to the notification this test asserts on.
    setAuthCheckRunnerForTests(async () => ({ code: 1, output: "Not logged in" }));
    const { attach, notifyInstanceTopic } = makeLifecycle(["classic-user-1234"]);
    const daemon = attach("classic-user-1234");

    daemon.emit("pty_error", {
      name: "classic-user-1234",
      type: "auth_error",
      action: "notify",
      message: "Login expired",
    });

    await vi.waitFor(() => expect(notifyInstanceTopic).toHaveBeenCalledTimes(1));
    expect(notifyInstanceTopic).toHaveBeenCalledWith(
      "general",
      expect.stringMatching(/Login expired/s),
    );
  });
});
