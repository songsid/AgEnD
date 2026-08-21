import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { TopicCommands } from "../src/topic-commands.js";
import { SchedulerDb } from "../src/scheduler/db.js";
import { canUnlockAdvancedTips, TIPS, selectTip, visibleTipLevels } from "../src/tips.js";

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
    expect(TIPS.map(t => t.id)).toEqual(
      Array.from({ length: 300 }, (_, index) => `tip-${String(index + 1).padStart(3, "0")}`),
    );
    expect(TIPS.every(t => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(t.text_en + t.text_zh))).toBe(true);

    // Beginner tips are mobile-chat onboarding copy. Architecture vocabulary is
    // introduced (with definitions) in the intermediate tier, never leaked into
    // the first hundred tips as unexplained implementation detail.
    const beginnerTechnicalTerms = /\b(?:MCP|tmux|pane|daemon|stdio|epoch|IPC|CLI|instance|backend|fleet|context)\b|fleet\.yaml|config key/iu;
    for (const tip of beginner) {
      expect(`${tip.id}: ${tip.text_en}`).not.toMatch(beginnerTechnicalTerms);
      expect(`${tip.id}: ${tip.text_zh}`).not.toMatch(beginnerTechnicalTerms);
    }

    const firstFiftyNonChatTerms = /\b(?:General|model|quota|administrator|Settings|Claude Code|Codex|Kiro|Grok|Antigravity|OpenCode)\b|\/(?:pause|wake|restart|update|dashboard|status|clear|model|effort|raw|doctor|sysinfo)\b/iu;
    for (const tip of beginner.slice(0, 50)) {
      expect(`${tip.id}: ${tip.text_en}`).not.toMatch(firstFiftyNonChatTerms);
      expect(`${tip.id}: ${tip.text_zh}`).not.toMatch(firstFiftyNonChatTerms);
    }

    const beginnerAdminSurface = /\/(?:pause|wake|restart|update|dashboard|status|clear|model|effort|raw|doctor|sysinfo)\b|\/tips\s+(?:on|off)\b|\bSettings\b|管理員/u;
    for (const tip of beginner) {
      expect(`${tip.id}: ${tip.text_en}`).not.toMatch(beginnerAdminSurface);
      expect(`${tip.id}: ${tip.text_zh}`).not.toMatch(beginnerAdminSurface);
    }
    expect(beginner[20]).toMatchObject({ id: "tip-021" });
    expect(beginner[20].text_en).toMatch(/AgEnD.+connects?.+chat.+AI assistant/i);
    expect(beginner[20].text_zh).toMatch(/AgEnD.+聊天室.+AI 助手/u);

    const byId = new Map(TIPS.map(tip => [tip.id, tip]));
    for (const [id, concept] of [
      ["tip-101", "Instance"],
      ["tip-102", "Fleet"],
      ["tip-103", "General"],
      ["tip-104", "Backend"],
      ["tip-105", "Context"],
      ["tip-106", "MCP"],
    ] as const) {
      const tip = byId.get(id)!;
      expect(tip.level).toBe("intermediate");
      expect(tip.text_en).toContain(concept);
      expect(tip.text_zh).toContain(concept);
      // Each glossary entry explains the term in the same sentence instead of
      // assuming that graduating beginner readers already know it.
      expect(tip.text_en.split(/\s+/).length).toBeGreaterThan(8);
      expect(tip.text_zh).toMatch(/[（(].+[）)]/u);
    }

    const dismissed = new Set(intermediate.slice(0, 59).map(t => t.id));
    expect(canUnlockAdvancedTips(dismissed)).toBe(false);
    dismissed.add(intermediate[59].id);
    expect(canUnlockAdvancedTips(dismissed)).toBe(true);
    expect(visibleTipLevels(false).has("advanced")).toBe(false);
    expect(visibleTipLevels(true).has("advanced")).toBe(true);
    const allBasic = new Set(TIPS.filter(t => t.level !== "advanced").map(t => t.id));
    expect(selectTip(allBasic, () => 0, false)).toBeNull();
    expect(selectTip(allBasic, () => 0, true)?.level).toBe("advanced");
  });

  it("persists idempotent per-user dismissals and exposes fleet-wide distinct ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "agend-tips-db-"));
    dirs.push(dir);
    const db = new SchedulerDb(join(dir, "scheduler.db"));
    db.dismissTip("user-a", "tip-001");
    db.dismissTip("user-a", "tip-001");
    db.dismissTip("user-b", "tip-002");
    expect([...db.listDismissedTipIds()].sort()).toEqual(["tip-001", "tip-002"]);
    expect(db.isAdvancedTipsUnlocked()).toBe(false);
    db.unlockAdvancedTips("user-a");
    db.unlockAdvancedTips("user-b");
    expect(db.isAdvancedTipsUnlocked()).toBe(true);
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
    fm.fleetConfig = { defaults: {}, instances: { general: { general_topic: true } } } as any;

    expect(await fm.promptTip("general", adapter, "fleet", "general-topic")).toBe("posted");
    const alert = notifyAlert.mock.calls[0][1];
    expect(alert.type).toBe("tip");
    expect(alert.message).toMatch(/^💡 Tip: /);
    expect(alert.choices[0].id).toMatch(/^tip-dismiss:[0-9a-f]{32}:dismiss$/);

    await (fm as any).handleTipDismiss({
      callbackData: alert.choices[0].id,
      chatId: "fleet",
      threadId: "general-topic",
      messageId: "tip-message",
      // Deliberately not a fleet admin: a shared informational tip may be
      // acknowledged by the user who sees it; nonce/world binding still holds.
      userId: "reader",
    }, "discord-main", adapter);

    expect(dismissTip).toHaveBeenCalledWith("reader", expect.stringMatching(/^tip-/));
    expect(editMessageRemoveButtons).toHaveBeenCalledWith(
      "fleet", "tip-message", alert.message, "general-topic",
    );
  });

  it("offers and persists the explicit advanced unlock after 60 intermediate dismissals", async () => {
    const notifyAlert = vi.fn().mockResolvedValue({
      messageId: "unlock-message", chatId: "fleet", threadId: "general-topic",
    });
    const editMessageRemoveButtons = vi.fn().mockResolvedValue(undefined);
    const adapter = {
      id: "discord-main", type: "discord", notifyAlert, editMessageRemoveButtons,
    } as any;
    const dismissed = new Set(
      TIPS.filter(t => t.level === "intermediate").slice(0, 60).map(t => t.id),
    );
    const unlockAdvancedTips = vi.fn();
    const fm = new FleetManager("/tmp/agend-tip-unlock-test");
    (fm as any).scheduler = { db: {
      listDismissedTipIds: vi.fn(() => dismissed),
      isAdvancedTipsUnlocked: vi.fn(() => false),
      unlockAdvancedTips,
    } };
    fm.fleetConfig = { defaults: {}, instances: { general: { general_topic: true } } } as any;

    expect(await fm.promptTip("general", adapter, "fleet", "general-topic")).toBe("posted");
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
  });
});
