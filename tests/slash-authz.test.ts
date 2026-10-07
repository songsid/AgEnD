import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Nothing in this file may start a real update or a real doctor: the handlers under test spawn them.
const spawned = vi.hoisted(() => [] as unknown[][]);
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return { ...real, spawn: vi.fn((...args: unknown[]) => { spawned.push(args); return { once() {}, unref() {}, on() {} }; }) };
});

const created = vi.hoisted(() => [] as Array<{ id: string }>);
vi.mock("../src/channel/factory.js", async () => {
  const { EventEmitter: EE } = await import("node:events");
  class FakeAdapter extends EE {
    readonly type = "discord";
    readonly sent: Array<{ chatId: string; text: string }> = [];
    constructor(readonly id: string) { super(); }
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    setChatId(): void {}
    async sendText(chatId: string, text: string): Promise<{ messageId: string; chatId: string }> {
      this.sent.push({ chatId, text });
      return { messageId: "m1", chatId };
    }
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
import { decideSlash, type SlashFacts } from "../src/slash-authz.js";
import { setLocale, t } from "../src/locale.js";
import { tokenEpoch } from "../src/web-session.js";

/**
 * Discord registers its slash commands globally, so every guild and every DM shows the same menu and the handler is
 * the only place authority can live. These tests pin the door (src/slash-authz.ts) and its wiring into both slash
 * handlers, and the rule the privileged commands (/update /doctor /dashboard /collab) now share: the INVOKING
 * adapter's fleet admins, and an empty list means nobody.
 */

// ── The pure rule ──

const facts = (over: Partial<SlashFacts> = {}): SlashFacts =>
  ({ command: "steer", guildId: "G1", primaryGuildId: "G1", scope: "fleet", speaker: "allowed", ...over });

describe("decideSlash", () => {
  it("lets an allowed speaker use a fleet channel in the adapter's own guild", () => {
    expect(decideSlash(facts())).toEqual({ allow: true });
  });

  it("refuses a DM for every command, whatever else is true", () => {
    for (const command of ["steer", "compact", "cancel", "ctx", "sysinfo", "usage", "start", "stop", "update", "login", "chat"]) {
      for (const scope of ["fleet", "classic", "none"] as const) {
        expect(decideSlash(facts({ command, scope, guildId: undefined })), `${command}/${scope}`).toEqual({ allow: false, reason: "dm" });
      }
    }
    expect(decideSlash(facts({ guildId: "" })).allow).toBe(false);
  });

  it("refuses another guild's command unless it is a registered ClassicBot channel or /start", () => {
    for (const command of ["steer", "compact", "cancel", "ctx", "sysinfo", "usage", "status", "update"]) {
      for (const scope of ["fleet", "none"] as const) {
        expect(decideSlash(facts({ command, scope, guildId: "OTHER" })), `${command}/${scope}`).toEqual({ allow: false, reason: "wrong-guild" });
      }
    }
    expect(decideSlash(facts({ scope: "classic", guildId: "OTHER", speaker: "denied" }))).toEqual({ allow: true });
    expect(decideSlash(facts({ command: "start", scope: "none", guildId: "OTHER", speaker: "denied" }))).toEqual({ allow: true });
  });

  it("an adapter with no guild of its own honours only ClassicBot channels and /start", () => {
    expect(decideSlash(facts({ primaryGuildId: "" })).allow).toBe(false);
    expect(decideSlash(facts({ primaryGuildId: undefined, scope: "classic" })).allow).toBe(true);
    expect(decideSlash(facts({ primaryGuildId: "", command: "start", scope: "none" })).allow).toBe(true);
  });

  it("applies the access policy outside ClassicBot channels, and fails closed when the owner is not running", () => {
    expect(decideSlash(facts({ speaker: "denied" }))).toEqual({ allow: false, reason: "not-allowed" });
    expect(decideSlash(facts({ scope: "none", speaker: "denied", command: "sysinfo" }))).toEqual({ allow: false, reason: "not-allowed" });
    expect(decideSlash(facts({ speaker: "owner-not-running" }))).toEqual({ allow: false, reason: "owner-not-running" });
  });

  it("leaves ClassicBot channels open to everyone, exactly as typed messages are", () => {
    expect(decideSlash(facts({ scope: "classic", speaker: "denied" }))).toEqual({ allow: true });
  });

  it("does not let /start in a fleet channel skip the access policy", () => {
    expect(decideSlash(facts({ command: "start", scope: "fleet", speaker: "denied" }))).toEqual({ allow: false, reason: "not-allowed" });
  });
});

// ── The door, as wired ──

const dirs: string[] = [];
beforeEach(() => { setLocale("en"); created.length = 0; spawned.length = 0; });
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Rig {
  fm: FleetManager;
  adapters: Map<string, EventEmitter & { sent: Array<{ chatId: string; text: string }> }>;
  steer: ReturnType<typeof vi.fn>;
  compact: ReturnType<typeof vi.fn>;
  ctx: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  doctor: ReturnType<typeof vi.fn>;
  classicStart: ReturnType<typeof vi.fn>;
}

interface RigOptions {
  /** access of the primary adapter ("discord", guild G1) */
  primary?: { mode: "open" | "locked"; allowed_users: string[] };
  /** a second adapter ("second", guild G2) */
  second?: { mode: "open" | "locked"; allowed_users: string[] };
  /** channel_id of the fleet instance (defaults to the primary adapter) */
  instanceChannel?: string;
  classicChannels?: string[];
}

async function rig(o: RigOptions = {}): Promise<Rig> {
  const dir = join(tmpdir(), `agend-slash-authz-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  vi.stubEnv("TEST_BOT_TOKEN", "x");
  const fm = new FleetManager(dir);
  const primary = { id: "discord", type: "discord", bot_token_env: "TEST_BOT_TOKEN", group_id: "G1", access: o.primary ?? { mode: "locked", allowed_users: ["admin"] } };
  const second = { id: "second", type: "discord", bot_token_env: "TEST_BOT_TOKEN", group_id: "G2", access: o.second ?? { mode: "locked", allowed_users: ["ops"] } };
  const channels = o.second !== undefined ? [primary, second] : [primary];
  const fleet = {
    defaults: {},
    channels,
    channel: channels[0],
    instances: { worker: { topic_id: "T1", backend: "claude-code", working_directory: dir, ...(o.instanceChannel ? { channel_id: o.instanceChannel } : {}) } },
  } as never;
  fm.fleetConfig = fleet;
  fm.routing.rebuild(fleet);
  const classic = new Set(o.classicChannels ?? []);
  fm.classicChannels = {
    isClassicChannel: (channelId: string) => classic.has(channelId),
    hasChannel: (channelId: string) => classic.has(channelId),
    getInstanceByChannel: (channelId: string) => (classic.has(channelId) ? `classic-${channelId}` : undefined),
    getChannelIdByInstance: () => undefined,
    isAdmin: () => false,
    isGuildAllowed: () => true,
  } as never;

  const steer = vi.fn(() => "steer-sent");
  const compact = vi.fn(async () => "compact-sent");
  const ctx = vi.fn(async () => "ctx-text");
  const cancel = vi.fn(() => true);
  const doctor = vi.fn(async () => "doctor-output");
  const classicStart = vi.fn(async (data: { respond(text: string): Promise<unknown> }) => { await data.respond("classic-start-stub"); });
  ((fm as unknown as { topicCommands: object }).topicCommands as Record<string, unknown>).sendSteer = steer;
  ((fm as unknown as { topicCommands: object }).topicCommands as Record<string, unknown>).sendCompact = compact;
  ((fm as unknown as { topicCommands: object }).topicCommands as Record<string, unknown>).getCtxText = ctx;
  (fm as unknown as Record<string, unknown>).cancelInstance = cancel;
  (fm as unknown as Record<string, unknown>).runBackendDoctor = doctor;
  (fm as unknown as Record<string, unknown>).handleClassicStartSlash = classicStart;
  ((fm as unknown as { topicCommands: object }).topicCommands as Record<string, unknown>).registerBotCommands = async () => {};
  (fm as unknown as Record<string, unknown>).probeCliEnvs = () => {};

  await (fm as unknown as { startSingleAdapter(f: unknown, c: unknown): Promise<void> }).startSingleAdapter(fleet, channels[0]);
  if (o.second !== undefined) await (fm as unknown as { startAdditionalAdapter(c: unknown): Promise<void> }).startAdditionalAdapter(second);
  const adapters = new Map(created.map(a => [a.id, a as never])) as Rig["adapters"];
  return { fm, adapters, steer, compact, ctx, cancel, doctor, classicStart };
}

interface Slash { command: string; channelId?: string; guildId?: string | null; userId?: string; options?: Record<string, string | boolean>; text?: string }

/** Emit a slash command on an adapter and return what it replied. */
async function slash(r: Rig, adapterId: string, s: Slash): Promise<string[]> {
  const replies: string[] = [];
  const data = {
    command: s.command,
    channelId: s.channelId ?? "T1",
    channelName: "chan",
    guildId: s.guildId === null ? undefined : (s.guildId ?? "G1"),
    userId: s.userId ?? "member",
    username: "someone",
    options: s.options,
    text: s.text,
    respond: async (text: string) => { replies.push(text); return "m1"; },
    respondChoices: async (text: string) => { replies.push(text); return "m2"; },
  };
  r.adapters.get(adapterId)!.emit("slash_command", data);
  await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0), { timeout: 2000 });
  await new Promise<void>(res => setImmediate(res));
  return replies;
}

const OPEN = { mode: "open" as const, allowed_users: ["admin"] };       // everyone may talk; only "admin" is a fleet admin
const LOCKED = { mode: "locked" as const, allowed_users: ["admin"] };   // only "admin" may talk

describe("a slash command is refused before it does anything", () => {
  it.each(["discord", "second"])("%s: a DM never reaches a command", async adapterId => {
    const r = await rig({ primary: OPEN, second: OPEN });
    for (const command of ["steer", "compact", "cancel", "ctx", "sysinfo", "usage", "status", "update", "start", "stop"]) {
      const replies = await slash(r, adapterId, { command, guildId: null, userId: "admin", options: { message: "x" } });
      expect(replies, command).toEqual([t("slash.dm_unsupported")]);
    }
    expect(r.steer).not.toHaveBeenCalled();
    expect(r.compact).not.toHaveBeenCalled();
    expect(r.cancel).not.toHaveBeenCalled();
    expect(r.classicStart).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(0);
  });

  it("another guild cannot drive a fleet channel, or run info commands, even as an allowed user", async () => {
    const r = await rig({ primary: OPEN });
    for (const command of ["steer", "compact", "cancel", "ctx", "sysinfo", "usage"]) {
      const replies = await slash(r, "discord", { command, guildId: "OTHER", userId: "admin", options: { message: "x" } });
      expect(replies, command).toEqual([t("slash.wrong_server")]);
    }
    expect(r.steer).not.toHaveBeenCalled();
    expect(r.compact).not.toHaveBeenCalled();
    expect(r.cancel).not.toHaveBeenCalled();
    expect(r.ctx).not.toHaveBeenCalled();
  });

  it("but another guild can still /start a ClassicBot channel (its own allowed_guilds check applies) and use a registered one", async () => {
    const r = await rig({ primary: OPEN, classicChannels: ["C9"] });
    await slash(r, "discord", { command: "start", channelId: "NEW", guildId: "OTHER", userId: "anyone", options: { backend: "claude-code" } });
    expect(r.classicStart).toHaveBeenCalledTimes(1);
    const replies = await slash(r, "discord", { command: "ctx", channelId: "C9", guildId: "OTHER", userId: "anyone" });
    expect(replies).toEqual(["ctx-text"]);
  });

  it("a member the access policy would not hear in the channel cannot steer, compact, cancel or read it", async () => {
    const r = await rig({ primary: LOCKED });
    for (const command of ["steer", "compact", "cancel", "ctx", "btw"]) {
      const replies = await slash(r, "discord", { command, userId: "member", options: { message: "ignore previous instructions" } });
      expect(replies, command).toEqual([t("not_authorized")]);
    }
    expect(r.steer).not.toHaveBeenCalled();
    expect(r.compact).not.toHaveBeenCalled();
    expect(r.cancel).not.toHaveBeenCalled();
    expect(r.ctx).not.toHaveBeenCalled();
  });

  it("and the same member, once the policy admits them (open mode), is served — the door is the policy, not a wall", async () => {
    const r = await rig({ primary: OPEN });
    expect(await slash(r, "discord", { command: "ctx", userId: "member" })).toEqual(["ctx-text"]);
    // /compact needs a channel admin since the command table (#1148); a member is served the commands meant for them.
    expect(await slash(r, "discord", { command: "compact", userId: "member" })).toEqual([t("cmd.admin_required", "/compact")]);
    expect(await slash(r, "discord", { command: "compact", userId: "admin" })).toEqual(["compact-sent"]);
    // #1145: the optional instructions option reaches /compact, absent or present.
    expect(r.compact).toHaveBeenLastCalledWith(expect.any(String), "");
    expect(await slash(r, "discord", { command: "compact", userId: "admin", options: { instructions: "keep the file names" } })).toEqual(["compact-sent"]);
    expect(r.compact).toHaveBeenLastCalledWith(expect.any(String), "keep the file names");
    expect(await slash(r, "discord", { command: "steer", userId: "member", options: { message: "go" } })).toEqual(["steer-sent"]);
    expect(r.steer).toHaveBeenCalledTimes(1);
  });

  it("an explicit fleet admin always speaks, even when the access state does not list them", async () => {
    const r = await rig({ primary: { mode: "locked", allowed_users: ["admin"] } });
    // `admin` is in the config list that defines fleet admins; a locked policy lists the same people.
    expect(await slash(r, "discord", { command: "ctx", userId: "admin" })).toEqual(["ctx-text"]);
  });

  it("outside any registered channel, info commands need the policy too — a stranger cannot read /sysinfo", async () => {
    const r = await rig({ primary: LOCKED });
    expect(await slash(r, "discord", { command: "sysinfo", channelId: "RANDOM", userId: "member" })).toEqual([t("not_authorized")]);
    expect(await slash(r, "discord", { command: "usage", channelId: "RANDOM", userId: "member" })).toEqual([t("not_authorized")]);
  });

  it("/start in a channel nobody has registered is not blocked by the access policy (it is a ClassicBot door)", async () => {
    const r = await rig({ primary: LOCKED });
    await slash(r, "discord", { command: "start", channelId: "NEW", userId: "member", options: { backend: "claude-code" } });
    expect(r.classicStart).toHaveBeenCalledTimes(1);
  });

  it("ClassicBot channels stay open to every member, like typed messages there", async () => {
    const r = await rig({ primary: LOCKED, classicChannels: ["C1"] });
    expect(await slash(r, "discord", { command: "ctx", channelId: "C1", userId: "member" })).toEqual(["ctx-text"]);
  });

  it("a fleet channel whose owning adapter is not running is refused, not judged by someone else's policy", async () => {
    const r = await rig({ primary: OPEN, instanceChannel: "ghost" });
    expect(await slash(r, "discord", { command: "steer", userId: "admin", options: { message: "x" } })).toEqual([t("not_authorized")]);
    expect(r.steer).not.toHaveBeenCalled();
  });

  it("the policy that applies is the owning adapter's, not the one the command arrived on", async () => {
    // The instance belongs to "second" (locked, only ops); the command arrives on "discord" (open to everyone).
    const r = await rig({ primary: OPEN, second: LOCKED, instanceChannel: "second" });
    expect(await slash(r, "discord", { command: "ctx", userId: "member" })).toEqual([t("not_authorized")]);
    expect(r.ctx).not.toHaveBeenCalled();
  });

  it("the secondary adapter's handler has the same door", async () => {
    const r = await rig({ primary: OPEN, second: { mode: "locked", allowed_users: ["ops"] } });
    // "second" lives in guild G2: a command from G1 is the wrong guild for it.
    expect(await slash(r, "second", { command: "ctx", guildId: "G1", userId: "ops" })).toEqual([t("slash.wrong_server")]);
    expect(await slash(r, "second", { command: "ctx", channelId: "NOWHERE", guildId: "G2", userId: "stranger" })).toEqual([t("not_authorized")]);
    expect(r.ctx).not.toHaveBeenCalled();
  });
});

describe("/update /doctor /dashboard /collab: the invoking adapter's fleet admins, and an empty list is nobody", () => {
  const adminCommands = ["update", "doctor", "dashboard", "visibility"];

  it("an empty allowed_users list refuses — it used to let everyone through", async () => {
    const r = await rig({ primary: { mode: "open", allowed_users: [] } });
    expect(await slash(r, "discord", { command: "update", userId: "member" })).toEqual([t("update.disabled")]);
    expect(await slash(r, "discord", { command: "doctor", userId: "member" })).toEqual([t("not_authorized")]);
    expect(await slash(r, "discord", { command: "visibility", userId: "member", options: { mode: "hidden" } })).toEqual([t("not_authorized")]);
    expect(r.fm.fleetConfig!.defaults).not.toHaveProperty("cross_instance_visibility");
    expect(await slash(r, "discord", { command: "dashboard", userId: "member" })).toEqual([t("dashboard.disabled")]);
    expect(await slash(r, "discord", { command: "collab", userId: "member" })).toEqual([t("not_authorized")]);
    expect(r.doctor).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(0);
  });

  it("a user who is allowed to talk but is not a fleet admin is refused", async () => {
    const r = await rig({ primary: OPEN });
    for (const command of adminCommands) {
      expect(await slash(r, "discord", { command, userId: "member" }), command).toEqual([t("not_authorized")]);
    }
    expect(r.doctor).not.toHaveBeenCalled();
    expect(spawned).toHaveLength(0);
  });

  it("a fleet admin of the invoking adapter is served", async () => {
    const r = await rig({ primary: OPEN });
    expect(await slash(r, "discord", { command: "doctor", userId: "admin" })).toEqual(["doctor-output"]);
    expect((await slash(r, "discord", { command: "dashboard", userId: "admin" }))[0]).not.toBe(t("not_authorized"));
    expect((await slash(r, "discord", { command: "visibility", userId: "admin" }))[0]).toContain(t("visibility.current", "full"));
    expect((await slash(r, "discord", { command: "visibility", userId: "admin", options: { mode: "summary" } }))[0]).toContain(t("visibility.set", "summary"));
    expect(r.fm.fleetConfig!.defaults.cross_instance_visibility).toBe("summary");
    const update = await slash(r, "discord", { command: "update", userId: "admin" });
    expect(update).toEqual([t("update.progress.preparing", 0)]);
    expect(spawned).toHaveLength(1);                         // the stubbed spawn: nothing real ran
    // #1120: the update the fleet launches names who asked, so the CLI it starts is a recorded, authorised call
    expect((spawned[0]![2] as any).env.AGEND_RESTART_ORIGIN).toBe("slash /update by discord:admin");
  });

  it("the list consulted is the INVOKING adapter's, not the primary channel's", async () => {
    // "discord" (primary, channels[0]) admins: admin. "second" admins: ops.
    const r = await rig({ primary: OPEN, second: { mode: "open", allowed_users: ["ops"] } });
    // ops is an admin of "second" only: refused on the primary, served on "second".
    expect(await slash(r, "discord", { command: "doctor", userId: "ops" })).toEqual([t("not_authorized")]);
    expect(await slash(r, "second", { command: "doctor", userId: "ops", guildId: "G2", channelId: "C-second" })).toEqual(["doctor-output"]);
    // admin is an admin of the primary only: served on the primary, refused on "second".
    expect(await slash(r, "discord", { command: "doctor", userId: "admin" })).toEqual(["doctor-output"]);
    expect(await slash(r, "second", { command: "doctor", userId: "admin", guildId: "G2", channelId: "C-second" })).toEqual([t("not_authorized")]);
  });

  it("with no access manager to ask, a non-admin is refused rather than let through", async () => {
    const r = await rig({ primary: OPEN });
    (r.fm as unknown as { worlds: Map<string, unknown> }).worlds.delete("discord");
    (r.fm as unknown as { accessManager: unknown }).accessManager = null;
    expect(await slash(r, "discord", { command: "sysinfo", channelId: "RANDOM", userId: "member" })).toEqual([t("not_authorized")]);
  });

  it("a second adapter with no admins of its own is off, even when the primary has some", async () => {
    const r = await rig({ primary: OPEN, second: { mode: "open", allowed_users: [] } });
    expect(await slash(r, "second", { command: "update", userId: "admin", guildId: "G2", channelId: "C-second" })).toEqual([t("update.disabled")]);
    expect(await slash(r, "second", { command: "dashboard", userId: "admin", guildId: "G2", channelId: "C-second" })).toEqual([t("dashboard.disabled")]);
    expect(spawned).toHaveLength(0);
  });

  it("/dashboard action:revoke signs every browser out — the Discord form of the typed /dashboard revoke (#1260)", async () => {
    const r = await rig({ primary: OPEN });
    const fm = r.fm as unknown as {
      initializeWebAuthTokens(): void; initializeWebSessions(): void; readonly webToken: string | null;
      webSessions: { create(o: object): { sessionId: string }; authenticate(id: string, epoch: string, o?: object): unknown; ops: Record<string, unknown> };
    };
    fm.initializeWebAuthTokens();
    fm.initializeWebSessions();
    const epoch = tokenEpoch(fm.webToken!);
    const signIn = () => fm.webSessions.create({ tier: "admin", surface: "local", label: "Firefox on Linux", tokenEpoch: epoch }).sessionId;
    const alive = (id: string) => fm.webSessions.authenticate(id, epoch, { touch: false }) !== null;
    const a = signIn(), b = signIn();

    // Not a fleet admin: refused, and nothing is signed out.
    expect(await slash(r, "discord", { command: "dashboard", userId: "member", options: { action: "revoke" } })).toEqual([t("not_authorized")]);
    // No action: the sign-in text, nothing signed out.
    const shown = await slash(r, "discord", { command: "dashboard", userId: "admin" });
    expect(shown[0]).not.toBe(t("dashboard.revoked", 2));
    expect([alive(a), alive(b)]).toEqual([true, true]);

    expect(await slash(r, "discord", { command: "dashboard", userId: "admin", options: { action: "revoke" } })).toEqual([t("dashboard.revoked", 2)]);
    expect([alive(a), alive(b)], "both browsers are signed out").toEqual([false, false]);

    // A revocation that could not be saved says so — never "done".
    const c = signIn();
    fm.webSessions.ops.renameSync = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
    fm.webSessions.ops.unlinkSync = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
    expect(await slash(r, "discord", { command: "dashboard", userId: "admin", options: { action: "revoke" } })).toEqual([t("dashboard.revoked_not_durable", 1)]);
    expect(alive(c)).toBe(false);
  });

  it("/collab in a fleet channel needs a fleet admin too", async () => {
    const r = await rig({ primary: OPEN });
    expect(await slash(r, "discord", { command: "collab", userId: "member" })).toEqual([t("not_authorized")]);
    const served = await slash(r, "discord", { command: "collab", userId: "admin" });
    expect(served).toEqual([expect.stringMatching(/./)]);
    expect(served[0]).not.toBe(t("not_authorized"));
  });
});

describe("the typed versions of /update /doctor /dashboard follow the same rule", () => {
  async function typed(r: Rig, adapterId: string, text: string, userId: string): Promise<string[]> {
    const adapter = r.adapters.get(adapterId)!;
    const before = adapter.sent.length;
    await (r.fm as unknown as { topicCommands: { handleGeneralCommand(m: never): Promise<boolean> } }).topicCommands.handleGeneralCommand({
      source: "discord", adapterId, chatId: adapterId === "second" ? "G2" : "G1", threadId: "T1", messageId: "m", userId,
      username: userId, text, timestamp: new Date(), isBotMessage: false,
    } as never);
    return adapter.sent.slice(before).map(s => s.text);
  }

  it("an empty list refuses (update/dashboard say disabled; doctor says not authorised)", async () => {
    const r = await rig({ primary: { mode: "open", allowed_users: [] } });
    expect(await typed(r, "discord", "/update", "member")).toEqual([t("update.disabled")]);
    expect(await typed(r, "discord", "/dashboard", "member")).toEqual([t("dashboard.disabled")]);
    expect(await typed(r, "discord", "/doctor", "member")).toEqual([t("not_authorized")]);
    expect(spawned).toHaveLength(0);
  });

  it("typed /update is served to the invoking adapter's own admin and to nobody else", async () => {
    const r = await rig({ primary: OPEN, second: { mode: "open", allowed_users: ["ops"] } });
    expect(await typed(r, "second", "/update", "ops")).toEqual([t("update.progress.preparing", 0)]);
    expect(spawned).toHaveLength(1);                                        // the stubbed spawn
    expect((spawned[0]![2] as any).env.AGEND_RESTART_ORIGIN).toBe("command /update by second:ops");
    expect(await typed(r, "second", "/update", "admin")).toEqual([t("not_authorized")]);   // admin of "discord", not of "second"
    expect(spawned).toHaveLength(1);
  });

  it("a non-admin is refused; the invoking adapter's admin is served", async () => {
    const r = await rig({ primary: OPEN, second: { mode: "open", allowed_users: ["ops"] } });
    expect(await typed(r, "discord", "/doctor", "member")).toEqual([t("not_authorized")]);
    expect(await typed(r, "discord", "/update", "ops")).toEqual([t("not_authorized")]);       // ops is not an admin of "discord"
    expect(await typed(r, "discord", "/dashboard", "ops")).toEqual([t("not_authorized")]);
    expect(await typed(r, "second", "/dashboard", "ops")).not.toEqual([t("not_authorized")]);  // but is one of "second"
    expect(spawned).toHaveLength(0);
  });
});
