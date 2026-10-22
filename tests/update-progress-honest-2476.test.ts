/**
 * #2476: /update progress must not look finished at "installed". The ✅ belongs only
 * to RestartProgress.finish in the new fleet after READY. Tests written to fail on
 * the pre-fix copy and on the old process still editing after stage "starting".
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import type { ChannelAdapter } from "../src/channel/types.js";
import { setLocale } from "../src/locale.js";
import { formatRestartProgressCompletion } from "../src/restart-progress.js";
import { formatUpdateProgress } from "../src/update-progress.js";
import { beginUpdateProgress, setUpdateProgressStage, type UpdateMarker, type UpdateProgressState } from "../src/update-marker.js";

afterEach(() => {
  vi.useRealTimers();
  setLocale("en");
});

function marker(stage: UpdateProgressState["stage"], extra: Partial<UpdateProgressState> = {}): UpdateMarker & { progress: UpdateProgressState } {
  return {
    startedAt: 0,
    pid: 1,
    progress: {
      operation: "update",
      stage,
      target: { adapterId: "discord", chatId: "c", messageId: "m" },
      ...extra,
    },
  };
}

describe("#2476 /update progress is honest about restart", () => {
  it("installed (old process) has no checkmark and says the fleet is restarting — EN and zh-TW", () => {
    const installed = marker("installed", { version: "2.3.0-beta.26" });
    setLocale("en");
    const en = formatUpdateProgress(installed, 60_000);
    expect(en).toBe("Installed v2.3.0-beta.26 — restarting fleet (60s)");
    expect(en).not.toContain("✅");
    expect(en.toLowerCase()).not.toMatch(/complete|ready|updated/);

    setLocale("zh-TW");
    const zh = formatUpdateProgress(installed, 60_000);
    expect(zh).toBe("已安裝 v2.3.0-beta.26 — 正在重啟 fleet (60s)");
    expect(zh).not.toContain("✅");
    expect(zh).not.toContain("完成");
  });

  it("failure and already-current keep their honest messages", () => {
    setLocale("en");
    expect(formatUpdateProgress(marker("failed", { error: "npm timeout", failedStage: "downloading" }), 3_000))
      .toBe("❌ Update failed during download/install: npm timeout (3s)");
    expect(formatUpdateProgress(marker("complete", { version: "2.3.0-beta.26" }), 5_000))
      .toBe("✅ Already up to date — v2.3.0-beta.26 (5s)");
    setLocale("zh-TW");
    expect(formatUpdateProgress(marker("failed", { error: "npm timeout", failedStage: "downloading" }), 3_000))
      .toBe("❌ 更新在「下載／安裝」階段失敗：npm timeout (3s)");
    expect(formatUpdateProgress(marker("complete", { version: "2.3.0-beta.26" }), 5_000))
      .toBe("✅ 已是最新版本 — v2.3.0-beta.26 (5s)");
  });

  it("the ✅ completion is only the new fleet's READY line — EN and zh-TW", () => {
    const summary = { running: 44, total: 44, version: "2.3.0-beta.26", pausedNames: [] as string[] };
    setLocale("en");
    const en = formatRestartProgressCompletion("update", summary, 0, 180_000);
    expect(en).toBe("✅ Update complete — v2.3.0-beta.26 · 44/44 agents ready (180s)");
    expect(en.startsWith("✅")).toBe(true);
    expect(formatRestartProgressCompletion("update", { ...summary, running: 29 }, 0, 157_000))
      .toBe("✅ Update complete — v2.3.0-beta.26 · 29/44 agents ready (157s)");

    setLocale("zh-TW");
    const zh = formatRestartProgressCompletion("update", summary, 0, 180_000);
    expect(zh).toBe("✅ 更新完成 — v2.3.0-beta.26 · 44/44 個 Agent 已就緒 (180s)");
    expect(zh.startsWith("✅")).toBe(true);
  });

  it("the old CLI-stage monitor stops editing once the new fleet owns the message (stage starting)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    setLocale("zh-TW");
    const dir = mkdtempSync(join(tmpdir(), "agend-2476-handoff-"));
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = { id: "discord", editMessage } as unknown as ChannelAdapter;
    const fleet = new FleetManager(dir);
    try {
      fleet.beginUpdateProgress(adapter, "guild", "topic", "progress-1");
      await vi.advanceTimersByTimeAsync(0);
      expect(editMessage).toHaveBeenLastCalledWith("guild", "progress-1", "📦 正在更新 AgEnD... (0s)", "topic");

      setUpdateProgressStage(dir, "installed", { version: "2.3.0-beta.26" });
      vi.setSystemTime(61_000);
      await vi.advanceTimersByTimeAsync(200);
      expect(editMessage).toHaveBeenLastCalledWith(
        "guild", "progress-1", "已安裝 v2.3.0-beta.26 — 正在重啟 fleet (60s)", "topic",
      );
      const afterInstalled = editMessage.mock.calls.length;

      setUpdateProgressStage(dir, "starting", { version: "2.3.0-beta.26" });
      vi.setSystemTime(157_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(editMessage.mock.calls.length, "starting belongs to RestartProgress in the new process").toBe(afterInstalled);
      expect(editMessage.mock.calls.map(c => String(c[2])).join("\n")).not.toContain("✅");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the CLI-stage monitor stops on fleet shutdown: no further edit and the timer is cleared", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    setLocale("en");
    const dir = mkdtempSync(join(tmpdir(), "agend-2476-shutdown-"));
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = { id: "discord", editMessage } as unknown as ChannelAdapter;
    const fleet = new FleetManager(dir) as any;
    try {
      fleet.beginUpdateProgress(adapter, "guild", "topic", "progress-1");
      await vi.advanceTimersByTimeAsync(0);
      expect(editMessage).toHaveBeenLastCalledWith("guild", "progress-1", "📦 Updating AgEnD... (0s)", "topic");
      expect(fleet.updateProgressTimer).not.toBeNull();
      const afterStart = editMessage.mock.calls.length;

      const stopped = fleet.stopAll();
      expect(fleet.shuttingDown).toBe(true);
      expect(fleet.updateProgressTimer, "shutdown clears the CLI-stage interval").toBeNull();

      vi.setSystemTime(12_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(editMessage.mock.calls.length, "no edit after shutdown").toBe(afterStart);

      await stopped;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a tick after shuttingDown does not edit even if the interval is still armed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    setLocale("en");
    const dir = mkdtempSync(join(tmpdir(), "agend-2476-guard-"));
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = { id: "discord", editMessage } as unknown as ChannelAdapter;
    const fleet = new FleetManager(dir) as any;
    try {
      fleet.beginUpdateProgress(adapter, "guild", "topic", "progress-1");
      await vi.advanceTimersByTimeAsync(0);
      const afterStart = editMessage.mock.calls.length;
      expect(fleet.updateProgressTimer).not.toBeNull();

      fleet.shuttingDown = true;
      vi.setSystemTime(12_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(editMessage.mock.calls.length, "the shuttingDown guard skips the tick").toBe(afterStart);
      expect(fleet.updateProgressTimer).not.toBeNull();
    } finally {
      if (fleet.updateProgressTimer) {
        clearInterval(fleet.updateProgressTimer);
        fleet.updateProgressTimer = null;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
