/** Chat updates must survive the fleet's service cgroup being stopped (#1490 row 37). */
import { execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { updateCommand } from "./update-dispatch.js";
import { maskSecrets } from "./log-steps.js";

/** How many bytes of masked updater output to keep per run (older lines are rotated out). */
export const UPDATE_LOG_MAX_BYTES = 200 * 1024;
/** How many bytes to cap the update.log file at (across all runs). */
export const UPDATE_LOG_FILE_CAP = 400 * 1024;

/** Path of the update log file. */
export function updateLogPath(dataDir: string): string {
  return join(dataDir, "update.log");
}

/**
 * Extract a short human-readable cause from raw updater output.
 * Prefers the last `npm ERR!`/`npm error` summary line or the last `✗` line.
 * Falls back to the last non-blank line. Masks secrets and caps at ~300 chars.
 */
export function extractUpdateCause(output: string): string | null {
  const lines = output.split("\n").map(l => l.trimEnd()).filter(Boolean);
  if (!lines.length) return null;
  const npmErr = lines.filter(l => /^npm (ERR!|error)\b/i.test(l));
  if (npmErr.length) return maskSecrets(npmErr[npmErr.length - 1]).slice(0, 300);
  const cross = lines.filter(l => /^\s*[✗✕×✘]/.test(l));
  if (cross.length) return maskSecrets(cross[cross.length - 1]).slice(0, 300);
  return maskSecrets(lines[lines.length - 1]).slice(0, 300);
}

/**
 * Write a run header + masked output to the update log, rotating if the file exceeds UPDATE_LOG_FILE_CAP.
 */
export function appendUpdateLog(logPath: string, header: string, output: string): void {
  const masked = maskSecrets(output);
  // Ensure total log stays under cap: if it would exceed, truncate to half the cap first.
  try {
    if (existsSync(logPath) && statSync(logPath).size > UPDATE_LOG_FILE_CAP - masked.length - header.length) {
      const old = readFileSync(logPath, "utf8");
      const kept = old.slice(Math.max(0, old.length - UPDATE_LOG_FILE_CAP / 2));
      writeFileSync(logPath, kept, { mode: 0o600 });
    }
  } catch { /* best-effort */ }
  try {
    appendFileSync(logPath, `${header}\n${masked}\n\n`, { mode: 0o600 });
  } catch { /* best-effort */ }
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
  child: Pick<ChildProcess, "once" | "stdout" | "stderr">,
  fail: (message: string) => void,
  logPath?: string,
): void {
  let reported = false;
  let outputChunks: Buffer[] = [];
  let outputBytes = 0;

  const onData = (chunk: Buffer | string) => {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const space = UPDATE_LOG_MAX_BYTES - outputBytes;
    if (space > 0) {
      outputChunks.push(space < buf.length ? buf.subarray(0, space) : buf);
      outputBytes += Math.min(buf.length, space);
    }
  };
  if (child.stdout) child.stdout.on("data", onData);
  if (child.stderr) child.stderr.on("data", onData);

  const report = (reason: string) => {
    if (reported) return;
    reported = true;
    const raw = Buffer.concat(outputChunks).toString("utf8");
    const cause = extractUpdateCause(raw);
    const logNote = logPath ? ` Full log: ${logPath}.` : "";
    const detail = cause ? ` Cause: ${cause}.${logNote}` : logNote;
    fail(`/update could not complete (${reason}).${detail} Run \`agend update\` from a host shell.`);
  };

  child.once("error", () => {
    if (logPath) appendUpdateLog(logPath, `--- updater launch error ---`, Buffer.concat(outputChunks).toString("utf8"));
    report("updater launch failed");
  });
  child.once("exit", (code, signal) => {
    const raw = Buffer.concat(outputChunks).toString("utf8");
    if (logPath && (signal || (code !== 0 && code !== 75))) {
      appendUpdateLog(logPath, `--- updater exit code=${code ?? "null"} signal=${signal ?? "null"} ---`, raw);
    }
    if (signal || (code !== 0 && code !== 75)) {
      report(signal ? "updater was interrupted" : `updater exited ${code ?? "without a status"}`);
    }
  });
}
