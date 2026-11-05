/** Read-only OS incarnation proof. A failed query is unknown, never evidence that a process exited. */
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { join } from "node:path";
import { execFile } from "./child-process.js";
import { nativeCliEnvironment } from "./windows-cli-worker.js";
export function paneSystemBootId(ticks: string): string {
  if (ticks.trim() !== ticks || !/^\d{17,20}$/.test(ticks)) throw Error("Windows boot identity is unconfirmed");
  return createHash("sha256").update("agend-windows-boot-v1:" + ticks).digest("hex");
}
export async function readPaneSystemBootId(): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  try {
    const script = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::Write((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks)";
    const result = await promisify(execFile)(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { timeout: 30_000, maxBuffer: 4096, windowsHide: true, env: nativeCliEnvironment() });
    return paneSystemBootId(result.stdout.trim());
  } catch { return undefined; }
}
/** Command line of a process, read-only; unknown (undefined) when it cannot be read, which is never evidence either way. */
export async function readProcessCommandLine(pid: number): Promise<string | undefined> {
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::Write((Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine)`;
    const result = await promisify(execFile)(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { timeout: 30_000, maxBuffer: 65_536, windowsHide: true, env: nativeCliEnvironment() });
    return result.stdout.trim() || undefined;
  } catch { return undefined; }
}
/**
 * The profile lock's PID when a readable command line shows it is no Runtime (Windows reuses PIDs after a restart), else undefined.
 * A Runtime that is really running, or one whose command line cannot be read, is never reported, so it keeps its lock.
 */
export async function reusedRuntimeLockPid(holder: number | undefined, readCommandLine: (pid: number) => Promise<string | undefined> = readProcessCommandLine): Promise<number | undefined> {
  if (holder === undefined || holder === process.pid) return undefined;
  const line = await readCommandLine(holder);
  return line !== undefined && !/runtime-cli/i.test(line) ? holder : undefined;
}
