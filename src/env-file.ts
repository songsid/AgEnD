/**
 * The one reading of the data dir's .env (#1539 review): the fleet's start (loadEnvFile), a connection added to a
 * running fleet (loadEnvKeys) and the token-name generator (envFileKeys) all take the same lines as the same keys and
 * values, so a token is never read one way at start and another way later.
 *
 * - blank lines and lines starting with "#" are skipped; a line without "=" is skipped;
 * - `export KEY=value` is the shell-style form people paste from their .bashrc: the "export " goes;
 * - one pair of surrounding quotes ("…" or '…') goes from the value;
 * - a key that appears twice: the last one wins.
 */
export function parseEnvText(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).replace(/^export\s+/, "").trim();
    if (!key) continue;
    out.set(key, trimmed.slice(eqIdx + 1).replace(/^["'](.*)["']$/, "$1"));
  }
  return out;
}
