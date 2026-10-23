/**
 * The Telegram Bot API root a bot token may be sent to (#2490: shared by the Telegram adapter and the start-failure chat
 * notice, which runs before the rest of AgEnD loads — so no imports).
 */
/**
 * Whitelist of legitimate Telegram API roots. Misconfiguring `apiRoot`
 * (or having it set by an attacker via a config file write) would leak
 * the bot token — every API call sends the token in the path. Only the
 * official endpoint and loopback (E2E mock servers) are allowed.
 */
const TELEGRAM_API_HOST_ALLOWLIST = new Set([
  "api.telegram.org",
  "localhost",
  "127.0.0.1",
  "::1",
]);

export function validateTelegramApiRoot(apiRoot: string): void {
  let url: URL;
  try {
    url = new URL(apiRoot);
  } catch {
    throw new Error(`Invalid telegram_api_root URL: ${apiRoot}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`telegram_api_root must use http(s): ${apiRoot}`);
  }
  // http:// only allowed for loopback (mock servers); production must be https.
  // URL.hostname wraps IPv6 in brackets ("[::1]") — strip them for allowlist match.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!TELEGRAM_API_HOST_ALLOWLIST.has(host)) {
    throw new Error(
      `telegram_api_root host "${host}" is not in the allowlist ` +
      `(${[...TELEGRAM_API_HOST_ALLOWLIST].join(", ")}). ` +
      `Sending the bot token to an arbitrary host would leak credentials.`,
    );
  }
  if (url.protocol === "http:" && host === "api.telegram.org") {
    throw new Error("telegram_api_root must use https for api.telegram.org");
  }
}
