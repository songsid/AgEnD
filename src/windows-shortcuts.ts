/**
 * #1853: `agend shortcuts` — create or refresh the two Windows desktop shortcuts ("AgEnD 儀表板", "AgEnD 重新啟動") from
 * inside WSL, for people who installed before the installer made them, or who only run `agend update`.
 *
 * It runs the installer's own shortcut code (templates/windows-shortcuts.ps1, kept byte-identical to the installer's) in
 * Windows PowerShell through WSL interop, for this Linux (WSL_DISTRO_NAME) and this user. Interop off is said plainly,
 * with the other way: re-running the one-liner on Windows, which on an existing install only offers the shortcuts.
 *
 * After `agend update` in a WSL terminal without the shortcuts, one line says how to make them, once. Nothing here ever
 * makes a desktop item unasked.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { t } from "./locale.js";

/** Written in the data dir once the shortcuts exist (by this command or by the installer). */
export const SHORTCUTS_MARKER = "windows-shortcuts";
/** Written once the update hint has been shown. */
export const SHORTCUTS_HINT_MARKER = "windows-shortcuts-hint";
const MADE_LINE = /^AGEND_SHORTCUTS_MADE=(\d+)\s*$/m;
const SYSTEM_POWERSHELL = "Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

export interface ShortcutsHost {
  env: NodeJS.ProcessEnv;
  /** /proc/sys/kernel/osrelease, or null. */
  osRelease: string | null;
  /** Entries of /proc/sys/fs/binfmt_misc, or null when it can't be read. */
  binfmt: string[] | null;
  exists: (path: string) => boolean;
}

export function realHost(): ShortcutsHost {
  const read = (path: string) => { try { return readFileSync(path, "utf-8"); } catch { return null; } };
  let binfmt: string[] | null = null;
  try { binfmt = readdirSync("/proc/sys/fs/binfmt_misc"); } catch { /* not mounted: unknown */ }
  return { env: process.env, osRelease: read("/proc/sys/kernel/osrelease"), binfmt, exists: existsSync };
}

/** Inside WSL? WSL sets WSL_DISTRO_NAME in the shells it starts; its kernel's release names Microsoft. */
export function detectWsl(host: ShortcutsHost): { wsl: boolean; distro: string | null } {
  const distro = host.env.WSL_DISTRO_NAME?.trim() || null;
  return { wsl: distro !== null || /microsoft/i.test(host.osRelease ?? ""), distro };
}

/**
 * Can this WSL start a Windows program? Interop is a binfmt_misc entry (WSLInterop, or WSLInterop-late under systemd).
 * Without it, running powershell.exe does not fail: the exec falls back to /bin/sh, which reads the .exe as a script.
 * An unreadable binfmt_misc is unknown, and the run's own output decides.
 */
export function interopState(host: ShortcutsHost): "on" | "off" | "unknown" {
  if (host.binfmt === null) return "unknown";
  return host.binfmt.some(name => /^WSLInterop/.test(name)) ? "on" : "off";
}

/** Windows PowerShell: on PATH (interop appends Windows' PATH), else where Windows keeps it on a mounted drive. */
export function findPowershell(host: ShortcutsHost): string | null {
  for (const dir of (host.env.PATH ?? "").split(delimiter)) {
    if (dir && host.exists(join(dir, "powershell.exe"))) return join(dir, "powershell.exe");
  }
  for (const drive of ["c", "d", "e"]) {
    const path = `/mnt/${drive}/${SYSTEM_POWERSHELL}`;
    if (host.exists(path)) return path;
  }
  return null;
}

/** The installer's shortcut code: the template below its header (which ends at the first blank line). */
export function sharedShortcutsPs(templateText?: string): string {
  const text = templateText ?? readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "windows-shortcuts.ps1"), "utf-8");
  return text.slice(text.indexOf("\n\n") + 2);
}

const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** The whole script Windows PowerShell runs: the shared code, then both shortcuts for this Linux and user. */
export function buildShortcutsScript(shared: string, distro: string, user: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$script:OnWindows = $true",
    shared,
    `$made = @(Install-AgendShortcuts ${psQuote(distro)} ${psQuote(user)})`,
    "Write-Output ('AGEND_SHORTCUTS_MADE=' + $made.Count)",
    "",
  ].join("\n");
}

/** -EncodedCommand takes UTF-16LE in base64: no quoting, and the Chinese names arrive intact. */
export function encodePowershell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function powershellArgs(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePowershell(script)];
}

export interface RunResult { status: number | null; stdout: string; stderr: string; error?: Error }

export interface ShortcutsDeps {
  host: ShortcutsHost;
  user: string;
  dataDir: string;
  shared: () => string;
  run: (command: string, args: string[]) => RunResult;
  writeMarker: (path: string, content: string) => void;
  log: (line: string) => void;
  now: () => Date;
}

/** `agend shortcuts`. Returns the exit code. */
export function runShortcuts(deps: ShortcutsDeps): number {
  const { wsl, distro } = detectWsl(deps.host);
  if (!wsl) { deps.log(t("shortcuts.not_wsl")); return 1; }
  if (!distro) { deps.log(t("shortcuts.no_distro")); return 1; }
  const powershell = findPowershell(deps.host);
  if (interopState(deps.host) === "off" || !powershell) { deps.log(t("shortcuts.no_interop")); return 1; }
  deps.log(t("shortcuts.making", distro, deps.user));
  const result = deps.run(powershell, powershellArgs(buildShortcutsScript(deps.shared(), distro, deps.user)));
  const made = MADE_LINE.exec(result.stdout ?? "");
  if (!made) {
    // No answer from the script: Windows was never reached (interop) or PowerShell failed before it ran.
    deps.log(t("shortcuts.no_interop"));
    const detail = (result.error?.message ?? (result.stderr || "")).trim();
    if (detail) deps.log(`  ${detail.split("\n").slice(0, 3).join("\n  ")}`);
    return 1;
  }
  if (Number(made[1]) < 2) { deps.log(t("shortcuts.failed")); return 1; }
  try { deps.writeMarker(join(deps.dataDir, SHORTCUTS_MARKER), deps.now().toISOString() + "\n"); } catch { /* the hint may show once more */ }
  deps.log(t("shortcuts.done"));
  return 0;
}

export function realShortcutsDeps(dataDir: string, user: string, run: ShortcutsDeps["run"]): ShortcutsDeps {
  return {
    host: realHost(), user, dataDir, run,
    shared: () => sharedShortcutsPs(),
    writeMarker: (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); },
    log: line => console.log(line),
    now: () => new Date(),
  };
}

/**
 * The one-time line after `agend update`: only in a terminal (a chat /update's log has no reader), only in WSL, only
 * while the shortcuts were never made, and only once. Returns the line, or null. "Once" is claimed by creating the
 * hint marker exclusively (`write` must fail with EEXIST when it exists): two updates in two terminals at the same
 * moment show it once between them (#2260 review). Any other write failure still shows it (it may show again).
 */
export function shortcutsHintOnce(o: { host: ShortcutsHost; dataDir: string; tty: boolean; write: (path: string, content: string) => void }): string | null {
  if (!o.tty || !detectWsl(o.host).wsl) return null;
  if (o.host.exists(join(o.dataDir, SHORTCUTS_MARKER)) || o.host.exists(join(o.dataDir, SHORTCUTS_HINT_MARKER))) return null;
  try { o.write(join(o.dataDir, SHORTCUTS_HINT_MARKER), new Date().toISOString() + "\n"); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "EEXIST") return null; /* otherwise: shown, and may show again */ }
  return t("shortcuts.hint");
}

/** After `agend update`: print the one-time line, if it is due (#1853). */
export function printUpdateShortcutsHint(dataDir: string): void {
  const line = shortcutsHintOnce({ host: realHost(), dataDir, tty: !!process.stdout.isTTY, write: (path, content) => writeFileSync(path, content, { flag: "wx" }) });
  if (line) console.log(`  ${line}\n`);
}
