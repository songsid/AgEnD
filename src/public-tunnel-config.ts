import { isIP } from "node:net";

export const PUBLIC_TUNNEL_TOKEN_ENV = "AGEND_CLOUDFLARE_TUNNEL_TOKEN";
export const PUBLIC_TUNNEL_SECRET_ID = "cloudflare.tunnel_token";
export const PUBLIC_TUNNEL_ORIGIN_PORT = 19282;

/** One DNS hostname, never a wildcard, IP, port or URL carrying private data. */
export function publicTunnelHostname(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > 261 || /[\s\\@?#%]/.test(value)) return null;
  let name = value;
  if (name.startsWith("https://")) {
    const root = /^https:\/\/([a-zA-Z0-9.-]+)\/?$/.exec(name);
    if (!root) return null;
    name = root[1]!;
  }
  name = name.toLowerCase();
  if (name.length > 253 || isIP(name) || !name.includes(".") || name.endsWith(".localhost") || name.endsWith(".local")) return null;
  return name.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ? name : null;
}

export const PUBLIC_TUNNEL_TOKEN_HINT = "Paste only the long string that starts with eyJ.";

/** Decode strictly: Buffer.from alone silently discards invalid characters/padding. */
function base64Bytes(value: string, url: boolean): Buffer | null {
  if (!(url ? /^[A-Za-z0-9_-]+={0,2}$/ : /^[A-Za-z0-9+/]+={0,2}$/).test(value)) return null;
  const bare = value.replace(/=+$/, "");
  const bytes = Buffer.from(bare, url ? "base64url" : "base64");
  const canonical = bytes.toString(url ? "base64url" : "base64").replace(/=+$/, "");
  if (canonical !== bare || value.includes("=") && value.length % 4 !== 0) return null;
  return bytes;
}

/** Local shape check, not authentication. Only the normalized credential leaves this boundary.
 * cloudflared connection.TunnelToken: a=account tag, t=UUID, s=base64 []byte; e is optional.
 */
export function normalizePublicTunnelToken(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  let token = value.trim();
  if (token[0] === '"' && token.at(-1) === '"' || token[0] === "'" && token.at(-1) === "'") token = token.slice(1, -1).trim();
  if (token.length < 20) return null;
  const bytes = base64Bytes(token, false) ?? base64Bytes(token, true);
  if (!bytes) return null;
  try {
    // Fatal UTF-8 decoding prevents replacement characters from turning malformed bytes into valid JSON.
    const fields: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) return null;
    const { a, t, s, e } = fields as Record<string, unknown>;
    if (typeof a !== "string" || !a.trim() || typeof t !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)
      || typeof s !== "string" || !base64Bytes(s, false)?.length
      || e !== undefined && typeof e !== "string") return null;
    // cloudflared's decoder uses standard base64, even when the pasted form used base64url.
    return bytes.toString("base64");
  } catch { return null; } // Never expose parser errors or decoded fields.
}

export function validPublicTunnelToken(value: string): boolean {
  return normalizePublicTunnelToken(value) !== null;
}
