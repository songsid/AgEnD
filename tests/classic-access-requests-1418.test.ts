import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { FleetManager } from "../src/fleet-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { AccessManager } from "../src/channel/access-manager.js";
import { AdapterWorld } from "../src/adapter-world.js";
import { setLocale, t } from "../src/locale.js";

const dirs: string[] = [];
const fleets: any[] = [];
const USER = "42", ADMIN = "7", FLEET_ADMIN = "99";
afterEach(() => {
  for (const fm of fleets.splice(0)) {
    for (const p of fm.pendingNonceButtons.values()) clearTimeout(p.timer);
    for (const p of fm.pendingClassicStarts.values()) clearTimeout(p.timer);
  }
  vi.restoreAllMocks();
  setLocale("en");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function rig(type: "telegram" | "discord", defaults: Record<string, unknown> = {}) {
  setLocale("en");
  const dir = mkdtempSync(join(tmpdir(), "agend-classic-access-1418-"));
  dirs.push(dir);
  writeFileSync(join(dir, "classicBot.yaml"), yaml.dump({ defaults, channels: {} }));
  const fm = new FleetManager(dir) as any;
  fleets.push(fm);
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  fm.logger = logger;
  const id = type === "telegram" ? "tg" : "dc";
  let message = 0;
  const adapter: any = {
    id, type,
    sendText: vi.fn(async (chatId: string) => ({ chatId, messageId: `reply-${++message}` })),
    notifyAlert: vi.fn(async (chatId: string, _alert: unknown, opts?: { threadId?: string }) => ({ chatId, threadId: opts?.threadId, messageId: `prompt-${++message}` })),
    editMessageRemoveButtons: vi.fn().mockResolvedValue(undefined),
    promptUser: vi.fn().mockResolvedValue("chooser"),
    getBotUserId: () => "100",
    react: vi.fn().mockResolvedValue(undefined),
  };
  const config: any = { id, type, group_id: type === "telegram" ? "-9000" : "main-guild", bot_token_env: "INERT",
    access: { mode: "locked", allowed_users: [FLEET_ADMIN], max_pending_codes: 0, code_expiry_minutes: 0 } };
  const access = new AccessManager(config.access, join(dir, "access.json"));
  const world = new AdapterWorld(id, adapter, access, config);
  world.botUsername = "OurBot";
  world.botUserId = "100";
  fm.worlds.set(id, world);
  fm.adapters.set(id, adapter);
  fm.adapter = adapter;
  fm.fleetConfig = { channels: [config], defaults: { backend: "codex" }, instances: {
    general: { working_directory: dir, general_topic: true, topic_id: "1", channel_id: id },
  } };
  fm.routing.rebuild(fm.fleetConfig);
  fm.daemons.set("general", {}); // Inert routing presence, never start a daemon.
  fm.bindInstanceAdapter("general", id);
  const classic = new ClassicChannelManager(dir, logger as any);
  classic.configureAdapters([config]);
  fm.classicChannels = classic;
  const start = vi.spyOn(fm, "startClassicInstance").mockResolvedValue(undefined);
  vi.spyOn(fm, "startInstance").mockImplementation(() => { throw new Error("Unexpected real instance startup"); });
  vi.spyOn(fm, "reregisterClassicChannels").mockImplementation(() => {});
  vi.spyOn(fm, "isBackendInstalled").mockReturnValue(false);
  vi.spyOn(fm, "getMissingBackendWarning").mockReturnValue(undefined);
  const forward = vi.spyOn(fm, "forwardToClassicInstance").mockResolvedValue(undefined);
  vi.spyOn(fm, "notifyInstanceTopic").mockImplementation(() => {});
  vi.spyOn(fm, "sendCancelButton").mockResolvedValue(undefined);
  const respond = vi.fn().mockResolvedValue(undefined);
  let inbound = 0;
  async function say(chatId = USER, userId = USER, text = "/start codex") {
    await fm.handleInboundMessage({ source: "telegram", adapterId: id, chatId, userId, username: "requester", text,
      messageId: String(++inbound), timestamp: new Date(), isBotMessage: false });
    await flush();
  }
  async function slash(channelId = "new-channel", userId = USER, guildId: string | null = "other-guild") {
    await fm.dispatchSlash({ command: "start", channelId, channelName: "room", guildId: guildId ?? undefined, userId, username: "requester",
      options: { backend: "codex" }, respond }, id, adapter);
    await flush();
  }
  async function click(action: string, userId = FLEET_ADMIN, overrides: Record<string, unknown> = {}) {
    expect(adapter.notifyAlert.mock.calls.length, "an approval prompt must exist before a click").toBeGreaterThan(0);
    const alert = adapter.notifyAlert.mock.calls.at(-1)![1];
    const choice = alert.choices.find((c: any) => c.id.endsWith(`:${action}`));
    const entry = [...fm.pendingNonceButtons.values()].find((e: any) => choice.id.includes(e.nonce)) as any;
    const data = { callbackData: choice.id, chatId: entry.chatId, threadId: entry.threadId,
      messageId: entry.messageId, userId, ack: vi.fn(), ...overrides };
    await fm.receiveAdapterCallback(data, id, adapter, () => true);
    return data;
  }
  const persisted = () => yaml.load(readFileSync(join(dir, "classicBot.yaml"), "utf8")) as any;
  return { fm, classic, adapter, start, forward, respond, say, slash, click, persisted, id, logger };
}
async function flush() { for (let i = 0; i < 4; i++) await Promise.resolve(); }
function expectRequest(r: ReturnType<typeof rig>) {
  expect(r.start).not.toHaveBeenCalled();
  expect(r.classic.getAll()).toHaveLength(0);
  expect(r.adapter.notifyAlert).toHaveBeenCalledOnce();
  expect(r.adapter.notifyAlert.mock.calls[0][0]).toBe(r.adapter.type === "telegram" ? "-9000" : "main-guild");
  expect(r.adapter.notifyAlert.mock.calls[0][1].choices.map((c: any) => c.id.split(":").at(-1))).toEqual(["allow", "allow-admin", "ignore"]);
  for (const c of r.adapter.notifyAlert.mock.calls[0][1].choices) expect(Buffer.byteLength(c.id)).toBeLessThanOrEqual(64);
}

describe("new ClassicBot access requests (#1418)", () => {
  for (const defaults of [{}, { allowed_users: [], allowed_groups: [], allowed_guilds: [] },
    { allowed_users: "invalid", allowed_groups: "invalid", allowed_guilds: "invalid" }]) {
    it(`TG private: unset/empty/malformed lists request buttons, not startup (${JSON.stringify(defaults)})`, async () => {
      const r = rig("telegram", defaults);
      await r.say();
      expectRequest(r);
      expect(r.adapter.sendText).toHaveBeenCalledWith(USER, t("classic.access_requested"));
      expect(r.adapter.promptUser).not.toHaveBeenCalled();
    });
    it(`TG group: targeted /start requests admission (${JSON.stringify(defaults)})`, async () => {
      const r = rig("telegram", defaults);
      await r.say("-10042", USER, "/start@OurBot codex");
      expectRequest(r);
      expect(r.adapter.sendText).toHaveBeenCalledWith("-10042", t("classic.access_requested"));
    });
    it(`DC slash in another guild: requests admission (${JSON.stringify(defaults)})`, async () => {
      const r = rig("discord", defaults);
      await r.slash();
      expectRequest(r);
      expect(r.respond).toHaveBeenCalledWith(t("classic.access_requested"));
    });
  }

  it("General's agent can be stopped: the system approval buttons still reach its topic", async () => {
    const r = rig("telegram");
    r.fm.daemons.delete("general");
    await r.say();
    expectRequest(r);
  });

  it("an approval cannot notify through an adapter that has been replaced", async () => {
    const r = rig("telegram");
    await r.say();
    r.fm.worlds.get(r.id).adapter = { id: r.id, type: "telegram", sendText: vi.fn() };
    await r.click("allow");
    expect(r.classic.isUserAllowed(USER)).toBe(true);
    expect(r.adapter.sendText).toHaveBeenCalledTimes(1); // Initial request response only.
  });

  it("notification failure does not undo or repeat a persisted approval", async () => {
    const r = rig("telegram");
    await r.say();
    r.adapter.sendText.mockRejectedValueOnce(new Error("inert DM failure"));
    await r.click("allow");
    expect(r.classic.isUserAllowed(USER)).toBe(true);
    expect(r.fm.pendingNonceButtons.size).toBe(0);
    expect(r.logger.warn).toHaveBeenCalledWith(expect.anything(), "Could not notify Classic access requester");
    expect(r.start).not.toHaveBeenCalled();
  });

  it("private /start without backend requests access instead of a backend chooser", async () => {
    const r = rig("telegram");
    await r.say(USER, USER, "/start");
    expectRequest(r);
    expect(r.adapter.promptUser).not.toHaveBeenCalled();
  });

  it.each(["private", "group", "guild"])("ClassicBot admin can start with empty lists: %s", async scope => {
    const r = rig(scope === "guild" ? "discord" : "telegram", { admin_users: [ADMIN] });
    if (scope === "guild") await r.slash("channel-admin", ADMIN);
    else await r.say(scope === "group" ? "-1007" : ADMIN, ADMIN, scope === "group" ? "/start@OurBot codex" : "/start codex");
    expect(r.start).toHaveBeenCalledOnce();
    expect(r.classic.getAll()).toHaveLength(1);
    expect(r.adapter.notifyAlert).not.toHaveBeenCalled();
  });

  it("fleet admin alone cannot bypass the empty Classic allowlist", async () => {
    const r = rig("telegram");
    await r.say(FLEET_ADMIN, FLEET_ADMIN);
    expectRequest(r);
  });

  it.each(["allow", "allow-admin"])("private %s persists the first user, not group/guild; retry starts", async action => {
    const r = rig("telegram");
    await r.say();
    expectRequest(r);
    const callback = await r.click(action);
    expect(r.persisted().defaults.allowed_users).toEqual([USER]);
    expect(r.persisted().defaults.allowed_groups).toBeUndefined();
    expect(r.persisted().defaults.allowed_guilds).toBeUndefined();
    expect(r.classic.isAdmin(USER)).toBe(action === "allow-admin");
    expect(r.adapter.sendText).toHaveBeenLastCalledWith(USER, t("classic.request_allowed"));
    expect(r.start).not.toHaveBeenCalled(); // Approval is not an implicit spawn.
    await r.fm.receiveAdapterCallback(callback, r.id, r.adapter, () => true);
    expect(r.adapter.sendText.mock.calls.filter((c: any[]) => c[1] === t("classic.request_allowed"))).toHaveLength(1);
    await r.say();
    expect(r.start).toHaveBeenCalledOnce();
  });

  it("private Ignore tells the requester and leaves the first list empty", async () => {
    const r = rig("telegram");
    await r.say();
    await r.click("ignore");
    expect(r.classic.isUserAllowed(USER)).toBe(false);
    expect(r.adapter.sendText).toHaveBeenLastCalledWith(USER, t("classic.request_ignored"));
    expect(r.fm.pendingNonceButtons.size).toBe(0);
    expect(r.start).not.toHaveBeenCalled();
  });

  it("a non-admin or wrong-world click cannot grant; the real owner admin still can", async () => {
    const r = rig("telegram");
    await r.say();
    await r.click("allow", USER);
    expect(r.classic.isUserAllowed(USER)).toBe(false);
    await r.click("allow", FLEET_ADMIN, { chatId: "wrong-chat" });
    expect(r.classic.isUserAllowed(USER)).toBe(false);
    await r.click("allow", FLEET_ADMIN);
    expect(r.classic.isUserAllowed(USER)).toBe(true);
  });

  it("group Allow writes the first group; Allow alone does not grant C", async () => {
    const r = rig("telegram");
    await r.say("-10042", USER, "/start@OurBot codex");
    await r.click("allow");
    expect(r.persisted().defaults.allowed_groups).toEqual(["-10042"]);
    expect(r.classic.isAdmin(USER)).toBe(false);
    await r.say("-10042", USER, "/start@OurBot codex");
    expect(r.start).not.toHaveBeenCalled();
    expect(r.adapter.sendText).toHaveBeenLastCalledWith("-10042", t("classic.admin_only_start"));
  });

  it("group Allow+admin grants only that group and C, then targeted retry starts", async () => {
    const r = rig("telegram");
    await r.say("-10042", USER, "/start@OurBot codex");
    await r.click("allow-admin");
    expect(r.persisted().defaults.allowed_groups).toEqual(["-10042"]);
    expect(r.persisted().defaults.admin_users).toEqual([USER]);
    expect(r.persisted().defaults.allowed_users).toBeUndefined();
    await r.say("-10042", USER, "/start@OurBot codex");
    expect(r.start).toHaveBeenCalledOnce();
  });

  it("Discord Allow writes the first guild and a retry starts without C", async () => {
    const r = rig("discord");
    await r.slash();
    await r.click("allow");
    expect(r.persisted().defaults.allowed_guilds).toEqual(["other-guild"]);
    expect(r.classic.isAdmin(USER)).toBe(false);
    expect(r.adapter.sendText).toHaveBeenLastCalledWith("new-channel", t("classic.request_allowed"));
    await r.slash();
    expect(r.start).toHaveBeenCalledOnce();
  });

  it.each(["telegram", "discord"] as const)("an existing %s channel remains usable by a non-allowed user", async type => {
    const r = rig(type);
    const channel = type === "telegram" ? USER : "existing-channel";
    r.classic.register(channel, r.id, "existing", "old", "owner", "codex");
    r.fm.bindInstanceAdapter("existing", r.id);
    const chat = vi.spyOn(r.fm, "handleClassicChannelMessage").mockResolvedValue(undefined);
    if (type === "telegram") await r.say(channel, USER, "hello");
    else await r.fm.handleInboundMessage({ source: type, adapterId: r.id, chatId: "main-guild", threadId: channel,
      userId: USER, username: "requester", text: "/chat hello", messageId: "existing", timestamp: new Date(), isBotMessage: false });
    expect(chat).toHaveBeenCalledOnce();
    expect(r.adapter.notifyAlert).not.toHaveBeenCalled();
    const reply = await r.fm.handleClassicStart(channel, "old", USER, type === "discord" ? "other-guild" : undefined, r.id, "codex");
    expect(reply).toBe(t(type === "telegram" ? "classic.already_active.telegram" : "classic.already_active"));
    expect(r.start).not.toHaveBeenCalled();
  });

  it("Discord DM /start stays unsupported, even for C; no request or startup", async () => {
    const r = rig("discord", { admin_users: [ADMIN] });
    await r.slash("dm-channel", ADMIN, null);
    expect(r.respond).toHaveBeenCalledWith(t("slash.dm_unsupported"));
    expect(await r.fm.handleClassicStart("dm-channel", "dm", ADMIN, undefined, r.id)).toBe(t("slash.dm_unsupported"));
    expect(r.start).not.toHaveBeenCalled();
    expect(r.adapter.notifyAlert).not.toHaveBeenCalled();
  });

  it("bare or other-bot TG group /start is still ignored", async () => {
    const r = rig("telegram");
    await r.say("-10042", USER, "/start codex");
    await r.say("-10042", USER, "/start@OtherBot codex");
    expect(r.adapter.notifyAlert).not.toHaveBeenCalled();
    expect(r.adapter.sendText).not.toHaveBeenCalled();
    expect(r.start).not.toHaveBeenCalled();
  });

  it("a backend chooser does not preserve admission after its user grant is revoked", async () => {
    const r = rig("telegram", { allowed_users: [USER] });
    await r.say(USER, USER, "/start");
    expect(r.adapter.promptUser).toHaveBeenCalledOnce();
    const choice = r.adapter.promptUser.mock.calls[0][2][0];
    (r.classic as any).defaults.allowed_users = [];
    await r.fm.handleClassicBackendSelection({ callbackData: choice.id, chatId: USER, messageId: "chooser", userId: USER });
    await flush();
    expectRequest(r);
  });
});
