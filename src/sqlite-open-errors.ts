/**
 * Why a SQLite store failed to open (#1490), so a caller can tell a file worth quarantining from one that is fine.
 *
 * - "corrupt": SQLite proved the file is not a usable database (SQLITE_NOTADB, SQLITE_CORRUPT and its extended codes).
 *   Only this is evidence against the file itself.
 * - "busy": another connection held a lock past the busy timeout (SQLITE_BUSY*, SQLITE_LOCKED*). The file is fine.
 * - "abi": the native driver could not load (better-sqlite3 built for another Node.js or architecture). The file was
 *   never even read.
 * - "other": anything else (permissions, a missing directory, a full disk, I/O). Not evidence of corruption.
 */
export type SqliteOpenFailure = "corrupt" | "busy" | "abi" | "other";

const ABI_MESSAGE = /NODE_MODULE_VERSION|compiled against a different Node\.js version|invalid ELF header|wrong ELF class|mach-o.*wrong architecture|incompatible architecture/i;

export function classifySqliteOpenError(err: unknown): SqliteOpenFailure {
  const code = err && typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "";
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (code === "SQLITE_NOTADB" || code.startsWith("SQLITE_CORRUPT")) return "corrupt";
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) return "busy";
  if (code === "ERR_DLOPEN_FAILED" || ABI_MESSAGE.test(message)) return "abi";
  return "other";
}
