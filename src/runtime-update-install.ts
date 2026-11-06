/** Public managed-install inventory, code-only staging and pointer swap. Not composed into run/connect yet. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { validateRuntimeServer } from "./runtime-client-store.js";
import { runtimeCodeBuildId } from "./runtime-build-info.js";
import { parseRuntimeUpdateMetadata, validateRuntimeUpdateArchive, type RuntimeUpdateMetadata } from "./runtime-update-artifact.js";
import { assertRuntimeInstallDirectory, readRuntimeInstallBytes, readRuntimeInstallFile, type RuntimeInstallLock } from "./runtime-update-lock.js";

export const RUNTIME_INSTALL_RECEIPT = ".agend-runtime-install.json";
export interface RuntimeInstallReceipt { version: 1; id: string; createdAt: number; revision: number; origins: string[]; shared: boolean }
export interface RuntimeInstalledProgram { folder: string; version: string; sha256: string; buildId: string }
export class RuntimeManagedInstallError extends Error { constructor(readonly reason: "unmanaged" | "unsafe" | "changed" | "collision" | "stage") { super(`Runtime managed installation ${reason}`); } }
const HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function origin(value: unknown): string {
  if (typeof value !== "string" || validateRuntimeServer(value).origin !== value) throw new RuntimeManagedInstallError("unsafe");
  return value;
}
export function parseRuntimeInstallReceipt(value: unknown): RuntimeInstallReceipt {
  if (!object(value) || Object.keys(value).length !== 6 || Object.keys(value).some(key => !["version", "id", "createdAt", "revision", "origins", "shared"].includes(key))
    || value.version !== 1 || typeof value.id !== "string" || !UUID.test(value.id)
    || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1
    || !Array.isArray(value.origins) || value.origins.length < 1 || value.origins.length > 8 || typeof value.shared !== "boolean") throw new RuntimeManagedInstallError("unsafe");
  const origins = value.origins.map(origin);
  if (new Set(origins).size !== origins.length || origins.length > 1 && !value.shared) throw new RuntimeManagedInstallError("unsafe");
  return { version: 1, id: value.id, createdAt: value.createdAt as number, revision: value.revision as number, origins, shared: value.shared };
}
export function readRuntimeInstallReceipt(root: string): RuntimeInstallReceipt | undefined {
  assertRuntimeInstallDirectory(root);
  const value = readRuntimeInstallFile(join(root, RUNTIME_INSTALL_RECEIPT), 20_000);
  return value ? parseRuntimeInstallReceipt(JSON.parse(value.text)) : undefined;
}
/** No Node initialization/adoption path: only a genuinely new managed installer creates the receipt. */
export function registerRuntimeInstallOrigin(root: string, pairedOrigin: string, lock: RuntimeInstallLock): RuntimeInstallReceipt {
  lock.assert(); const selected = origin(pairedOrigin), before = readRuntimeInstallReceipt(root);
  if (!before) throw new RuntimeManagedInstallError("unmanaged");
  if (before.origins.includes(selected)) return before;
  const next: RuntimeInstallReceipt = { ...before, revision: before.revision + 1, shared: true,
    origins: [...before.origins, ...before.origins.length < 8 ? [selected] : []].sort() };
  lock.assert();
  atomicWriteFileSync(join(root, RUNTIME_INSTALL_RECEIPT), JSON.stringify(parseRuntimeInstallReceipt(next)), { mode: 0o600, beforeRename: () => lock.assert() });
  return next;
}
function programFolder(value: string): { version: string; suffix: string } {
  if (value.length > 90 || !/^[A-Za-z0-9.+-]+\+[a-f0-9]{8}$/.test(value)) throw new RuntimeManagedInstallError("unsafe");
  const version = value.slice(0, -9), suffix = value.slice(-8);
  parseRuntimeUpdateMetadata({ version, sha256: "a".repeat(64), bytes: 1 }); return { version, suffix };
}
function programPath(root: string, folder: string, name: string): string {
  if (name.length > 240 || !name.split("/").every(part => /^[A-Za-z0-9@_-][A-Za-z0-9@_.-]*$/.test(part) && !part.endsWith("."))) throw new RuntimeManagedInstallError("unsafe");
  const base = join(root, folder), target = resolve(base, name);
  if (!target.startsWith(resolve(base) + sep)) throw new RuntimeManagedInstallError("unsafe");
  let parent = dirname(target);
  while (parent !== base) { assertRuntimeInstallDirectory(parent); const next = dirname(parent); if (parent === next) throw new RuntimeManagedInstallError("unsafe"); parent = next; }
  return target;
}
/** Hashes current disk bytes; a marker alone never vouches for an incomplete or changed program. */
export function readRuntimeInstalledProgram(root: string, folder: string): RuntimeInstalledProgram {
  assertRuntimeInstallDirectory(root); const expected = programFolder(folder), base = join(root, folder); assertRuntimeInstallDirectory(base);
  const marker = readRuntimeInstallFile(join(base, ".agend-install-sha256"), 64)?.text;
  if (!marker || !HASH.test(marker) || !marker.startsWith(expected.suffix)) throw new RuntimeManagedInstallError("unsafe");
  const manifest = JSON.parse(readRuntimeInstallFile(join(base, "bundle-manifest.json"), 256 * 1024)?.text ?? "null");
  if (!object(manifest) || manifest.version !== expected.version || typeof manifest.buildId !== "string" || !HASH.test(manifest.buildId)
    || !Array.isArray(manifest.modules) || !manifest.modules.length || manifest.modules.length > 256 || new Set(manifest.modules).size !== manifest.modules.length
    || !object(manifest.sha256) || Object.keys(manifest.sha256).length > 512) throw new RuntimeManagedInstallError("unsafe");
  const files = new Map<string, Buffer>(); let total = 0;
  for (const [name, hash] of Object.entries(manifest.sha256)) {
    if (typeof hash !== "string" || !HASH.test(hash)) throw new RuntimeManagedInstallError("unsafe");
    const path = programPath(root, folder, name), file = readRuntimeInstallBytes(path, 2 * 1024 * 1024);
    if (!file || (total += file.bytes.length) > 8 * 1024 * 1024 || digest(file.bytes) !== hash) throw new RuntimeManagedInstallError("changed"); files.set(name, file.bytes);
  }
  const modules = manifest.modules;
  if (modules.some(name => typeof name !== "string" || !/^[a-z0-9][a-z0-9.-]*\.(js|ps1)$/.test(name) || !files.has(`dist/${name}`))
    || !["runtime-cli.js", "runtime-client.js", "runtime-protocol.js"].every(name => modules.includes(name))) throw new RuntimeManagedInstallError("unsafe");
  const buildId = runtimeCodeBuildId(expected.version, modules.map(name => [name, files.get(`dist/${name}`)!] as const));
  const pkg = JSON.parse(files.get("package.json")?.toString("utf8") ?? "null");
  if (buildId !== manifest.buildId || !object(pkg) || pkg.name !== "@songsid/agend-runtime" || pkg.version !== expected.version || pkg.type !== "module"
    || !object(pkg.bin) || pkg.bin["agend-runtime"] !== "./dist/runtime-cli.js") throw new RuntimeManagedInstallError("unsafe");
  return { folder, version: expected.version, sha256: marker, buildId };
}
export function readRuntimeSelectedProgram(root: string): RuntimeInstalledProgram {
  assertRuntimeInstallDirectory(root); assertRuntimeInstallDirectory(join(root, "bin"));
  const pointer = readRuntimeInstallFile(join(root, "bin", "current.txt"), 90)?.text;
  if (!pointer || pointer.trim() !== pointer) throw new RuntimeManagedInstallError("unmanaged");
  return readRuntimeInstalledProgram(root, pointer);
}
export function stageRuntimeUpdate(root: string, bytes: Buffer, metadata: RuntimeUpdateMetadata, lock: RuntimeInstallLock): RuntimeInstalledProgram {
  lock.assert(); if (!readRuntimeInstallReceipt(root)) throw new RuntimeManagedInstallError("unmanaged");
  const archive = validateRuntimeUpdateArchive(bytes, metadata), folder = `${archive.metadata.version}+${archive.metadata.sha256.slice(0, 8)}`, target = join(root, folder);
  programFolder(folder);
  let exists = false;
  try { lstatSync(target); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (exists) {
    const existing = readRuntimeInstalledProgram(root, folder);
    if (existing.sha256 !== archive.metadata.sha256 || existing.buildId !== archive.buildId) throw new RuntimeManagedInstallError("collision");
    return existing;
  }
  const stage = join(root, `.install-${randomUUID()}`); mkdirSync(stage, { mode: 0o700 }); const identity = lstatSync(stage);
  const unpacked = join(stage, folder);
  try {
    mkdirSync(unpacked, { mode: 0o700 });
    for (const [name, contents] of archive.files) {
      const path = join(unpacked, name); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fd = openSync(path, "wx", 0o600); try { writeFileSync(fd, contents); fsyncSync(fd); } finally { closeSync(fd); }
    }
    const marker = openSync(join(unpacked, ".agend-install-sha256"), "wx", 0o600);
    try { writeFileSync(marker, archive.metadata.sha256); fsyncSync(marker); } finally { closeSync(marker); }
    const verified = readRuntimeInstalledProgram(stage, folder);
    if (verified.sha256 !== archive.metadata.sha256 || verified.buildId !== archive.buildId) throw new RuntimeManagedInstallError("stage");
    lock.assert();
    try { lstatSync(target); throw new RuntimeManagedInstallError("collision"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    renameSync(unpacked, target); return verified;
  } finally {
    const now = lstatSync(stage);
    if (!now.isDirectory() || now.isSymbolicLink() || now.ino !== identity.ino || now.dev !== identity.dev) throw new RuntimeManagedInstallError("changed");
    // Only this attempt's newly created staging directory; existing program versions are never removed.
    rmSync(unpacked, { recursive: true, force: true }); rmdirSync(stage);
  }
}
/** Only the pointer changes. Pairings, journals, the stable shim and prior programs are untouched. */
export function selectRuntimeProgram(root: string, before: RuntimeInstalledProgram, after: RuntimeInstalledProgram, lock: RuntimeInstallLock): void {
  lock.assert();
  if (JSON.stringify(readRuntimeSelectedProgram(root)) !== JSON.stringify(before) || JSON.stringify(readRuntimeInstalledProgram(root, after.folder)) !== JSON.stringify(after)) throw new RuntimeManagedInstallError("changed");
  atomicWriteFileSync(join(root, "bin", "current.txt"), after.folder, { mode: 0o600, beforeRename: () => {
    lock.assert(); if (readRuntimeInstallFile(join(root, "bin", "current.txt"), 90)?.text !== before.folder) throw new RuntimeManagedInstallError("changed");
  } });
}
