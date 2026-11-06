/** Shared installer/supervisor lock. Process observation never sends a termination signal. */
import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "./child-process.js";
import { paneSystemBootId } from "./runtime-pane-boot.js";
import { nativeCliEnvironment } from "./windows-cli-worker.js";

export const RUNTIME_INSTALL_LOCK = ".agend-runtime-install.lock";
export interface RuntimeProcessProof { pid: number; birth: string; boot: string }
export type RuntimeProcessObservation = { state: "alive"; proof: RuntimeProcessProof } | { state: "gone" } | { state: "unknown" };
export interface RuntimeInstallLockRecord extends RuntimeProcessProof { version: 1; type: "installer" | "supervisor"; nonce: string }
export class RuntimeInstallLockError extends Error { constructor(readonly reason: "held" | "unsafe" | "changed" | "unknown") { super(`Runtime install lock ${reason}`); } }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function proof(value: unknown): value is RuntimeProcessProof {
  const p = value as RuntimeProcessProof;
  return !!p && Number.isSafeInteger(p.pid) && p.pid > 0 && typeof p.birth === "string" && /^\d{17,20}$/.test(p.birth) && typeof p.boot === "string" && /^[a-f0-9]{64}$/.test(p.boot);
}
export function parseRuntimeInstallLock(value: unknown): RuntimeInstallLockRecord {
  const v = value as RuntimeInstallLockRecord;
  if (!proof(v) || !v || Array.isArray(v) || Object.keys(v).length !== 6 || Object.keys(v).some(k => !["version", "type", "nonce", "pid", "birth", "boot"].includes(k))
    || v.version !== 1 || !["installer", "supervisor"].includes(v.type) || typeof v.nonce !== "string" || !UUID.test(v.nonce)) throw new RuntimeInstallLockError("unsafe");
  return { version: 1, type: v.type, nonce: v.nonce, pid: v.pid, birth: v.birth, boot: v.boot };
}
/** Fixed local query; no command line, profile, account, credential or response-provided program is read. */
export async function observeRuntimeProcess(pid: number): Promise<RuntimeProcessObservation> {
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid < 1) return { state: "unknown" };
  try { process.kill(pid, 0); } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown" };
  }
  try {
    const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $p=Get-Process -Id ${pid} -ErrorAction Stop; $o=Get-CimInstance Win32_OperatingSystem -ErrorAction Stop; [Console]::Write((@{birth=[string]$p.StartTime.ToUniversalTime().Ticks;boot=[string]$o.LastBootUpTime.ToUniversalTime().Ticks}|ConvertTo-Json -Compress))`;
    const result = await promisify(execFile)(join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { timeout: 10_000, maxBuffer: 4096, windowsHide: true, env: nativeCliEnvironment() });
    const value = JSON.parse(result.stdout.trim()), candidate = { pid, birth: value.birth, boot: paneSystemBootId(value.boot) };
    return proof(candidate) ? { state: "alive", proof: candidate } : { state: "unknown" };
  } catch { return { state: "unknown" }; }
}
export function runtimeProcessMatches(expected: RuntimeProcessProof, observed: RuntimeProcessObservation): boolean | undefined {
  if (!proof(expected) || observed.state === "unknown") return undefined;
  if (observed.state === "gone") return false;
  if (!proof(observed.proof) || observed.proof.pid !== expected.pid) return undefined;
  return observed.proof.birth === expected.birth && observed.proof.boot === expected.boot;
}
function sameFile(a: Stats, b: Stats): boolean { return a.ino === b.ino && a.dev === b.dev && a.uid === b.uid; }
export function assertRuntimeInstallDirectory(path: string): Stats {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o022))) throw new RuntimeInstallLockError("unsafe");
  return stat;
}
/** Only ENOENT is absence; malformed, writable or changed files never become an empty installation. */
export function readRuntimeInstallBytes(path: string, max = 8192): { bytes: Buffer; stat: Stats } | undefined {
  if (!Number.isSafeInteger(max) || max < 1 || max > 8 * 1024 * 1024) throw new RuntimeInstallLockError("unsafe");
  let before: Stats;
  try { before = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > max || process.getuid && (before.uid !== process.getuid() || (before.mode & 0o022))) throw new RuntimeInstallLockError("unsafe");
  const fd = openSync(path, "r");
  try {
    const opened = fstatSync(fd); if (!sameFile(before, opened) || opened.nlink !== 1 || opened.size > max) throw new RuntimeInstallLockError("changed");
    const bytes = Buffer.alloc(max + 1); let length = 0, count: number;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length > max || !sameFile(opened, lstatSync(path))) throw new RuntimeInstallLockError("changed");
    return { bytes: bytes.subarray(0, length), stat: opened };
  } finally { closeSync(fd); }
}
export function readRuntimeInstallFile(path: string, max = 8192): { text: string; stat: Stats } | undefined {
  const result = readRuntimeInstallBytes(path, max);
  return result ? { text: new TextDecoder("utf-8", { fatal: true }).decode(result.bytes), stat: result.stat } : undefined;
}
interface Snapshot { directory: Stats; record: RuntimeInstallLockRecord; text: string; file: Stats }
function snapshot(path: string): Snapshot {
  const directory = assertRuntimeInstallDirectory(path), file = readRuntimeInstallFile(join(path, "owner.json"), 2048);
  if (!file) throw new RuntimeInstallLockError("unknown");
  return { directory, record: parseRuntimeInstallLock(JSON.parse(file.text)), text: file.text, file: file.stat };
}
function current(path: string, expected: Snapshot): boolean {
  const now = snapshot(path);
  return sameFile(now.directory, expected.directory) && sameFile(now.file, expected.file) && now.text === expected.text;
}
export interface RuntimeInstallLock { readonly record: RuntimeInstallLockRecord; assert(): void; release(): void }
export async function acquireRuntimeInstallLock(root: string, options: {
  type?: RuntimeInstallLockRecord["type"];
  ownProof?: RuntimeProcessProof;
  observe?: (pid: number) => Promise<RuntimeProcessObservation>;
} = {}): Promise<RuntimeInstallLock> {
  assertRuntimeInstallDirectory(root);
  const type = options.type ?? "supervisor";
  if (type !== "installer" && type !== "supervisor") throw new RuntimeInstallLockError("unsafe");
  const observe = options.observe ?? observeRuntimeProcess;
  const own = options.ownProof ? { state: "alive" as const, proof: options.ownProof } : await observe(process.pid);
  if (own.state !== "alive" || !proof(own.proof) || own.proof.pid !== process.pid) throw new RuntimeInstallLockError("unknown");
  const path = join(root, RUNTIME_INSTALL_LOCK);
  let created = false;
  try { mkdirSync(path, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (!created) {
    const before = snapshot(path), match = runtimeProcessMatches(before.record, await observe(before.record.pid));
    if (match !== false) throw new RuntimeInstallLockError(match ? "held" : "unknown");
    const reclaim = join(path, "reclaim");
    try { mkdirSync(reclaim, { mode: 0o700 }); } catch { throw new RuntimeInstallLockError("held"); }
    const guard = lstatSync(reclaim);
    try {
      if (!current(path, before)) throw new RuntimeInstallLockError("changed");
      unlinkSync(join(path, "owner.json")); rmdirSync(reclaim); rmdirSync(path);
    } finally {
      try { if (sameFile(lstatSync(reclaim), guard)) rmdirSync(reclaim); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    // Another acquirer may win after the stale directory is removed. Never remove or overwrite its new owner.
    try { mkdirSync(path, { mode: 0o700 }); created = true; } catch { throw new RuntimeInstallLockError("held"); }
  }
  const record: RuntimeInstallLockRecord = { version: 1, type, nonce: randomUUID(), pid: own.proof.pid, birth: own.proof.birth, boot: own.proof.boot };
  try { writeFileSync(join(path, "owner.json"), JSON.stringify(record), { flag: "wx", mode: 0o600 }); }
  catch (error) { try { rmdirSync(path); } catch {} throw error; }
  let owned = snapshot(path), released = false;
  const assert = () => { if (released || !current(path, owned)) throw new RuntimeInstallLockError("changed"); };
  return { record, assert, release: () => {
    if (released) return;
    assert();
    // A concurrent stale observer may briefly own a reclamation marker. Retain this lease and permit a later retry.
    try { lstatSync(join(path, "reclaim")); throw new RuntimeInstallLockError("held"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (readdirSync(path).some(name => name !== "owner.json")) throw new RuntimeInstallLockError("held");
    unlinkSync(join(path, "owner.json"));
    try { rmdirSync(path); released = true; }
    catch (error) {
      // A failed directory removal must not silently discard this process's ownership or prevent a positive retry.
      try {
        if (sameFile(lstatSync(path), owned.directory) && !readRuntimeInstallFile(join(path, "owner.json"))) {
          writeFileSync(join(path, "owner.json"), owned.text, { flag: "wx", mode: 0o600 }); owned = snapshot(path);
        }
      } catch { /* absence/changed ownership remains unconfirmed, never a successful release */ }
      throw error;
    }
  } };
}
