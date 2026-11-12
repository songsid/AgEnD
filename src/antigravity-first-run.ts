/**
 * AGEND-224 (upstream #3330 ruling): the first-run files of a NAMED Antigravity account's folder are GENERATED here, never copied from the default account's `~/.gemini`.
 * Without them agy starts a new folder with its first run (a welcome, a colour scheme, the terms of use, then the workspace-trust question), which an agent in an unattended pane can never answer.
 *
 * An allow-list, nothing else is ever written:
 *  - `settings.json`: `statusLine` (what AgEnD itself sets for agy: its own script, enabled) and `trustedWorkspaces` (this instance's own working directory only — the trust AgEnD gives the instance on
 *    its other backends, and what its auto-answer to agy's trust prompt grants; never a list carried over from another account);
 *  - `cache/onboarding.json`: the known first-run booleans.
 * A file is written only when it is MISSING (`wx`: never overwrites, never follows a link at the target); one the account already has is left exactly as it is. Nothing here reads any file.
 */
import { closeSync, constants, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** The first-run outcome agy records once its welcome, theme and terms are answered (agy 1.5.x `cache/onboarding.json`). */
export const FIRST_RUN_ONBOARDING = Object.freeze({ consumerOnboardingComplete: true, enterpriseOnboardingComplete: false, onboardingComplete: true });

/** The files, by name relative to the account's folder, as they are written. Pure. */
export function firstRunFiles(workingDirectory: string, statusLineCommand: string): Record<string, unknown> {
  return {
    "settings.json": { statusLine: { command: statusLineCommand, enabled: true }, trustedWorkspaces: [workingDirectory] },
    "cache/onboarding.json": { ...FIRST_RUN_ONBOARDING },
  };
}

const plain = (value: string): boolean => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value);

/** Writes the missing ones; returns the names written. A working directory that is not an absolute path writes nothing: a trust entry must name one directory. */
export function seedFirstRun(folder: string, workingDirectory: string, statusLineCommand: string): string[] {
  if (!isAbsolute(workingDirectory) || !plain(workingDirectory) || !plain(statusLineCommand)) return [];
  const written: string[] = [];
  for (const [name, content] of Object.entries(firstRunFiles(workingDirectory, statusLineCommand))) {
    const target = join(folder, name);
    try {
      const parent = dirname(target);
      if (parent !== folder) {
        let st; try { st = lstatSync(parent); } catch { st = null; }
        if (!st) mkdirSync(parent, { recursive: true, mode: 0o700 });
        else if (!st.isDirectory() || st.isSymbolicLink()) continue;   // a link or a file where the folder belongs: not written through
      }
      const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { writeSync(fd, JSON.stringify(content, null, 2) + "\n"); } finally { closeSync(fd); }
      written.push(name);
    } catch { /* it exists already (kept as it is), or cannot be written: the first-run screens are then agy's own */ }
  }
  return written;
}
