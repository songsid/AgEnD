import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Nothing in here may start a backend, a process or a network call: every handler that would is a recorder.
const spawned = vi.hoisted(() => [] as unknown[][]);
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, spawn: vi.fn((...args: unknown[]) => { spawned.push(args); return { once() {}, unref() {}, on() {} }; }) };
});

import { FleetManager } from "../src/fleet-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { COMMANDS, commandSpec, decideCommand, isLocked, ruleFor, slashLock, type CommandScope } from "../src/command-table.js";
import { setLocale, t } from "../src/locale.js";

/**
 * The command table against the code that actually answers, one platform at a time.
 *
 * The audit behind the table looked at Discord and Telegram together and wrote one level per command, which lost
 * Telegram's side of it: `/start` in a Telegram group needs a ClassicBot admin (the table said "anyone"), `/stop`
 * needs one on Telegram only (the table said "channel admin", which also lets a fleet admin in), `/compact` and
 * `/save` are checked in a ClassicBot chat and NOT in a fleet topic. So this file drives the real Telegram handlers
 * (`handleInboundMessage` → the ClassicBot block / `TopicCommands.handleInstanceCommand`) with only their side effects
 * recorded, and the real Discord `/start` admission, and compares what they do with the table's cells.
 *
 * The expectations are written out by hand from reading those handlers and from the Telegram matrix muse drove through
 * the same entry point; they are NOT derived from `COMMANDS`.
 */
const FLEET_CHAT = "-1001111111111";
const CLASSIC_GROUP = "-1002222222222";
const CLASSIC_PRIVATE = "5551";
const ALLOWED_GROUP = "-1005555555555";
const OTHER_GROUP = "-1006666666666";
const BOT = "fleetbot";
const FA = "100";        // a fleet admin (in the Telegram adapter's `allowed_users`) and NOT a ClassicBot admin
const CA = "200";        // a ClassicBot admin (`admin_users`) and NOT a fleet admin
const PU = "300";        // allowed to talk to the ClassicBot, nothing else
const STRANGER = "999";  // on no list

type Person = "plain" | "fleetAdmin" | "classicAdmin";
const ID: Record<Person, string> = { plain: PU, fleetAdmin: FA, classicAdmin: CA };
const PEOPLE: Person[] = ["plain", "fleetAdmin", "classicAdmin"];
const ALL: Person[] = PEOPLE;

const dirs: string[] = [];
beforeEach(() => { setLocale("en"); spawned.length = 0; });
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Rig {
  fm: FleetManager;
  reached: string[];
  replies: string[];
  say(chatId: string, userId: string, text: string, threadId?: string): Promise<void>;
}

async function rig(): Promise<Rig> {
  const dir = join(tmpdir(), `agend-gates-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const fm = new FleetManager(dir);
  const any = fm as unknown as Record<string, any>;
  const reached: string[] = [];
  const replies: string[] = [];
  const sendText = async (chatId: string, text: string) => { replies.push(String(text)); return { messageId: "m", chatId }; };
  const tg = { id: "tg", type: "telegram", react: async () => {}, unreact: async () => {}, sendText, editMessage: async () => {}, sendWithKeyboard: async () => ({ messageId: "k", chatId: "x" }) };
  const tgCfg = { id: "tg", type: "telegram", mode: "topic", group_id: FLEET_CHAT, access: { mode: "locked", allowed_users: [FA, "999000"] }, bot_token_env: "X" };
  any.adapter = tg;
  any.worlds.set("tg", { id: "tg", adapter: tg, channelConfig: tgCfg, groupId: FLEET_CHAT, botUsername: BOT });
  fm.fleetConfig = {
    defaults: { backend: "claude-code" }, channels: [tgCfg], channel: tgCfg,
    instances: { general: { working_directory: dir, topic_id: 1, general_topic: true }, worker: { working_directory: dir, topic_id: 30 } },
  } as never;
  fm.routing.rebuild(fm.fleetConfig!);
  const cm = new ClassicChannelManager(dir, pino({ level: "silent" }) as never);
  cm.setPrimaryAdapterId("tg");
  (cm as any).defaults = { admin_users: [CA], allowed_users: [CA, PU, FA], allowed_groups: [CLASSIC_GROUP, ALLOWED_GROUP], allowed_guilds: ["G-ok"] };
  cm.register(CLASSIC_PRIVATE, "tg", "classic-priv", "priv", "owner", "claude-code");
  cm.register(CLASSIC_GROUP, "tg", "classic-grp", "grp", "owner", "claude-code");
  fm.classicChannels = cm;

  // Whatever would reach an instance, a process or the platform is recorded and never executed.
  any.deliverToInstance = async () => { reached.push("agent"); };
  any.forwardToClassicInstance = async () => { reached.push("agent"); };
  any.pasteRawToClassicInstance = () => { reached.push("save"); };
  any.sendCancelButton = async () => {};
  any.reactMessageStatus = () => {};
  any.setTopicIcon = () => {};
  any.touchActivity = () => {};
  any.trackInboundMsg = () => {};
  any.saveClassicAttachment = async () => undefined;
  any.notifyInstanceTopic = () => {};
  any.promptClassicApproval = async () => { reached.push("approval"); };
  any.handleClassicStart = async () => { reached.push("start"); return "ok:start"; };
  any.beginClassicBackendSelection = async () => { reached.push("start"); };
  any.handleClassicStop = async () => { reached.push("stop"); return "ok:stop"; };
  any.toggleFleetCollab = () => { reached.push("collab"); return true; };
  any.applyModel = async () => { reached.push("model"); return "ok"; };
  any.promptModelMenu = async () => { reached.push("model"); };
  any.promptClearConfirmation = async () => { reached.push("clear"); };
  any.daemons.set("general", {});
  const tc = any.topicCommands;
  tc.sendCompact = async () => { reached.push("compact"); return "ok:compact"; };
  tc.sendSave = async () => { reached.push("save"); return "ok:save"; };
  tc.runPauseWake = async (_name: string, action: string) => { reached.push(action); return `ok:${action}`; };
  tc.sendSteer = () => { reached.push("steer"); return "ok"; };

  async function say(chatId: string, userId: string, text: string, threadId?: string): Promise<void> {
    reached.length = 0;
    replies.length = 0;
    await any.handleInboundMessage({
      source: "telegram", adapterId: "tg", chatId, threadId, messageId: `m${Math.random()}`, userId, username: `u${userId}`,
      text, timestamp: new Date(), chatTitle: "t",
    });
  }
  return { fm, reached, replies, say };
}

/** Who gets the command from the handler, across the three kinds of caller. */
async function reach(r: Rig, command: string, label: string, where: { chatId: string; threadId?: string; at?: boolean }): Promise<Person[]> {
  const out: Person[] = [];
  for (const person of PEOPLE) {
    const text = where.at ? command.replace(/^(\/\w+)/, `$1@${BOT}`) : command;
    await r.say(where.chatId, ID[person], text, where.threadId);
    if (r.reached.includes(label)) out.push(person);
  }
  return out;
}

const TG = {
  general: { chatId: FLEET_CHAT },
  fleet: { chatId: FLEET_CHAT, threadId: "30" },
  classicPrivate: { chatId: CLASSIC_PRIVATE },
  classicGroup: { chatId: CLASSIC_GROUP, at: true },
} as const;

/**
 * Telegram, typed. [command text, what its handler records, who reaches it in a General topic / an instance's topic /
 * a ClassicBot chat]. `null` = the text is not a command there (it goes to the agent) and nothing is asserted.
 */
const TG_EXPECTED: Array<{ name: string; text: string; label: string; general: Person[] | null; fleet: Person[] | null; classic: Person[] | null }> = [
  // fleet topic: NO check; ClassicBot chat: a ClassicBot admin only (a fleet admin alone is refused)
  { name: "compact", text: "/compact", label: "compact", general: ALL, fleet: ALL, classic: ["classicAdmin"] },
  { name: "save", text: "/save f.json", label: "save", general: ALL, fleet: ALL, classic: ["classicAdmin"] },
  // fleet topic: NO check; ClassicBot chat: not a command (the text goes to the agent)
  { name: "collab", text: "/collab", label: "collab", general: ALL, fleet: ALL, classic: null },
  // fleet admin in a fleet topic; ClassicBot admin ONLY in a ClassicBot chat
  { name: "pause", text: "/pause", label: "pause", general: null, fleet: ["fleetAdmin"], classic: ["classicAdmin"] },
  { name: "wake", text: "/wake", label: "wake", general: null, fleet: ["fleetAdmin"], classic: ["classicAdmin"] },
  // a fleet admin, or in a ClassicBot chat also a ClassicBot admin (`isModelAdmin`)
  { name: "model", text: "/model x", label: "model", general: ["fleetAdmin"], fleet: ["fleetAdmin"], classic: ["fleetAdmin", "classicAdmin"] },
  { name: "clear", text: "/clear", label: "clear", general: ["fleetAdmin"], fleet: ["fleetAdmin"], classic: ["fleetAdmin", "classicAdmin"] },
  // only exists in a ClassicBot chat
  { name: "stop", text: "/stop", label: "stop", general: null, fleet: null, classic: ["classicAdmin"] },
];

describe("Telegram's typed commands, through the real handlers", () => {
  it.each(TG_EXPECTED)("/$name", async ({ text, label, general, fleet, classic }) => {
    const r = await rig();
    if (general) expect(await reach(r, text, label, TG.general), "General topic").toEqual(general);
    if (fleet) expect(await reach(r, text, label, TG.fleet), "instance topic").toEqual(fleet);
    if (classic) {
      expect(await reach(r, text, label, TG.classicPrivate), "ClassicBot private chat").toEqual(classic);
      expect(await reach(r, text, label, TG.classicGroup), "ClassicBot group, /cmd@bot").toEqual(classic);
    }
    expect(spawned).toHaveLength(0);
  });

  it("/pause in General names the instance; the same people reach it", async () => {
    const r = await rig();
    expect(await reach(r, "/pause worker", "pause", TG.general)).toEqual(["fleetAdmin"]);
    expect(await reach(r, "/wake worker", "wake", TG.general)).toEqual(["fleetAdmin"]);
  });
});

describe("the table's Telegram column says what those handlers do (cell by cell)", () => {
  const checksFor = (person: Person, scope: CommandScope) => {
    const fleetAdmin = person === "fleetAdmin";
    const classicAdmin = person === "classicAdmin";
    return {
      fleetAdmin: () => (fleetAdmin ? "ok" as const : "denied" as const),
      channelAdmin: () => fleetAdmin || (scope === "classic" && classicAdmin),
      classicAdmin: () => classicAdmin,
    };
  };
  const tableWho = (name: string, scope: CommandScope, platform: "telegram" | "discord"): Person[] =>
    PEOPLE.filter(person => decideCommand(commandSpec(name)!, scope, checksFor(person, scope), platform).allow);

  it.each(TG_EXPECTED)("/$name", ({ name, general, fleet, classic }) => {
    if (general) expect(tableWho(name, "general", "telegram"), "General").toEqual(general);
    if (fleet) expect(tableWho(name, "fleet", "telegram"), "fleet").toEqual(fleet);
    if (classic) expect(tableWho(name, "classic", "telegram"), "classic").toEqual(classic);
  });

  it("the Discord column is untouched by the Telegram overrides, and a command without an override reads the same on both", () => {
    for (const spec of COMMANDS) {
      for (const scope of ["fleet", "general", "classic", "none"] as CommandScope[]) {
        if (!spec.telegram?.[scope]) expect(ruleFor(spec, scope, "telegram"), `${spec.name}/${scope}`).toBe(spec.scopes[scope]);
        expect(ruleFor(spec, scope, "discord"), `${spec.name}/${scope}`).toBe(spec.scopes[scope]);
      }
    }
  });

  it("an override can only describe a scope the Discord column also has a level for", () => {
    // (a Telegram-only refusal would be a new rule, not a difference of gate)
    for (const spec of COMMANDS) {
      for (const [scope, rule] of Object.entries(spec.telegram ?? {})) {
        expect("level" in rule!, `${spec.name}/${scope}`).toBe(true);
        expect("level" in spec.scopes[scope as CommandScope], `${spec.name}/${scope}`).toBe(true);
      }
    }
  });
});

describe("/start: not one level, and neither platform's real gate moved", () => {
  it("Telegram private chat: the user allowlist, no admin needed", async () => {
    const r = await rig();
    for (const [person, id] of Object.entries({ plain: PU, fleetAdmin: FA, classicAdmin: CA })) {
      await r.say("5560", id, "/start claude-code");
      expect(r.reached, person).toEqual(["start"]);
    }
    await r.say("5560", STRANGER, "/start claude-code");
    expect(r.reached, "a stranger").toEqual([]);
    expect(r.replies).toEqual([t("classic.not_allowed_user")]);
  });

  it("Telegram group: an allowed group AND a ClassicBot admin — a fleet admin or a plain member is refused", async () => {
    const r = await rig();
    await r.say(ALLOWED_GROUP, CA, `/start@${BOT} claude-code`);
    expect(r.reached, "ClassicBot admin").toEqual(["start"]);
    for (const [person, id] of Object.entries({ plain: PU, fleetAdmin: FA })) {
      await r.say(ALLOWED_GROUP, id, `/start@${BOT} claude-code`);
      expect(r.reached, person).toEqual([]);
      expect(r.replies, person).toEqual([t("classic.admin_only_start")]);
    }
  });

  it("Telegram group not on the allowlist: nobody, an admin included — an approval is asked of General instead", async () => {
    const r = await rig();
    for (const id of [CA, FA, PU]) {
      await r.say(OTHER_GROUP, id, `/start@${BOT} claude-code`);
      expect(r.reached, id).toEqual(["approval"]);
      expect(r.replies, id).toEqual([t("classic.access_requested")]);
    }
  });

  it("Discord: the guild allowlist and nothing else — any caller in an allowed guild starts, no admin", async () => {
    const r = await rig();
    const any = r.fm as unknown as Record<string, any>;
    any.startClassicInstance = async () => { r.reached.push("started"); };
    any.reregisterClassicChannels = () => {};
    // The real admission (the stub above stands in for it only on the Telegram paths).
    const start = (channel: string, user: string, guild: string) =>
      FleetManager.prototype.handleClassicStart.call(r.fm, channel, `n-${channel}`, user, guild, "tg", "claude-code");
    const results: string[] = [];
    for (const [i, id] of [PU, FA, CA].entries()) results.push(await start(`chan-${i}`, id, "G-ok"));
    expect(results).toEqual([t("classic.started"), t("classic.started"), t("classic.started")]);
    expect(r.reached).toEqual(["started", "started", "started"]);
    r.reached.length = 0;
    expect(await start("chan-x", CA, "G-not-allowed"), "an admin in a guild that is not allowed").toBe(t("classic.not_authorized_guild"));
    expect(r.reached).toEqual(["approval"]);
  });

  it("the table says so: handler-decided, and not a locked command", () => {
    const spec = commandSpec("start")!;
    expect(spec.scopes.none).toMatchObject({ level: "handler" });
    expect(isLocked(spec)).toBe(false);
    expect(slashLock("start")).toBe("");
    // The level asks the caller nothing: whatever the door let through reaches the handler, which does the checking above.
    expect(decideCommand(spec, "none", { fleetAdmin: () => "denied", channelAdmin: () => false, classicAdmin: () => false })).toEqual({ allow: true });
  });
});

describe("Discord's own handlers behind the table ask for no more than the table does", () => {
  // The dispatcher's table check comes first; each of these handlers still carries a check of its own (`isModelAdmin`,
  // `isFleetAdmin`). If one were stricter than the table the effective rule would be the intersection and the table would
  // be a lie in the other direction, so the real handlers are called here with only their leaf side effects recorded.
  const call = async (r: Rig, handler: string, command: string, person: Person, channelId: string): Promise<boolean> => {
    r.reached.length = 0;
    let said = "";
    await (r.fm as unknown as Record<string, any>)[handler].call(r.fm, {
      command, channelId, channelName: "c", userId: ID[person], username: person,
      options: { filename: "f.json", instance: "worker", name: "x", level: "high" },
      respond: async (text: string) => { said = text; return "m1"; }, respondChoices: async (text: string) => { said = text; return "m2"; },
    }, "tg");
    return said !== t("permission.denied") && said !== t("admin.required") && said !== t("cmd.admin_required", `/${command}`);
  };
  const WHO_BY_TABLE = (name: string, scope: CommandScope): Person[] =>
    PEOPLE.filter(person => decideCommand(commandSpec(name)!, scope, {
      fleetAdmin: () => (person === "fleetAdmin" ? "ok" : "denied"),
      channelAdmin: () => person === "fleetAdmin" || (scope === "classic" && person === "classicAdmin"),
      classicAdmin: () => person === "classicAdmin",
    }).allow);

  it.each([
    ["handlePauseWakeSlash", "pause"], ["handlePauseWakeSlash", "wake"], ["handleSlashSave", "save"],
    ["handleModelSlash", "model"], ["handleClearSlash", "clear"],
  ])("%s (/%s): who passes its own check = who the table lets in, in a ClassicBot channel and in a fleet topic", async (handler, command) => {
    const r = await rig();
    for (const [scope, channelId] of [["classic", CLASSIC_GROUP], ["fleet", "30"]] as const) {
      const passed: Person[] = [];
      for (const person of PEOPLE) if (await call(r, handler, command, person, channelId)) passed.push(person);
      expect(passed, `${command} in ${scope}`).toEqual(WHO_BY_TABLE(command, scope));
    }
    expect(spawned).toHaveLength(0);
  });
});

describe("/stop is a ClassicBot admin on both platforms", () => {
  it("Telegram: only a ClassicBot admin (above); Discord: the table says the same", () => {
    const spec = commandSpec("stop")!;
    expect(spec.scopes.classic).toEqual({ level: "classic-admin" });
    expect(spec.telegram).toBeUndefined();
    expect(isLocked(spec)).toBe(true);
    expect(slashLock("stop")).toBe("🔒 ");
  });
});
