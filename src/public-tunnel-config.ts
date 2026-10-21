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

export function validPublicTunnelToken(value: string): boolean {
  return value.length >= 20 && value.length <= 4096 && /^[A-Za-z0-9_+\/-]+=*$/.test(value);
}
