/**
 * #1421: setup guide links at the bot-token step in quickstart + setup wizard.
 *
 * Tests turn red if the link is removed from SETUP_GUIDE_URLS or the
 * setupGuideUrl() helper returns the wrong URL for a locale.
 *
 * Wiring tests check that both src/quickstart.ts and src/setup-wizard.ts call
 * setupGuideUrl() at the right place. Removing the call from either file turns
 * the corresponding test red.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setLocale } from "../src/locale.js";
// Import from the shared module — not from quickstart (circular) or wizard.
import { setupGuideUrl, SETUP_GUIDE_URLS } from "../src/setup-guide.js";

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

const ROOT = join(import.meta.dirname ?? import.meta.url.replace(/\/[^/]+$/, ""), "..");

describe("quickstart.ts source — links are wired into both flows", () => {
  it("runTelegramFlow calls setupGuideUrl('telegram')", () => {
    const src = readFileSync(join(ROOT, "src/quickstart.ts"), "utf-8");
    const telegramFlowStart = src.indexOf("async function runTelegramFlow");
    const discordFlowStart = src.indexOf("async function runDiscordFlow");
    const callIdx = src.indexOf('setupGuideUrl("telegram")', telegramFlowStart);
    expect(callIdx, "setupGuideUrl('telegram') must be called in runTelegramFlow").toBeGreaterThan(telegramFlowStart);
    expect(callIdx, "must be in runTelegramFlow, not runDiscordFlow").toBeLessThan(discordFlowStart);
  });

  it("runDiscordFlow calls setupGuideUrl('discord')", () => {
    const src = readFileSync(join(ROOT, "src/quickstart.ts"), "utf-8");
    const discordFlowStart = src.indexOf("async function runDiscordFlow");
    const callIdx = src.indexOf('setupGuideUrl("discord")', discordFlowStart);
    expect(callIdx, "setupGuideUrl('discord') must be called in runDiscordFlow").toBeGreaterThan(discordFlowStart);
  });

  it("quickstart imports setupGuideUrl from setup-guide (not from locale directly)", () => {
    const src = readFileSync(join(ROOT, "src/quickstart.ts"), "utf-8");
    expect(src).toContain('from "./setup-guide.js"');
    // Must NOT define its own SETUP_GUIDE_URLS constant (would be a duplicate).
    const ownDefinition = /export\s+const\s+SETUP_GUIDE_URLS\s*=/.test(src);
    expect(ownDefinition, "quickstart must not define SETUP_GUIDE_URLS itself").toBe(false);
  });
});

describe("setup-wizard.ts source — links are wired into both steps", () => {
  it("Telegram Step 3 calls setupGuideUrl('telegram')", () => {
    const src = readFileSync(join(ROOT, "src/setup-wizard.ts"), "utf-8");
    const telegramStep = src.indexOf("Step 3: Telegram Bot Token");
    const discordStep = src.indexOf("Step 3: Discord Bot Token");
    const callIdx = src.indexOf('setupGuideUrl("telegram")', telegramStep);
    expect(callIdx, "setupGuideUrl('telegram') must be in Telegram Step 3").toBeGreaterThan(telegramStep);
    expect(callIdx, "must be in Telegram step, not Discord step").toBeLessThan(discordStep);
  });

  it("Discord Step 3 calls setupGuideUrl('discord')", () => {
    const src = readFileSync(join(ROOT, "src/setup-wizard.ts"), "utf-8");
    const discordStep = src.indexOf("Step 3: Discord Bot Token");
    const callIdx = src.indexOf('setupGuideUrl("discord")', discordStep);
    expect(callIdx, "setupGuideUrl('discord') must be in Discord Step 3").toBeGreaterThan(discordStep);
  });

  it("setup-wizard imports setupGuideUrl from setup-guide (not from quickstart)", () => {
    const src = readFileSync(join(ROOT, "src/setup-wizard.ts"), "utf-8");
    expect(src).toContain('from "./setup-guide.js"');
    // Must NOT import from quickstart (would be circular).
    expect(src).not.toContain('from "./quickstart');
  });
});
