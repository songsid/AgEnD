/**
 * #1854 rank 4: a healthy update ends with one completion line and the once-only 2.2 welcome is two lines. The
 * update-completion tip is deferred (daily tips and /tips are unchanged). Warning lines are kept.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale, t } from "../src/locale.js";
import { formatRestartProgressCompletion } from "../src/restart-progress.js";
import { beginUpdateProgress, readUpdateProgress, setUpdateProgressStage } from "../src/update-marker.js";

afterEach(() => setLocale("en"));

describe("the copy from the approved proposal", () => {
  it("welcome: two lines, EN and zh-TW, no URL", () => {
    setLocale("en");
    expect(t("upgrade.web_chat")).toBe("🆕 AgEnD 2.2 adds web chat. You can keep chatting here.\n"
      + "Admins: send /web in General, then press a sign-in button to get a code.");
    setLocale("zh-TW");
    expect(t("upgrade.web_chat")).toBe("🆕 AgEnD 2.2：新增網頁聊天，這裡也照常使用。\n管理員：在 General 傳 /web，再按登入按鈕取碼。");
  });

  it("healthy completion: one line, EN and zh-TW", () => {
    const healthy = { running: 3, total: 3, version: "2.2.0", pausedNames: [] as string[] };
    setLocale("en");
    expect(formatRestartProgressCompletion("update", healthy, 0, 42_000)).toBe("✅ Update complete — v2.2.0 · 3/3 agents ready (42s)");
    setLocale("zh-TW");
    expect(formatRestartProgressCompletion("update", healthy, 0, 42_000)).toBe("✅ 更新完成 — v2.2.0 · 3/3 個 Agent 已就緒 (42s)");
  });

  it("every warning line is still there", () => {
    setLocale("en");
    const text = formatRestartProgressCompletion("update", {
      running: 1, total: 4, version: "2.2.0", pausedNames: ["p"], failedNames: ["f"], backgroundWorkEndedNames: ["b"],
      warningText: "Old copy left behind", warningCommand: "sudo rm x",
    }, 0, 1_000);
    expect(text.split("\n")).toEqual([
      "✅ Update complete — v2.2.0 · 1/4 agents ready (1s)",
      "⏸ Paused (1): p",
      "⚠️ Failed (1): f",
      "⚠️ Background work was running and was ended: b",
      "",
      "⚠️ Old copy left behind",
      "`$ sudo rm x`",
    ]);
  });
});

describe("an update that needed no restart completes without a tip", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("the old fleet edits its message to the bare completion, tips enabled and available", async () => {
    setLocale("en");
    dir = mkdtempSync(join(tmpdir(), "agend-1854-tip-"));
    beginUpdateProgress(dir, { adapterId: "a", chatId: "c", messageId: "m" }, Date.now());
    setUpdateProgressStage(dir, "complete", { version: "2.2.0" });
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = { id: "a", editMessage };
    const fm = Object.create(FleetManager.prototype) as any;
    Object.assign(fm, {
      dataDir: dir, adapters: new Map([["a", adapter]]), logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      updateCleanupWatch: null, updateProgressTimer: null, updateProgressEditRunning: false, lastUpdateProgressText: null,
      tipsEnabled: () => true, pickAvailableTip: () => ({ id: "tip-x" }), formatTip: () => "💡 Tip: try /status",
      updateCompletionTipText: null,   // the tip cache the removed code read; a constructed fleet started it at null
    });
    fm.startUpdateProgressMonitor(adapter);
    await vi.waitFor(() => expect(readUpdateProgress(dir)).toBeNull());
    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(editMessage.mock.calls[0][2]).toMatch(/^✅ Already up to date — v2\.2\.0 \(\d+s\)$/);
  });
});
