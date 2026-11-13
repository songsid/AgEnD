/**
 * AGEND-250 (#3771 review P2-1): proof that a named account's sign-in file was written BY THIS ATTEMPT.
 *
 * The post-login isolation check ("the account's own folder holds the CLI's sign-in file as a plain file") used to accept any plain file, so an expired or invalid file left in the folder by an
 * earlier attempt passed even when this login had gone to the shared keyring (the pin ignored). The evidence is now a before/after fingerprint of that one file: it counts only when the file is
 * a plain file now AND is not the file (same inode, size, modification time, content) that was there when the attempt began. The earlier file is never removed or moved, so a failed attempt
 * leaves the named account's previous credential exactly as it was. Light on purpose (the setup host loads this): node:fs and node:crypto only.
 */
import { lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";

/** What was in the store path when the attempt began: `null` = nothing there (or nothing that is a plain file). */
export type StoreFingerprint = string | null;

function plainFile(path: string): { key: string } | null {
  try {
    const st = lstatSync(path, { bigint: true });
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    return { key: `${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}:${digest}` };
  } catch { return null; }
}

/** Taken immediately before the login is started. */
export function fingerprintStore(path: string): StoreFingerprint { return plainFile(path)?.key ?? null; }

/** After the command ended with exit 0: a plain file that is not the one that was there before. Anything else (no file, a link, the very same file) is "not written by this attempt". */
export function storeWrittenSince(path: string, before: StoreFingerprint): boolean {
  const now = plainFile(path)?.key ?? null;
  return now !== null && now !== before;
}
