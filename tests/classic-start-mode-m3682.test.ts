/**
 * M-3682: /start shows a backend and a required Restricted / Free choice.
 * The room is not created until both are chosen. Free is a fleet-admin choice.
 * These are the menu captures: Discord respondButtons and Telegram promptUser.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import yaml from "js-yaml";
import { FleetManager } from "../src/fleet-manager.js";
import { ClassicChannelManager } from "../src/classic-channel-manager.js";
import { setLocale, t } from "../src/locale.js";

const USER = "42";
const dirs: string[] = [];
const fleets: any[] = [];

afterEach(() => {
  for (const fm of fleets.splice(0)) {
    for (const pending of fm.pendingClassicStarts.values()) clearTimeout(pending.timer);
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  setLocale("en");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rig(type: "discord" | "telegram", fleetAdmin: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "agend-m3682-"));
  dirs.push(dir);
  writeFileSync(join(dir, "classicBot.yaml"), yaml.dump({ defaults: { admin_users: [USER] }, channels: {} }));
  const fm = new FleetManager(dir) as any;
  fleets.push(fm);
  fm.logger = { info() {}, warn() {}, error() {}, debug() {} };
  const adapterId = type === "discord" ? "dc" : "tg";
  const channel = {
    id: adapterId,
    type,
    access: { mode: "locked", allowed_users: fleetAdmin ? [USER] : ["someone-else"], max_pending_codes: 0, code_expiry_minutes: 0 },
  };
  const adapter: any = {
    id: adapterId,
    type,
    sendText: vi.fn(async (chatId: string) => ({ chatId, messageId: "reply" })),
    editMessageRemoveButtons: vi.fn().mockResolvedValue(undefined),
    promptUser: vi.fn().mockResolvedValue("menu"),
  };
  fm.fleetConfig = { channels: [channel], defaults: { backend: "codex" }, instances: {} };
  fm.worlds.set(adapterId, { id: adapterId, adapter, channelConfig: channel });
  fm.adapter = adapter;
  const classic = new ClassicChannelManager(dir, fm.logger);
  classic.setPrimaryAdapterId(adapterId);
  classic.configureAdapters([channel as any]);
  fm.classicChannels = classic;
  const start = vi.spyOn(fm, "startClassicInstance").mockResolvedValue(undefined);
  vi.spyOn(fm, "reregisterClassicChannels").mockImplementation(() => {});
  vi.spyOn(fm, "getMissingBackendWarning").mockReturnValue(undefined);
  const respond = vi.fn().mockResolvedValue(undefined);
  const respondButtons = vi.fn(async (text: string, choices: { id: string; label: string }[]) => {
    respondButtons.shown.push({ text, choices });
    return "menu";
  }) as any;
  respondButtons.shown = [] as { text: string; choices: { id: string; label: string }[] }[];
  return { fm, classic, adapter, start, respond, respondButtons, userId: USER, adapterId, dir, type };
}

function shown(choices: { id: string; label: string }[]) {
  return choices.map(choice => ({
    id: choice.id.replace(/classic-mode:[0-9a-f]+:/, "classic-mode:NONCE:"),
    label: choice.label,
  }));
}

async function discordMenu(r: ReturnType<typeof rig>) {
  await r.fm.handleClassicStartSlash({
    command: "start",
    channelId: "room-1",
    channelName: "room",
    guildId: "guild-1",
    userId: r.userId,
    options: { backend: "codex" },
    respond: r.respond,
    respondButtons: r.respondButtons,
  }, r.adapterId);
  return r.respondButtons.shown[0] as { text: string; choices: { id: string; label: string }[] };
}

async function telegramMenu(r: ReturnType<typeof rig>, backend = "codex") {
  await r.fm.beginClassicModeSelection({
    command: "start",
    channelId: "12345",
    channelName: "room",
    userId: r.userId,
    respond: r.respond,
  }, r.adapter, backend, r.adapterId);
  const call = r.adapter.promptUser.mock.calls.at(-1);
  return { text: String(call[1]), choices: call[2] as { id: string; label: string }[] };
}

async function click(r: ReturnType<typeof rig>, callbackData: string, chatId: string, userId = r.userId) {
  const ack = vi.fn();
  await r.fm.receiveAdapterCallback({
    callbackData, chatId, messageId: "menu", userId, ack,
  }, r.adapterId, r.adapter, () => true);
  return ack;
}

const LABELS = {
  en: {
    restricted: "Restricted",
    recommended: "Free (recommended)",
    free: "Free",
  },
  "zh-TW": {
    restricted: "受限模式",
    recommended: "自由模式（建議）",
    free: "自由模式",
  },
} as const;

describe("Classic /start mode menu (M-3682)", () => {
  for (const platform of ["discord", "telegram"] as const) {
    for (const locale of ["en", "zh-TW"] as const) {
      const words = LABELS[locale];
      it(`${platform} ${locale}: a fleet admin must still choose, Free first and recommended`, async () => {
        setLocale(locale);
        const r = rig(platform, true);
        const chatId = platform === "discord" ? "room-1" : "12345";
        const menu = platform === "discord" ? await discordMenu(r) : await telegramMenu(r);
        expect(r.start).not.toHaveBeenCalled();
        expect(r.classic.getAll()).toHaveLength(0);
        expect(menu.text).toBe(t("classic.choose_mode"));
        expect(shown(menu.choices)).toEqual([
          { id: "classic-mode:NONCE:free", label: words.recommended },
          { id: "classic-mode:NONCE:restricted", label: words.restricted },
        ]);
        expect(t("classic.mode_free_recommended")).toBe(words.recommended);
        expect(t("classic.mode_free")).toBe(words.free);
        expect(t("classic.mode_restricted")).toBe(words.restricted);
        await click(r, menu.choices[0]!.id, chatId);
        expect(r.classic.get(chatId, r.adapterId)?.restrictedMode).toBe(false);
        expect(readFileSync(join(r.dir, "classicBot.yaml"), "utf8")).toContain("restricted_mode: false");
        expect(r.start).toHaveBeenCalledOnce();
      });

      it(`${platform} ${locale}: anyone else is offered Restricted only, and a crafted Free click does nothing`, async () => {
        setLocale(locale);
        const r = rig(platform, false);
        const chatId = platform === "discord" ? "room-1" : "12345";
        const menu = platform === "discord" ? await discordMenu(r) : await telegramMenu(r);
        expect(menu.text).toBe(t("classic.choose_mode_fixed"));
        expect(menu.text).toContain(locale === "en" ? "only for a fleet admin" : "只有 Fleet 管理員可以選擇自由模式");
        expect(shown(menu.choices)).toEqual([
          { id: "classic-mode:NONCE:restricted", label: words.restricted },
        ]);
        expect(t("classic.mode_restricted")).toBe(words.restricted);
        const nonce = menu.choices[0]!.id.split(":")[1];
        const ack = await click(r, `classic-mode:${nonce}:free`, chatId);
        expect(ack.mock.calls[0]?.[0]).toBe(t("classic.mode_free_admin_only"));
        expect(r.fm.pendingClassicStarts.has(nonce)).toBe(true);
        expect(r.start).not.toHaveBeenCalled();
        expect(r.classic.getAll()).toHaveLength(0);
        await click(r, menu.choices[0]!.id, chatId);
        expect(r.classic.get(chatId, r.adapterId)?.restrictedMode).toBe(true);
        expect(readFileSync(join(r.dir, "classicBot.yaml"), "utf8")).toContain("restricted_mode: true");
        expect(r.start).toHaveBeenCalledOnce();
      });
    }
  }

  it("telegram: a fleet admin can still tap Restricted, and that creates a restricted room", async () => {
    const r = rig("telegram", true);
    const menu = await telegramMenu(r);
    expect(shown(menu.choices)[1]).toEqual({ id: "classic-mode:NONCE:restricted", label: "Restricted" });
    await click(r, menu.choices[1]!.id, "12345");
    expect(r.classic.get("12345", r.adapterId)?.restrictedMode).toBe(true);
    expect(readFileSync(join(r.dir, "classicBot.yaml"), "utf8")).toContain("restricted_mode: true");
    expect(r.start).toHaveBeenCalledOnce();
  });

  it("telegram: an unknown backend token still opens the mode menu and creates nothing yet", async () => {
    const r = rig("telegram", false);
    const menu = await telegramMenu(r, "claude");
    expect(menu.text).toBe(t("classic.choose_mode_fixed"));
    expect(r.start).not.toHaveBeenCalled();
    expect(r.classic.getAll()).toHaveLength(0);
  });

  it("telegram: the backend menu asks only for a backend", async () => {
    const r = rig("telegram", true);
    await r.fm.beginClassicBackendSelection({
      command: "start",
      channelId: "12345",
      channelName: "room",
      userId: r.userId,
      respond: r.respond,
    }, r.adapter);
    expect(r.adapter.promptUser.mock.calls[0][1]).toBe(t("classic.choose_backend"));
    expect(r.start).not.toHaveBeenCalled();
    expect(r.classic.getAll()).toHaveLength(0);
  });

  it("a direct start that omits the mode stays restricted", async () => {
    const r = rig("telegram", false);
    await r.fm.handleClassicStart("direct-room", "direct", r.userId, undefined, r.adapterId, "codex");
    expect(r.classic.get("direct-room", r.adapterId)?.restrictedMode).toBe(true);
    await r.fm.handleClassicStart("direct-free", "direct", r.userId, undefined, r.adapterId, "codex", false);
    expect(r.classic.get("direct-free", r.adapterId)?.restrictedMode).toBe(false);
  });

  it("a click with no user id leaves both choices pending", async () => {
    const r = rig("telegram", true);
    await r.fm.beginClassicBackendSelection({
      command: "start",
      channelId: "12345",
      channelName: "room",
      userId: r.userId,
      respond: r.respond,
    }, r.adapter);
    const backendChoices = r.adapter.promptUser.mock.calls[0][2] as { id: string }[];
    const codex = backendChoices.find(choice => choice.id.endsWith(":codex"))!;
    const backendNonce = codex.id.split(":")[1];
    for (const userId of [undefined, ""] as const) {
      await r.fm.handleClassicBackendSelection({
        callbackData: codex.id, chatId: "12345", messageId: "menu", userId,
      });
    }
    expect(r.adapter.promptUser).toHaveBeenCalledOnce();
    expect(r.fm.pendingClassicStarts.has(backendNonce)).toBe(true);
    expect(r.start).not.toHaveBeenCalled();

    await r.fm.handleClassicBackendSelection({
      callbackData: codex.id, chatId: "12345", messageId: "menu", userId: r.userId,
    });
    const menu = r.adapter.promptUser.mock.calls.at(-1);
    const free = (menu[2] as { id: string }[]).find(choice => choice.id.endsWith(":free"))!;
    const modeNonce = free.id.split(":")[1];
    for (const userId of [undefined, ""] as const) {
      await r.fm.handleClassicModeSelection({
        callbackData: free.id, chatId: "12345", messageId: "menu", userId,
      });
    }
    expect(r.fm.pendingClassicStarts.has(modeNonce)).toBe(true);
    expect(r.start).not.toHaveBeenCalled();
    expect(r.classic.getAll()).toHaveLength(0);
    await click(r, free.id, "12345");
    expect(r.classic.get("12345", r.adapterId)?.restrictedMode).toBe(false);
    expect(r.start).toHaveBeenCalledOnce();
  });

  it("only the /start user can consume the mode click", async () => {
    const r = rig("telegram", true);
    const menu = await telegramMenu(r);
    await click(r, menu.choices[0]!.id, "12345", "someone-else");
    expect(r.start).not.toHaveBeenCalled();
    expect(r.classic.getAll()).toHaveLength(0);
    await click(r, menu.choices[0]!.id, "12345");
    expect(r.classic.get("12345", r.adapterId)?.restrictedMode).toBe(false);
    expect(r.start).toHaveBeenCalledOnce();
  });

  it("a mode timeout creates nothing", async () => {
    vi.useFakeTimers();
    const r = rig("telegram", true);
    await telegramMenu(r);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.start).not.toHaveBeenCalled();
    expect(r.classic.getAll()).toHaveLength(0);
    expect(r.adapter.editMessageRemoveButtons).toHaveBeenCalledWith("12345", "menu", t("classic.mode_selection_expired"));
    expect(r.fm.pendingClassicStarts.size).toBe(0);
  });

  it("a failed backend menu creates nothing", async () => {
    const r = rig("telegram", true);
    r.adapter.promptUser.mockRejectedValueOnce(new Error("transport"));
    await r.fm.beginClassicBackendSelection({
      command: "start",
      channelId: "12345",
      channelName: "room",
      userId: r.userId,
      respond: r.respond,
    }, r.adapter);
    expect(r.respond).toHaveBeenCalledWith(t("classic.backend_menu_failed"));
    expect(r.start).not.toHaveBeenCalled();
    expect(r.classic.getAll()).toHaveLength(0);
    expect(r.fm.pendingClassicStarts.size).toBe(0);
  });

  it.each(["discord", "telegram"] as const)("%s: a failed mode menu creates nothing", async platform => {
    const r = rig(platform, true);
    if (platform === "discord") {
      r.respondButtons.mockRejectedValueOnce(new Error("transport"));
      await discordMenu(r);
    } else {
      r.adapter.promptUser.mockRejectedValueOnce(new Error("transport"));
      await telegramMenu(r);
    }
    expect(r.respond).toHaveBeenCalledWith(t("classic.mode_menu_failed"));
    expect(r.start).not.toHaveBeenCalled();
    expect(r.classic.getAll()).toHaveLength(0);
    expect(r.fm.pendingClassicStarts.size).toBe(0);
  });
});
