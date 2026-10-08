/**
 * Setup guide URLs for the bot-token steps in quickstart and the setup wizard.
 *
 * A single constant used by both src/quickstart.ts and src/setup-wizard.ts to
 * avoid duplication and prevent a circular import (quickstart imports from
 * setup-wizard, so the URLs must live in a third module that both can import).
 */
import { getLocale } from "./locale.js";

/** Locale-keyed setup guide URLs per platform. */
export const SETUP_GUIDE_URLS = {
  telegram: {
    en: "https://songsid.github.io/AgEnD/setup-telegram/",
    "zh-TW": "https://songsid.github.io/AgEnD/zh-tw/setup-telegram/",
  },
  discord: {
    en: "https://songsid.github.io/AgEnD/setup-discord/",
    "zh-TW": "https://songsid.github.io/AgEnD/zh-tw/setup-discord/",
  },
} as const;

/** Returns the locale-appropriate setup guide URL for the given platform. */
export function setupGuideUrl(platform: "telegram" | "discord"): string {
  const locale = getLocale();
  return SETUP_GUIDE_URLS[platform][locale === "zh-TW" ? "zh-TW" : "en"];
}
