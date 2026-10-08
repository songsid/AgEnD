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

vi.mock("../src/usage/usage-api.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/usage/usage-api.js")>();
  return { ...real, getUsageSnapshot: vi.fn(async () => ({})) };
});
vi.mock("../src/usage/format-rich.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/usage/format-rich.js")>();
  return { ...real, renderUsageMarkdown: vi.fn(() => "ok:usage"), renderUsageHtml: vi.fn(() => "ok:usage") };
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
  // Some handlers end in a reply that names what they would have done. The reply is the trace, and where the next step
  // would be real (an update, a doctor run) it is also where the handler is stopped.
  const stop = new Error("stopped before the side effect");
  const sendText = async (chatId: string, text: string) => {
    replies.push(String(text));
    if (text === t("restart.usage")) reached.push("restart");
    if (text === "ok:usage") reached.push("usage");
    if (text === t("update.progress.preparing", 0)) { reached.push("update"); throw stop; }
    if (text === t("doctor.running")) { reached.push("doctor"); throw stop; }
    if (String(text).startsWith(t("visibility.current", "full"))) reached.push("visibility");
    return { messageId: "m", chatId };
  };
  const tg = { id: "tg", type: "telegram", react: async () => {}, unreact: async () => {}, sendText, editMessage: async () => {}, sendWithKeyboard: async () => ({ messageId: "k", chatId: "x" }) };
  const tgCfg = { id: "tg", type: "telegram", mode: "topic", group_id: FLEET_CHAT, access: { mode: "locked", allowed_users: [FA, "999000"] }, bot_token_env: "X" };
  any.adapter = tg;
  any.adapters.set("tg", tg);
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
  // Registered: the stop is recorded and not performed. Not registered: what the real one says.
  any.handleClassicStop = async (chatId: string, adapterId?: string) => {
    if (!cm.getInstanceByChannel(chatId, adapterId)) return t("classic.no_agent");
    reached.push("stop");
    return "ok:stop";
  };
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
  tc.sendBtw = () => { reached.push("btw"); return "ok"; };
  tc.getCtxText = async () => { reached.push("ctx"); return "ok:ctx"; };
  tc.getStatusText = async () => { reached.push("status"); return "ok:status"; };
  tc.getDashboardText = () => { reached.push("dashboard"); return "ok:dashboard"; };
  any.dashboardMenu = async (msg: any) => { await tc.getReplyAdapter(msg).sendText(msg.chatId, tc.getDashboardText(), { threadId: msg.threadId }); };
  tc.sendSysInfo = async () => { reached.push("sysinfo"); };
  tc.handleTipsCommand = async () => { reached.push("tips"); };     // entry only: its `on|off` arguments are gated inside
  any.startCpuProfile = async () => { reached.push("profile"); return { seconds: 60, done: new Promise(() => {}) }; };
  any.cancelInstance = () => { reached.push("cancel"); return true; };
  any.promptLoginBackends = async () => { reached.push("login"); };
  any.startLoginSession = async () => { reached.push("login"); return "ok"; };
  any.cancelLoginSession = async () => { reached.push("login"); return "ok"; };
  any.promptEffortMenu = async () => { reached.push("effort"); };
  any.applyEffort = async () => { reached.push("effort"); return "ok"; };

  async function say(chatId: string, userId: string, text: string, threadId?: string): Promise<void> {
    reached.length = 0;
    replies.length = 0;
    try {
      await any.handleInboundMessage({
        source: "telegram", adapterId: "tg", chatId, threadId, messageId: `m${Math.random()}`, userId, username: `u${userId}`,
        text, timestamp: new Date(), chatTitle: "t",
      });
    } catch (err) {
      if ((err as Error).message !== "stopped before the side effect") throw err;
    }
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

const UNREGISTERED_GROUP = "-1007777777777";
const UNREGISTERED_PRIVATE = "5570";
const TG = {
  general: { chatId: FLEET_CHAT },
  fleet: { chatId: FLEET_CHAT, threadId: "30" },
  classicPrivate: { chatId: CLASSIC_PRIVATE },
  classicGroup: { chatId: CLASSIC_GROUP, at: true },
} as const;

/** `pass`: not a command here — the text goes to the agent (or, in a chat with no agent, is dropped), and no handler runs. */
type TgCell = Person[] | "pass";
const PASS_ = "pass" as const;
const FA_ONLY: Person[] = ["fleetAdmin"];
const CA_ONLY: Person[] = ["classicAdmin"];
const FA_OR_CA: Person[] = ["fleetAdmin", "classicAdmin"];

/**
 * Telegram, typed, for EVERY command in the table: [text, what its handler records, who reaches it in a General topic /
 * an instance's topic / a ClassicBot chat]. A chat with no agent is checked separately (nothing reaches anything).
 * `pass` cells are asserted too: the same three callers, and what happens is that the agent is handed the text and no
 * handler runs.
 */
type NoAgentCell = "pass" | "refuse";
const TG_EXPECTED: Array<{ name: string; text: string; label: string; general: TgCell; fleet: TgCell; classic: TgCell; none: NoAgentCell }> = [
  // lifecycle (classic /start: its own test below)
  { name: "start", text: "/start", label: "start", general: PASS_, fleet: PASS_, classic: PASS_ /* replaced: see the /start tests */, none: "pass" },
  { name: "stop", text: "/stop", label: "stop", general: PASS_, fleet: PASS_, classic: CA_ONLY, none: "refuse" },
  { name: "chat", text: "/chat hi", label: "agent", general: PASS_, fleet: PASS_, classic: ALL, none: "pass" },
  { name: "load", text: "/load f.json", label: "load", general: PASS_, fleet: PASS_, classic: PASS_, none: "pass" },
  // fleet topic: NO check; ClassicBot chat: a ClassicBot admin only (a fleet admin alone is refused)
  // #754 audit: channel-admin on Telegram too, as the Discord slash command (was: anyone who may speak).
  // #754: a fleet admin of the bot is a ClassicBot admin here too, as on Discord (channel-admin).
  { name: "compact", text: "/compact", label: "compact", general: FA_ONLY, fleet: FA_ONLY, classic: FA_OR_CA, none: "refuse" },
  { name: "save", text: "/save f.json", label: "save", general: FA_ONLY, fleet: FA_ONLY, classic: FA_OR_CA, none: "refuse" },
  // fleet topic: NO check; ClassicBot chat: not a command
  { name: "collab", text: "/collab", label: "collab", general: FA_ONLY, fleet: FA_ONLY, classic: PASS_, none: "pass" },
  // fleet admin in a fleet topic; ClassicBot admin ONLY in a ClassicBot chat
  { name: "pause", text: "/pause", label: "pause", general: "pause-needs-instance" as never, fleet: FA_ONLY, classic: FA_OR_CA, none: "refuse" },
  { name: "wake", text: "/wake", label: "wake", general: "pause-needs-instance" as never, fleet: FA_ONLY, classic: FA_OR_CA, none: "refuse" },
  // a fleet admin, or in a ClassicBot chat also a ClassicBot admin (`isModelAdmin`)
  { name: "model", text: "/model x", label: "model", general: FA_ONLY, fleet: FA_ONLY, classic: FA_OR_CA, none: "refuse" },
  { name: "clear", text: "/clear", label: "clear", general: FA_ONLY, fleet: FA_ONLY, classic: FA_OR_CA, none: "refuse" },
  // no ClassicBot handler
  { name: "effort", text: "/effort high", label: "effort", general: FA_ONLY, fleet: FA_ONLY, classic: PASS_, none: "pass" },
  { name: "steer", text: "/steer hi", label: "steer", general: ALL, fleet: ALL, classic: ALL, none: "refuse" },
  { name: "btw", text: "/btw hi", label: "btw", general: ALL, fleet: ALL, classic: ALL, none: "refuse" },
  { name: "cancel", text: "/cancel", label: "cancel", general: ALL, fleet: ALL, classic: ALL, none: "refuse" },
  { name: "ctx", text: "/ctx", label: "ctx", general: ALL, fleet: ALL, classic: ALL, none: "refuse" },
  // only the General topic has a handler
  { name: "status", text: "/status", label: "status", general: FA_ONLY, fleet: PASS_, classic: PASS_, none: "pass" },
  { name: "restart", text: "/restart x", label: "restart", general: FA_ONLY, fleet: PASS_, classic: PASS_, none: "pass" },   // "x" is no mode: an admin gets the usage line, nobody restarts
  { name: "login", text: "/login", label: "login", general: FA_ONLY, fleet: PASS_, classic: PASS_, none: "pass" },
  { name: "profile", text: "/profile", label: "profile", general: FA_ONLY, fleet: PASS_, classic: PASS_, none: "pass" },
  { name: "update", text: "/update", label: "update", general: FA_ONLY, fleet: PASS_, classic: PASS_, none: "pass" },
  { name: "doctor", text: "/doctor", label: "doctor", general: FA_ONLY, fleet: PASS_, classic: PASS_, none: "pass" },
  { name: "dashboard", text: "/dashboard", label: "dashboard", general: FA_ONLY, fleet: PASS_, classic: PASS_, none: "pass" },
  { name: "visibility", text: "/visibility", label: "visibility", general: FA_ONLY, fleet: PASS_, classic: PASS_, none: "pass" },
  { name: "sysinfo", text: "/sysinfo", label: "sysinfo", general: ALL, fleet: PASS_, classic: PASS_, none: "pass" },
  { name: "usage", text: "/usage", label: "usage", general: ALL, fleet: PASS_, classic: PASS_, none: "pass" },
  // General and an instance's topic; not a ClassicBot chat
  { name: "tips", text: "/tips", label: "tips", general: ALL, fleet: ALL, classic: PASS_, none: "pass" },
];
const textFor = (e: { name: string; text: string }, scope: "general" | "fleet" | "classic"): string =>
  e.name === "pause" || e.name === "wake" ? (scope === "general" ? `${e.text} worker` : e.text) : e.text;
const cellOf = (e: (typeof TG_EXPECTED)[number], scope: "general" | "fleet" | "classic"): TgCell =>
  e[scope] === ("pause-needs-instance" as never) ? FA_ONLY : e[scope];

/**
 * What a command that is not a command here looks like. In a ClassicBot private chat the agent is handed the text, as
 * with any message; in a ClassicBot group a message that does not @mention the bot is only logged — and in neither does a
 * handler run, whoever sent it.
 */
async function passesThrough(r: Rig, text: string, where: { chatId: string; threadId?: string; at?: boolean }): Promise<boolean> {
  const expected = where.at ? "" : "agent";
  for (const person of PEOPLE) {
    const sent = where.at ? text.replace(/^(\/\w+)/, `$1@${BOT}`) : text;
    await r.say(where.chatId, ID[person], sent, where.threadId);
    if (r.reached.join(",") !== expected) return false;
  }
  return true;
}

describe("Telegram's typed commands, through the real handlers", () => {
  const kinds = [["general", "General topic", [TG.general]], ["fleet", "instance topic", [TG.fleet]], ["classic", "ClassicBot chat", [TG.classicPrivate, TG.classicGroup]]] as const;

  it.each(TG_EXPECTED.filter(e => e.name !== "start"))("/$name", async entry => {
    const r = await rig();
    for (const [scope, what, wheres] of kinds) {
      const cell = cellOf(entry, scope);
      for (const where of wheres) {
        // In a ClassicBot group the way to talk to the agent is an @mention, not a command.
        const text = entry.name === "chat" && "at" in where ? `@${BOT} hi` : textFor(entry, scope);
        if (cell === "pass") {
          expect(await passesThrough(r, text, where), `${what}: not a command here, the agent gets the text and nothing else runs`).toBe(true);
        } else {
          expect(await reach(r, text, entry.label, { ...where, at: entry.name === "chat" ? false : "at" in where }), what).toEqual(cell);
        }
      }
    }
    expect(spawned, "nothing real ran").toHaveLength(0);
  });

  it("a chat with no agent (unregistered group or private chat): a command that exists answers 'no agent' or refuses, one that does not is dropped — nothing reaches a handler either way", async () => {
    const r = await rig();
    for (const entry of TG_EXPECTED.filter(e => e.name !== "start")) {
      for (const where of [{ chatId: UNREGISTERED_GROUP, at: true }, { chatId: UNREGISTERED_PRIVATE, at: false }]) {
        for (const person of PEOPLE) {
          const text = where.at ? textFor(entry, "classic").replace(/^(\/\w+)/, `$1@${BOT}`) : textFor(entry, "classic");
          await r.say(where.chatId, ID[person], text);
          const what = `${entry.name} as ${person} in ${where.chatId}`;
          expect(r.reached, what).toEqual([]);
          expect(r.replies.length, what).toBe(entry.none === "refuse" ? 1 : 0);
        }
      }
    }
  });

  it("/pause in General names the instance; the same people reach it", async () => {
    const r = await rig();
    expect(await reach(r, "/pause worker", "pause", TG.general)).toEqual(["fleetAdmin"]);
    expect(await reach(r, "/wake worker", "wake", TG.general)).toEqual(["fleetAdmin"]);
  });
});

describe("the table's Telegram column says what those handlers do, for every command (cell by cell)", () => {
  const checksFor = (person: Person, scope: CommandScope) => {
    const fleetAdmin = person === "fleetAdmin";
    const classicAdmin = person === "classicAdmin";
    return {
      fleetAdmin: () => (fleetAdmin ? "ok" as const : "denied" as const),
      channelAdmin: () => fleetAdmin || (scope === "classic" && classicAdmin),
      classicAdmin: () => classicAdmin,
    };
  };
  /** Who the table lets through on Telegram, or "pass" for a cell that says there is no command there. */
  const tableCell = (name: string, scope: CommandScope): TgCell => {
    const spec = commandSpec(name)!;
    const rule = ruleFor(spec, scope, "telegram");
    if ("passthrough" in rule) return "pass";
    return PEOPLE.filter(person => decideCommand(spec, scope, checksFor(person, scope), "telegram").allow);
  };

  it("is written out for every command the table has, and for no other", () => {
    expect(TG_EXPECTED.map(e => e.name).sort()).toEqual(COMMANDS.map(c => c.name).sort());
  });

  it.each(TG_EXPECTED.filter(e => e.name !== "start"))("/$name", entry => {
    expect(tableCell(entry.name, "general"), "General").toEqual(cellOf(entry, "general"));
    expect(tableCell(entry.name, "fleet"), "fleet").toEqual(cellOf(entry, "fleet"));
    expect(tableCell(entry.name, "classic"), "classic").toEqual(cellOf(entry, "classic"));
    const none = ruleFor(commandSpec(entry.name)!, "none", "telegram");
    expect("passthrough" in none ? "pass" : "refuse" in none ? "refuse" : "level", "a chat with no agent").toBe(entry.none);
  });

  it("a pass-through cell is not a refusal and not a permission: the decision says so and asks nobody", () => {
    const asked: string[] = [];
    const spy = { fleetAdmin: () => { asked.push("f"); return "ok" as const; }, channelAdmin: () => { asked.push("c"); return true; }, classicAdmin: () => { asked.push("a"); return true; } };
    expect(decideCommand(commandSpec("status")!, "fleet", spy, "telegram")).toEqual({ allow: false, passthrough: true });
    expect(decideCommand(commandSpec("collab")!, "classic", spy, "telegram")).toEqual({ allow: false, passthrough: true });
    expect(asked).toEqual([]);
  });

  it("the Discord column has no pass-through anywhere (every command applies, or refuses with a reason)", () => {
    for (const spec of COMMANDS) {
      for (const scope of ["fleet", "general", "classic", "none"] as CommandScope[]) {
        expect("passthrough" in ruleFor(spec, scope, "discord"), `${spec.name}/${scope}`).toBe(false);
        expect(ruleFor(spec, scope, "discord"), `${spec.name}/${scope}`).toBe(spec.scopes[scope]);
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
    // A Discord bot of its own: the reply names the Discord way to talk (#1196), and the guild is a Discord guild.
    const dc = { id: "dc", type: "discord", sendText: async () => ({ messageId: "m", chatId: "c" }) };
    any.worlds.set("dc", { id: "dc", adapter: dc, channelConfig: { id: "dc", type: "discord", bot_token_env: "X" } });
    // The real admission (the stub above stands in for it only on the Telegram paths).
    const start = (channel: string, user: string, guild: string) =>
      FleetManager.prototype.handleClassicStart.call(r.fm, channel, `n-${channel}`, user, guild, "dc", "claude-code");
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
    expect([spec.telegram.general, spec.telegram.fleet], "typed /start in a fleet topic is only text for the agent").toEqual([{ passthrough: true }, { passthrough: true }]);
    expect([spec.telegram.classic, spec.telegram.none].map(rule => "level" in rule && rule.level)).toEqual(["handler", "handler"]);
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
    expect(spec.telegram.classic).toEqual({ level: "classic-admin" });
    expect(isLocked(spec)).toBe(true);
    expect(slashLock("stop")).toBe("🔒 ");
  });
});
