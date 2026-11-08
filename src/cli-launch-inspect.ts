/** Read-only executable proof. Called in a bounded worker, never starts a backend CLI. */
import { closeSync, openSync, readSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
export interface CliProcessIdentity {
  pid: number;
  start: string;
  dev: number;
  ino: number;
}
export interface CliLaunchSnapshot {
  chain: CliProcessIdentity[];
  process: CliProcessIdentity & {
    exe: string;
    version: string | null;
    reason: "deleted" | "npm-temporary" | null;
  };
  installed: {
    path: string;
    real: string;
    version: string | null;
    stamp: string;
  } | null;
}
export const CLAUDE_MINIMUM_ERROR = /^[ \t]*(?:●[ \t]+)?API Error:[ \t]*(?:400[ \t]+)?Claude Code[ \t]+(\d+\.\d+\.\d+)[ \t]+does\s+not\s+support\s+this\s+model;[ \t\r\n]*version[ \t]+(\d+\.\d+\.\d+)[ \t]+or\s+newer\s+is\s+required\.?[ \t]*$/im;
export function cliVersionBelow(a: string, b: string): boolean {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++)
    if (x[i] !== y[i])
      return x[i]! < y[i]!;
  return false;
}
export function claudeMinimumError(pane: string): {
  running: string;
  required: string;
} | null {
  const match = [...pane.matchAll(new RegExp(CLAUDE_MINIMUM_ERROR.source, "gim"))].at(-1);
  return match && cliVersionBelow(match[1]!, match[2]!) ? { running: match[1]!, required: match[2]! } : null;
}
export function executableReplacementReason(path: string): "deleted" | "npm-temporary" | null {
  if (path.endsWith(" (deleted)"))
    return "deleted";
  return /(?:^|\/)node_modules\/(?:@[^/]+\/)?\.claude-code-[A-Za-z0-9_-]+(?:\/|$)/.test(path) ? "npm-temporary" : null;
}
const MAX_BYTES = 65536;
function text(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const b = Buffer.alloc(MAX_BYTES + 1), n = readSync(fd, b, 0, b.length, 0);
    return n > MAX_BYTES ? null : b.subarray(0, n).toString("utf8");
  }
  catch {
    return null;
  }
  finally {
    if (fd !== undefined)
      closeSync(fd);
  }
}
function identity(pid: number, proc: string): (CliProcessIdentity & {
  parent: number;
}) | null {
  const stat = text(join(proc, String(pid), "stat"));
  if (!stat)
    return null;
  const end = stat.lastIndexOf(")"), parts = stat.slice(end + 2).trim().split(/\s+/), start = parts[19], parent = Number(parts[1]);
  if (end < 1 || !/^\d+$/.test(start ?? "") || !Number.isSafeInteger(parent))
    return null;
  try {
    const st = statSync(join(proc, String(pid), "exe"));
    return { pid, start: start!, parent, dev: st.dev, ino: st.ino };
  }
  catch {
    return null;
  }
}
function equal(a: CliProcessIdentity, b: CliProcessIdentity): boolean { return a.pid === b.pid && a.start === b.start && a.dev === b.dev && a.ino === b.ino; }
export function sameCliProcess(a: CliLaunchSnapshot, b: CliLaunchSnapshot): boolean {
  return a.chain.length === b.chain.length && a.chain.every((v, i) => equal(v, b.chain[i]!)) && equal(a.process, b.process);
}
function stamp(path: string): string | null {
  try {
    const s = statSync(path);
    return s.isFile() ? `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}` : null;
  } catch {
    return null;
  }
}
function diskVersion(path: string): string | null {
  const parts = path.split("/"), nm = parts.lastIndexOf("node_modules");
  if (nm >= 0) {
    const pkg = parts.slice(0, nm + (parts[nm + 1]?.startsWith("@") ? 3 : 2)).join("/");
    const file = join(pkg, "package.json"), before = stamp(file), raw = text(file);
    if (!raw || !before)
      return null;
    try {
      const p = JSON.parse(raw);
      return p.name === "@anthropic-ai/claude-code" && /^\d+\.\d+\.\d+$/.test(p.version) && before === stamp(file) ? p.version : null;
    }
    catch {
      return null;
    }
  }
  for (let i = parts.length - 1; i > 0; i--)
    if ((parts[i - 1] === "versions" || parts[i - 1] === "releases") && /^\d+\.\d+\.\d+$/.test(parts[i]!))
      return parts[i]!;
  return null;
}
/** Only a stable, non-temporary resolved target is an installed replacement. */
export function inspectInstalledClaude(path: string): CliLaunchSnapshot["installed"] {
  try {
    const real = realpathSync(path);
    if (executableReplacementReason(real))
      return null;
    const before = stamp(real);
    if (!before)
      return null;
    const version = diskVersion(real);
    return real === realpathSync(path) && before === stamp(real) ? { path, real, version, stamp: before } : null;
  }
  catch {
    return null;
  }
}
/** Exact pane root, then at most five single-child shell/env wrappers. Never enumerate other processes. */
export function inspectClaudeLaunch(panePid: number, path: string, proc = "/proc"): CliLaunchSnapshot | null {
  if (!Number.isSafeInteger(panePid) || panePid <= 1)
    return null;
  const chain: CliProcessIdentity[] = [];
  let pid = panePid, parent: number | null = null;
  for (let depth = 0; depth < 6; depth++) {
    const id = identity(pid, proc);
    if (!id || (parent !== null && id.parent !== parent))
      return null;
    let exe: string;
    try {
      exe = readlinkSync(join(proc, String(pid), "exe"));
    }
    catch {
      return null;
    }
    chain.push({ pid: id.pid, start: id.start, dev: id.dev, ino: id.ino });
    const name = basename(exe.replace(/ \(deleted\)$/, ""));
    let script: string | null = null;
    if (/^(?:node|nodejs)$/.test(name)) {
      const argv = text(join(proc, String(pid), "cmdline"))?.split("\0") ?? [];
      if (argv[1] && /(?:^|\/)node_modules\/@anthropic-ai\/(?:claude-code|\.claude-code-[A-Za-z0-9_-]+)\/(?:cli\.js|bin\/claude\.js)$/.test(argv[1]))
        script = argv[1];
    }
    const nativeVersionImage = /\/claude\/versions\/\d+\.\d+\.\d+$/.test(exe.replace(/ \(deleted\)$/, ""));
    if (name === "claude" || name === "claude.exe" || nativeVersionImage || script) {
      const reason = executableReplacementReason(exe) || (script ? executableReplacementReason(script) : null);
      const before = stamp(join(proc, String(pid), "exe"));
      // A replaced JS source cannot be attributed to its old Node process. Do not call its current package version the running version.
      const version = reason || script ? null : diskVersion(exe);
      if (!before || before !== stamp(join(proc, String(pid), "exe")))
        return null;
      for (let i = 0; i < chain.length; i++) {
        const fresh = identity(chain[i]!.pid, proc);
        if (!fresh || !equal(chain[i]!, fresh) || (i > 0 && fresh.parent !== chain[i - 1]!.pid))
          return null;
      }
      return { chain, process: { ...chain.at(-1)!, exe, version, reason }, installed: inspectInstalledClaude(path) };
    }
    if (!["sh", "bash", "dash", "zsh", "fish", "env", "busybox"].includes(name))
      return null;
    const children = text(join(proc, String(pid), "task", String(pid), "children"))?.trim().split(/\s+/).filter(Boolean) ?? [];
    if (children.length !== 1 || !/^\d+$/.test(children[0]!))
      return null;
    parent = pid;
    pid = Number(children[0]);
    if (!Number.isSafeInteger(pid) || pid <= 1)
      return null;
  }
  return null;
}
