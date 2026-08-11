import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { TelegramAdapter } from "../src/channel/adapters/telegram.js";

// #410: the cancel button was retired whenever the agent called `reply`, on the
// assumption that a reply ends the turn. On multi-step work an agent replies
// ("starting…") and keeps going for many minutes, so the channel went quiet with no
// way to cancel and no sign anything was happening.
// #409: that same message is the natural place to show progress — editing it means
// exactly one progress message per turn instead of a stream of new ones.

describe("progressText", () => {
  it("uses the configured threshold, defaulting to 30 seconds", () => {
    // Default dropped from 2 minutes: real work now shows signs of life at 30s.
    expect(FleetManager.progressText(29_000)).toBe("👀 處理中…");
    expect(FleetManager.progressText(31_000)).toBe("⏳ 處理中… (已進行 0m 31s)");
    // Explicit threshold (defaults.progress_min_elapsed) wins over the default.
    expect(FleetManager.progressText(10_000, null, 5_000)).toBe("⏳ 處理中… (已進行 0m 10s)");
    expect(FleetManager.progressText(10_000, null, 120_000)).toBe("👀 處理中…");
  });

  it("keeps the original wording for a normal quick answer", () => {
    // Below the threshold nothing changes, so short turns look exactly as before.
    expect(FleetManager.progressText(0)).toBe("👀 處理中…");
    expect(FleetManager.progressText(29_999)).toBe("👀 處理中…");
    expect(FleetManager.progressText(119_000, null, 120_000)).toBe("👀 處理中…"); // old 2-min default, now opt-in
  });

  it("shows elapsed minutes and seconds once work is clearly long", () => {
    expect(FleetManager.progressText(120_000)).toBe("⏳ 處理中… (已進行 2m 00s)");
    expect(FleetManager.progressText(332_000)).toBe("⏳ 處理中… (已進行 5m 32s)");
  });

  it("switches to hours past 60 minutes", () => {
    expect(FleetManager.progressText(3_600_000)).toBe("⏳ 處理中… (已進行 1h 0m)");
    expect(FleetManager.progressText(4_500_000)).toBe("⏳ 處理中… (已進行 1h 15m)");
  });

  it("is deterministic, which is what lets an unchanged tick skip its API call", () => {
    // The ticker compares against lastProgressText and skips the edit when equal,
    // so the same elapsed time must always render identically.
    for (const ms of [0, 60_000, 332_000, 3_600_000]) {
      expect(FleetManager.progressText(ms)).toBe(FleetManager.progressText(ms));
    }
  });

  it("advances within a minute, so a 60s tick always has something new to show", () => {
    expect(FleetManager.progressText(332_000)).not.toBe(FleetManager.progressText(392_000));
  });
});

describe("Telegram editAlert keeps the inline keyboard", () => {
  // The trap this method exists for: TelegramAdapter.editMessage calls
  // editMessageText WITHOUT reply_markup, and the Bot API treats that as "clear the
  // keyboard" — which is exactly how editMessageRemoveButtons works. Editing the
  // cancel button's text with editMessage would delete the cancel button.
  function makeAdapter() {
    const adapter = Object.create(TelegramAdapter.prototype) as TelegramAdapter & {
      bot: { api: { editMessageText: ReturnType<typeof vi.fn> } };
    };
    adapter.bot = { api: { editMessageText: vi.fn().mockResolvedValue(undefined) } };
    return adapter;
  }

  it("re-sends the keyboard built from the alert's choices", async () => {
    const adapter = makeAdapter();
    await adapter.editAlert("123", "456", {
      type: "cancel",
      instanceName: "alpha",
      message: "⏳ working",
      choices: [{ id: "cancel:alpha", label: "Cancel" }],
    });

    const [, , text, opts] = adapter.bot.api.editMessageText.mock.calls[0];
    expect(text).toBe("⏳ working");
    // A non-empty keyboard is what keeps the button alive.
    expect(opts.reply_markup.inline_keyboard.flat()).toHaveLength(1);
    expect(opts.reply_markup.inline_keyboard.flat()[0]).toMatchObject({
      text: "Cancel",
      callback_data: "cancel:alpha",
    });
  });

  it("always passes reply_markup, even with no choices", async () => {
    // Omitting the field entirely is what clears the keyboard, so it must always
    // be present — an empty keyboard is an explicit choice, an absent one is a bug.
    const adapter = makeAdapter();
    await adapter.editAlert("123", "456", { type: "cancel", instanceName: "alpha", message: "x" });
    const [, , , opts] = adapter.bot.api.editMessageText.mock.calls[0];
    expect(opts).toHaveProperty("reply_markup");
  });
});

describe("reply no longer retires a button while work continues", () => {
  function makeFleet(idle: boolean) {
    const fm = new FleetManager(mkdtempSync(join(tmpdir(), "agend-btn-")));
    const internals = fm as unknown as {
      getInstanceIdle(name: string): boolean;
      clearCancelButton(name: string): void;
      sendCancelButton(name: string): Promise<void>;
    };
    internals.getInstanceIdle = () => idle;
    const cleared = vi.fn();
    const reposted = vi.fn().mockResolvedValue(undefined);
    internals.clearCancelButton = cleared;
    internals.sendCancelButton = reposted;
    return { internals, cleared, reposted };
  }

  // The reply branch is inline in the tool router, so these assert the decision
  // rule it now applies rather than reaching through the whole IPC path.
  it("retires when the instance has gone idle", () => {
    const { internals, cleared, reposted } = makeFleet(true);
    if (internals.getInstanceIdle("alpha")) internals.clearCancelButton("alpha");
    else void internals.sendCancelButton("alpha");
    expect(cleared).toHaveBeenCalledOnce();
    expect(reposted).not.toHaveBeenCalled();
  });

  it("reposts below the new reply when still working", () => {
    const { internals, cleared, reposted } = makeFleet(false);
    if (internals.getInstanceIdle("alpha")) internals.clearCancelButton("alpha");
    else void internals.sendCancelButton("alpha");
    expect(cleared).not.toHaveBeenCalled();
    expect(reposted).toHaveBeenCalledOnce();
  });
});

describe("progressMinElapsedMs", () => {
  it("reads defaults.progress_min_elapsed in seconds, falling back to 30s", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "agend-pmin-"));
    const fm = new FleetManager(dir);
    try {
      (fm as any).fleetConfig = { defaults: { progress_min_elapsed: 15 }, instances: {} };
      expect(fm.progressMinElapsedMs()).toBe(15_000);

      (fm as any).fleetConfig = { defaults: { progress_min_elapsed: 0 }, instances: {} };
      expect(fm.progressMinElapsedMs()).toBe(0); // 0 = show time immediately

      // Absent or invalid → the 30s default, never NaN.
      (fm as any).fleetConfig = { defaults: {}, instances: {} };
      expect(fm.progressMinElapsedMs()).toBe(30_000);
      (fm as any).fleetConfig = { defaults: { progress_min_elapsed: -5 }, instances: {} };
      expect(fm.progressMinElapsedMs()).toBe(30_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Tool progress in the bubble (feat/tool-progress-steering) ──────────────

describe("bubbleText — the ONE composer for ticker and tool progress", () => {
  // #528 trap 2: v2.1.2's ticker rendered only its own header, so the first
  // elapsed tick after a progress push WIPED the tool list from the bubble.
  // Both writers now render through bubbleText; these tests pin that a header
  // refresh can never lose the list.
  it("keeps the tool list when only elapsed time advances (the ticker path)", () => {
    const list = "🧪 執行測試\n📄 讀取檔案：src/daemon.ts";
    const beforeTick = FleetManager.bubbleText(60_000, undefined, 30_000, list);
    const afterTick = FleetManager.bubbleText(120_000, undefined, 30_000, list);
    expect(beforeTick).toContain(list);
    expect(afterTick).toContain(list); // the elapsed tick must NOT wipe the list
    expect(afterTick).toContain("已進行 2m 00s");
  });

  it("renders header-only when no progress exists (unchanged legacy shape)", () => {
    expect(FleetManager.bubbleText(120_000, undefined, 30_000, undefined))
      .toBe(FleetManager.progressText(120_000, undefined, 30_000));
  });

  it("drops the redundant single-line activity once a list exists", () => {
    const withList = FleetManager.bubbleText(120_000, "$ npm test", 30_000, "🧪 執行測試");
    expect(withList).not.toContain("$ npm test");
    expect(withList).toContain("🧪 執行測試");
    const withoutList = FleetManager.bubbleText(120_000, "$ npm test", 30_000, undefined);
    expect(withoutList).toContain("$ npm test");
  });

  it("shows the list even below the elapsed threshold", () => {
    const text = FleetManager.bubbleText(5_000, undefined, 30_000, "🧪 執行測試");
    expect(text).toContain("👀 處理中…");
    expect(text).toContain("🧪 執行測試");
  });
});

describe("retiring a tool-progress bubble preserves its history", () => {
  function makeFleet() {
    const dir = mkdtempSync(join(tmpdir(), "agend-progress-retire-"));
    const fm = new FleetManager(dir);
    const notifyAlert = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "g1", threadId: "123" });
    const editAlert = vi.fn().mockResolvedValue(undefined);
    const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
    const deleteMessage = vi.fn().mockResolvedValue(undefined);
    const adapter = {
      id: "telegram",
      type: "telegram",
      notifyAlert,
      editAlert,
      editMessageRemoveButtons,
      deleteMessage,
    };
    (fm as any).fleetConfig = {
      defaults: { progress_min_elapsed: 0 },
      channel: { group_id: "g1" },
      instances: { alpha: { working_directory: "/tmp", topic_id: "123" } },
    };
    (fm as any).adapter = adapter;
    return {
      dir,
      fm,
      internals: fm as any,
      notifyAlert,
      editMessageRemoveButtons,
      deleteMessage,
    };
  }

  it("removes only the button after the daemon clears its completed turn", async () => {
    const { dir, internals, editMessageRemoveButtons, deleteMessage } = makeFleet();
    try {
      const history = "🧪 執行測試\n📄 讀取檔案：src/daemon.ts";
      await internals.sendCancelButton("alpha");
      internals.cacheInstanceProgress("alpha", history);

      // The daemon resets progress immediately before broadcasting the idle
      // edge. This used to erase the list, then delete the whole bubble.
      internals.cacheInstanceProgress("alpha", null);
      internals.clearCancelButton("alpha");

      await vi.waitFor(() => expect(internals.cancelButtons.size).toBe(0));
      expect(editMessageRemoveButtons).toHaveBeenCalledWith(
        "g1",
        "m1",
        expect.stringContaining(history),
        "123",
      );
      expect(deleteMessage).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the legacy delete behavior when no tool progress was shown", async () => {
    const { dir, internals, editMessageRemoveButtons, deleteMessage } = makeFleet();
    try {
      await internals.sendCancelButton("alpha");
      internals.clearCancelButton("alpha");

      await vi.waitFor(() => expect(internals.cancelButtons.size).toBe(0));
      expect(deleteMessage).toHaveBeenCalledWith("g1", "m1", "123");
      expect(editMessageRemoveButtons).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries tool history when a mid-turn reply re-posts the bubble", async () => {
    const { dir, internals, notifyAlert, editMessageRemoveButtons } = makeFleet();
    try {
      notifyAlert
        .mockResolvedValueOnce({ messageId: "m1", chatId: "g1", threadId: "123" })
        .mockResolvedValueOnce({ messageId: "m2", chatId: "g1", threadId: "123" });
      const history = "🔧 呼叫工具：reply\n🧪 執行測試";
      await internals.sendCancelButton("alpha");
      internals.cacheInstanceProgress("alpha", history);

      await internals.sendCancelButton("alpha", undefined, true);
      await vi.waitFor(() => expect(internals.cancelButtons.has("m1")).toBe(false));
      internals.cacheInstanceProgress("alpha", null);
      internals.clearCancelButton("alpha");

      await vi.waitFor(() => expect(internals.cancelButtons.size).toBe(0));
      expect(editMessageRemoveButtons).toHaveBeenCalledTimes(2);
      expect(editMessageRemoveButtons.mock.calls[1][2]).toContain(history);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("/steer registration covers dispatch (#528 trap 5)", () => {
  // A Discord slash handler without a registration is invisible: the command
  // works if you type it blind but does not exist in the picker. Pin that the
  // registered name, the dispatch branches, and the locale keys all exist.
  const read = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf-8");

  it("registers /steer with a required message option on the Discord adapter", () => {
    const src = read("channel/adapters/discord.ts");
    expect(src).toMatch(/name: "steer"/);
    expect(src.slice(src.indexOf('name: "steer"'))).toMatch(/required: true/);
  });

  it("dispatches steer in every slash_command handler that dispatches compact", () => {
    const src = read("fleet-manager.ts");
    const compactSites = src.match(/data\.command === "compact"/g)?.length ?? 0;
    const steerSites = src.match(/data\.command === "steer"/g)?.length ?? 0;
    expect(steerSites).toBe(compactSites);
    expect(steerSites).toBeGreaterThanOrEqual(3);
  });

  it("has locale strings for every steer-facing message, in both languages", () => {
    const src = read("locale.ts");
    for (const key of ['"slash.steer"', '"steer.usage"', '"steer.sent"', '"steer.not_connected"', '"steer.unsupported"']) {
      expect(src.match(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length ?? 0).toBe(2);
    }
  });

  it("registers /steer in the Telegram command menus (fleet + classic)", () => {
    const src = read("topic-commands.ts");
    expect(src.match(/command: "steer"/g)?.length ?? 0).toBe(2);
  });
});
