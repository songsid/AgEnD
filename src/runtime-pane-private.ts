/** Private local pane-host discovery. Never contains a provider or machine credential. */
import { chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "./child-process.js";
import { atomicWriteFileSync } from "./atomic-write.js";
import { nativeCliEnvironment } from "./windows-cli-worker.js";
export interface PaneHostDescriptor { version: 1; scope: string; hostBootId: string; pid: number; port: number; token: string }
export async function protectPaneDirectory(directory: string): Promise<void> {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()) throw Error("Pane host directory is not owned");
  if (process.platform === "win32") await promisify(execFile)(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./runtime-pane-private.ps1", import.meta.url)), "-Directory", directory,
  ], { env: nativeCliEnvironment(), windowsHide: true, timeout: 30_000, maxBuffer: 4096 });
  else chmodSync(directory, 0o700);
}
export function readPaneHostDescriptor(directory: string, scope: string): PaneHostDescriptor | null {
  const path = join(directory, "host.json");
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077)) throw Error("Pane host descriptor is not private");
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value?.version !== 1 || value.scope !== scope || !/^[a-f0-9-]{36}$/i.test(value.hostBootId)
      || !Number.isSafeInteger(value.pid) || value.pid < 1 || !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535
      || typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token)) throw Error("Pane host descriptor scope is invalid");
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export function savePaneHostDescriptor(directory: string, value: PaneHostDescriptor): void {
  atomicWriteFileSync(join(directory, "host.json"), JSON.stringify(value), { mode: 0o600 });
}
