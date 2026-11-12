/**
 * AGEND-113: which Google account this host's Antigravity sign-in is, for Settings → Accounts. Read from agy's own token file, locally: no process is started, no network request is
 * made, and what is returned is the masked identity of `parseAntigravityToken` (`ab***@example.com`) and nothing else. The file's text is passed to that parser and dropped here: it is
 * never kept, logged or sent, and neither is the path. A file that is missing, not a regular file, a link or too big gives nothing (an answer, not an error).
 *
 * Windows keeps this login in the Credential Manager, not in a file, so this is the host's (Linux, macOS, WSL) only; a paired Windows computer shows no account for it.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { parseAntigravityToken, type AccountIdentity } from "./claude-auth-status.js";
import { readAntigravityTokenText } from "./antigravity-store.js";

/** Where agy keeps its token under the CLI's home: the same file the availability probe and the usage panel read. */
export const AGY_TOKEN_FILE = Object.freeze(["antigravity-cli", "antigravity-oauth-token"] as const);

/** The account of the sign-in kept in a folder (the default sign-in's `~/.gemini/antigravity-cli`, or a named account's own folder), masked; undefined when there is none or it names no one. */
export function readAntigravityIdentityIn(folder: string): AccountIdentity | undefined {
  try {
    const text = readAntigravityTokenText(folder);
    return typeof text === "string" ? parseAntigravityToken(text) : undefined;
  } catch { return undefined; }
}

export function readAntigravityIdentity(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): AccountIdentity | undefined {
  return readAntigravityIdentityIn(join(env.GEMINI_HOME || join(home, ".gemini"), AGY_TOKEN_FILE[0]));
}
