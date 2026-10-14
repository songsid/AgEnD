/** Chat updates must survive the fleet's service cgroup being stopped (#1490 row 37). */
import { execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fchmodSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { updateCommand } from "./update-dispatch.js";
import { maskSecrets } from "./log-steps.js";

/** How many bytes to read from the tail of the log when extracting a cause after the updater exits. */
const CAUSE_TAIL_BYTES = 8 * 1024;
/** How many bytes to cap the update.log file at (across all runs). */
export const UPDATE_LOG_FILE_CAP = 400 * 1024;

/**
 * Path of the update log file (mode 0600; raw updater output is written directly — secrets are
 * masked only when extracting the short cause shown in chat; the file itself is owner-readable only).
 */
export function updateLogPath(dataDir: string): string {
  return join(dataDir, "update.log");
}

/**
 * Extract a short human-readable cause from raw updater output.
 * Prefers the last `npm ERR!`/`npm error` summary line or the last `✗` line.
 * Falls back to the last non-blank line. Masks secrets and caps at ~300 chars.
 */
export function extractUpdateCause(output: string): string | null {
  // Lines starting with --- are log headers, not updater output.
  const lines = output.split("\n").map(l => l.trimEnd()).filter(l => Boolean(l) && !l.startsWith("---"));
  if (!lines.length) return null;
  // npm ERR! ends with !, a non-word char: \b does not anchor here. Use (?:\s|$) instead.
  const npmErrRe = /^npm (ERR!|error)(?:\s|$)/i;
  const npmLines = lines.filter(l => npmErrRe.test(l));
  if (npmLines.length) {
    // npm 10 always ends with "A complete log of this run can be found in: …". Skip that footer.
    // Prefer the first `npm error code` line plus the next for context.
    const codeIdx = npmLines.findIndex(l => /^npm (ERR!|error) code\s/i.test(l));
    if (codeIdx >= 0) {
      const summary = [npmLines[codeIdx], npmLines[codeIdx + 1]].filter(Boolean).join(" — ");
      return maskSecrets(summary).slice(0, 300);
    }
    const meaningful = npmLines.filter(l => !/A complete log of this run can be found in/i.test(l));
    const pick = meaningful.length ? meaningful[meaningful.length - 1] : npmLines[npmLines.length - 1];
    return maskSecrets(pick).slice(0, 300);
  }
  const cross = lines.filter(l => /^\s*[✗✕×✘]/.test(l));
  if (cross.length) return maskSecrets(cross[cross.length - 1]).slice(0, 300);
  return maskSecrets(lines[lines.length - 1]).slice(0, 300);
}

/**
 * Rotate the log file if needed, write a run header, and return an open file descriptor
 * for the child process to write to directly — not a pipe.
 *
 * Using an fd instead of a pipe means the updater can keep writing after the fleet process
 * that spawned it has been stopped: there is no read end to close, so no EPIPE.
 * The caller must closeSync(fd) after spawn so the parent's copy of the fd is released.
 *
 * Returns `null` when the log file cannot be opened (dataDir unwritable, disk full, etc.).
 * In that case the caller should fall back to `stdio: "ignore"` and omit the log note.
 */
export function openUpdateLog(logPath: string, header: string): { fd: number; offset: number } | null {
  // Rotate BEFORE opening the fd the child will use (never write to the same inode concurrently).
  try {
    if (existsSync(logPath) && statSync(logPath).size > UPDATE_LOG_FILE_CAP / 2) {
      const old = readFileSync(logPath);
      writeFileSync(logPath, old.subarray(Math.max(0, old.length - UPDATE_LOG_FILE_CAP / 2)));
    }
  } catch { /* best-effort */ }
  try {
    appendFileSync(logPath, `${header}\n`, { mode: 0o600 });
  } catch { /* best-effort */ }
  let fd: number;
  try {
    fd = openSync(logPath, "a", 0o600);
  } catch {
    return null; // caller falls back to stdio: "ignore" and no log note
  }
  // fchmod: mode param of openSync only applies to new files; existing files keep their mode.
  try { fchmodSync(fd, 0o600); } catch { /* best-effort */ }
  // Record the offset so readRunCause only reads this run's output, not previous runs.
  const offset = (() => { try { return statSync(logPath).size; } catch { return 0; } })();
  return { fd, offset };
}

/**
 * Read only this run's output from the log (from `offset`) and extract a cause.
 * Prevents a run with no output from picking up the previous run's error as the cause.
 */
function readRunCause(logPath: string, offset: number): string | null {
  try {
    const buf = readFileSync(logPath);
    const runBytes = buf.subarray(offset);
    const tail = runBytes.subarray(Math.max(0, runBytes.length - CAUSE_TAIL_BYTES)).toString("utf8");
    return extractUpdateCause(tail);
  } catch { return null; }
}

export interface UpdateLaunchDeps {
  platform: string;
  cgroup(): Promise<string>;
  version(): Promise<string | null>;
  nonce(): string;
}

export const defaultUpdateLaunchDeps: UpdateLaunchDeps = {
  platform: process.platform,
  cgroup: async () => {
    const started = performance.now();
    const result = await readFile("/proc/self/cgroup", { encoding: "utf8", signal: AbortSignal.timeout(2000) });
    if (performance.now() - started >= 2000) throw Error("cgroup read deadline");
    return result;
  },
  version: async () => {
    const started = performance.now();
    try {
      const { stdout } = await promisify(execFile)("systemd-run", ["--version"], {
        encoding: "utf8", timeout: 2000, maxBuffer: 64 * 1024,
      });
      return performance.now() - started < 2000 ? stdout : null;
    } catch { return null; }
  },
  nonce: () => randomBytes(16).toString("hex"),
};

/** Unknown is not proof that a detached child can escape a service's KillMode. */
export function inServiceCgroup(text: string): boolean | null {
  if (!text || text.length > 64 * 1024 || text.includes("\0")) return null;
  const rows = text.trimEnd().split("\n");
  let service = false;
  for (const row of rows) {
    const parsed = /^(\d+):([^:]*):(\/[^\r\n]*)$/.exec(row);
    if (!parsed || parsed[3].split("/").some(part => part === "." || part === "..")) return null;
    // user@UID.service is the user manager itself, not a fleet stop boundary.
    service ||= parsed[3].split("/").some(part => part.endsWith(".service") && !/^user@\d+\.service$/.test(part));
  }
  return service;
}

export type UpdateLaunch = { ok: true; command: string; args: string[]; scope?: string }
  | { ok: false; reason: string };

/** Same UID, no privileged or remote manager, no credentials in argv. No unsafe detached fallback. */
export async function resolveUpdateLaunch(agend: string, deps: UpdateLaunchDeps = defaultUpdateLaunchDeps): Promise<UpdateLaunch> {
  const plain = updateCommand(agend);
  if (deps.platform !== "linux") return { ok: true, ...plain };
  let before: string;
  try { before = await deps.cgroup(); }
  catch { return { ok: false, reason: "cannot read the fleet's service cgroup" }; }
  const service = inServiceCgroup(before);
  if (service === null) return { ok: false, reason: "cannot identify the fleet's service cgroup" };
  if (!service) return { ok: true, ...plain };
  let version: string | null;
  try { version = await deps.version(); } catch { version = null; }
  const major = /^systemd (\d+)\b/.exec(version ?? "")?.[1];
  if (!major || Number(major) < 240) return { ok: false, reason: "cannot verify a supported systemd-run for an independent updater scope" };
  // v254 introduced --expand-environment. Older scope implementations pass argv literally.
  // Newer versions must explicitly disable expansion: both "$1" and the installed path are data.
  const expansion = Number(major) >= 254 ? ["--expand-environment=no"] : [];
  const nonce = deps.nonce();
  if (!/^[a-f0-9]{32}$/.test(nonce)) return { ok: false, reason: "cannot allocate an updater scope identity" };
  try {
    if (await deps.cgroup() !== before) return { ok: false, reason: "the fleet's service cgroup changed during update preparation" };
  } catch { return { ok: false, reason: "cannot recheck the fleet's service cgroup" }; }
  const scope = `agend-updater-${nonce}.scope`;
  return { ok: true, command: "systemd-run", scope, args: [
    "--user", "--scope", "--quiet", "--collect", "--no-ask-password", `--unit=${scope}`,
    ...expansion, "--", plain.command, ...plain.args,
  ] };
}

/** Spawn/manager refusal and nonzero updater exit are visible; exit 75 is the existing pending hand-off. */
export function watchUpdateLaunch(
  child: Pick<ChildProcess, "once">,
  fail: (message: string) => void,
  logPath?: string,
  /** Byte offset into the log file at which this run's output begins. */
  logOffset?: number,
): void {
  let reported = false;

  const report = (reason: string) => {
    if (reported) return;
    reported = true;
    const cause = logPath != null && logOffset != null ? readRunCause(logPath, logOffset) : null;
    const logNote = logPath ? ` Full log: ${logPath}.` : "";
    const detail = cause ? ` Cause: ${cause}.${logNote}` : logNote;
    fail(`/update could not complete (${reason}).${detail} Run \`agend update\` from a host shell.`);
  };

  child.once("error", () => report("updater launch failed"));
  child.once("exit", (code, signal) => {
    if (signal || (code !== 0 && code !== 75)) {
      report(signal ? "updater was interrupted" : `updater exited ${code ?? "without a status"}`);
    }
  });
}
