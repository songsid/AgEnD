/**
 * AGEND-181 PR2: where an antigravity (agy) or grok instance's own transcript lies, for the Log and the chat's activity
 * timeline. Both CLIs keep their records per working directory, and AgEnD launches each in the instance's
 * `working_directory`, so that directory names the conversation:
 *
 * - agy: `~/.gemini/antigravity-cli/cache/last_conversations.json` maps a working directory to its latest conversation
 *   (the one `agy --continue`, which AgEnD launches it with, resumes); the transcript is
 *   `~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl`.
 * - grok: `~/.grok/sessions/<encodeURIComponent(cwd)>/<session>/updates.jsonl`; the session is the one in that directory
 *   with the newest activity (the rule `GrokBackend.getSessionId` uses for `--resume`).
 *
 * Read only when the Log asks (sync, small): nothing here runs in the background. Limit, said on the page's reason: a
 * second agent of the same CLI started in the same directory outside AgEnD moves "latest" to its conversation.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAP_MAX_BYTES = 4 * 1024 * 1024;

/** The transcript of the latest agy conversation in `cwd`, or null (no mapping for it, or an id that is not a conversation id). */
export function antigravityTranscriptPath(cwd: string, home = homedir()): string | null {
  const root = join(home, ".gemini", "antigravity-cli");
  let map: unknown;
  try {
    const file = join(root, "cache", "last_conversations.json");
    if (statSync(file).size > MAP_MAX_BYTES) return null;
    map = JSON.parse(readFileSync(file, "utf-8"));
  } catch { return null; }
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const table = map as Record<string, unknown>;
  const keys = [cwd];
  try { const real = realpathSync(cwd); if (real !== cwd) keys.push(real); } catch { /* a directory that is gone: the plain key only */ }
  for (const key of keys) {
    const id = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
    if (typeof id === "string" && UUID.test(id)) return join(root, "brain", id, ".system_generated", "logs", "transcript.jsonl");
  }
  return null;
}

/** grok sessions are looked for at most this often per directory (each look stats every session of the directory). */
export const GROK_LOOKUP_TTL_MS = 5_000;
const grokLookups = new Map<string, { at: number; path: string | null }>();

/** The `updates.jsonl` of the grok session in `cwd` with the newest activity, or null. */
export function grokUpdatesPath(cwd: string, home = homedir(), now = Date.now()): string | null {
  const base = join(home, ".grok", "sessions", encodeURIComponent(cwd));
  const held = grokLookups.get(base);
  if (held && now - held.at < GROK_LOOKUP_TTL_MS && now >= held.at) return held.path;
  let best: string | null = null, bestMs = -1;
  try {
    for (const name of readdirSync(base)) {
      if (!UUID.test(name)) continue;
      const file = join(base, name, "updates.jsonl");
      try { const m = statSync(file).mtimeMs; if (m > bestMs) { bestMs = m; best = file; } } catch { /* a session with no updates yet */ }
    }
  } catch { best = null; }
  if (grokLookups.size > 64) grokLookups.clear();
  grokLookups.set(base, { at: now, path: best });
  return best;
}

/** The CLIs whose own record the Log reads, each with where to find it (the table the Log's source resolution asks). */
const OWN_RECORD = { antigravity: antigravityTranscriptPath, grok: grokUpdatesPath };
/** The transcript formats the Log can parse: Claude Code's and Codex's (found by their monitors) and the CLIs above. */
export type LogFormat = "claude" | "codex" | keyof typeof OWN_RECORD;

/**
 * `backend`'s own record for an instance working in `cwd` (null: no working directory to look in): its format and
 * path — the path null when none is known. Null: this CLI's record is not read this way.
 */
export function ownTranscript(backend: string, cwd: string | null): { format: keyof typeof OWN_RECORD; path: string | null } | null {
  if (!Object.prototype.hasOwnProperty.call(OWN_RECORD, backend)) return null;
  const format = backend as keyof typeof OWN_RECORD;
  return { format, path: cwd ? OWN_RECORD[format](cwd) : null };
}
