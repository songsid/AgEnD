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

// hmsg-d1809f2a + hmsg-3b8ac2af: #2581's DM choice is withdrawn. Every notice posts in its topic; a legacy "dm" (either
// form) reads as on and is never a reason to DM.
describe("#2580 fleet notices never go by DM", () => {
  const legacy = (h: ReturnType<typeof rig>, form: string) => {
    if (form === "route") { h.fm.fleetConfig.web = { notify_login: true, notice_delivery: { login: "dm" } }; }
  };
  it.each([["true"], ["undefined"], ["dm"], ["route"]])("operator sign-in with %s posts the exact topic notice, never a DM", async form => {
    const h = form === "undefined" ? rig(undefined) : form === "true" ? rig(true) : rig("dm"); legacy(h, form);
    h.fm.onWebLogin(h.info); await flush();
    expect(h.topic).toHaveBeenCalledWith(t("web.login_notice", "Firefox", "local", "session-"));
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
  });
  it("false keeps operator notices off and local guest security notices in General", () => {
    const h = rig(false); h.fm.onWebLogin(h.info); expect(h.topic).not.toHaveBeenCalled();
    h.fm.webPerson = () => ({ name: "Guest" }); h.fm.guestScope = () => new Set(["agent"]);
    h.fm.onWebLogin({ ...h.info, tier: "guest", owner: { adapterId: "tg", userId: "guest" } });
    expect(h.topic).toHaveBeenCalledWith(t("web.guest_login_notice", "Guest", "Firefox", 1, "session-"));
  });
  it.each([["dm"], ["route"]])("a local guest's sign-in with legacy %s posts in General, not by DM", async form => {
    const h = rig("dm"); legacy(h, form); h.fm.webPerson = () => ({ name: "Guest" }); h.fm.guestScope = () => new Set(["agent"]);
    h.fm.onWebLogin({ ...h.info, tier: "guest", owner: { adapterId: "tg", userId: "guest" } }); await flush();
    expect(h.topic).toHaveBeenCalledWith(t("web.guest_login_notice", "Guest", "Firefox", 1, "session-"));
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
  });
  it.each([[true], ["dm"]] as const)("%s public sign-in posts in the owner's topic and keeps the owner and authority fence", async mode => {
    const h = rig(mode); const info = { label: "Firefox", handle: "session-handle", owner: h.owner };
    await h.fm.confirmPublicWebLogin(info, () => true);
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
    expect(h.adapter.sendText).toHaveBeenCalledWith("group", t("web.public_login_notice", "Firefox", "session-"), { threadId: "topic", allowedMentions: { parse: [] } });
    h.adapter.sendText.mockClear();
    await expect(h.fm.confirmPublicWebLogin(info, () => false)).rejects.toThrow(); expect(h.adapter.sendText).not.toHaveBeenCalled();
  });
  it("a public guest sign-in posts in the link owner's topic, never by DM", async () => {
    const h = rig("dm"); h.fm.publicWebLink = { openSignin: () => ({ owner: h.owner, exposureId: "exposure" }) };
    h.fm.guestSignInAllowed = () => true; h.fm.webPerson = () => ({ name: "Guest" }); h.fm.guestScope = () => new Set(["agent"]);
    await h.fm.confirmGuestPublicWebLogin({ label: "Firefox", handle: "session-handle", account: { adapterId: "tg", userId: "guest" }, exposureId: "exposure" }, () => true);
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
    expect(h.adapter.sendText).toHaveBeenCalledWith("group", t("web.guest_public_login_notice", "Guest", "Firefox", 1, "session-"), { threadId: "topic", allowedMentions: { parse: [] } });
  });
  // hmsg-d1809f2a: tips never go by DM. A legacy "dm" (either form) posts in the General topic like true.
  it.each([["defaults.tips", "dm"], ["notice_delivery.tips", "dm"]])("a daily tip with legacy %s %s posts in the topic, never by DM", async key => {
    const h = rig();
    if (key === "defaults.tips") h.fm.fleetConfig.defaults.tips = "dm";
    else { h.fm.fleetConfig.defaults.tips = true; h.fm.fleetConfig.web.notice_delivery = { tips: "dm" }; }
    await h.fm.sendTipToGeneral();
    expect(h.adapter.sendDirect).not.toHaveBeenCalled();
    expect(h.adapter.notifyAlert).toHaveBeenCalledOnce();
    expect((h.adapter.notifyAlert.mock.calls as unknown as unknown[][])[0]![0]).toBe("group");
    const entry: any = [...h.fm.pendingNonceButtons.values()][0];
    expect([entry.chatId, entry.threadId]).toEqual(["group", "topic"]);
  });
  it("validates true and false, and tolerates a legacy dm with a warning", () => {
    for (const mode of [true, false, "dm"]) {
      expect(validateFleetConfig({ defaults: { tips: mode }, web: { notify_login: mode }, instances: {} }).valid).toBe(true);
      expect(parseWebSettingsBody({ notify_login: mode })).toMatchObject({ notifyLogin: mode });
    }
    expect(validateFleetConfig({ defaults: { tips: "email" }, web: { notify_login: "email" }, instances: {} }).valid).toBe(false);
    expect(parseWebSettingsBody({ notify_login: "email" })).toHaveProperty("error");
    const legacy = validateFleetConfig({ defaults: { tips: "dm" }, web: { notify_login: "dm", notice_delivery: { login: "dm", tips: "dm" } }, instances: {} });
    expect(legacy.valid).toBe(true);
    expect(legacy.warnings.map(w => w.path)).toEqual(expect.arrayContaining(["defaults.tips", "web.notify_login", "web.notice_delivery"]));
    expect(validateFleetConfig({ defaults: { tips: true }, web: { notify_login: false }, instances: {} }).warnings
      .filter(w => /tips|notify_login|notice_delivery/.test(w.path))).toEqual([]);
  });
});
