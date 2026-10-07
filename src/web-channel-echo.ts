/** Shared visible protocol prefix; provenance is the platform's author identity. */
export const WEB_ECHO_PREFIX = "🌐 web · ";

function clip(text: string, length: number): string {
  return text.slice(0, length).replace(/[\uD800-\uDBFF]$/, "");
}

function neutralizeTokens(text: string): string {
  return text
    .replace(/<@([!&]?)(\d+)>/g, (_token, kind: string, id: string) => `[${kind === "&" ? "role" : "mention"}: ${id}]`)
    .replace(/<#(\d+)>/g, (_token, id: string) => `[channel: ${id}]`)
    .replace(/(?<![\p{L}\p{N}_/])\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?![\p{L}\p{N}_/@])/gu,
      (_token, command: string, bot?: string) => `[command: ${command}${bot ? ` at ${bot}` : ""}]`)
    .replace(/@([A-Za-z0-9_]+)(?=@)/g, (_token, name: string) => `[at: ${name}]`)
    .replace(/(?<![\p{L}\p{N}_@.+%\-])@([A-Za-z0-9_]+)(?![A-Za-z0-9_])/gu, (_token, name: string) => `[at: ${name}]`);
}

/** Visible ASCII labels survive compatibility normalisation/format stripping.
 * URLs and email local parts are data, not mention/command tokens.
 */
export function neutralizeWebEchoText(text: string): string {
  const normalized = text.normalize("NFKC").replace(/[\p{Cc}\p{Cf}]/gu, char => char === "\n" ? "\n" : char === "\t" ? " " : "");
  const dataTokens = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`]+|(?<![\p{L}\p{N}_@])(?:"[^"\r\n]+"|[\p{L}\p{N}._%+\-]+)@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}(?![\p{L}\p{N}_@])/gu;
  let result = "", offset = 0;
  for (const match of normalized.matchAll(dataTokens)) {
    let end = match.index + match[0].length;
    // A Markdown/parenthesised URL ends at its balanced closing delimiter;
    // that delimiter must not hide an adjacent active mention from rewriting.
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(match[0]) && normalized[match.index - 1] === "(") {
      let depth = 1;
      for (let index = match.index; index < end; index++) {
        if (normalized[index] === "(") depth++;
        if (normalized[index] === ")" && --depth === 0) { end = index; break; }
      }
    }
    result += neutralizeTokens(normalized.slice(offset, match.index)) + normalized.slice(match.index, end);
    offset = end;
  }
  return result + neutralizeTokens(normalized.slice(offset));
}

export function formatWebChannelEcho(user: string, preview: string, fullTextNote = "full text in web chat"): string {
  const label = clip(neutralizeWebEchoText(user).replace(/\s+/g, " "), 80) || "web-user";
  const header = `${WEB_ECHO_PREFIX}${label}: `;
  const body = neutralizeWebEchoText(preview);
  // Labels can expand short input dramatically. Keep one platform message:
  // a later Discord chunk would otherwise lose the provenance prefix.
  const budget = 1800 - header.length;
  const note = ` … (${clip(neutralizeWebEchoText(fullTextNote), 100)})`;
  return header + (body.length > budget ? clip(body, budget - note.length) + note : body);
}

/** Before trigger evaluation, independent of flags, send ACKs or recent IDs. */
export function isWebChannelEcho(text: string, authorId: string, fleetBotIds: ReadonlySet<string>): boolean {
  return fleetBotIds.has(authorId) && text.startsWith(WEB_ECHO_PREFIX);
}
