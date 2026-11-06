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
 * loopback too, so reading it is enough to redeem the code first. The file is deleted a few seconds later by a detached
 * helper (so the command can exit at once), and any a crash left behind is swept at the next run.
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

export interface WebSigninLinks {
  readonly display: string;
  readonly open: string;
}

export function webSigninLinks(port: number, code: string, nextTarget?: string): WebSigninLinks {
  const display = `http://localhost:${port}/signin${nextTarget ? `?next=${encodeURIComponent(nextTarget)}` : ""}`;
  return { display, open: `${display}#code=${encodeURIComponent(code)}` };
}

/** "valid ~5 min" / "valid ~24 h": a first-install code lasts a day, and "~1440 min" reads as a typo. */
export function describeCodeLifetime(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) return `~${minutes} min`;
  return `~${Math.round(minutes / 60)} h`;
}

/** How long the launch file lives: long enough for a browser that is still starting, short enough to be gone when it matters. */
export const SIGNIN_LAUNCH_FILE_TTL_MS = 15_000;
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
      { detached: true, stdio: "ignore" });
    child.on("error", () => { /* swept by the next run */ });
    child.unref();
  } catch { /* swept by the next run */ }
}

/**
 * Whether this is WSL, where the opener hands a Linux path to a Windows browser (interop, `wslview`) whose command line the
 * Windows user's processes can read and which may not see a file in the distro at all. There `agend web` opens the clean
 * address and the person types the code.
 */
export function isWsl(env: NodeJS.ProcessEnv = process.env, readVersion: () => string = () => readFileSync("/proc/version", "utf8")): boolean {
  if (env.AGEND_WSL === "0") return false;                               // tests, and a machine the detection gets wrong
  if (env.AGEND_WSL === "1" || env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try { return /microsoft|wsl/i.test(readVersion()); } catch { return false; }
}

/** What the opener is given for the launch file: Windows' `explorer` takes the path, the others take a file:// URL. */
export function launchFileArgument(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? path : pathToFileURL(path).href;
}
