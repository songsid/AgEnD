import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { TopicCommands } from "../src/topic-commands.js";
import { SchedulerDb } from "../src/scheduler/db.js";
import {
  canUnlockAdvancedTips,
  TIPS,
  TIPS_MAX_VISIBLE_LEVEL,
  selectTip,
  visibleTipLevels,
} from "../src/tips.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("tips catalog and persistence", () => {
  it("ships a 100/100/100 catalog and requires an explicit advanced unlock", () => {
    const beginner = TIPS.filter(t => t.level === "beginner");
    const intermediate = TIPS.filter(t => t.level === "intermediate");
    expect(beginner).toHaveLength(100);
    expect(intermediate).toHaveLength(100);
    expect(TIPS.filter(t => t.level === "advanced")).toHaveLength(100);
    expect(new Set(TIPS.map(t => t.id)).size).toBe(300);
    expect(TIPS.every(t => t.text_en.trim() && t.text_zh.trim())).toBe(true);
    const backendTags = new Set([
      "claude-code", "codex", "kiro-cli", "grok", "antigravity", "opencode",
    ]);
    expect(TIPS.flatMap(tip => tip.tags ?? []).every(tag => backendTags.has(tag))).toBe(true);
    expect(TIPS.map(t => t.id)).toEqual(
      Array.from({ length: 300 }, (_, index) => `tip-${String(index + 1).padStart(3, "0")}`),
    );
    expect(TIPS.every(t => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(t.text_en + t.text_zh))).toBe(true);

    // Beginner copy intentionally uses the user's own concise vocabulary:
    // define the term with "=" and immediately state its practical effect.
    const byId = new Map(TIPS.map(tip => [tip.id, tip]));
    expect(byId.get("tip-001")?.text_en).toMatch(/Instance = Agent = one AI CLI/);
    expect(byId.get("tip-001")?.text_zh).toMatch(/instance = Agent =/u);
    expect(byId.get("tip-020")?.text_en).toMatch(/already in conversation history/i);
    expect(byId.get("tip-020")?.text_zh).toMatch(/已進入 Context/u);
    expect(byId.get("tip-021")?.text_en).toMatch(/AgEnD =.+Telegram.+Discord.+Agents/i);
    expect(byId.get("tip-052")?.text_en).toMatch(/localhost.+only on the AgEnD machine/i);
    expect(byId.get("tip-061")?.text_en).toMatch(/Context =.+current conversation.+remember/i);
    expect(byId.get("tip-073")?.text_en).toMatch(/\/update.+restart the fleet/i);
    expect(byId.get("tip-074")?.text_en).toMatch(/whole Fleet, not only/i);
    expect(byId.get("tip-083")?.text_en).toMatch(/latest five lines.+not the entire/i);

    for (const [id, englishConcept, zhConcept] of [
      ["tip-101", "Instance", "instance"],
      ["tip-102", "Fleet", "Fleet"],
      ["tip-103", "General", "General"],
      ["tip-104", "Backend", "Backend"],
      ["tip-105", "Context", "Context"],
      ["tip-106", "MCP", "MCP"],
    ] as const) {
      const tip = byId.get(id)!;
      expect(tip.level).toBe("intermediate");
      expect(tip.text_en).toContain(englishConcept);
      expect(tip.text_zh).toContain(zhConcept);
      // Each glossary entry explains the term in the same sentence instead of
      // assuming that graduating beginner readers already know it.
      expect(tip.text_en.split(/\s+/).length).toBeGreaterThan(8);
      expect(tip.text_zh).toMatch(/[（(].+[）)]/u);
    }

    expect(TIPS.map(tip => tip.text_zh).join("\n")).not.toMatch(
      /AI 助手|助手|AI 引擎|引擎|後端|上下文|前後文|對話空間|工作資料夾|專案資料夾/u,
    );

    const dismissed = new Set(intermediate.slice(0, 59).map(t => t.id));
    expect(canUnlockAdvancedTips(dismissed)).toBe(false);
    dismissed.add(intermediate[59].id);
    expect(canUnlockAdvancedTips(dismissed)).toBe(true);
    expect(TIPS_MAX_VISIBLE_LEVEL).toBe("beginner");
    expect([...visibleTipLevels(false)]).toEqual(["beginner"]);
    expect([...visibleTipLevels(true)]).toEqual(["beginner"]);
    const allBeginner = new Set(beginner.map(t => t.id));
    expect(selectTip(allBeginner, () => 0, false, new Set(["claude-code"]))).toBeNull();
    expect(selectTip(allBeginner, () => 0, true, new Set(["claude-code"]))).toBeNull();

    expect(byId.get("tip-014")?.tags).toEqual(["claude-code", "codex", "grok"]);
    expect(byId.get("tip-069")?.tags).toEqual(["claude-code", "kiro-cli"]);
    expect(byId.get("tip-016")?.tags).toEqual(["claude-code"]);
    expect(byId.get("tip-070")?.tags).toEqual(["kiro-cli"]);

    // Isolate one backend-scoped beginner tip: it is absent without a matching
    // backend and selectable once that backend is active.
    const allButKiroLoad = new Set(beginner
      .filter(tip => tip.id !== "tip-070")
      .map(tip => tip.id));
    expect(selectTip(allButKiroLoad, () => 0, false, new Set(["claude-code"]))).toBeNull();
    expect(selectTip(allButKiroLoad, () => 0, false, new Set(["kiro-cli"]))?.id)
      .toBe("tip-070");
  });

  it("persists idempotent per-user dismissals and exposes fleet-wide distinct ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-tips-db-"));
    dirs.push(dir);
    const db = new SchedulerDb(join(dir, "scheduler.db"));
    db.dismissTip("user-a", "tip-001");
    db.dismissTip("user-a", "tip-001");
    db.dismissTip("user-b", "tip-002");
    db.recordTipFeedback("user-a", "tip-003", "confused");
    db.recordTipFeedback("user-a", "tip-003", "confused");
    expect([...db.listDismissedTipIds()].sort()).toEqual(["tip-001", "tip-002"]);
    expect(db.isAdvancedTipsUnlocked()).toBe(false);
    db.unlockAdvancedTips("user-a");
    db.unlockAdvancedTips("user-b");
    expect(db.isAdvancedTipsUnlocked()).toBe(true);
    expect(db.listTipFeedback()).toEqual([
      expect.objectContaining({
        tip_id: "tip-003",
        user_id: "user-a",
        feedback_type: "confused",
      }),
    ]);
    db.close();
  });
});

describe("tip button flow", () => {
  it("routes the daily tip to the live General topic and honors defaults.tips=false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-daily-tip-"));
    dirs.push(dir);
    const notifyAlert = vi.fn().mockResolvedValue({
      messageId: "daily-tip", chatId: "fleet", threadId: "general-topic",
    });
    const adapter = { id: "tg-main", type: "telegram", notifyAlert } as any;
    const fm = new FleetManager(dir);
    (fm as any).scheduler = { db: {
      listDismissedTipIds: vi.fn(() => new Set<string>()),
      isAdvancedTipsUnlocked: vi.fn(() => false),
    } };
    fm.fleetConfig = {
      defaults: {},
      channels: [{ id: "tg-main", type: "telegram", mode: "topic", group_id: "fleet" }],
      instances: { general: { general_topic: true, topic_id: "general-topic" } },
    } as any;
    fm.worlds.set("tg-main", { id: "tg-main", adapter, groupId: "fleet" } as any);
    (fm as any).daemons.set("general", {});

    await (fm as any).sendTipToGeneral();
    expect(notifyAlert).toHaveBeenCalledWith(
      "fleet", expect.objectContaining({ type: "tip" }), { threadId: "general-topic" },
    );

    fm.fleetConfig.defaults.tips = false;
    await (fm as any).sendTipToGeneral();
    expect(notifyAlert).toHaveBeenCalledTimes(1);
  });

  it("posts a real nonce prompt and permanently dismisses it for the clicking user", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-tip-button-"));
    dirs.push(dir);
    const notifyAlert = vi.fn().mockResolvedValue({
      messageId: "tip-message", chatId: "fleet", threadId: "general-topic",
    });
    const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue({ messageId: "feedback", chatId: "fleet" });
    const adapter = {
      id: "discord-main", type: "discord", notifyAlert, editMessageRemoveButtons, sendText,
    } as any;
    const dismissTip = vi.fn();
    const recordTipFeedback = vi.fn();
    const fm = new FleetManager(dir);
    (fm as any).scheduler = {
      db: {
        listDismissedTipIds: vi.fn(() => new Set<string>()),
        isAdvancedTipsUnlocked: vi.fn(() => false),
        dismissTip,
        recordTipFeedback,
      },
    };
    fm.fleetConfig = { defaults: {}, instances: { general: { general_topic: true } } } as any;

    expect(await fm.promptTip("general", adapter, "fleet", "general-topic")).toBe("posted");
    const alert = notifyAlert.mock.calls[0][1];
    expect(alert.type).toBe("tip");
    expect(alert.message).toMatch(/^💡 Tip: /);
    expect(alert.choices[0].id).toMatch(/^tip-dismiss:[0-9a-f]{32}:dismiss$/);
    expect(alert.choices[1]).toMatchObject({ label: "❓ I don't understand" });
    expect(alert.choices[1].id).toMatch(/^tip-dismiss:[0-9a-f]{32}:confused$/);

    await (fm as any).handleTipDismiss({
      callbackData: alert.choices[1].id,
      chatId: "fleet",
      threadId: "general-topic",
      messageId: "tip-message",
      userId: "reader",
    }, "discord-main", adapter);

    expect(recordTipFeedback).toHaveBeenCalledWith("reader", expect.stringMatching(/^tip-/), "confused");
    expect(dismissTip).not.toHaveBeenCalled();
    expect(editMessageRemoveButtons).toHaveBeenCalledWith(
      "fleet", "tip-message", alert.message, "general-topic",
    );
    expect(sendText).toHaveBeenCalledWith(
      "fleet", "Feedback recorded. Thank you.", { threadId: "general-topic" },
    );

    // Confusion records feedback without dismissing the Tip. A later draw gets
    // a fresh one-shot prompt that can still be acknowledged normally.
    expect(await fm.promptTip("general", adapter, "fleet", "general-topic")).toBe("posted");
    const secondAlert = notifyAlert.mock.calls[1][1];
    await (fm as any).handleTipDismiss({
      callbackData: secondAlert.choices[0].id,
      chatId: "fleet",
      threadId: "general-topic",
      messageId: "tip-message",
      // Deliberately not a fleet admin: a shared informational tip may be
      // acknowledged by the user who sees it; nonce/world binding still holds.
      userId: "reader",
    }, "discord-main", adapter);

    expect(dismissTip).toHaveBeenCalledWith("reader", expect.stringMatching(/^tip-/));
    // Bug 2 fix: dismissal now preserves the tip text AND adds confirmation
    expect(editMessageRemoveButtons).toHaveBeenLastCalledWith(
      "fleet", "tip-message",
      expect.stringContaining(secondAlert.message),  // Original tip preserved
      "general-topic",
    );
    const dismissEditText = editMessageRemoveButtons.mock.calls.at(-1)![2];
    expect(dismissEditText).toContain("Tip dismissed");  // Confirmation added
  });

  it("binds Telegram General tip callbacks to the canonical provider context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-tip-telegram-general-"));
    dirs.push(dir);
    const notifyAlert = vi.fn().mockResolvedValue({
      messageId: "tip-message", chatId: "fleet", threadId: undefined,
    });
    const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue({ messageId: "feedback", chatId: "fleet" });
    const adapter = {
      id: "tg-main", type: "telegram", notifyAlert, editMessageRemoveButtons, sendText,
    } as any;
    const dismissTip = vi.fn();
    const recordTipFeedback = vi.fn();
    const fm = new FleetManager(dir);
    (fm as any).scheduler = { db: {
      listDismissedTipIds: vi.fn(() => new Set<string>()),
      isAdvancedTipsUnlocked: vi.fn(() => false),
      dismissTip,
      recordTipFeedback,
    } };
    fm.fleetConfig = { defaults: {}, instances: { general: { general_topic: true } } } as any;

    // "1" is AgEnD's logical General sentinel. Telegram omits it from the API
    // request and therefore from callback_query.message.message_thread_id.
    expect(await fm.promptTip("general", adapter, "fleet", "1")).toBe("posted");
    const firstAlert = notifyAlert.mock.calls[0][1];
    await (fm as any).handleTipDismiss({
      callbackData: firstAlert.choices[1].id,
      chatId: "fleet",
      threadId: undefined,
      messageId: "tip-message",
      userId: "reader",
    }, "tg-main", adapter);

    expect(recordTipFeedback).toHaveBeenCalledWith("reader", expect.stringMatching(/^tip-/), "confused");
    expect(dismissTip).not.toHaveBeenCalled();
    expect(editMessageRemoveButtons).toHaveBeenLastCalledWith(
      "fleet", "tip-message", firstAlert.message, undefined,
    );

    expect(await fm.promptTip("general", adapter, "fleet", "1")).toBe("posted");
    const secondAlert = notifyAlert.mock.calls[1][1];
    await (fm as any).handleTipDismiss({
      callbackData: secondAlert.choices[0].id,
      chatId: "fleet",
      threadId: undefined,
      messageId: "tip-message",
      userId: "reader",
    }, "tg-main", adapter);

    expect(dismissTip).toHaveBeenCalledWith("reader", expect.stringMatching(/^tip-/));
    expect(editMessageRemoveButtons).toHaveBeenLastCalledWith(
      "fleet", "tip-message", expect.stringContaining("Tip dismissed"), undefined,
    );
  });

  it("keeps exact nonce world binding after canonicalizing the delivery context", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-tip-canonical-security-"));
    dirs.push(dir);
    const notifyAlert = vi.fn().mockResolvedValue({
      messageId: "actual-message", chatId: "actual-chat", threadId: "42",
    });
    const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
    const adapter = {
      id: "tg-main", type: "telegram", notifyAlert, editMessageRemoveButtons,
    } as any;
    const dismissTip = vi.fn();
    const fm = new FleetManager(dir);
    (fm as any).scheduler = { db: {
      listDismissedTipIds: vi.fn(() => new Set<string>()),
      isAdvancedTipsUnlocked: vi.fn(() => false),
      dismissTip,
    } };
    fm.fleetConfig = { defaults: {}, instances: { general: { general_topic: true } } } as any;

    expect(await fm.promptTip("general", adapter, "logical-chat", "logical-thread")).toBe("posted");
    const alert = notifyAlert.mock.calls[0][1];
    const valid = {
      callbackData: alert.choices[0].id,
      chatId: "actual-chat",
      threadId: "42",
      messageId: "actual-message",
      userId: "reader",
    };

    for (const mismatch of [
      { ...valid, chatId: "copied-chat" },
      { ...valid, threadId: "copied-thread" },
      { ...valid, messageId: "copied-message" },
    ]) {
      expect(await (fm as any).handleTipDismiss(mismatch, "tg-main", adapter)).toBe(true);
      expect(dismissTip).not.toHaveBeenCalled();
    }
    expect(await (fm as any).handleTipDismiss(valid, "copied-adapter", adapter)).toBe(true);
    expect(dismissTip).not.toHaveBeenCalled();

    // Mismatched copies do not consume the real nonce; the exact callback can
    // still claim it once.
    expect(await (fm as any).handleTipDismiss(valid, "tg-main", adapter)).toBe(true);
    expect(dismissTip).toHaveBeenCalledOnce();
  });

  it("posts a Discord /tips request in the current non-General channel without an ephemeral corpse", async () => {
    const fm = new FleetManager(mkdtempSync(join(tmpdir(), "agend-tip-slash-")));
    dirs.push(fm.dataDir);
    fm.fleetConfig = {
      defaults: {},
      channels: [{ id: "discord-main", type: "discord", mode: "topic", group_id: "guild-id" }],
      instances: {
        general: { general_topic: true, topic_id: "general-topic" },
        worker: { topic_id: "worker-topic" },
      },
    } as any;
    fm.routing.rebuild(fm.fleetConfig);
    const adapter = { id: "discord-main", type: "discord" } as any;
    fm.adapters.set(adapter.id, adapter);
    fm.worlds.set("discord-main", { id: "discord-main", adapter, groupId: "guild-id" } as any);
    const promptTip = vi.spyOn(fm, "promptTip").mockResolvedValue("posted");
    const respond = vi.fn().mockResolvedValue("ephemeral");
    const dismissResponse = vi.fn().mockResolvedValue(undefined);

    await (fm as any).handleTipsSlash({
      command: "tips",
      channelId: "worker-topic",
      channelName: "worker",
      userId: "reader",
      options: {},
      respond,
      dismissResponse,
    }, adapter.id);

    // The fix: chatId is the guild ID (what Discord callbacks emit), threadId
    // is the channel where /tips was invoked (so the tip posts there).
    expect(promptTip).toHaveBeenCalledWith("worker", adapter, "guild-id", "worker-topic");
    expect(dismissResponse).toHaveBeenCalledOnce();
    expect(respond).not.toHaveBeenCalled();
  });

  it("Discord /tips callback binding matches the real callback shape (chatId=guildId, threadId=channelId)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-tip-slash-callback-"));
    dirs.push(dir);
    const notifyAlert = vi.fn().mockResolvedValue({
      messageId: "tip-msg", chatId: "guild-id", threadId: "some-channel",
    });
    const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
    const adapter = {
      id: "discord-main", type: "discord", notifyAlert, editMessageRemoveButtons,
    } as any;
    const dismissTip = vi.fn();
    const fm = new FleetManager(dir);
    (fm as any).scheduler = {
      db: {
        listDismissedTipIds: vi.fn(() => new Set<string>()),
        isAdvancedTipsUnlocked: vi.fn(() => false),
        dismissTip,
      },
    };
    fm.fleetConfig = {
      defaults: {},
      channels: [{ id: "discord-main", type: "discord", mode: "topic", group_id: "guild-id" }],
      instances: {
        general: { general_topic: true, topic_id: "general-topic" },
        worker: { topic_id: "worker-topic" },
      },
    } as any;
    fm.routing.rebuild(fm.fleetConfig);
    fm.adapters.set(adapter.id, adapter);
    fm.worlds.set("discord-main", { id: "discord-main", adapter, groupId: "guild-id" } as any);

    // Simulate /tips in a non-General channel (the bug scenario)
    const respond = vi.fn().mockResolvedValue("ephemeral");
    const dismissResponse = vi.fn().mockResolvedValue(undefined);
    await (fm as any).handleTipsSlash({
      command: "tips",
      channelId: "some-channel",  // Where the slash command was invoked
      channelName: "worker",
      userId: "reader",
      options: {},
      respond,
      dismissResponse,
    }, adapter.id);

    expect(notifyAlert).toHaveBeenCalledWith(
      "guild-id",  // chatId: the canonical group ID
      expect.objectContaining({ type: "tip" }),
      { threadId: "some-channel" },  // threadId: where the tip posts
    );
    const alert = notifyAlert.mock.calls[0][1];

    // Simulate the Discord callback with the REAL shape Discord emits:
    // chatId = guildId, threadId = channelId (where button was clicked)
    await (fm as any).handleTipDismiss({
      callbackData: alert.choices[0].id,  // dismiss action
      chatId: "guild-id",       // Discord emits guildId here
      threadId: "some-channel", // Discord emits interaction.channelId here
      messageId: "tip-msg",
      userId: "reader",
    }, "discord-main", adapter);

    // The callback should be CONSUMED and the tip dismissed (not rejected)
    expect(dismissTip).toHaveBeenCalledWith("reader", expect.stringMatching(/^tip-/));
    expect(editMessageRemoveButtons).toHaveBeenCalledWith(
      "guild-id", "tip-msg",
      expect.stringContaining("Tip dismissed"),  // Bug 2 fix: confirmation visible
      "some-channel",
    );
    // Also verify the edited message still contains the original tip text
    const editedText = editMessageRemoveButtons.mock.calls[0][2];
    expect(editedText).toContain("💡 Tip:");  // Original tip preserved
    expect(editedText).toContain("Tip dismissed");  // Confirmation added
  });

  it("persists the explicit advanced unlock when its retained prompt is confirmed", async () => {
    const notifyAlert = vi.fn().mockResolvedValue({
      messageId: "unlock-message", chatId: "fleet", threadId: "general-topic",
    });
    const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
    const adapter = {
      id: "discord-main", type: "discord", notifyAlert, editMessageRemoveButtons,
    } as any;
    const unlockAdvancedTips = vi.fn();
    const fm = new FleetManager("/tmp/agend-tip-unlock-test");
    (fm as any).scheduler = { db: {
      listDismissedTipIds: vi.fn(() => new Set<string>()),
      isAdvancedTipsUnlocked: vi.fn(() => false),
      unlockAdvancedTips,
    } };
    fm.fleetConfig = { defaults: {}, instances: { general: { general_topic: true } } } as any;

    expect(await (fm as any).promptAdvancedTipUnlock(
      "general", adapter, "fleet", "general-topic",
    )).toBe(true);
    const alert = notifyAlert.mock.calls[0][1];
    expect(alert.message).toContain("60");
    expect(alert.message).toContain("fleet");
    expect(alert.choices[0].id).toMatch(/^tip-unlock:[0-9a-f]{32}:unlock$/);

    await (fm as any).handleTipUnlock({
      callbackData: alert.choices[0].id,
      chatId: "fleet",
      threadId: "general-topic",
      messageId: "unlock-message",
      userId: "reader",
    }, "discord-main", adapter);

    expect(unlockAdvancedTips).toHaveBeenCalledWith("reader");
    expect(editMessageRemoveButtons).toHaveBeenCalledWith(
      "fleet", "unlock-message", expect.stringContaining("unlocked"), "general-topic",
    );
  });

  it("/tips modes persist settings, allow an admin unlock, and bare /tips requests a button", async () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: "reply", chatId: "fleet" });
    const promptTip = vi.fn().mockResolvedValue("posted");
    const saveFleetConfig = vi.fn();
    const unlockAdvancedTips = vi.fn(() => true);
    const ctx = {
      adapter: { id: "tg", type: "telegram", sendText },
      fleetConfig: { defaults: {}, instances: { general: { general_topic: true } } },
      isFleetAdmin: vi.fn(() => true),
      saveFleetConfig,
      promptTip,
      unlockAdvancedTips,
    } as any;
    const commands = new TopicCommands(ctx);
    const message = (text: string) => ({
      source: "telegram", adapterId: "tg", chatId: "fleet", threadId: "general-topic",
      messageId: "m1", userId: "admin", username: "admin", timestamp: new Date(), text,
    });

    expect(await commands.handleGeneralCommand(message("/tips off"))).toBe(true);
    expect(ctx.fleetConfig.defaults.tips).toBe(false);
    expect(saveFleetConfig).toHaveBeenCalledTimes(1);

    await commands.handleGeneralCommand(message("/tips on"));
    expect(ctx.fleetConfig.defaults.tips).toBe(true);
    expect(saveFleetConfig).toHaveBeenCalledTimes(2);

    await commands.handleGeneralCommand(message("/tips advanced on"));
    expect(unlockAdvancedTips).toHaveBeenCalledWith("admin");
    expect(sendText).toHaveBeenCalledWith(
      "fleet", expect.stringContaining("Advanced tips unlocked"), { threadId: "general-topic" },
    );

    ctx.isFleetAdmin.mockReturnValue(false);
    await commands.handleGeneralCommand({ ...message("/tips advanced on"), userId: "guest" });
    expect(unlockAdvancedTips).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenLastCalledWith(
      "fleet", expect.stringMatching(/permission|authorized/i), { threadId: "general-topic" },
    );

    await commands.handleGeneralCommand(message("/tips"));
    expect(promptTip).toHaveBeenCalledWith("general", ctx.adapter, "fleet", "general-topic");

    await commands.handleInstanceCommand(
      { ...message("/tips"), threadId: "worker-topic" },
      "worker",
    );
    expect(promptTip).toHaveBeenLastCalledWith("general", ctx.adapter, "fleet", "worker-topic");
  });
});

describe("stale tip buttons (restart-orphaned)", () => {
  function makeFm() {
    const dir = mkdtempSync(join(tmpdir(), "agend-tip-stale-"));
    dirs.push(dir);
    const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
    const removeMessageButtons = vi.fn().mockResolvedValue(undefined);
    const sendText = vi.fn().mockResolvedValue({ messageId: "hint" });
    const adapter = { id: "tg-main", type: "telegram", editMessageRemoveButtons, removeMessageButtons, sendText } as any;
    const fm = new FleetManager(dir);
    fm.fleetConfig = { defaults: {}, instances: {} } as any;
    return { fm, adapter, editMessageRemoveButtons, removeMessageButtons, sendText };
  }

  const staleClick = {
    callbackData: "tip-dismiss:00000000000000000000000000000000:dismiss",
    chatId: "fleet", threadId: "general-topic", messageId: "old-tip", userId: "reader",
  };

  it("keeps the tip text (keyboard-only removal) and always posts the /tips hint", async () => {
    const { fm, adapter, editMessageRemoveButtons, removeMessageButtons, sendText } = makeFm();
    const consumed = await (fm as any).handleTipDismiss(staleClick, "tg-main", adapter);
    expect(consumed).toBe(true);
    expect(removeMessageButtons).toHaveBeenCalledWith("fleet", "old-tip", "general-topic");
    // The tip content must NOT be replaced by a generic stale line.
    expect(editMessageRemoveButtons).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith("fleet", expect.stringContaining("/tips"), { threadId: "general-topic" });
  });

  it("still posts the hint when the keyboard edit is refused (Telegram >48h)", async () => {
    const { fm, adapter, removeMessageButtons, sendText } = makeFm();
    removeMessageButtons.mockRejectedValue(new Error("message can't be edited"));
    expect(await (fm as any).handleTipDismiss(staleClick, "tg-main", adapter)).toBe(true);
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
  });

  it("falls back to the legacy collapse when the adapter lacks keyboard-only removal", async () => {
    const { fm, adapter, editMessageRemoveButtons } = makeFm();
    delete (adapter as any).removeMessageButtons;
    await (fm as any).handleTipDismiss(staleClick, "tg-main", adapter);
    expect(editMessageRemoveButtons).toHaveBeenCalled();
  });

  it("stale unlock buttons behave the same", async () => {
    const { fm, adapter, removeMessageButtons, sendText } = makeFm();
    const consumed = await (fm as any).handleTipUnlock({
      ...staleClick, callbackData: "tip-unlock:00000000000000000000000000000000:unlock",
    }, "tg-main", adapter);
    expect(consumed).toBe(true);
    expect(removeMessageButtons).toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith("fleet", expect.stringContaining("/tips"), { threadId: "general-topic" });
  });

  it("non-tip stale prompts keep the original collapse semantics (no hint spam)", async () => {
    const { fm, adapter, editMessageRemoveButtons, removeMessageButtons, sendText } = makeFm();
    const consumed = (fm as any).consumeNonceCallback(
      "hang:", /^hang:([0-9a-f]+):(restart|wait)$/,
      { ...staleClick, callbackData: "hang:00000000000000000000000000000000:restart" },
      "tg-main", adapter,
    );
    expect(consumed).toBe("consumed");
    expect(editMessageRemoveButtons).toHaveBeenCalled();
    expect(removeMessageButtons).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });
});
