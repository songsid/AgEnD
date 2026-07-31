import { chmodSync, statSync, writeFileSync } from "node:fs";

/** Owner read/write only. Anything wider exposes a token to every local user. */
export const SECRET_FILE_MODE = 0o600;

export interface SecretWriteResult {
  /** False when the file is readable or writable by anyone but its owner. */
  ok: boolean;
  /** The permission bits actually on disk afterwards, or null if unreadable. */
  mode: number | null;
  reason?: string;
}

/**
 * Write a file containing a secret and *confirm* it ended up owner-only.
 *
 * Every call site already passed `{ mode: 0o600 }` to writeFileSync and then
 * re-chmod'd — correctly, because writeFileSync's mode applies only on create, so
 * an existing file keeps whatever permissions it already had. But the chmod was
 * wrapped in a bare `catch {}`, and the only situation where that chmod does
 * anything is the situation where the file is already too permissive. So the one
 * case the code was defending against was also the one case it failed silently:
 * the secret stayed world-readable and nothing said so.
 *
 * This does not throw. A bot token that cannot be tightened is still a bot token
 * the fleet needs, and refusing to start would be worse than running exposed.
 * It reports instead, so the caller can say so where a human will see it.
 */
export interface SecretFileOps {
  write(path: string, content: string, mode: number): void;
  chmod(path: string, mode: number): void;
  /** Permission bits currently on disk, or null if they cannot be read. */
  mode(path: string): number | null;
}

/** Exported so the failure branches can be tested without an exotic filesystem. */
export const realSecretFileOps: SecretFileOps = {
  write: (path, content, mode) => writeFileSync(path, content, { mode }),
  chmod: (path, mode) => chmodSync(path, mode),
  mode: readMode,
};

export function writeSecretFile(
  path: string,
  content: string,
  ops: SecretFileOps = realSecretFileOps,
): SecretWriteResult {
  ops.write(path, content, SECRET_FILE_MODE);
  try {
    ops.chmod(path, SECRET_FILE_MODE);
  } catch (err) {
    return { ok: false, mode: ops.mode(path), reason: (err as Error).message };
  }
  const mode = ops.mode(path);
  if (mode === null) return { ok: false, mode, reason: "could not stat the file after writing" };
  // Check the group/other bits rather than equality: a stricter mode is fine, and
  // some filesystems (and Windows) will not reproduce 0o600 exactly.
  if ((mode & 0o077) !== 0) {
    return { ok: false, mode, reason: `permissions are ${mode.toString(8)}, expected owner-only` };
  }
  return { ok: true, mode };
}

function readMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}
