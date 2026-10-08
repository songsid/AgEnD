/**
 * #1196 — the ClassicBot /start replies say how to talk to the agent. On Telegram that is @mentioning the bot; the
 * replies used to lead with `/chat`, which is the Discord habit. Telegram now gets its own wording; Discord keeps its
 * own. Copy only: nothing about what reaches the agent changes. Expectations written out by hand.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FleetManager } from "../src/fleet-manager.js";
import { setLocale, t } from "../src/locale.js";

const dirs: string[] = [];
afterEach(() => {
  setLocale("en");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TG_STARTED = "✅ Agent started in this chat. @mention me to talk (or `/chat <message>`).";
const TG_ACTIVE = "This chat already has an active agent. @mention me to talk.";
const DC_STARTED = "✅ Agent started in this channel. Use `/chat <message>` or @mention to talk.";
const DC_ACTIVE = "This channel already has an active agent. Use /chat to talk.";

/** A fleet with a Telegram bot "tg" (the primary) and a Discord bot "dc"; channel "active" already has an agent. */
function fleet() {
  const dir = mkdtempSync(join(tmpdir(), "agend-1196-"));
  dirs.push(dir);
  const fm = new FleetManager(dir);
  const any = fm as unknown as Record<string, any>;
  const tg = { id: "tg", type: "telegram" };
  const dc = { id: "dc", type: "discord" };
  any.adapter = tg;
  any.worlds.set("tg", { id: "tg", adapter: tg });
  any.worlds.set("dc", { id: "dc", adapter: dc });
  any.classicChannels = {
    isGuildAllowed: () => true, isAdmin: () => true,
    isClassicChannel: (channelId: string) => channelId === "active",
    deriveInstanceName: (name: string) => `classic-${name}`,
    register() {}, getBackend: () => "claude-code", getPreTaskCommand: () => undefined, getModel: () => undefined,
    getAutoPauseAfter: () => undefined, isCollab: () => true, toggleCollab() {},
  };
  any.startClassicInstance = async () => {};
  any.reregisterClassicChannels = () => {};
  any.bindInstanceAdapter = () => {};
  any.logger = { info() {}, warn() {}, error() {}, debug() {} };
  const start = (channelId: string, adapterId: string | undefined, guildId?: string) =>
    fm.handleClassicStart(channelId, channelId, "user-1", guildId, adapterId, "claude-code");
  return { fm, start };
}

describe("/start replies (#1196)", () => {
  it("Telegram: talk by @mentioning the bot", async () => {
    const { start } = fleet();
    expect(await start("-1001", "tg")).toBe(TG_STARTED);
    expect(await start("active", "tg")).toBe(TG_ACTIVE);
  });

  it("Discord: unchanged — @mention or /chat", async () => {
    const { start } = fleet();
    expect(await start("chan", "dc", "guild-1")).toBe(DC_STARTED);
    expect(await start("active", "dc", "guild-1")).toBe(DC_ACTIVE);
  });

  it("no adapter named: the primary's platform (here Telegram)", async () => {
    const { start } = fleet();
    expect(await start("-1002", undefined)).toBe(TG_STARTED);
  });

  it("an adapter id the fleet does not know falls back to the primary, never to a guess", async () => {
    const { start } = fleet();
    expect(await start("-1003", "gone")).toBe(TG_STARTED);
  });

  it("zh-TW: the same split", async () => {
    setLocale("zh-TW");
    const { start } = fleet();
    expect(await start("-1004", "tg")).toBe("✅ Agent 已在此聊天啟動。@我 就能對話（也可用 `/chat <訊息>`）。");
    expect(await start("active", "tg")).toBe("此聊天已有活動中的 Agent。@我 就能對話。");
    expect(await start("chan", "dc", "guild-1")).toBe("✅ Agent 已在此頻道啟動。用 `/chat <訊息>` 或 @mention 對話。");
    expect(await start("active", "dc", "guild-1")).toBe("此頻道已有活動中的 Agent。請用 /chat 對話。");
  });

  it("the Telegram wording leads with @mention, not /chat, in both languages", () => {
    for (const locale of ["en", "zh-TW"] as const) {
      setLocale(locale);
      for (const key of ["classic.started.telegram", "classic.already_active.telegram"]) {
        const text = t(key);
        expect(text, `${locale} ${key}`).not.toBe(key);           // the key exists in this locale
        expect(text.indexOf("@"), `${locale} ${key}`).toBeGreaterThan(-1);
        const chat = text.indexOf("/chat");
        if (chat !== -1) expect(text.indexOf("@"), `${locale} ${key}: @ comes first`).toBeLessThan(chat);
      }
    }
  });
});
