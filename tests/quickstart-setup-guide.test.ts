/**
 * #1421: setup guide links at the bot-token step in quickstart.
 *
 * Tests turn red if the link is removed from SETUP_GUIDE_URLS or the
 * setupGuideUrl() helper returns the wrong URL for a locale.
 */
import { describe, it, expect, afterEach } from "vitest";
import { setLocale } from "../src/locale.js";
import { setupGuideUrl, SETUP_GUIDE_URLS } from "../src/quickstart.js";

afterEach(() => setLocale("en"));

describe("SETUP_GUIDE_URLS — correct URLs present", () => {
  it("Telegram English URL is the website setup page", () => {
    expect(SETUP_GUIDE_URLS.telegram.en).toBe("https://songsid.github.io/AgEnD/setup-telegram/");
  });
  it("Discord English URL is the website setup page", () => {
    expect(SETUP_GUIDE_URLS.discord.en).toBe("https://songsid.github.io/AgEnD/setup-discord/");
  });
  it("Telegram zh-TW URL is the zh-tw website setup page", () => {
    expect(SETUP_GUIDE_URLS.telegram["zh-TW"]).toBe("https://songsid.github.io/AgEnD/zh-tw/setup-telegram/");
  });
  it("Discord zh-TW URL is the zh-tw website setup page", () => {
    expect(SETUP_GUIDE_URLS.discord["zh-TW"]).toBe("https://songsid.github.io/AgEnD/zh-tw/setup-discord/");
  });
});

describe("setupGuideUrl — locale-aware selection", () => {
  it("returns English Telegram URL for en locale", () => {
    setLocale("en");
    expect(setupGuideUrl("telegram")).toBe(SETUP_GUIDE_URLS.telegram.en);
  });
  it("returns zh-TW Telegram URL for zh-TW locale", () => {
    setLocale("zh-TW");
    expect(setupGuideUrl("telegram")).toBe(SETUP_GUIDE_URLS.telegram["zh-TW"]);
  });
  it("returns English Discord URL for en locale", () => {
    setLocale("en");
    expect(setupGuideUrl("discord")).toBe(SETUP_GUIDE_URLS.discord.en);
  });
  it("returns zh-TW Discord URL for zh-TW locale", () => {
    setLocale("zh-TW");
    expect(setupGuideUrl("discord")).toBe(SETUP_GUIDE_URLS.discord["zh-TW"]);
  });
  it("URL contains the platform name", () => {
    setLocale("en");
    expect(setupGuideUrl("telegram")).toContain("telegram");
    expect(setupGuideUrl("discord")).toContain("discord");
  });
  it("zh-TW URL contains zh-tw path segment", () => {
    setLocale("zh-TW");
    expect(setupGuideUrl("telegram")).toContain("zh-tw");
    expect(setupGuideUrl("discord")).toContain("zh-tw");
  });
});

describe("quickstart.ts source — links are wired into both flows", () => {
  it("runTelegramFlow calls setupGuideUrl('telegram')", () => {
    // Structural check: ensures the link is printed in the Telegram flow.
    // Removing it turns this red without breaking TypeScript compilation.
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const src = readFileSync(join(import.meta.dirname ?? "", "../src/quickstart.ts"), "utf-8");
    // The call must appear inside runTelegramFlow (before runDiscordFlow).
    const telegramFlowStart = src.indexOf("async function runTelegramFlow");
    const discordFlowStart = src.indexOf("async function runDiscordFlow");
    const callIdx = src.indexOf('setupGuideUrl("telegram")', telegramFlowStart);
    expect(callIdx, "setupGuideUrl('telegram') must be called in runTelegramFlow").toBeGreaterThan(telegramFlowStart);
    expect(callIdx, "setupGuideUrl('telegram') must be in runTelegramFlow, not runDiscordFlow").toBeLessThan(discordFlowStart);
  });

  it("runDiscordFlow calls setupGuideUrl('discord')", () => {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const src = readFileSync(join(import.meta.dirname ?? "", "../src/quickstart.ts"), "utf-8");
    const discordFlowStart = src.indexOf("async function runDiscordFlow");
    const callIdx = src.indexOf('setupGuideUrl("discord")', discordFlowStart);
    expect(callIdx, "setupGuideUrl('discord') must be called in runDiscordFlow").toBeGreaterThan(discordFlowStart);
  });
});
