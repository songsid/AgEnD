/**
 * #1148, PR-C: a General-only command typed in an instance topic is refused with a pointer to General — it used to be
 * handed to the agent as an ordinary message (the agent got raw command text, nothing acted and nothing refused).
 * (The rig below is PR-A's two-bot fleet; its PR-B description follows.)
 *
 * #754 / #1148 audit, PR-B: one fleet-admin gate.
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



const GENERAL_ONLY = ["status", "restart", "login", "profile", "update", "doctor", "dashboard", "visibility", "sysinfo", "usage"];

describe("a General-only command in a Telegram instance topic points to General, for everyone, and reaches no agent", () => {
  for (const name of GENERAL_ONLY) {
    it(`/${name}`, async () => {
      for (const who of [PLAIN, ADMIN_A]) {
        const r = rig("open");
        const delivered = vi.fn();
        r.any.deliverToInstance = delivered;
        expect(await r.any.topicCommands.handleInstanceCommand(typed(`/${name}`, who, "30"), "alpha"), who).toBe(true);
        expect(r.replies.map(x => x.text), who).toEqual([t("cmd.use_in_general", `/${name}`)]);
        expect(delivered, who).not.toHaveBeenCalled();
      }
    });
  }

  it("the bot-suffixed form too (/status@bot)", async () => {
    const r = rig("open");
    expect(await r.any.topicCommands.handleInstanceCommand(typed("/status@fleetbot", ADMIN_A, "30"), "alpha")).toBe(true);
    expect(r.replies.map(x => x.text)).toEqual([t("cmd.use_in_general", "/status")]);
  });

  it("in General the same commands still run (the refusal is the instance topic's only)", async () => {
    const r = rig("open");
    const status = vi.spyOn(r.any.topicCommands, "handleStatusCommand").mockResolvedValue(undefined);
    expect(await r.any.topicCommands.handleGeneralCommand(typed("/status", ADMIN_A, "1"), "general")).toBe(true);
    expect(status).toHaveBeenCalledOnce();
    expect(r.replies.map(x => x.text)).not.toContain(t("cmd.use_in_general", "/status"));
  });

  it("the other forms General runs too: /RESTART, /sys-info, /install_cli (pointed to the command they are)", async () => {
    for (const [text, shown] of [["/RESTART", "/restart"], ["/sys-info", "/sysinfo"], ["/install_cli", "/login"]]) {
      const r = rig("open");
      expect(await r.any.topicCommands.handleInstanceCommand(typed(text, PLAIN, "30"), "alpha"), text).toBe(true);
      expect(r.replies.map(x => x.text), text).toEqual([t("cmd.use_in_general", shown)]);
    }
  });

  it("a form General would not run either (/status report, /STATUS, /Doctor, /update now) is the agent's text, for anyone", async () => {
    for (const who of [PLAIN, ADMIN_A]) {
      const r = rig("open");
      for (const text of ["/status report", "/STATUS", "/Doctor", "/update now"]) {
        expect(await r.any.topicCommands.handleInstanceCommand(typed(text, who, "30"), "alpha"), `${who} ${text}`).toBe(false);
      }
      expect(r.replies, who).toEqual([]);
    }
  });

  it("an ordinary message in the instance topic still goes to the agent (only commands are intercepted)", async () => {
    const r = rig("open");
    expect(await r.any.topicCommands.handleInstanceCommand(typed("status of the build?", PLAIN, "30"), "alpha")).toBe(false);
    expect(r.replies).toEqual([]);
  });
});
