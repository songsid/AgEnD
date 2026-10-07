/** Stable display-only framing, shared by fleet-topic and ClassicBot web echoes.
 * This is provenance, not a credential: only bot-authored frames are filtered.
 * No in-memory receipt is needed, so replay/adapter recreation keeps the rule.
 */
const WEB_ECHO_FRAME = "\u2063\u2060\u2063\u2060\u2060\u2063";

/** Neutralise platform entities AND AgEnD's plain-text bot/command matching. */
export function neutralizeWebEchoText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, char => char === "\n" ? "\n" : char === "\t" ? " " : "")
    .replace(/@/g, "＠").replace(/\//g, "／");
}

export function formatWebChannelEcho(user: string, preview: string): string {
  const label = neutralizeWebEchoText(user).replace(/\s+/g, " ").slice(0, 80) || "web-user";
  return `${WEB_ECHO_FRAME}🌐 web · ${label}: ${neutralizeWebEchoText(preview)}${WEB_ECHO_FRAME}`;
}

/** Run before any access/collab/mention admission or dedup claim. */
export function isWebChannelEcho(text: string, fromBot: boolean): boolean {
  return fromBot && text.startsWith(`${WEB_ECHO_FRAME}🌐 web · `) && text.endsWith(WEB_ECHO_FRAME);
}
