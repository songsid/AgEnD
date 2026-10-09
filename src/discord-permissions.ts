/**
 * #1519 P3 (docs/design/ux-onboarding-walkthrough.md §5.3): the one permission set an AgEnD Discord bot is invited with —
 * the CLI's persona invite and Settings' invite button both use it. Each bit is here because an adapter call needs it
 * (tests/discord-permissions-1519.test.ts maps every call to its bits); nothing is asked for "just in case", and never
 * Administrator. Slash commands need no bit: registering them is authorized by the applications.commands scope the invite
 * carries (Use Application Commands is a member's permission to USE commands — #1533 review).
 */
export const DISCORD_PERMISSION_BITS = {
  ADD_REACTIONS: 6n,              // status reactions (reactions/@me)
  VIEW_CHANNEL: 10n,              // every channel the bot reads or writes
  SEND_MESSAGES: 11n,             // replies, prompts, approvals, alerts, stickers
  ATTACH_FILES: 15n,              // sendFile
  READ_MESSAGE_HISTORY: 16n,      // messages.fetch before editing/deleting/reacting to its own messages
  USE_EXTERNAL_EMOJIS: 18n,       // a status emoji from another server the bot is in (#1056)
  MANAGE_CHANNELS: 4n,            // the topic category and topic channels (createTopic, deleteTopic)
  SEND_MESSAGES_IN_THREADS: 38n,  // a reply into a thread
} as const;

/** Administrator — never part of the set (a test pins it). */
export const DISCORD_ADMINISTRATOR_BIT = 3n;

/** The set as Discord's permission integer (a decimal string, as the invite URL carries it). */
export const DISCORD_BOT_PERMISSIONS: string = Object.values(DISCORD_PERMISSION_BITS).reduce((acc, bit) => acc | (1n << bit), 0n).toString();

/** The bot's invite: its application id (for a bot, its user id), the bot + slash-command scopes, the set above. */
export function discordInviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&scope=bot%20applications.commands&permissions=${DISCORD_BOT_PERMISSIONS}`;
}

/** The developer portal page where the Message Content intent is turned on (the API cannot set it). */
export function discordBotPortalUrl(applicationId: string): string {
  return `https://discord.com/developers/applications/${encodeURIComponent(applicationId)}/bot`;
}

/** A gateway refusal for an intent the application has not been granted (close code 4014). */
export function isDisallowedIntentsError(message: string | null | undefined): boolean {
  return typeof message === "string" && /disallowed intents|\b4014\b/i.test(message);
}

/**
 * The platform refused the bot token itself (#1519 P6): Discord's "An invalid token was provided" / TokenInvalid,
 * Telegram's 401 Unauthorized, a 401 status. Used only to name the problem; the error text is never shown.
 */
export function isRejectedTokenError(message: string | null | undefined): boolean {
  return typeof message === "string" && /invalid token|TokenInvalid|\b401\b|unauthorized/i.test(message);
}
