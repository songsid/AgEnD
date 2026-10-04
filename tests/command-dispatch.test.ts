import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every handler that would do something real is replaced by a recorder: this file proves WHO gets through, and
// nothing in it may start an update, restart, pause, stop or network call.
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
  return { ...real, renderUsageMarkdown: vi.fn(() => "ok:usage") };
});

const created = vi.hoisted(() => [] as Array<{ id: string }>);
vi.mock("../src/channel/factory.js", async () => {
  const { EventEmitter: EE } = await import("node:events");
  class FakeAdapter extends EE {
    readonly type = "discord";
    constructor(readonly id: string) { super(); }
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    setChatId(): void {}
    async sendText(chatId: string): Promise<{ messageId: string; chatId: string }> { return { messageId: "m1", chatId }; }
    async react(): Promise<void> {}
    async unreact(): Promise<void> {}
  }
  return {
    createAdapter: vi.fn(async (_config: unknown, opts: { id: string }) => {
      const adapter = new FakeAdapter(opts.id);
      created.push(adapter);
      return adapter;
    }),
  };
});

import { FleetManager } from "../src/fleet-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { COMMANDS, commandSpec, decideCommand, isLocked, slashLock, type CommandChecks, type CommandScope } from "../src/command-table.js";
import { setLocale, t } from "../src/locale.js";

/**
 * The command table, as it behaves: every slash command × every kind of channel × every kind of caller, through the
 * real dispatcher. The expectations are written out by hand below — as "who reaches the command" per scope — and are
 * deliberately NOT derived from `COMMANDS`, so an error in the table is a failing test rather than a self-consistent
 * mistake. Where a level changed, the old level is in the comment.
 */
type Who = "member" | "fleetAdmin" | "classicAdmin";
const WHO: Record<Who, string> = { member: "member", fleetAdmin: "admin", classicAdmin: "cadmin" };

const ALL: Who[] = ["member", "fleetAdmin", "classicAdmin"];
const FLEET_ADMIN: Who[] = ["fleetAdmin"];
/** channel-admin in a ClassicBot channel: a fleet admin or a ClassicBot admin. */
const CHANNEL_ADMIN_IN_CLASSIC: Who[] = ["fleetAdmin", "classicAdmin"];
const CLASSIC_ADMIN: Who[] = ["classicAdmin"];

type Cell = Who[] | { refuse: string };
type Row = Record<CommandScope, Cell>;
const refuse = (key: string): Cell => ({ refuse: key });
const NO_AGENT = refuse("classic.no_agent");
const NO_AGENT_START = refuse("classic.no_agent_start");

const everywhere = (who: Who[]): Row => ({ fleet: who, general: who, classic: who, none: who });
const agentChannels = (fleetLike: Who[], classic: Who[], none: Cell): Row => ({ fleet: fleetLike, general: fleetLike, classic, none });
const classicOnly = (who: Who[], other: Cell): Row => ({ fleet: other, general: other, classic: who, none: other });

const EXPECTED: Record<string, Row> = {
  // `handler`-decided (the table asks nothing): Discord's guild allowlist, Telegram's user / group allowlist + ClassicBot admin in a group. See tests/command-gates-by-platform.test.ts.
  start: { fleet: refuse("classic.topic_bound"), general: refuse("classic.topic_bound"), classic: refuse("classic.already_active"), none: ALL },
  stop: classicOnly(CLASSIC_ADMIN, NO_AGENT),                                             // was: anyone (Discord; "the guild allowlist is the boundary"). Telegram always needed a ClassicBot admin — and ONLY that, not a fleet admin
  chat: classicOnly(ALL, NO_AGENT_START),
  load: classicOnly(CLASSIC_ADMIN, NO_AGENT_START),                                       // unchanged: ClassicBot admins only
  pause: agentChannels(FLEET_ADMIN, CHANNEL_ADMIN_IN_CLASSIC, NO_AGENT),                  // Discord, in a ClassicBot channel: was classic admin only (a fleet admin was refused). Telegram still is.
  wake: agentChannels(FLEET_ADMIN, CHANNEL_ADMIN_IN_CLASSIC, NO_AGENT),
  compact: agentChannels(FLEET_ADMIN, CHANNEL_ADMIN_IN_CLASSIC, NO_AGENT),                // Discord was: anyone, while labelled 🔒. Telegram: ClassicBot admin in a ClassicBot chat, nobody checked in a fleet topic
  clear: agentChannels(FLEET_ADMIN, CHANNEL_ADMIN_IN_CLASSIC, NO_AGENT),                  // unchanged for people who could use it
  model: agentChannels(FLEET_ADMIN, CHANNEL_ADMIN_IN_CLASSIC, NO_AGENT),
  effort: agentChannels(FLEET_ADMIN, CHANNEL_ADMIN_IN_CLASSIC, NO_AGENT),
  collab: agentChannels(FLEET_ADMIN, CHANNEL_ADMIN_IN_CLASSIC, NO_AGENT_START),           // was in a ClassicBot channel: classic admin only
  save: agentChannels(FLEET_ADMIN, CHANNEL_ADMIN_IN_CLASSIC, NO_AGENT_START),             // was everywhere: classic admin only (the wrong kind in a fleet channel)
  steer: agentChannels(ALL, ALL, NO_AGENT),
  btw: agentChannels(ALL, ALL, NO_AGENT),
  cancel: agentChannels(ALL, ALL, NO_AGENT),
  ctx: agentChannels(ALL, ALL, NO_AGENT),
  status: everywhere(FLEET_ADMIN),
  restart: everywhere(FLEET_ADMIN),
  login: everywhere(FLEET_ADMIN),
  update: everywhere(FLEET_ADMIN),
  doctor: everywhere(FLEET_ADMIN),
  dashboard: everywhere(FLEET_ADMIN),
  sysinfo: everywhere(ALL),
  usage: everywhere(ALL),
  tips: everywhere(ALL),
};

const CHANNEL: Record<CommandScope, string> = { fleet: "T1", general: "T0", classic: "C1", none: "RANDOM" };

interface Rig {
  fm: FleetManager;
  reached: string[];
  replies: string[];
  /** Which collab switch was thrown: the fleet instance's, or the ClassicBot channel's. */
  collab: { fleet: string[]; classic: string[] };
  emit(adapterId: string, command: string, who: Who, scope: CommandScope, guildId?: string | null): Promise<void>;
}

const dirs: string[] = [];
beforeEach(() => { setLocale("en"); created.length = 0; spawned.length = 0; });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function rig(opts: { primaryMode?: "open" | "locked"; ownerGone?: boolean; overlap?: boolean } = {}): Promise<Rig> {
  const dir = join(tmpdir(), `agend-command-dispatch-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  vi.stubEnv("TEST_BOT_TOKEN", "x");
  const fm = new FleetManager(dir);
  const open = { mode: opts.primaryMode ?? "open", allowed_users: ["admin"] };    // "open": everyone may talk; only "admin" is a fleet admin
  const primary = { id: "discord", type: "discord", bot_token_env: "TEST_BOT_TOKEN", group_id: "G1", access: open };
  const second = { id: "second", type: "discord", bot_token_env: "TEST_BOT_TOKEN", group_id: "G2", access: { mode: "open", allowed_users: ["ops"] } };
  const channels = [primary, second];
  const fleet = {
    defaults: {},
    channels,
    channel: primary,
    instances: {
      worker: { topic_id: "T1", backend: "claude-code", working_directory: dir, ...(opts.ownerGone ? { channel_id: "ghost" } : {}) },
      general: { topic_id: "T0", backend: "claude-code", working_directory: dir, general_topic: true, ...(opts.ownerGone ? { channel_id: "ghost" } : {}) },
    },
  } as never;
  fm.fleetConfig = fleet;
  fm.routing.rebuild(fleet);

  const classicRoom = "C1";
  const anyFm = fm as unknown as Record<string, unknown>;
  const tc = (fm as unknown as { topicCommands: Record<string, unknown> }).topicCommands;
  const reached: string[] = [];
  const replies: string[] = [];
  const collab = { fleet: [] as string[], classic: [] as string[] };
  // `overlap`: the fleet instance's channel is ALSO registered as a ClassicBot channel — two configurations that each
  // validate on their own, so both are live at once.
  const isClassicRoom = (room: string) => room === classicRoom || (opts.overlap === true && room === "T1");

  fm.classicChannels = {
    isClassicChannel: (room: string) => isClassicRoom(room),
    hasChannel: (room: string) => isClassicRoom(room),
    getInstanceByChannel: (room: string) => (isClassicRoom(room) ? "classic-1" : undefined),
    getChannelIdByInstance: () => undefined,
    getAdapterIdByInstance: () => "discord",
    isAdmin: (user: string) => user === "cadmin",
    isGuildAllowed: () => true,
    toggleCollab: () => { reached.push("collab"); collab.classic.push("classic-1"); return true; },
    getBackendByInstance: () => "claude-code",
    getContextLines: () => 5,
    getAll: () => [],
  } as never;

  const marks = (cmd: string) => async (data: { respond(text: string): Promise<unknown> }) => { reached.push(cmd); await data.respond(`ok:${cmd}`); };
  anyFm.handleClassicStartSlash = marks("start");
  anyFm.handleClassicStop = async () => { reached.push("stop"); return "ok:stop"; };
  anyFm.handlePauseWakeSlash = async (data: { command: string; respond(text: string): Promise<unknown> }) => { reached.push(data.command); await data.respond(`ok:${data.command}`); };
  anyFm.handleSlashSave = marks("save");
  anyFm.handleModelSlash = marks("model");
  anyFm.handleEffortSlash = marks("effort");
  anyFm.handleClearSlash = marks("clear");
  anyFm.handleLoginSlash = marks("login");
  anyFm.handleRestartSlash = marks("restart");
  anyFm.handleUpdateSlash = marks("update");
  anyFm.handleTipsSlash = marks("tips");
  anyFm.runBackendDoctor = async () => { reached.push("doctor"); return "ok:doctor"; };
  anyFm.cancelInstance = () => { reached.push("cancel"); return true; };
  anyFm.toggleFleetCollab = (name: string) => { reached.push("collab"); collab.fleet.push(name); return true; };
  anyFm.forwardToClassicInstance = async () => { reached.push("chat"); };
  anyFm.pasteRawToClassicInstance = () => { reached.push("load"); };
  anyFm.resolveStatusEmojisFor = () => ({ platform: "discord", received: "👀" });
  tc.sendCompact = async () => { reached.push("compact"); return "ok:compact"; };
  tc.sendSteer = () => { reached.push("steer"); return "ok:steer"; };
  tc.sendBtw = () => { reached.push("btw"); return "ok:btw"; };
  tc.getCtxText = async () => { reached.push("ctx"); return "ok:ctx"; };
  tc.getStatusText = async () => { reached.push("status"); return "ok:status"; };
  tc.sendSysInfo = async (send: (text: string) => Promise<unknown>) => { reached.push("sysinfo"); await send("ok:sysinfo"); };
  tc.getDashboardText = () => { reached.push("dashboard"); return "ok:dashboard"; };
  tc.registerBotCommands = async () => {};
  anyFm.probeCliEnvs = () => {};
  vi.spyOn(ClassicChannelManager, "logMessage").mockImplementation(() => {});

  await (fm as unknown as { startSingleAdapter(f: unknown, c: unknown): Promise<void> }).startSingleAdapter(fleet, channels[0]);
  await (fm as unknown as { startAdditionalAdapter(c: unknown): Promise<void> }).startAdditionalAdapter(second);
  const adapters = new Map(created.map(a => [a.id, a as unknown as { emit(e: string, d: unknown): void }]));

  async function emit(adapterId: string, command: string, who: Who, scope: CommandScope, guildId?: string | null): Promise<void> {
    replies.length = 0;
    reached.length = 0;
    adapters.get(adapterId)!.emit("slash_command", {
      command, channelId: CHANNEL[scope], channelName: "chan",
      guildId: guildId === null ? undefined : (guildId ?? (adapterId === "second" ? "G2" : "G1")), userId: WHO[who], username: who,
      options: { message: "go", filename: "f.json", instructions: "", instance: "worker" }, text: "go",
      respond: async (text: string) => { replies.push(text); return "m1"; },
      respondChoices: async (text: string) => { replies.push(text); return "m2"; },
    });
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0), { timeout: 2000 });
    await new Promise<void>(res => setImmediate(res));
    // /usage renders through a mocked formatter, so its reply is the only trace that it ran.
    if (replies.includes("ok:usage")) reached.push("usage");
  }
  return { fm, reached, replies, collab, emit };
}

const cells = (): Array<[string, CommandScope, Who, Cell]> => {
  const out: Array<[string, CommandScope, Who, Cell]> = [];
  for (const [command, row] of Object.entries(EXPECTED)) {
    for (const scope of ["fleet", "general", "classic", "none"] as CommandScope[]) {
      for (const who of ALL) out.push([command, scope, who, row[scope]]);
    }
  }
  return out;
};

describe("every command × every kind of channel × every kind of caller", () => {
  it("is written out for every command the table has, and for no other", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(COMMANDS.map(c => c.name).sort());
  });

  it("(the table, read cell by cell, says what the expectations say)", () => {
    for (const spec of COMMANDS) {
      for (const scope of ["fleet", "general", "classic", "none"] as CommandScope[]) {
        const expected = EXPECTED[spec.name]![scope];
        const rule = spec.scopes[scope];
        if (Array.isArray(expected)) {
          expect("level" in rule, `${spec.name}/${scope}`).toBe(true);
        } else {
          expect("refuse" in rule && rule.refuse[0], `${spec.name}/${scope}`).toBe(expected.refuse);
        }
      }
    }
  });

  let r: Rig;
  beforeEach(async () => { r = await rig(); });

  it.each(cells())("%s in %s as %s", async (command, scope, who, cell) => {
    await r.emit("discord", command, who, scope);
    if (!Array.isArray(cell)) {
      expect(r.replies, "a command that does not apply says so").toEqual([t(cell.refuse)]);
      expect(r.reached, "and does nothing").toEqual([]);
    } else if (cell.includes(who)) {
      expect(r.reached, "someone at the required level gets the command").toContain(command);
    } else {
      expect(r.reached, "someone below the required level does not reach the command").toEqual([]);
      expect(r.replies).toHaveLength(1);
      expect(r.replies[0], "and is told so").not.toMatch(/^ok:/);
    }
    expect(spawned, "nothing real ran").toHaveLength(0);
  });

  it("tells the General dispatcher from an instance's own channel (the table has a row for each)", async () => {
    const info = vi.fn();
    (r.fm as unknown as { logger: unknown }).logger = { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), child() { return this; } };
    await r.emit("discord", "compact", "member", "general");
    await r.emit("discord", "compact", "member", "fleet");
    await r.emit("discord", "compact", "member", "classic");
    const scopes = info.mock.calls.filter(c => c[1] === "Slash command refused by the command table").map(c => (c[0] as { scope: string }).scope);
    expect(scopes).toEqual(["general", "fleet", "classic"]);
  });

  it("a command nobody registered is answered, not left to time out", async () => {
    await r.emit("discord", "removed-in-a-later-version", "fleetAdmin", "fleet");
    expect(r.replies).toEqual([t("slash.unknown_command")]);
    expect(r.reached).toEqual([]);
  });

  it("the second adapter dispatches through the same table", async () => {
    // "ops" is the second adapter's only fleet admin; "admin" is the primary's.
    await r.emit("second", "status", "fleetAdmin", "none");              // admin is NOT an admin of "second"
    expect(r.reached).toEqual([]);
    expect(r.replies[0]).toBe(t("cmd.admin_required", "/status"));
    await r.emit("second", "stop", "member", "classic");                 // classic room: a member is not a channel admin
    expect(r.reached).toEqual([]);
    expect(r.replies[0]).toBe(t("classic.admin_only_stop"));
    await r.emit("second", "ctx", "member", "none");
    expect(r.replies).toEqual([t("classic.no_agent")]);
  });

  it("the replies a refusal uses are the ones each command always used", async () => {
    await r.emit("discord", "compact", "member", "fleet");
    expect(r.replies).toEqual([t("cmd.admin_required", "/compact")]);
    await r.emit("discord", "save", "member", "classic");
    expect(r.replies).toEqual([t("admin.required")]);
    await r.emit("discord", "pause", "member", "fleet");
    expect(r.replies).toEqual([t("permission.denied")]);
    await r.emit("discord", "update", "member", "none");
    expect(r.replies).toEqual([t("not_authorized")]);
  });
});

describe("the pure rule", () => {
  const nobody: CommandChecks = { fleetAdmin: () => "denied", channelAdmin: () => false, classicAdmin: () => false };

  it("`handler` lets through whoever the door admitted and asks nobody; it is not a lock", () => {
    const asked: string[] = [];
    const spy: CommandChecks = {
      fleetAdmin: () => { asked.push("f"); return "denied"; }, channelAdmin: () => { asked.push("c"); return false; }, classicAdmin: () => { asked.push("a"); return false; },
    };
    expect(decideCommand(commandSpec("start")!, "none", spy)).toEqual({ allow: true });
    expect(decideCommand(commandSpec("start")!, "none", spy, "telegram")).toEqual({ allow: true });
    expect(asked).toEqual([]);
    expect(isLocked(commandSpec("start")!)).toBe(false);
  });

  it("a Telegram override applies only on Telegram; the Discord answer for the same cell is unchanged", () => {
    const classicAdminOnly: CommandChecks = { ...nobody, classicAdmin: () => true };
    const fleetAdminInClassic: CommandChecks = { ...nobody, channelAdmin: () => true };    // what `isModelAdmin` says of a fleet admin
    expect(decideCommand(commandSpec("pause")!, "classic", fleetAdminInClassic, "discord")).toEqual({ allow: true });
    expect(decideCommand(commandSpec("pause")!, "classic", fleetAdminInClassic, "telegram")).toEqual({ allow: false, reply: ["permission.denied"] });
    expect(decideCommand(commandSpec("pause")!, "classic", classicAdminOnly, "telegram")).toEqual({ allow: true });
    expect(decideCommand(commandSpec("compact")!, "fleet", nobody, "telegram")).toEqual({ allow: true });
    expect(decideCommand(commandSpec("compact")!, "fleet", nobody, "discord")).toEqual({ allow: false, reply: ["cmd.admin_required", "/compact"] });
    expect(decideCommand(commandSpec("compact")!, "fleet", nobody)).toEqual({ allow: false, reply: ["cmd.admin_required", "/compact"] });      // the default platform is Discord
  });

  const checks = (over: Partial<Record<keyof CommandChecks, unknown>> = {}) => {
    const asked: string[] = [];
    const c: CommandChecks = {
      fleetAdmin: () => { asked.push("fleetAdmin"); return (over.fleetAdmin as "ok") ?? "denied"; },
      channelAdmin: () => { asked.push("channelAdmin"); return (over.channelAdmin as boolean) ?? false; },
      classicAdmin: () => { asked.push("classicAdmin"); return (over.classicAdmin as boolean) ?? false; },
    };
    return { c, asked };
  };

  it("asks only about the level the command needs", () => {
    const { c, asked } = checks({ channelAdmin: true });
    expect(decideCommand(commandSpec("compact")!, "fleet", c)).toEqual({ allow: true });
    expect(asked).toEqual(["channelAdmin"]);
    const second = checks();
    decideCommand(commandSpec("steer")!, "fleet", second.c);
    expect(second.asked).toEqual([]);                      // `anyone` asks nobody
    const refused = checks();
    expect(decideCommand(commandSpec("ctx")!, "none", refused.c)).toEqual({ allow: false, reply: ["classic.no_agent"] });
    expect(refused.asked).toEqual([]);                     // a command that does not apply never asks who is calling
  });

  it("a fleet-admin command says 'disabled' only when the adapter lists no admin at all, and only if it has such a reply", () => {
    expect(decideCommand(commandSpec("update")!, "none", checks({ fleetAdmin: "disabled" }).c)).toEqual({ allow: false, reply: ["update.disabled"] });
    expect(decideCommand(commandSpec("doctor")!, "none", checks({ fleetAdmin: "disabled" }).c)).toEqual({ allow: false, reply: ["not_authorized"] });
    expect(decideCommand(commandSpec("update")!, "none", checks({ fleetAdmin: "denied" }).c)).toEqual({ allow: false, reply: ["not_authorized"] });
    expect(decideCommand(commandSpec("update")!, "none", checks({ fleetAdmin: "ok" }).c)).toEqual({ allow: true });
  });

  it("classic-admin means a ClassicBot admin and nobody else", () => {
    expect(decideCommand(commandSpec("load")!, "classic", checks({ classicAdmin: true }).c)).toEqual({ allow: true });
    expect(decideCommand(commandSpec("load")!, "classic", checks({ fleetAdmin: "ok", channelAdmin: true }).c)).toEqual({ allow: false, reply: ["admin.required"] });
  });
});

describe("the lock emoji is generated from the table", () => {
  it("is on exactly the commands that ask for more than 'anyone' somewhere", () => {
    const locked = COMMANDS.filter(isLocked).map(c => c.name).sort();
    expect(locked).toEqual(
      ["clear", "collab", "compact", "dashboard", "doctor", "effort", "load", "login", "model", "pause", "restart", "save", "status", "stop", "update", "wake"].sort(),
    );
    for (const spec of COMMANDS) expect(slashLock(spec.name), spec.name).toBe(isLocked(spec) ? "🔒 " : "");
    expect(slashLock("not-a-command")).toBe("");
  });

  it("is what the Discord adapter registers: every command's description starts from the table, none is typed by hand", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(join(process.cwd(), "src", "channel", "adapters", "discord.ts"), "utf8");
    const block = src.slice(src.indexOf("commands.set(["), src.indexOf("]);", src.indexOf("commands.set([")));
    expect(block).not.toContain("🔒");
    const registered = [...block.matchAll(/name: "(\w+)", description: (?:withFleetLabel\()?slashLock\("(\w+)"\)/g)];
    for (const [, name, locked] of registered) expect(locked).toBe(name);
    expect(registered.map(m => m[1]).sort()).toEqual(COMMANDS.filter(c => c.slash).map(c => c.name).sort());
  });

  it("every reply a refusal can use exists in both languages", () => {
    for (const spec of COMMANDS) {
      const replies = [spec.denied, ...(spec.disabled ? [spec.disabled] : [])];
      for (const rule of Object.values(spec.scopes)) if ("refuse" in rule) replies.push(rule.refuse);
      for (const locale of ["en", "zh-TW"] as const) {
        setLocale(locale);
        for (const [key, ...args] of replies) expect(t(key, ...args), `${locale} ${spec.name} ${key}`).not.toBe(key);
      }
    }
    setLocale("en");
  });
});

describe("the two handlers whose own admin check changed kind (#1148)", () => {
  let r: Rig;
  beforeEach(async () => { r = await rig(); });

  /** The dispatch matrix stubs these two; the real ones are what this section runs. */
  function real(r: Rig) {
    const fm = r.fm as unknown as Record<string, any>;
    delete fm.handleSlashSave;
    delete fm.handlePauseWakeSlash;
    const send = vi.fn();
    (fm.instanceIpcClients as Map<string, unknown>).set("worker", { send, connected: true });
    const pasted = vi.fn();
    fm.pasteRawToClassicInstance = pasted;
    const runPauseWake = vi.fn(async (name: string, action: string) => `${action}:${name}`);
    fm.topicCommands.runPauseWake = runPauseWake;
    const replies: string[] = [];
    const data = (channelId: string, who: Who, extra: Record<string, unknown> = {}) => ({
      command: "pause", channelId, channelName: "c", guildId: "G1", userId: WHO[who], options: { filename: "f.json" },
      respond: async (text: string) => { replies.push(text); return "m"; }, ...extra,
    });
    return { fm, send, pasted, runPauseWake, replies, data };
  }

  it("/save in a fleet channel: a fleet admin may, a ClassicBot admin who is not one may not (it was the other way round)", async () => {
    const h = real(r);
    await h.fm.handleSlashSave(h.data("T1", "fleetAdmin"), "discord");
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0]![0]).toMatchObject({ type: "raw_paste" });
    h.send.mockClear();
    for (const who of ["classicAdmin", "member"] as Who[]) {
      h.replies.length = 0;
      await h.fm.handleSlashSave(h.data("T1", who), "discord");
      expect(h.replies, who).toEqual([t("admin.required")]);
    }
    expect(h.send).not.toHaveBeenCalled();
  });

  it("/save in a ClassicBot channel: a fleet admin or a ClassicBot admin may; a member may not", async () => {
    const h = real(r);
    await h.fm.handleSlashSave(h.data("C1", "classicAdmin"), "discord");
    await h.fm.handleSlashSave(h.data("C1", "fleetAdmin"), "discord");
    expect(h.pasted).toHaveBeenCalledTimes(2);
    h.pasted.mockClear();
    await h.fm.handleSlashSave(h.data("C1", "member"), "discord");
    expect(h.pasted).not.toHaveBeenCalled();
    expect(h.replies.at(-1)).toBe(t("admin.required"));
  });

  it("/pause in a ClassicBot channel: a fleet admin may now too; a member may not", async () => {
    const h = real(r);
    await h.fm.handlePauseWakeSlash(h.data("C1", "classicAdmin"), "discord");
    await h.fm.handlePauseWakeSlash(h.data("C1", "fleetAdmin"), "discord");
    expect(h.runPauseWake.mock.calls).toEqual([["classic-1", "pause"], ["classic-1", "pause"]]);
    h.runPauseWake.mockClear();
    await h.fm.handlePauseWakeSlash(h.data("C1", "member"), "discord");
    expect(h.runPauseWake).not.toHaveBeenCalled();
    expect(h.replies.at(-1)).toBe(t("permission.denied"));
  });

  it("/pause in a fleet channel is still the fleet admin's alone", async () => {
    const h = real(r);
    await h.fm.handlePauseWakeSlash(h.data("T1", "classicAdmin"), "discord");
    await h.fm.handlePauseWakeSlash(h.data("T1", "member"), "discord");
    expect(h.runPauseWake).not.toHaveBeenCalled();
    await h.fm.handlePauseWakeSlash(h.data("T1", "fleetAdmin"), "discord");
    expect(h.runPauseWake).toHaveBeenCalledWith("worker", "pause");
  });
});

/**
 * The hard contract of the table: it sits BEHIND the door and can only narrow. So wherever the door refuses —
 * a DM, another guild, a speaker the access policy would not hear, an owner adapter that is not running — no
 * command is reached, however generous the table's row is and however senior the caller (a fleet admin included).
 * Asserted for every command in every scope, so a future table row cannot become a way round the door.
 */
describe("the table can only narrow: wherever the door refuses, no command is reached", () => {
  const scopesWithChannels: CommandScope[] = ["fleet", "general", "classic", "none"];

  it.each(COMMANDS.map(c => c.name))("%s", async command => {
    // A DM and another guild: refused for everyone, a fleet admin too. (ClassicBot channels keep honouring a
    // registered channel from another guild — that is the door's own rule — so the foreign guild is tried in the
    // scopes where it must be refused.)
    const open = await rig();
    for (const scope of scopesWithChannels) {
      for (const who of ALL) {
        await open.emit("discord", command, who, scope, null);
        expect(open.reached, `${command}/${scope}/${who} in a DM`).toEqual([]);
        expect(open.replies, `${command}/${scope}/${who} in a DM`).toEqual([t("slash.dm_unsupported")]);
      }
    }
    for (const scope of ["fleet", "general", "none"] as CommandScope[]) {
      if (command === "start") continue;                                // the door lets /start in from another guild (its own allowlist applies); the table then refuses it in a fleet channel
      for (const who of ALL) {
        await open.emit("discord", command, who, scope, "OTHER-GUILD");
        expect(open.reached, `${command}/${scope}/${who} from another guild`).toEqual([]);
        expect(open.replies, `${command}/${scope}/${who} from another guild`).toEqual([t("slash.wrong_server")]);
      }
    }

    // A speaker the access policy would not hear (locked, and not an admin): refused outside ClassicBot channels,
    // whatever the table says about the command — including every `anyone` row.
    const locked = await rig({ primaryMode: "locked" });
    for (const scope of ["fleet", "general", "none"] as CommandScope[]) {
      if (command === "start" && scope === "none") continue;            // a ClassicBot door, by design
      for (const who of ["member", "classicAdmin"] as Who[]) {
        await locked.emit("discord", command, who, scope);
        expect(locked.reached, `${command}/${scope}/${who} under a locked policy`).toEqual([]);
        expect(locked.replies, `${command}/${scope}/${who} under a locked policy`).toEqual([t("not_authorized")]);
      }
    }

    // A fleet channel whose owning adapter is not running: nobody, a fleet admin included.
    const orphaned = await rig({ ownerGone: true });
    for (const scope of ["fleet", "general"] as CommandScope[]) {
      for (const who of ALL) {
        await orphaned.emit("discord", command, who, scope);
        expect(orphaned.reached, `${command}/${scope}/${who} with the owner not running`).toEqual([]);
        expect(orphaned.replies).toEqual([t("not_authorized")]);
      }
    }
  });

  it("is the door's decision that stops them, not the table's: a command whose table row allows everyone is still refused", async () => {
    const r = await rig({ primaryMode: "locked" });
    expect(commandSpec("ctx")!.scopes.fleet).toEqual({ level: "anyone" });
    await r.emit("discord", "ctx", "member", "fleet");
    expect(r.reached).toEqual([]);
    expect(r.replies).toEqual([t("not_authorized")]);
  });
});

describe("/collab acts in the scope that was authorized (a channel in both the ClassicBot registry and the routing table)", () => {
  it.each(["discord", "second"])("%s: a ClassicBot admin switches the ClassicBot channel's collab, never the fleet instance's", async adapterId => {
    const r = await rig({ overlap: true });
    await r.emit(adapterId, "collab", "classicAdmin", "fleet");          // T1: the fleet instance's channel, also registered as ClassicBot
    expect(r.collab.classic).toEqual(["classic-1"]);
    expect(r.collab.fleet, "the fleet instance's switch is not theirs to throw").toEqual([]);
  });

  it("a fleet admin in that same channel is judged — and acts — as the ClassicBot channel too", async () => {
    const r = await rig({ overlap: true });
    await r.emit("discord", "collab", "fleetAdmin", "fleet");
    expect(r.collab).toEqual({ fleet: [], classic: ["classic-1"] });
  });

  it("control — an ordinary fleet channel: the fleet admin throws the fleet switch, a ClassicBot admin throws nothing", async () => {
    const r = await rig();
    await r.emit("discord", "collab", "fleetAdmin", "fleet");
    expect(r.collab).toEqual({ fleet: ["worker"], classic: [] });
    await r.emit("discord", "collab", "classicAdmin", "fleet");
    expect(r.collab).toEqual({ fleet: ["worker"], classic: [] });
    expect(r.replies).toEqual([t("not_authorized")]);
  });

  it("control — an ordinary ClassicBot channel still throws the ClassicBot switch for either kind of admin", async () => {
    const r = await rig();
    await r.emit("discord", "collab", "classicAdmin", "classic");
    await r.emit("discord", "collab", "fleetAdmin", "classic");
    expect(r.collab).toEqual({ fleet: [], classic: ["classic-1", "classic-1"] });      // once per admin
  });
});
