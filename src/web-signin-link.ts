/**
 * What `agend web` shows and opens (#3270). Kept out of cli.ts so it can be tested without running the command.
 *
 * Two addresses are made from one code:
 *   - `display`: the clean sign-in page, printed to the terminal — no code in it, safe to copy, paste or log;
 *   - `open`: the same page with `#code=XXXX-XXXX`, which the browser reaches by way of a launch file, never by a
 *     command line. A URL fragment stays in the browser: it is not sent to the server, not logged, not put in a Referer,
 *     and the sign-in page removes it from the address bar before it does anything else (src/ui/shared/signin.js).
 *
 * The launch file is the Jupyter pattern: the opener (`xdg-open`, `open`, `explorer`) is handed the path of a `0600` HTML
 * file in the AgEnD home, and the file's page sends the browser on to `open`. A URL given to the opener is its argv, which
 * other users of the machine can read for as long as the process lives (`/proc/<pid>/cmdline`, `ps`) — and one of them is on
 * loopback too, so reading it is enough to redeem the code first. The file is deleted two minutes later by a detached
 * helper (so the command can exit at once), and any a crash left behind is swept at the next run.
 *
 * What the terminal always carries too — on every launch, not only on WSL or a headless machine — is the clean address and the
 * code, with one line saying what to do if the page does not open. A browser installed as a Snap or Flatpak (Ubuntu's default
 * Firefox is a snap) cannot read a file under a hidden directory of the home folder, and shows an error page for the launch file:
 * the person then opens the printed address and types the printed code, as they did before this existed.
 */
import { spawn } from "./child-process.js";
import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { isWsl } from "./wsl-detect.js";

export { isWsl };

export interface WebSigninLinks {
  readonly display: string;
  readonly open: string;
}

export function webSigninLinks(port: number, code: string, nextTarget?: string): WebSigninLinks {
  const display = `http://localhost:${port}/signin${nextTarget ? `?next=${encodeURIComponent(nextTarget)}` : ""}`;
  return { display, open: `${display}#code=${encodeURIComponent(code)}` };
}

/** "valid ~5 min" / "valid ~60 min": the longest a code lives is the first-install hour. */
export function describeCodeLifetime(ms: number): string {
  return `~${Math.max(1, Math.round(ms / 60_000))} min`;
}

/**
 * How long the launch file lives: long enough for a browser that is cold-starting on a slow machine (more than 45 s happens),
 * and still well inside the 5-minute life of the code it carries — a file left that long holds a code that is nearly spent.
 */
export const SIGNIN_LAUNCH_FILE_TTL_MS = 120_000;

/** What `agend web` prints after the address and the code whenever it opens a browser: the way on when the page does not open. */
export const SIGNIN_FALLBACK_HINT = "If the page did not open (a Snap or Flatpak browser may not), open the address above in your browser and type the code.";

/**
 * What `agend web` tells `/auth/issue-code` about where the code it gets will be shown (the `X-Agend-Code-Delivery` header).
 * Only a code that is printed to an interactive terminal on a machine that is not WSL may ask for the first-install lifetime
 * (`tty`); a code that goes into a launch-file URL (`url`) or to stdout that is not a terminal — a pipe, a redirect, an
 * install script's log (`non-tty`) — keeps the ordinary 5 minutes, because a long-lived code must never end up in a log or in
 * browser history. On WSL nothing is asked for: the server refuses the long lifetime there anyway.
 */
export type CodeDelivery = "tty" | "url" | "non-tty";
export function codeDeliveryFor(opts: { printOnly: boolean; stdoutIsTty: boolean; wsl: boolean }): CodeDelivery | undefined {
  if (!opts.printOnly) return opts.wsl ? undefined : "url";      // the browser is opened: through a launch file, or (WSL) on the clean address
  if (opts.wsl) return undefined;
  return opts.stdoutIsTty ? "tty" : "non-tty";
}
const LAUNCH_PREFIX = "agend-signin-";
const LAUNCH_SUFFIX = ".html";

/** The page the launch file holds: sends the browser on to `target` (a script, and a meta refresh for a browser that blocks it). */
export function signinLaunchHtml(target: string): string {
  const attr = target.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const script = JSON.stringify(target).replace(/</g, "\\u003c");
  return `<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0;url=${attr}">\n<title>AgEnD</title>\n<script>location.replace(${script});</script>\n`;
}

/** Write the launch file (mode 0600, in a 0700 directory of its own under the AgEnD home) and return its path. */
export function writeSigninLaunchFile(homeDir: string, target: string): string {
  const dir = join(homeDir, "signin-launch");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best effort: an existing directory we do not own */ }
  const path = join(dir, `${LAUNCH_PREFIX}${randomBytes(12).toString("hex")}${LAUNCH_SUFFIX}`);
  writeFileSync(path, signinLaunchHtml(target), { mode: 0o600, flag: "wx" });
  return path;
}

/** Delete launch files older than `maxAgeMs` — what a crashed or killed run left behind. Never throws. */
export function sweepSigninLaunchFiles(homeDir: string, now: number, maxAgeMs = SIGNIN_LAUNCH_FILE_TTL_MS): number {
  const dir = join(homeDir, "signin-launch");
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(LAUNCH_PREFIX) || !name.endsWith(LAUNCH_SUFFIX)) continue;
      const file = join(dir, name);
      try { if (now - statSync(file).mtimeMs >= maxAgeMs) { unlinkSync(file); removed++; } } catch { /* gone already */ }
    }
  } catch { /* no directory yet */ }
  return removed;
}

/**
 * Delete `path` after `delayMs`, from a detached helper process, so `agend web` can exit at once and the file is still
 * removed. Best effort: if the helper cannot start, the next run's sweep removes it.
 */
export function scheduleSigninLaunchCleanup(path: string, delayMs = SIGNIN_LAUNCH_FILE_TTL_MS): void {
  try {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{try{require('fs').unlinkSync(process.argv[1])}catch{}},Number(process.argv[2]))", path, String(delayMs)],
      { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => { /* swept by the next run */ });
    child.unref();
  } catch { /* swept by the next run */ }
}

// `isWsl` (./wsl-detect.ts, re-exported above): on WSL the opener hands a Linux path to a Windows browser (interop, `wslview`)
// whose command line the Windows user's processes can read and which may not see a file in the distro at all. There `agend web`
// opens the clean address and the person types the code.

/** What the opener is given for the launch file: Windows' `explorer` takes the path, the others take a file:// URL. */
export function launchFileArgument(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? path : pathToFileURL(path).href;
}
