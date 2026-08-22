import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { FleetManager } from "../src/fleet-manager.js";
import { setAuthCheckRunnerForTests } from "../src/login-flows.js";

describe("/login auth pre-check", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = join(tmpdir(), `login-precheck-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => {
    setAuthCheckRunnerForTests(null);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup() {
    const fm = new FleetManager(tmpDir);
    fm.fleetConfig = { defaults: {}, instances: {} } as any;
    const notifyAlert = vi.fn().mockResolvedValue({ messageId: "prompt-1" });
    const sendText = vi.fn().mockResolvedValue({ messageId: "m1" });
    const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
    const adapter = { id: "discord", type: "discord", notifyAlert, sendText, editMessageRemoveButtons } as any;
    const launch = vi.spyOn(fm as any, "launchLoginSession").mockResolvedValue("launched");
    vi.spyOn(fm, "isFleetAdmin").mockReturnValue(true);
    const chat = { adapter, adapterId: "discord", chatId: "chat", threadId: "topic" };
    return { fm, adapter, notifyAlert, sendText, launch, chat };
  }

  it("valid auth posts the re-login confirmation instead of launching", async () => {
    const { fm, notifyAlert, launch, chat } = setup();
    setAuthCheckRunnerForTests(async () => ({ code: 0, output: "ok" }));
    const result = await fm.startLoginSession("codex", chat);
    expect(result).toBeNull();
    expect(launch).not.toHaveBeenCalled();
    expect(notifyAlert).toHaveBeenCalledTimes(1);
    const alert = notifyAlert.mock.calls[0][1];
    expect(alert.choices.map((c: { id: string }) => c.id))
      .toEqual([expect.stringMatching(/^login-confirm:[0-9a-f]{32}:go$/), expect.stringMatching(/^login-confirm:[0-9a-f]{32}:cancel$/)]);
  });

  it("invalid auth launches immediately without asking", async () => {
    const { fm, notifyAlert, launch, chat } = setup();
    setAuthCheckRunnerForTests(async () => ({ code: 1, output: "Not logged in" }));
    expect(await fm.startLoginSession("codex", chat)).toBe("launched");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(notifyAlert).not.toHaveBeenCalled();
  });

  it("an uncertain check (timeout) launches immediately", async () => {
    const { fm, launch, chat } = setup();
    setAuthCheckRunnerForTests(async () => ({ code: null, output: "" }));
    expect(await fm.startLoginSession("grok", chat)).toBe("launched");
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("confirm button launches with the pre-check skipped; cancel retires only", async () => {
    const { fm, notifyAlert, launch, chat, adapter } = setup();
    const runner = vi.fn(async () => ({ code: 0, output: "ok" }));
    setAuthCheckRunnerForTests(runner);
    await fm.startLoginSession("codex", chat);
    const goId = notifyAlert.mock.calls[0][1].choices[0].id as string;

    const click = { chatId: "chat", threadId: "topic", messageId: "prompt-1", userId: "admin", callbackData: goId } as any;
    expect(await (fm as any).handleLoginConfirm(click, "discord", adapter)).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
    // skipAuthCheck path: the runner ran once (for the original command), not twice.
    expect(runner).toHaveBeenCalledTimes(1);

    // Cancel path on a fresh prompt.
    launch.mockClear();
    await fm.startLoginSession("codex", chat);
    const cancelId = notifyAlert.mock.calls[1][1].choices[1].id as string;
    expect(await (fm as any).handleLoginConfirm({ ...click, callbackData: cancelId }, "discord", adapter)).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    expect(adapter.editMessageRemoveButtons).toHaveBeenCalled();
  });

  it("a backend without remote login still reports unsupported before any check", async () => {
    const { fm, launch, chat } = setup();
    const runner = vi.fn(async () => ({ code: 0, output: "ok" }));
    setAuthCheckRunnerForTests(runner);
    expect(await fm.startLoginSession("opencode", chat)).toContain("opencode");
    expect(runner).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });
});
