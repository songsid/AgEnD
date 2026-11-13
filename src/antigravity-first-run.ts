/**
 * AGEND-224 (upstream #3330 ruling): the first-run files of a NAMED Antigravity account's folder are GENERATED here, never copied from the default account's `~/.gemini`.
 * AGEND-251 (#3771 review round 2; upstream decision 0a47ab4b): the CONSENT screens are NOT skipped. A new account's first launch shows agy's wizard (welcome, theme, the terms with the "Interactions"
 * data-sharing choice), and it is answered by the interactive first-run handler the upstream review approved (#3779 in main; #3780 for the alpha line): accept the terms, sharing UNTICKED. This file never
 * writes `consumerOnboardingComplete` / `onboardingComplete` (a completion marker would skip the very screen where sharing is switched off, and would claim a consent that nobody gave), and it never infers
 * that sharing is off from any flag in a folder. The default account and a Windows headless launch keep their limits: nothing here sets or proves their state.
 *
 * An allow-list, nothing else is ever written:
 *  - `settings.json`: `statusLine` (what AgEnD itself sets for agy: its own script, enabled) and `trustedWorkspaces` (this instance's own working directory only — the trust AgEnD gives the instance on
 *    its other backends, and what its auto-answer to agy's trust prompt grants; never a list carried over from another account).
 * A file is written only when it is MISSING (`wx`: never overwrites, never follows a link at the target); one the account already has is left exactly as it is. Nothing here reads any file.
 */
import { closeSync, constants, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/** The files, by name relative to the account's folder, as they are written. Pure. */
export function firstRunFiles(workingDirectory: string, statusLineCommand: string): Record<string, unknown> {
  return {
    "settings.json": { statusLine: { command: statusLineCommand, enabled: true }, trustedWorkspaces: [workingDirectory] },
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
