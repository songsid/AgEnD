/**
 * Kiro's V3 (KAS) session store, read-only.
 *
 * V3 keeps a conversation as a directory, not a sqlite row:
 *   <KIRO_HOME or ~/.kiro>/sessions/<bucket>/<session id>/{session.json, messages.jsonl}
 * where <bucket> is the first 16 hex of SHA-256 of the working directory
 * (checked against real buckets kiro-cli 2.27.1 wrote). Session ids are
 * `sess_<uuid>` for sessions V3 started and `cli_<classic id>_<suffix>` for ones
 * converted from a classic conversation.
 *
 * Unlike the classic store this is not under XDG_DATA_HOME, so a credential
 * profile does not give an instance its own copy of it.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface KasSession {
  id: string;
  /** Epoch ms from session.json, or null when absent or not a time. */
  createdAt: number | null;
  lastModifiedAt: number | null;
}

/** A timestamp kiro wrote, as an instant; anything that is not one is null (never "" or NaN). */
function instant(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

export function kiroHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.KIRO_HOME || join(homedir(), ".kiro");
}

/** The bucket kiro files a working directory's V3 sessions under. */
export function kasBucket(workingDirectory: string): string {
  let cwd = workingDirectory;
  // kiro hashes its process cwd, which the kernel reports with symlinks resolved.
  try { cwd = realpathSync(workingDirectory); } catch { /* not there (yet): hash it as given */ }
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

/** This working directory's V3 sessions, most recently active first. Unreadable entries are skipped. */
export function listKasSessions(workingDirectory: string, env: NodeJS.ProcessEnv = process.env): KasSession[] {
  const dir = join(kiroHome(env), "sessions", kasBucket(workingDirectory));
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const sessions: KasSession[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    try {
      const meta = JSON.parse(readFileSync(join(dir, name, "session.json"), "utf8")) as Record<string, unknown>;
      // The directory name is the id `--resume-id` takes (what ensure-session returns).
      sessions.push({
        id: name,
        createdAt: instant(meta.createdAt),
        lastModifiedAt: instant(meta.lastModifiedAt),
      });
    } catch { /* not a session directory, or one being written */ }
  }
  // Compared as instants (offsets differ between writers); one with no time sorts last.
  const latest = (s: KasSession) => s.lastModifiedAt ?? s.createdAt ?? -Infinity;
  return sessions.sort((a, b) => latest(b) - latest(a));
}
