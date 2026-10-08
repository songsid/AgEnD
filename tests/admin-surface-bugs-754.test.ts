/**
 * #754 / #1148 audit, PR-A: the bugs it found in who may do what. Each case is the old behaviour, which these assertions
 * refuse, next to the control that still works.
 *
 *  - the cancel button interrupted for anyone who clicked it, through any adapter, from any message;
 *  - typed `/raw <text>` pasted raw CLI input for anyone who may speak in the topic;
 *  - the advanced-tips unlock button changed a persistent setting for any clicker;
 *  - Telegram /collab, /compact, /save had no admin check (Discord: channel-admin);
 *  - the /model and /effort menus did not re-check the clicker's admin status or the adapter on click;
 *  - /pause and /wake from a General reached another bot's instances;
 *  - fleet-admin slash commands ran from a ClassicBot channel in a foreign guild.
 *
 * A two-bot fleet on Telegram (tg-a owns alpha, tg-b owns beta, one group). Nothing reaches a real CLI, tmux or chat:
 * delivery and every pane action are stubs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetManager } from "../src/fleet-manager.js";
import { decideSlash } from "../src/slash-authz.js";
import { t } from "../src/locale.js";

const GROUP = "-1001";
const ADMIN_A = "111";
const ADMIN_B = "222";
const PLAIN = "333";
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function rig(mode: "open" | "locked" = "open") {
  const dir = join(tmpdir(), `agend-754-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const fm = new FleetManager(dir);
  const any = fm as unknown as Record<string, any>;
  const replies: Array<{ adapter: string; text: string }> = [];
  const adapter = (id: string) => ({
    id, type: "telegram",
    sendText: vi.fn(async (_chat: string, text: string) => { replies.push({ adapter: id, text: String(text) }); return { messageId: "r", chatId: GROUP }; }),
    editMessage: vi.fn(async () => {}), react: async () => {}, unreact: async () => {},
  });
  const a = adapter("tg-a"); const b = adapter("tg-b");
  const cfgA = { id: "tg-a", type: "telegram", mode: "topic", group_id: GROUP, access: { mode, allowed_users: [ADMIN_A] }, bot_token_env: "X" };
  const cfgB = { id: "tg-b", type: "telegram", mode: "topic", group_id: GROUP, access: { mode, allowed_users: [ADMIN_B] }, bot_token_env: "Y" };
  any.adapter = a;
  any.adapters.set("tg-a", a); any.adapters.set("tg-b", b);
  const access = (cfg: { access: { mode: string; allowed_users: string[] } }) => ({ isAllowed: (u: string) => cfg.access.mode === "open" || cfg.access.allowed_users.includes(u) });
  any.worlds.set("tg-a", { id: "tg-a", adapter: a, channelConfig: cfgA, groupId: GROUP, accessManager: access(cfgA) });
  any.worlds.set("tg-b", { id: "tg-b", adapter: b, channelConfig: cfgB, groupId: GROUP, accessManager: access(cfgB) });
  fm.fleetConfig = {
    defaults: { backend: "claude-code" }, channels: [cfgA, cfgB], channel: cfgA,
    instances: {
      general: { working_directory: dir, topic_id: 1, general_topic: true, channel_id: "tg-a" },
      alpha: { working_directory: dir, topic_id: 30, channel_id: "tg-a" },
      beta: { working_directory: dir, topic_id: 40, channel_id: "tg-b" },
    },
  } as never;
  fm.routing.rebuild(fm.fleetConfig!);
  // Nothing real: an interrupt, a pause/wake, a delivery are recorded and never executed.
  const cancelled: string[] = [];
  any.cancelInstance = (name: string) => { cancelled.push(name); return true; };
  const pausedWoken: string[] = [];
  any.topicCommands.runPauseWake = async (name: string, action: string) => { pausedWoken.push(`${action}:${name}`); return "ok"; };
  any.toggleFleetCollab = () => true;
  return { fm, any, a, b, replies, cancelled, pausedWoken };
}

const typed = (text: string, userId: string, threadId = "30", adapterId = "tg-a") =>
  ({ source: "telegram", adapterId, chatId: GROUP, threadId, messageId: `m-${Math.random()}`, userId, username: "u", text, timestamp: new Date() }) as never;

describe("the cancel button interrupts only for someone its instance's adapter lets speak, on that instance's own button", () => {
  it("a live button, clicked by someone the owner lets speak, through the owner: interrupted (control)", () => {
    const r = rig("locked");
    r.any.cancelButtons.set("btn-a", { instanceName: "alpha", messageId: "btn-a", chatId: GROUP, adapterId: "tg-a" });
    r.any.handleCancelClick("alpha", r.a, { callbackData: "cancel:alpha", chatId: GROUP, messageId: "btn-a", userId: ADMIN_A }, "tg-a");
    expect(r.cancelled).toEqual(["alpha"]);
  });

  it("someone the owner's access policy does not let speak: refused", () => {
    const r = rig("locked");
    r.any.cancelButtons.set("btn-a", { instanceName: "alpha", messageId: "btn-a", chatId: GROUP, adapterId: "tg-a" });
    const ack = vi.fn();
    r.any.handleCancelClick("alpha", r.a, { callbackData: "cancel:alpha", chatId: GROUP, messageId: "btn-a", userId: PLAIN, ack }, "tg-a");
    expect(r.cancelled).toEqual([]);
    expect(ack).toHaveBeenCalledWith(t("buttons.not_allowed"));
  });

  it("a click arriving through another bot than the instance's owner: refused", () => {
    const r = rig("open");
    r.any.cancelButtons.set("btn-a", { instanceName: "alpha", messageId: "btn-a", chatId: GROUP, adapterId: "tg-a" });
    r.any.handleCancelClick("alpha", r.b, { callbackData: "cancel:alpha", chatId: GROUP, messageId: "btn-a", userId: ADMIN_B }, "tg-b");
    expect(r.cancelled).toEqual([]);
  });

  it("callback data naming one instance on another instance's live button: refused", () => {
    const r = rig("open");
    r.any.cancelButtons.set("btn-b", { instanceName: "beta", messageId: "btn-b", chatId: GROUP, adapterId: "tg-b" });
    r.any.handleCancelClick("alpha", r.a, { callbackData: "cancel:alpha", chatId: GROUP, messageId: "btn-b", userId: ADMIN_A }, "tg-a");
    expect(r.cancelled).toEqual([]);
  });

  it("a click with no user id (Telegram always carries one): refused", () => {
    const r = rig("open");
    r.any.cancelButtons.set("btn-a", { instanceName: "alpha", messageId: "btn-a", chatId: GROUP, adapterId: "tg-a" });
    r.any.handleCancelClick("alpha", r.a, { callbackData: "cancel:alpha", chatId: GROUP, messageId: "btn-a" }, "tg-a");
    expect(r.cancelled).toEqual([]);
  });
});

describe("typed /raw is CLI input: only the owning bot's fleet admin may send it", () => {
  it("a member who may speak (open mode) but is not an admin: refused, nothing delivered", async () => {
    const r = rig("open");
    expect(await r.any.topicCommands.handleInstanceCommand(typed("/raw /clear", PLAIN), "alpha")).toBe(true);
    expect(r.replies.map(x => x.text)).toEqual([t("permission.denied")]);
  });

  it("the owner's fleet admin: falls through to delivery unchanged (the daemon pastes it raw)", async () => {
    const r = rig("open");
    expect(await r.any.topicCommands.handleInstanceCommand(typed("/raw /clear", ADMIN_A), "alpha")).toBe(false);
    expect(r.replies).toEqual([]);
  });
});

describe("Telegram /collab, /compact, /save are channel-admin, as on Discord", () => {
  for (const text of ["/collab", "/compact", "/save notes.md"]) {
    it(`${text}: a member who may speak is refused; the owner's fleet admin is not`, async () => {
      const r = rig("open");
      const sendCompact = vi.spyOn(r.any.topicCommands, "sendCompact").mockResolvedValue("compacted");
      const sendSave = vi.spyOn(r.any.topicCommands, "sendSave").mockResolvedValue("saved");
      expect(await r.any.topicCommands.handleInstanceCommand(typed(text, PLAIN), "alpha")).toBe(true);
      expect(r.replies.map(x => x.text)).toEqual([t("permission.denied")]);
      expect(sendCompact).not.toHaveBeenCalled();
      expect(sendSave).not.toHaveBeenCalled();
      r.replies.length = 0;
      expect(await r.any.topicCommands.handleInstanceCommand(typed(text, ADMIN_A), "alpha")).toBe(true);
      expect(r.replies.map(x => x.text)).not.toContain(t("permission.denied"));
    });
  }
});

describe("/pause and /wake from a General reach its own bot's instances only", () => {
  it("Telegram General of tg-a: its own instance is paused; tg-b's is refused", async () => {
    const r = rig("open");
    await r.any.topicCommands.handleInstanceCommand(typed("/pause alpha", ADMIN_A, "1"), "general");
    await r.any.topicCommands.handleInstanceCommand(typed("/pause beta", ADMIN_A, "1"), "general");
    expect(r.pausedWoken).toEqual(["pause:alpha"]);
    expect(r.replies.map(x => x.text)).toContain(t("instance.other_bot", "beta"));
  });

  it("Discord-style slash from tg-a's General: the same", async () => {
    const r = rig("open");
    const respond = vi.fn(async () => undefined);
    vi.spyOn(r.any.routing, "resolve").mockReturnValue({ kind: "general", name: "general" });
    await r.any.handlePauseWakeSlash({ command: "wake", channelId: "1", userId: ADMIN_A, options: { instance: "beta" }, respond }, "tg-a");
    await r.any.handlePauseWakeSlash({ command: "wake", channelId: "1", userId: ADMIN_A, options: { instance: "alpha" }, respond }, "tg-a");
    expect(r.pausedWoken).toEqual(["wake:alpha"]);
    expect(respond).toHaveBeenCalledWith(t("instance.other_bot", "beta"));
  });
});

describe("the advanced-tips unlock is an admin action", () => {
  it("a plain clicker cannot confirm it; the bot's fleet admin can", async () => {
    const r = rig("open");
    const unlockAdvancedTips = vi.fn();
    r.any.scheduler = { db: { listDismissedTipIds: () => new Set<string>(), isAdvancedTipsUnlocked: () => false, unlockAdvancedTips } };
    const notifyAlert = vi.fn().mockResolvedValue({ messageId: "unlock", chatId: GROUP, threadId: "1" });
    const adapter = { id: "tg-a", type: "telegram", notifyAlert, editMessageRemoveButtons: vi.fn(async () => {}) };
    expect(await r.any.promptAdvancedTipUnlock("general", adapter, GROUP, "1")).toBe(true);
    const id = notifyAlert.mock.calls[0][1].choices[0].id;
    const click = (userId: string) => r.any.handleTipUnlock({ callbackData: id, chatId: GROUP, threadId: "1", messageId: "unlock", userId, ack: vi.fn() }, "tg-a", adapter);
    await click(PLAIN);
    expect(unlockAdvancedTips).not.toHaveBeenCalled();
    await click(ADMIN_A);
    expect(unlockAdvancedTips).toHaveBeenCalledWith(ADMIN_A);
  });
});

describe("the /model and /effort menus re-check the clicker and the adapter when clicked", () => {
  async function modelMenu(r: ReturnType<typeof rig>) {
    vi.spyOn(r.any, "getModelOptions").mockResolvedValue([{ id: "m1", label: "M1" }, { id: "m2", label: "M2" }]);
    const applyModel = vi.spyOn(r.fm, "applyModel").mockResolvedValue("✅");
    const promptUser = vi.fn().mockResolvedValue("menu");
    const adapter = { id: "tg-a", type: "telegram", promptUser, editMessageRemoveButtons: vi.fn(async () => {}), editMessage: vi.fn(async () => {}), sendText: vi.fn(async () => ({ messageId: "p" })) } as never;
    await r.fm.promptModelMenu("alpha", ADMIN_A, "30", adapter, GROUP, "30", "tg-a");
    const choice = (promptUser.mock.calls[0] as any)[2].find((c: { id: string }) => c.id.endsWith(":m2")).id;
    const click = (userId: string | undefined, adapterId = "tg-a") => r.any.handleModelSelection({ callbackData: choice, chatId: GROUP, threadId: "30", messageId: "menu", userId, ack: vi.fn() }, adapterId);
    return { applyModel, click };
  }

  it("the admin who opened it, still an admin, through the same bot: applied (control)", async () => {
    const r = rig("open");
    const m = await modelMenu(r);
    await m.click(ADMIN_A);
    expect(m.applyModel).toHaveBeenCalledWith("alpha", "m2");
  });

  it("the same admin after losing admin while the menu was open: not applied", async () => {
    const r = rig("open");
    const m = await modelMenu(r);
    (r.fm.fleetConfig as any).channels[0].access.allowed_users = [];
    await m.click(ADMIN_A);
    expect(m.applyModel).not.toHaveBeenCalled();
  });

  it("the click arriving through another bot: not applied, even from someone who is an admin of both bots", async () => {
    const r = rig("open");
    (r.fm.fleetConfig as any).channels[1].access.allowed_users.push(ADMIN_A);
    const m = await modelMenu(r);
    await m.click(ADMIN_A, "tg-b");
    expect(m.applyModel).not.toHaveBeenCalled();
  });

  it("a click with no user id: not applied", async () => {
    const r = rig("open");
    const m = await modelMenu(r);
    await m.click(undefined);
    expect(m.applyModel).not.toHaveBeenCalled();
  });

  it("the effort menu: an admin who lost admin cannot apply it", async () => {
    const r = rig("open");
    vi.spyOn(r.any, "effortLevelsFor").mockReturnValue(["low", "high"]);
    const applyEffort = vi.spyOn(r.fm, "applyEffort").mockResolvedValue("✅");
    const promptUser = vi.fn().mockResolvedValue("menu");
    const adapter = { id: "tg-a", type: "telegram", promptUser, editMessageRemoveButtons: vi.fn(async () => {}), editMessage: vi.fn(async () => {}), sendText: vi.fn(async () => ({ messageId: "p" })) } as never;
    await r.fm.promptEffortMenu("alpha", ADMIN_A, "30", adapter, GROUP, "30", "tg-a");
    const id = (promptUser.mock.calls[0] as any)[2].find((c: { id: string }) => c.id.endsWith(":high")).id;
    (r.fm.fleetConfig as any).channels[0].access.allowed_users = [];
    await r.any.handleEffortSelection({ callbackData: id, chatId: GROUP, threadId: "30", messageId: "menu", userId: ADMIN_A, ack: vi.fn() }, "tg-a");
    expect(applyEffort).not.toHaveBeenCalled();
  });
});

describe("fleet-admin slash commands need the fleet's own guild, also from a ClassicBot channel", () => {
  const base = { primaryGuildId: "G-fleet", speaker: "allowed" as const };
  it("a foreign guild's ClassicBot channel: a fleet-admin command is refused, an ordinary one still runs", () => {
    expect(decideSlash({ ...base, command: "update", guildId: "G-other", scope: "classic", fleetAdminCommand: true })).toEqual({ allow: false, reason: "wrong-guild" });
    expect(decideSlash({ ...base, command: "chat", guildId: "G-other", scope: "classic", fleetAdminCommand: false })).toEqual({ allow: true });
  });
  it("the fleet's own guild: the fleet-admin command reaches its own admin check (the door does not refuse it)", () => {
    expect(decideSlash({ ...base, command: "update", guildId: "G-fleet", scope: "classic", fleetAdminCommand: true })).toEqual({ allow: true });
  });
  it("through the real door: /update from a foreign guild's ClassicBot channel is refused, /chat there is let in", async () => {
    const r = rig("open");
    (r.fm.fleetConfig as any).channels[0].group_id = "G-fleet";
    r.any.classicChannels = { isClassicChannel: () => true, getInstanceByChannel: () => "classic-1", hasChannel: () => true, isAdmin: () => false };
    const ask = async (command: string) => {
      const respond = vi.fn(async () => undefined);
      const scope = await r.any.authorizeSlash({ command, channelId: "cc-1", guildId: "G-other", userId: ADMIN_A, respond }, "tg-a");
      return { scope, respond };
    };
    const update = await ask("update");
    expect(update.scope).toBeNull();
    expect(update.respond).toHaveBeenCalledWith(t("slash.wrong_server"));
    expect((await ask("chat")).scope).toBe("classic");
  });

  it("the facts come from the command table: /update in a ClassicBot channel is a fleet-admin command there", async () => {
    const { commandSpec, ruleFor } = await import("../src/command-table.js");
    const rule = ruleFor(commandSpec("update")!, "classic", "discord");
    expect("level" in rule && rule.level).toBe("fleet-admin");
  });
});
