import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export const WEB_TOKEN_INVALID_MESSAGE = "Token expired or invalid — run /dashboard again";
const WEB_TOKEN_PATTERN = /^[0-9a-f]{48}$/i;

function readValidToken(path: string): string | null {
  try {
    const token = readFileSync(path, "utf8").trim();
    return WEB_TOKEN_PATTERN.test(token) ? token : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function replaceTokenAtomically(path: string, token: string): void {
  const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temp, token, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* temp was never created or already moved */ }
    throw err;
  }
}

/**
 * Load the fleet-wide web bearer token, creating it only when absent/invalid.
 * A fleet restart must not revoke every previously issued /dashboard URL.
 */
export function loadOrCreateWebToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "web.token");
  const existing = readValidToken(path);
  if (existing) {
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
    return existing;
  }

  const token = randomBytes(24).toString("hex");
  replaceTokenAtomically(path, token);
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
  return token;
}
