import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import type { ChannelAdapter } from "../src/channel/types.js";
import { readUpdateProgress, setUpdateProgressStage } from "../src/update-marker.js";
import { setLocale } from "../src/locale.js";

afterEach(() => {
  vi.useRealTimers();
  setLocale("en");
});

describe("/update live progress", () => {
  it("edits the same message as CLI stages change and reports a localized failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    setLocale("zh-TW");
    const dir = mkdtempSync(join(tmpdir(), "agend-update-live-"));
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = { id: "telegram", editMessage } as unknown as ChannelAdapter;
    const fleet = new FleetManager(dir);

    try {
      fleet.beginUpdateProgress(adapter, "-1001", "42", "message-7");
      await vi.advanceTimersByTimeAsync(0);
      expect(editMessage).toHaveBeenLastCalledWith(
        "-1001",
        "message-7",
        "📦 正在更新 AgEnD... (0s)",
        "42",
      );

      setUpdateProgressStage(dir, "downloading");
      vi.setSystemTime(4_000);
      await vi.advanceTimersByTimeAsync(200);
      expect(editMessage).toHaveBeenLastCalledWith(
        "-1001",
        "message-7",
        "⬇️ 下載及安裝中... (3s)",
        "42",
      );

      setUpdateProgressStage(dir, "failed", { error: "npm timeout" });
      await vi.advanceTimersByTimeAsync(200);
      expect(editMessage).toHaveBeenLastCalledWith(
        "-1001",
        "message-7",
        "❌ 更新在「下載／安裝」階段失敗：npm timeout (3s)",
        "42",
      );
      expect(readUpdateProgress(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
