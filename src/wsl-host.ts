/**
 * What this Linux can say about reaching Windows from it: is it WSL, is interop on, where is Windows PowerShell.
 *
 * Shared by `agend shortcuts` (windows-shortcuts.ts) and the local Windows CLI bridge (windows-cli.ts). No locale or UI
 * imports: the standalone Runtime loads the bridge too. Every question takes the host as a value, so each branch of
 * "why can't PowerShell be started" is testable without a WSL.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface WslHost {
  env: NodeJS.ProcessEnv;
  /** /proc/sys/kernel/osrelease, or null. */
  osRelease: string | null;
  /** Entries of /proc/sys/fs/binfmt_misc, or null when it can't be read. */
  binfmt: string[] | null;
  exists: (path: string) => boolean;
}

export function realHost(): WslHost {
  const read = (path: string) => { try { return readFileSync(path, "utf-8"); } catch { return null; } };
  let binfmt: string[] | null = null;
  try { binfmt = readdirSync("/proc/sys/fs/binfmt_misc"); } catch { /* not mounted: unknown */ }
  return { env: process.env, osRelease: read("/proc/sys/kernel/osrelease"), binfmt, exists: existsSync };
}

/** Inside WSL? WSL sets WSL_DISTRO_NAME in the shells it starts; its kernel's release names Microsoft. */
export function detectWsl(host: WslHost): { wsl: boolean; distro: string | null } {
  const distro = host.env.WSL_DISTRO_NAME?.trim() || null;
  return { wsl: distro !== null || /microsoft/i.test(host.osRelease ?? ""), distro };
}

/**
 * Can this WSL start a Windows program? Interop is a binfmt_misc entry (WSLInterop, or WSLInterop-late under systemd).
 * Without it, running powershell.exe does not fail: the exec falls back to /bin/sh, which reads the .exe as a script.
 * An unreadable binfmt_misc is unknown, and the run's own output decides.
 */
export function interopState(host: WslHost): "on" | "off" | "unknown" {
  if (host.binfmt === null) return "unknown";
  return host.binfmt.some(name => /^WSLInterop/.test(name)) ? "on" : "off";
}

/** Where Windows keeps its PowerShell, under a mounted drive. WSL's own PATH spells the folder `windows`; drvfs ignores case, a case-sensitive mount does not. */
const SYSTEM_POWERSHELL_DIRS = ["Windows", "windows", "WINDOWS"].map(dir => `${dir}/System32/WindowsPowerShell/v1.0/powershell.exe`);

/**
 * Windows PowerShell for `agend shortcuts` (a one-off CLI): on PATH (interop appends Windows' PATH), else where Windows
 * keeps it on a mounted drive — `drives`, c, d and e by default. The daemon's bridge (windowsReach) looks the other way
 * round and under /mnt/c only, since a stat on an offline network drive can hold the event loop for seconds (a drive
 * mounted elsewhere is `wslpath`'s job).
 */
export function findPowershell(host: WslHost, drives: readonly string[] = ["c", "d", "e"]): string | null {
  return powershellOnPath(host) ?? systemPowershell(host, drives);
}
function powershellOnPath(host: WslHost): string | null {
  for (const dir of (host.env.PATH ?? "").split(delimiter)) {
    if (dir && host.exists(join(dir, "powershell.exe"))) return join(dir, "powershell.exe");
  }
  return null;
}
function systemPowershell(host: WslHost, drives: readonly string[]): string | null {
  for (const drive of drives) {
    for (const rel of SYSTEM_POWERSHELL_DIRS) {
      const path = `/mnt/${drive}/${rel}`;
      if (host.exists(path)) return path;
    }
  }
  return null;
}

/**
 * A container (Docker, Podman). Docker Desktop's containers run on WSL2's own kernel, so `osrelease` says Microsoft in them
 * too — but they have no WSL_DISTRO_NAME, no /mnt/c and no interop, and "turn interop on" would be the wrong advice there.
 * Only a hint for the wording: a WSL distro made by `docker export | wsl --import` carries a /.dockerenv too, and a daemon
 * started by systemd, ssh or a schedule often has no WSL_DISTRO_NAME — so it never decides alone (see windowsReach).
 */
export function inContainer(host: WslHost): boolean {
  return host.exists("/.dockerenv") || host.exists("/run/.containerenv");
}

/** Why a local Windows process can't be started from this host (the first thing that is wrong). */
export type WindowsReachProblem = "not-wsl" | "interop-off" | "powershell-missing";

/**
 * Whether this Linux can start Windows PowerShell, decided before anything is spawned. `powershell` is the path found
 * (/mnt/c's system folder, then PATH; `viaWslpath` is a path that `wslpath` gave for a drive mounted elsewhere), or null.
 * The daemon asks on every launch and each stat is synchronous on its event loop: the usual place first is one stat,
 * and Windows' PATH (often dozens of folders) is scanned only when it isn't there. `agend shortcuts` keeps PATH first.
 *
 * Interop that is not off (on, or unreadable) plus a PowerShell found is always a go. A container is named only when
 * neither holds — interop not seen on AND no PowerShell — where "not WSL" is the truer advice than "turn interop on".
 */
export function windowsReach(host: WslHost, viaWslpath: string | null = null): { ok: true; powershell: string } | { ok: false; problem: WindowsReachProblem } {
  const { wsl, distro } = detectWsl(host);
  if (!wsl) return { ok: false, problem: "not-wsl" };
  const interop = interopState(host);
  const powershell = systemPowershell(host, ["c"]) ?? powershellOnPath(host) ?? (viaWslpath && host.exists(viaWslpath) ? viaWslpath : null);
  if (interop !== "off" && powershell) return { ok: true, powershell };
  if (interop !== "on" && !powershell && !distro && inContainer(host)) return { ok: false, problem: "not-wsl" };
  return { ok: false, problem: interop === "off" ? "interop-off" : "powershell-missing" };
}
