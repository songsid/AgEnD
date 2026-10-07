import { execFile } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** argv-only discovery; bounded child execution never blocks the fleet loop. */
export function discoveryOutput(binary: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { encoding: "utf8", timeout, killSignal: "SIGKILL", maxBuffer: 128 * 1024 },
      (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}

export async function executableFile(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return (await stat(path)).isFile(); }
  catch { return false; }
}

export async function checkBinaryInstalledAsync(binary: string): Promise<boolean> {
  try { await discoveryOutput("which", [binary], 2000); return true; } catch { return false; }
}

export async function resolveBinaryAsync(name: string, fallbackDirs?: readonly string[]): Promise<string> {
  try {
    const resolved = (await discoveryOutput("which", [name], 2000)).trim();
    if (resolved) return resolved;
  } catch { /* same ordered absolute fallback as resolveBinary */ }
  let dirs = fallbackDirs;
  if (!dirs) {
    const common = [dirname(process.execPath), join(homedir(), ".local", "bin"),
      join(homedir(), ".npm-global", "bin"), "/usr/local/bin", "/usr/bin", "/bin"];
    try {
      for (const version of (await readdir(join(homedir(), ".nvm", "versions", "node"))).sort().reverse()) {
        common.push(join(homedir(), ".nvm", "versions", "node", version, "bin"));
      }
    } catch { /* optional nvm */ }
    try {
      const prefix = (await discoveryOutput("npm", ["prefix", "-g"], 3000)).trim();
      if (prefix) common.push(join(prefix, "bin"));
    } catch { /* optional npm */ }
    dirs = [...new Set(common)];
  }
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (await executableFile(candidate)) return candidate;
  }
  return name;
}
