import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(),
  spawn: () => { throw Error("No fleet/process"); }, execFile: () => { throw Error("No CLI"); }, execFileSync: () => { throw Error("No CLI"); }, execSync: () => { throw Error("No CLI"); }, spawnSync: () => { throw Error("No CLI"); } }));
vi.mock("node:inspector", () => ({ Session: class { constructor() { throw Error("No native inspector"); } } }));
vi.mock("../src/backend/index.js", async original => ({ ...await original<typeof import("../src/backend/index.js")>(), createBackend: () => { throw Error("No backend"); } }));
vi.mock("../src/tmux-manager.js", async original => ({ ...await original<typeof import("../src/tmux-manager.js")>(), TmuxManager: new Proxy({}, { get: () => () => { throw Error("No live tmux"); } }) }));
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale, t } from "../src/locale.js";
import { ProfileBusyError, type ProfileResult } from "../src/runtime-cpu-profile.js";
const rigs: Array<{ directory: string; fm: FleetManager }> = [];
function rig(platform: "telegram" | "discord" = "discord") {
  const directory = mkdtempSync(join(tmpdir(), "agend-profile-handler-"));
  const fm = new FleetManager(directory), any = fm as any;
  const sent: Array<{ chat: string; text: string; opts: unknown }> = [];
  const adapter = { id: "owner", type: platform, sendText: vi.fn(async (chat: string, text: string, opts: unknown) => { sent.push({ chat, text, opts }); return { messageId: "out", chatId: chat }; }) };
  const owner = { id: "owner", type: platform, group_id: "G", access: { mode: "open", allowed_users: ["admin"] }, bot_token_env: "NONE" };
  const other = { ...owner, id: "other", group_id: "OTHER", access: { mode: "open", allowed_users: ["other-admin"] } };
  fm.fleetConfig = { defaults: {}, channel: owner, channels: [owner, other], instances: {
    general: { working_directory: directory, general_topic: true, topic_id: "T0", channel_id: "owner" },
    worker: { working_directory: directory, topic_id: "T1", channel_id: "owner" },
  } } as never;
  fm.routing.rebuild(fm.fleetConfig!); any.adapter = adapter; any.adapters.set("owner", adapter);
  any.worlds.set("owner", { adapter, groupId: "G", channelConfig: owner, botUsername: "fleetbot", botUserId: "fleetbot-id", accessManager: { isAllowed: () => true }, stop: async () => {} });
  any.worlds.set("other", { adapter, groupId: "OTHER", channelConfig: other, accessManager: { isAllowed: () => true }, stop: async () => {} });
  any.classicChannels = { isClassicChannel: () => false, hasChannel: () => false };
  const start = vi.spyOn(fm, "startCpuProfile");
  let finish!: (result: ProfileResult) => void, fail!: (err: Error) => void;
  const done = new Promise<ProfileResult>((yes, no) => { finish = yes; fail = no; });
  start.mockResolvedValue({ seconds: 60, done });
  const respond = vi.fn(async (_text: string) => undefined);
  async function slash(user = "admin", channel = "T0", adapterId = "owner", seconds?: number) {
    await any.dispatchSlash({ command: "profile", guildId: adapterId === "owner" ? "G" : "OTHER", channelId: channel, userId: user, username: user, options: { seconds }, respond }, adapterId, adapter);
  }
  async function typed(user = "admin", source: "telegram" | "discord" = platform, text = "/profile", threadId = "T0", adapterId = "owner") {
    return any.topicCommands.handleGeneralCommand({ source, chatId: "G", threadId, adapterId, text, userId: user, username: user, messageId: "private", timestamp: new Date() });
  }
  const result = { directory, fm, any, sent, adapter, owner, start, finish, fail, respond, slash, typed }; rigs.push(result); return result;
}
async function flush() { for (let n = 0; n < 12; n++) await Promise.resolve(); }
beforeEach(() => setLocale("en"));
afterEach(() => { for (const h of rigs.splice(0)) { h.fm.stormWindow.shutdown(); h.fm.spawnGate.shutdown(); rmSync(h.directory, { recursive: true, force: true }); } vi.restoreAllMocks(); });

describe("real General dispatcher and shared profile handler, all runtime effects stubbed", () => {
  it.each(["telegram", "discord"] as const)("%s starts and posts the result/path/size to the owning General", async platform => {
    const h = rig(platform);
    if (platform === "telegram") expect(await h.typed("admin", platform, "/profile 15")).toBe(true);
    else await h.slash("admin", "T0", "owner", 15);
    expect(h.start).toHaveBeenCalledExactlyOnceWith(15);
    h.finish({ path: "/private/profiles/a.cpuprofile", bytes: 1048576 }); await flush();
    expect(h.sent.at(-1)).toEqual({ chat: "G", text: t("profile.saved", "/private/profiles/a.cpuprofile", "1.00 MiB"), opts: { threadId: "T0" } });
  });
  it.each(["telegram", "discord"] as const)("%s refuses non-admin and empty admin list", async platform => {
    const h = rig(platform);
    if (platform === "telegram") await h.typed("member"); else await h.slash("member");
    expect(h.start).not.toHaveBeenCalled();
    h.owner.access.allowed_users = [];
    if (platform === "telegram") await h.typed(); else await h.slash();
    expect(h.start).not.toHaveBeenCalled();
    expect(platform === "telegram" ? h.sent.at(-1)?.text : h.respond.mock.calls.at(-1)?.[0]).toBe(t("profile.disabled"));
  });
  it("requires the owner adapter's authority, not an admin of a sibling world", async () => {
    // #754: a General owned by another bot is refused at the door, before /profile's own owner check.
    const h = rig(); await h.slash("other-admin", "T0", "other"); expect(h.start).not.toHaveBeenCalled();
    expect(h.respond).toHaveBeenCalledWith(t("slash.other_bot"));
  });
  it("a fleet admin on both worlds still cannot use a sibling adapter for General", async () => {
    const h = rig(); h.fm.fleetConfig!.channels![1].access!.allowed_users = ["admin"];
    await h.slash("admin", "T0", "other"); expect(h.start).not.toHaveBeenCalled();
    expect(h.respond).toHaveBeenCalledWith(t("slash.other_bot"));
  });
  it("Discord rejects non-General slash and ignores typed /profile", async () => {
    const h = rig(); await h.slash("admin", "T1");
    expect(h.respond).toHaveBeenCalledWith(t("profile.general_only")); expect(await h.typed()).toBe(false); expect(h.start).not.toHaveBeenCalled();
  });
  it("Telegram addressed /profile is General-only and validates duration", async () => {
    const h = rig("telegram"); await h.typed("admin", "telegram", "/profile@fleetbot 5"); expect(h.start).toHaveBeenCalledWith(5);
    h.start.mockClear(); await h.typed("admin", "telegram", "/profile 5", "T1"); expect(h.start).not.toHaveBeenCalled();
    await h.typed("admin", "telegram", "/profile 1801"); expect(h.start).not.toHaveBeenCalled(); expect(h.sent.at(-1)?.text).toBe(t("profile.invalid"));
  });
  it("busy reports remaining seconds and returns without waiting for recording", async () => {
    const h = rig(); h.start.mockRejectedValue(new ProfileBusyError(47)); await h.slash();
    expect(h.respond).toHaveBeenCalledWith(t("profile.busy", "47")); expect(h.sent).toEqual([]);
  });
  it("failure is a static notice, and a replacement binding never gets a late artifact", async () => {
    const a = rig(); await a.slash(); a.fail(Error("sensitive internals")); await flush(); expect(a.sent.at(-1)?.text).toBe(t("profile.failed"));
    const b = rig(); await b.slash(); b.fm.fleetConfig!.instances.general.topic_id = "replacement";
    b.finish({ path: "/private/profile", bytes: 10 }); await flush(); expect(b.sent).toEqual([]);
  });
  it("real FleetManager shutdown stops the owner before closing control and prevents starts", async () => {
    const h = rig(); const order: string[] = [];
    h.start.mockRestore();
    h.any.runtimeCpuProfiler = { closed: false, start: vi.fn(), shutdown: vi.fn(async () => { order.push("profile.stop"); return null; }) };
    h.any.cpuProfileControl = { close: vi.fn(async () => { order.push("control.close"); }) };
    h.any.shutdownLoginWindows = async () => {};
    await h.fm.stopAll(); expect(order).toEqual(["profile.stop", "control.close"]);
    await expect(h.fm.startCpuProfile()).rejects.toThrow("stopping");
    expect(h.any.runtimeCpuProfiler.start).not.toHaveBeenCalled();
  });
  it("real Telegram ingress starts the General recording without a delivery to an agent", async () => {
    const h = rig("telegram"); h.any.deliverToInstance = vi.fn(); h.any.touchActivity = vi.fn(); h.any.reactMessageStatus = vi.fn();
    await h.any.handleInboundMessage({ source: "telegram", adapterId: "owner", chatId: "G", threadId: "T0", userId: "admin", username: "admin", messageId: "profile-real-ingress", text: "/profile 5", timestamp: new Date() });
    expect(h.start).toHaveBeenCalledExactlyOnceWith(5); expect(h.any.deliverToInstance).not.toHaveBeenCalled();
    h.finish({ path: "/private/capture", bytes: 4 }); await flush(); expect(h.sent.at(-1)?.text).toContain("/private/capture");
  });
  it("real Discord text ingress consumes /profile with the native-menu notice, never starts or delivers", async () => {
    const h = rig(); h.any.deliverToInstance = vi.fn(); h.any.touchActivity = vi.fn(); h.any.reactMessageStatus = vi.fn();
    await h.any.handleInboundMessage({ source: "discord", adapterId: "owner", chatId: "G", threadId: "T0", userId: "admin", username: "admin", messageId: "profile-text-ingress", text: "/profile 5", timestamp: new Date() });
    expect(h.start).not.toHaveBeenCalled(); expect(h.any.deliverToInstance).not.toHaveBeenCalled(); expect(h.sent.at(-1)?.text).toBe(t("cmd.not_a_command"));
  });
  it("new profile messages have matching English and Traditional Chinese keys", () => {
    for (const locale of ["en", "zh-TW"] as const) { setLocale(locale); for (const key of ["profile.started", "profile.saved", "profile.busy", "profile.disabled", "profile.general_only", "profile.failed", "slash.profile", "slash.option.profile_seconds"]) expect(t(key), locale).not.toBe(key); }
  });
});
