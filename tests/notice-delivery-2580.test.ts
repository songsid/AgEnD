import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale, t } from "../src/locale.js";
import { validateFleetConfig } from "../src/config-validator.js";
import { parseWebSettingsBody } from "../src/web-settings-patch.js";

vi.mock("../src/logger.js", () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
const rigs: Array<{ fm: any; dir: string }> = [];
afterEach(() => { for (const { fm, dir } of rigs.splice(0)) { for (const entry of fm.pendingNonceButtons.values()) clearTimeout(entry.timer); rmSync(dir, { recursive: true, force: true }); } vi.restoreAllMocks(); vi.useRealTimers(); });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function rig(mode?: boolean | "dm") {
  if (arguments.length === 0) mode = "dm";
  setLocale("en");
  const dir = mkdtempSync(join(tmpdir(), "agend-notice-2580-"));
  const fm = new FleetManager(dir) as any;
  rigs.push({ fm, dir });
  const adapter = { id: "tg", type: "telegram", sendDirect: vi.fn(async (id: string) => ({ chatId: id, threadId: undefined, messageId: "private" })),
    sendText: vi.fn(async () => ({ chatId: "group", threadId: "topic", messageId: "public" })),
    notifyAlert: vi.fn(async () => ({ chatId: "group", threadId: "topic", messageId: "tip" })) };
  fm.fleetConfig = { defaults: {}, web: mode === undefined ? {} : { notify_login: mode },
    channels: [{ id: "tg", type: "telegram", mode: "topic", group_id: "group", access: { allowed_users: ["operator", "requester"] } }],
    instances: { general: { general_topic: true, channel_id: "tg", topic_id: "topic" } } };
  fm.adapters.set("tg", adapter); fm.worlds.set("tg", { id: "tg", adapter, groupId: "group", channelConfig: fm.fleetConfig.channels[0] });
  fm.daemons.set("general", {});
  fm.scheduler = { db: { listDismissedTipIds: () => new Set(), isAdvancedTipsUnlocked: () => false } };
  const topic = vi.spyOn(fm, "notifyFleetError").mockReturnValue(true);
  const info = { label: "Firefox", surface: "local", tier: "admin", handle: "session-handle", owner: { adapterId: "tg", userId: "requester" } };
  const owner = { ...info.owner, chatId: "group", threadId: "topic", binding: adapter };
  return { fm, adapter, topic, info, owner };
}

describe("#2580 private fleet notices", () => {
  it("DMs the requesting operator, with no topic post", async () => {
    const h = rig(); h.fm.onWebLogin(h.info); await flush();
    expect(h.adapter.sendDirect).toHaveBeenCalledWith("requester", t("web.login_notice", "Firefox", "local", "session-"), { disablePreview: true });
    expect(h.topic).not.toHaveBeenCalled();
  });
  it.each(["reject", "unsupported", "unknown", "missing"])("%s DM falls back to the exact topic notice", async kind => {
    const h = rig();
    if (kind === "reject") h.adapter.sendDirect.mockRejectedValueOnce(new Error("DM disabled"));
    if (kind === "unsupported") h.adapter.sendDirect = undefined as any;
    if (kind === "unknown") h.info.owner.userId = "not-an-admin";
    if (kind === "missing") h.info.owner = undefined as any;
    h.fm.onWebLogin(h.info); await flush();
    expect(h.topic).toHaveBeenCalledWith(t("web.login_notice", "Firefox", "local", "session-"));
    if (kind === "unknown") expect(h.adapter.sendDirect).not.toHaveBeenCalled();
  });
  it("a stalled DM leaves time for the original public notice fallback", async () => {
    const h = rig(); vi.useFakeTimers();
    let mono = 0; vi.spyOn(performance, "now").mockImplementation(() => mono);
    h.adapter.sendDirect.mockImplementationOnce(() => new Promise(() => {}));
    const done = h.fm.confirmPublicWebLogin({ label: "Firefox", handle: "session-handle", owner: h.owner }, () => true);
    mono = 2_001; await vi.advanceTimersByTimeAsync(2_001); await done;
    expect(h.adapter.sendText).toHaveBeenCalledOnce();
  });
  it.each([true, undefined])("%s keeps the original synchronous topic path and bytes", mode => {
    const h = rig(mode); h.fm.onWebLogin(h.info);
    expect(h.topic).toHaveBeenCalledWith(t("web.login_notice", "Firefox", "local", "session-"));
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
  });
  it("false keeps operator notices off and local guest security notices in General", () => {
    const h = rig(false); h.fm.onWebLogin(h.info); expect(h.topic).not.toHaveBeenCalled();
    h.fm.webPerson = () => ({ name: "Guest" }); h.fm.guestScope = () => new Set(["agent"]);
    h.fm.onWebLogin({ ...h.info, tier: "guest", owner: { adapterId: "tg", userId: "guest" } });
    expect(h.topic).toHaveBeenCalledWith(t("web.guest_login_notice", "Guest", "Firefox", 1, "session-"));
  });
  it("local guest notice goes to its connection's admin, never the guest", async () => {
    const h = rig(); h.fm.webPerson = () => ({ name: "Guest" }); h.fm.guestScope = () => new Set(["agent"]);
    h.fm.onWebLogin({ ...h.info, tier: "guest", owner: { adapterId: "tg", userId: "guest" } }); await flush();
    expect(h.adapter.sendDirect).toHaveBeenCalledWith("operator", t("web.guest_login_notice", "Guest", "Firefox", 1, "session-"), { disablePreview: true });
    expect(h.topic).not.toHaveBeenCalled();
  });
  it("a secondary connection's guest notice never goes to the primary admin", async () => {
    const h = rig();
    const secondary = { ...h.adapter, id: "secondary", sendDirect: vi.fn(async (_id: string, _text: string, _opts: unknown) => ({ chatId: "second-admin", messageId: "private" })) };
    h.fm.adapters.set("secondary", secondary);
    h.fm.fleetConfig.channels.push({ id: "secondary", type: "telegram", access: { allowed_users: ["second-admin"] } });
    h.fm.webPerson = () => ({ name: "Guest" }); h.fm.guestScope = () => new Set(["agent"]);
    h.fm.onWebLogin({ ...h.info, tier: "guest", owner: { adapterId: "secondary", userId: "guest" } }); await flush();
    expect(secondary.sendDirect.mock.calls[0]?.[0]).toBe("second-admin");
    expect(h.adapter.sendDirect).not.toHaveBeenCalled(); expect(h.topic).not.toHaveBeenCalled();
  });
  it("a local guest with no configured admin falls back to General, not the guest", async () => {
    const h = rig(); h.fm.fleetConfig.channels[0].access.allowed_users = [];
    h.fm.webPerson = () => ({ name: "Guest" }); h.fm.guestScope = () => new Set(["agent"]);
    h.fm.onWebLogin({ ...h.info, tier: "guest", owner: { adapterId: "tg", userId: "guest" } }); await flush();
    expect(h.adapter.sendDirect).not.toHaveBeenCalled(); expect(h.topic).toHaveBeenCalledOnce();
  });
  it.each([true, "dm"] as const)("%s public sign-in retains the owner and authority fence", async mode => {
    const h = rig(mode); const info = { label: "Firefox", handle: "session-handle", owner: h.owner };
    await h.fm.confirmPublicWebLogin(info, () => true);
    if (mode === "dm") { expect(h.adapter.sendDirect.mock.calls[0]![0]).toBe("requester"); expect(h.adapter.sendText).not.toHaveBeenCalled(); }
    else { expect(h.adapter.sendDirect).not.toHaveBeenCalled(); expect(h.adapter.sendText).toHaveBeenCalledWith("group", t("web.public_login_notice", "Firefox", "session-"), { threadId: "topic", allowedMentions: { parse: [] } }); }
    await expect(h.fm.confirmPublicWebLogin(info, () => false)).rejects.toThrow();
  });
  it("public DM failure falls back, but revocation during that failure never posts", async () => {
    const h = rig(); const info = { label: "Firefox", handle: "session-handle", owner: h.owner };
    h.adapter.sendDirect.mockRejectedValueOnce(new Error("disabled"));
    await h.fm.confirmPublicWebLogin(info, () => true); expect(h.adapter.sendText).toHaveBeenCalledOnce(); h.adapter.sendText.mockClear();
    let current = true; h.adapter.sendDirect.mockImplementationOnce(async () => { current = false; throw Error("disabled"); });
    await expect(h.fm.confirmPublicWebLogin(info, () => current)).rejects.toThrow("changed"); expect(h.adapter.sendText).not.toHaveBeenCalled();
  });
  it("public guest notice goes to the link owner, never the signing-in guest", async () => {
    const h = rig(); h.fm.publicWebLink = { openSignin: () => ({ owner: h.owner, exposureId: "exposure" }) };
    h.fm.guestSignInAllowed = () => true; h.fm.webPerson = () => ({ name: "Guest" }); h.fm.guestScope = () => new Set(["agent"]);
    await h.fm.confirmGuestPublicWebLogin({ label: "Firefox", handle: "session-handle", account: { adapterId: "tg", userId: "guest" }, exposureId: "exposure" }, () => true);
    expect(h.adapter.sendDirect.mock.calls[0]![0]).toBe("requester"); expect(h.adapter.sendText).not.toHaveBeenCalled();
  });
  it.each(["sent", "reject", "unknown"])("daily tip DM %s retains a live canonical nonce or falls back", async kind => {
    const h = rig(); h.fm.fleetConfig.defaults.tips = "dm";
    if (kind === "reject") h.adapter.sendDirect.mockRejectedValueOnce(new Error("disabled"));
    if (kind === "unknown") h.fm.fleetConfig.channels[0].access.allowed_users = [];
    await h.fm.sendTipToGeneral();
    expect(h.fm.pendingNonceButtons.size).toBe(1);
    const entry: any = [...h.fm.pendingNonceButtons.values()][0];
    if (kind === "sent") {
      expect(h.adapter.sendDirect).toHaveBeenCalledWith("operator", expect.stringMatching(/^💡 Tip:/), expect.objectContaining({ choices: expect.any(Array) }));
      expect(h.adapter.notifyAlert).not.toHaveBeenCalled(); expect([entry.chatId, entry.threadId]).toEqual(["operator", undefined]);
    } else { expect(h.adapter.notifyAlert).toHaveBeenCalledOnce(); expect([entry.chatId, entry.threadId]).toEqual(["group", "topic"]); }
  });
  it("validates only true, false and dm, including the web Settings projection parser", () => {
    for (const mode of [true, false, "dm"]) {
      expect(validateFleetConfig({ defaults: { tips: mode }, web: { notify_login: mode }, instances: {} }).valid).toBe(true);
      expect(parseWebSettingsBody({ notify_login: mode })).toMatchObject({ notifyLogin: mode });
    }
    expect(validateFleetConfig({ defaults: { tips: "email" }, web: { notify_login: "email" }, instances: {} }).valid).toBe(false);
    expect(parseWebSettingsBody({ notify_login: "email" })).toHaveProperty("error");
  });
});
