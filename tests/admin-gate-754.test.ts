/**
 * #754 / #1148 audit, PR-B: one fleet-admin gate. (The rig below is PR-A's two-bot fleet.)
 *
 *  - `adminGate(user, ownerAdapterId)`: the owning adapter's list only — an unknown adapter is nobody (no fallback to
 *    the primary channel), an empty list is nobody (`disabled`);
 *  - a Discord slash command in a channel owned by another bot of the fleet is refused (`other-bot`), so every admin
 *    check after the door is about the owning bot;
 *  - Telegram typed commands are decided by the same command table as Discord slash commands, before any handler.
 *
 * Kept from PR-A's header for the rig:
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
import { commandSpec } from "../src/command-table.js";

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


describe("adminGate: the owning adapter's list, and nothing else", () => {
  it("listed → ok; another adapter's admin → denied; an empty list → disabled", () => {
    const r = rig("open");
    expect(r.fm.adminGate(ADMIN_A, "tg-a")).toBe("ok");
    expect(r.fm.adminGate(ADMIN_B, "tg-a")).toBe("denied");
    (r.fm.fleetConfig as any).channels[1].access.allowed_users = [];
    expect(r.fm.adminGate(ADMIN_B, "tg-b")).toBe("disabled");
  });
  it("an adapter id that matches nothing is nobody — never the primary channel's list", () => {
    const r = rig("open");
    expect(r.fm.adminGate(ADMIN_A, "no-such-adapter")).toBe("denied");
    expect(r.fm.isFleetAdmin(ADMIN_A, "no-such-adapter")).toBe(false);
    expect(r.fm.hasFleetAdmins("no-such-adapter")).toBe(false);
    // (getChannelConfig, which other code uses for non-admin settings, still falls back — the admin path does not.)
    expect(r.fm.getChannelConfig("no-such-adapter")?.id).toBe("tg-a");
  });
  it("no adapter id at all means the primary adapter (a single-adapter fleet's only one)", () => {
    const r = rig("open");
    expect(r.fm.adminGate(ADMIN_A)).toBe("ok");
    expect(r.fm.adminGate(ADMIN_B)).toBe("denied");
  });
});

describe("a Discord slash command in a channel another bot owns is refused at the door", () => {
  const ask = (r: ReturnType<typeof rig>, channelId: string, userId: string, adapterId: string) =>
    r.any.slashDoor({ command: "status", channelId, guildId: GROUP, userId, respond: vi.fn() }, adapterId);
  it("beta belongs to tg-b: through tg-a it is refused even for an admin of both; through tg-b it reaches the table", async () => {
    const r = rig("open");
    (r.fm.fleetConfig as any).channels[1].access.allowed_users.push(ADMIN_A);
    expect(ask(r, "40", ADMIN_A, "tg-a")).toEqual({ refusal: "slash.other_bot" });
    expect(ask(r, "40", ADMIN_A, "tg-b")).toEqual({ scope: "fleet" });
    expect(ask(r, "30", ADMIN_A, "tg-a")).toEqual({ scope: "fleet" });   // its own channel: unchanged
  });
  it("the facts: decideSlash refuses other-bot in a fleet channel, and keeps owner-not-running when the owner is down", () => {
    const base = { command: "status", guildId: "G", primaryGuildId: "G", scope: "fleet" as const };
    expect(decideSlash({ ...base, speaker: "allowed", otherBotOwns: true })).toEqual({ allow: false, reason: "other-bot" });
    expect(decideSlash({ ...base, speaker: "owner-not-running", otherBotOwns: true })).toEqual({ allow: false, reason: "owner-not-running" });
    expect(decideSlash({ ...base, speaker: "allowed", otherBotOwns: false })).toEqual({ allow: true });
  });
});

describe("Telegram typed commands are decided by the command table before any handler", () => {
  it("/status in General from a member: the table's refusal, and the handler never runs", async () => {
    const r = rig("open");
    const status = vi.spyOn(r.any.topicCommands, "handleStatusCommand");
    expect(await r.any.topicCommands.handleGeneralCommand(typed("/status", PLAIN, "1"), "general")).toBe(true);
    const [key, ...args] = commandSpec("status")!.denied;
    expect(r.replies.map(x => x.text)).toEqual([t(key, ...args)]);
    expect(status).not.toHaveBeenCalled();
  });
  it("/update with an empty admin list: the table's 'disabled' reply, as on Discord", async () => {
    const r = rig("open");
    (r.fm.fleetConfig as any).channels[0].access.allowed_users = [];
    expect(await r.any.topicCommands.handleGeneralCommand(typed("/update", ADMIN_A, "1"), "general")).toBe(true);
    const [key, ...args] = commandSpec("update")!.disabled!;
    expect(r.replies.map(x => x.text)).toEqual([t(key, ...args)]);
  });
  it("a command the table passes through in an instance topic is left alone (handled as before)", async () => {
    const r = rig("open");
    expect(await r.any.topicCommands.handleInstanceCommand(typed("/status", PLAIN, "30"), "alpha")).toBe(false);
    expect(r.replies).toEqual([]);
  });
  it("an ordinary command the table lets anyone use still runs for a member (/steer in an instance topic)", async () => {
    const r = rig("open");
    expect(await r.any.topicCommands.handleInstanceCommand(typed("/steer hi", PLAIN, "30"), "alpha")).toBe(true);
    expect(r.replies.map(x => x.text)).not.toContain(t(...commandSpec("steer")!.denied));
  });
});

describe("the check and the act are one stretch: an instance rebound to another bot cannot slip in between (#1399 review)", () => {
  /** alpha's owner at the moment each effect runs. */
  function recordEffects(r: ReturnType<typeof rig>) {
    const acted: string[] = [];
    const at = (what: string, name: string) => acted.push(`${what}:${name}@${r.fm.getInstanceAdapterId(name)}`);
    r.any.toggleFleetCollab = (name: string) => { at("collab", name); return true; };
    r.any.topicCommands.sendCompact = async (name: string) => { at("compact", name); return "ok"; };
    return acted;
  }
  /** alpha moves to tg-b on the first microtask after the command arrives — where an await after the check resumed. */
  const rebindAlphaToBNext = (r: ReturnType<typeof rig>) =>
    queueMicrotask(() => { (r.fm.fleetConfig as any).instances.alpha.channel_id = "tg-b"; });

  for (const command of ["collab", "compact"]) {
    it(`Telegram /${command}: rebound right after it arrives, it acted while tg-a still owned alpha`, async () => {
      const r = rig("open"); const acted = recordEffects(r);
      rebindAlphaToBNext(r);
      expect(await r.any.topicCommands.handleInstanceCommand(typed(`/${command}`, ADMIN_A), "alpha")).toBe(true);
      expect(acted).toEqual([`${command}:alpha@tg-a`]);
    });
    it(`Discord /${command}: rebound right after it arrives, it acted while tg-a still owned alpha`, async () => {
      const r = rig("open"); const acted = recordEffects(r);
      const respond = vi.fn(async () => undefined);
      rebindAlphaToBNext(r);
      await r.any.dispatchSlash({ command, channelId: "30", guildId: GROUP, userId: ADMIN_A, respond, options: {} }, "tg-a", r.a);
      expect(acted).toEqual([`${command}:alpha@tg-a`]);
    });
    it(`/${command} controls: unchanged owner acts; owned by tg-b from the start, tg-a's admin does nothing`, async () => {
      const r = rig("open"); const acted = recordEffects(r);
      const respond = vi.fn(async () => undefined);
      await r.any.topicCommands.handleInstanceCommand(typed(`/${command}`, ADMIN_A), "alpha");
      await r.any.dispatchSlash({ command, channelId: "30", guildId: GROUP, userId: ADMIN_A, respond, options: {} }, "tg-a", r.a);
      expect(acted).toEqual([`${command}:alpha@tg-a`, `${command}:alpha@tg-a`]);

      (r.fm.fleetConfig as any).instances.alpha.channel_id = "tg-b";
      acted.length = 0; respond.mockClear();
      expect(await r.any.topicCommands.handleInstanceCommand(typed(`/${command}`, ADMIN_A), "alpha")).toBe(false);
      await r.any.dispatchSlash({ command, channelId: "30", guildId: GROUP, userId: ADMIN_A, respond, options: {} }, "tg-a", r.a);
      expect(acted).toEqual([]);
      expect(respond).toHaveBeenCalledWith(t("slash.other_bot"));   // the dispatch answers the door's refusal
    });
  }
});

describe("the table judges only what a handler would run: other text is the agent's, for a member and an admin alike (#1399 review)", () => {
  const generalForms = ["/status report", "/STATUS", "/Doctor", "/update now", "/sysinfo please"];
  const instanceForms = ["/COLLAB", "/pause one two", "/Compact", "/clear all", "/cancel now", "/ctx please"];
  for (const user of [PLAIN, ADMIN_A]) {
    it(`General, ${user === PLAIN ? "member" : "admin"}: ${generalForms.join(", ")} pass through with no reply`, async () => {
      const r = rig("open");
      for (const text of generalForms) {
        expect(await r.any.topicCommands.handleInstanceCommand(typed(text, user, "1"), "general"), text).toBe(false);
        expect(await r.any.topicCommands.handleGeneralCommand(typed(text, user, "1"), "general"), text).toBe(false);
      }
      expect(r.replies).toEqual([]);
    });
    it(`instance topic, ${user === PLAIN ? "member" : "admin"}: ${instanceForms.join(", ")} pass through with no reply`, async () => {
      const r = rig("open"); const collab = vi.fn(() => true); r.any.toggleFleetCollab = collab;
      for (const text of instanceForms) expect(await r.any.topicCommands.handleInstanceCommand(typed(text, user), "alpha"), text).toBe(false);
      expect(r.replies).toEqual([]);
      expect(collab).not.toHaveBeenCalled();
    });
  }

  it("the forms the handlers do run keep their casing, alias and @bot suffix — and the table still gates each of them", async () => {
    const cases: Array<[string, string, boolean]> = [
      // text, the handler that runs it, whether a member is refused (sysinfo is anyone's)
      ["/status@agend_bot", "handleStatusCommand", true],
      ["/RESTART", "handleRestartCommand", true],
      ["/VISIBILITY", "handleVisibilityCommand", true],
      ["/sys-info", "handleSysInfoCommand", false],
      ["/sys_info", "handleSysInfoCommand", false],
    ];
    for (const [text, handler, gated] of cases) {
      const [thread, instance] = ["1", "general"];
      const member = rig("open");
      const memberRan = vi.spyOn(member.any.topicCommands, handler).mockResolvedValue(undefined);
      expect(await member.any.topicCommands.handleGeneralCommand(typed(text, PLAIN, thread), instance), text).toBe(true);
      expect(memberRan.mock.calls.length, `${text} member`).toBe(gated ? 0 : 1);
      expect(member.replies.length, `${text} member is answered`).toBe(gated ? 1 : 0);

      const admin = rig("open");
      const adminRan = vi.spyOn(admin.any.topicCommands, handler).mockResolvedValue(undefined);
      expect(await admin.any.topicCommands.handleGeneralCommand(typed(text, ADMIN_A, thread), instance), text).toBe(true);
      expect(adminRan, `${text} admin`).toHaveBeenCalledOnce();
    }
    // An instance topic: /collab@bot and /pause <one name> are still commands, and still a member's refusal.
    for (const text of ["/collab@agend_bot", "/compact@agend_bot keep the plan"]) {
      const r = rig("open"); const collab = vi.fn(() => true); r.any.toggleFleetCollab = collab;
      r.any.topicCommands.sendCompact = vi.fn(async () => "ok");
      expect(await r.any.topicCommands.handleInstanceCommand(typed(text, PLAIN), "alpha"), text).toBe(true);
      expect(r.replies.length, text).toBe(1);
      expect(collab).not.toHaveBeenCalled();
      expect(r.any.topicCommands.sendCompact).not.toHaveBeenCalled();
    }
    const g = rig("open");
    expect(await g.any.topicCommands.handleInstanceCommand(typed("/pause alpha", PLAIN, "1"), "general")).toBe(true);
    expect(g.pausedWoken).toEqual([]);
  });
});
