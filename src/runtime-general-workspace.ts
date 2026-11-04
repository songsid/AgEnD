/** Runner-owned General knowledge. Only fixed installed assets enter a dedicated, receipt-owned workspace. */
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFileSync } from "./atomic-write.js";
import { GENERAL_KNOWLEDGE_FILES, GENERAL_ROLE_INSTRUCTIONS } from "./general-role.js";
import { validateGeneralWorkspaceRequest, type GeneralWorkspaceRequest, type GeneralWorkspaceReceipt } from "./runtime-general-protocol.js";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
function directory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("General workspace directory is unsafe");
  if (resolve(realpathSync(path)).toLowerCase() !== resolve(path).toLowerCase()) throw Error("General workspace directory leads elsewhere");
}
function text(path: string, limit: number): string {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw Error("General program or workspace file is unsafe");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > limit || opened.dev !== before.dev || opened.ino !== before.ino) throw Error("General file changed while opening");
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (bytes.length > limit || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || bytes.includes(0)) throw Error("General file changed or contains invalid text");
    const value = bytes.toString("utf8"); if (!Buffer.from(value, "utf8").equals(bytes)) throw Error("General asset is not valid UTF-8");
    return value;
  } finally { closeSync(fd); }
}
function child(root: string, name: string, create = false): string {
  if (!name || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..")) throw Error("Invalid General asset path");
  directory(root);
  const parts = name.split("/"); let path = root;
  for (const part of parts.slice(0, -1)) {
    path = join(path, part);
    if (create) { try { mkdirSync(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
    directory(path);
  }
  const target = join(root, ...parts), within = relative(root, target);
  if (!within || within.startsWith(".." + sep) || within === "..") throw Error("General asset escaped its workspace");
  return target;
}
export interface GeneralKnowledgePack { hash: string; files: Readonly<Record<string, string>> }
export function loadGeneralKnowledge(cli: GeneralWorkspaceRequest["cli"], moduleDirectory = dirname(fileURLToPath(import.meta.url))): GeneralKnowledgePack {
  const root = join(moduleDirectory, "general-knowledge"); directory(root);
  const files: Record<string, string> = {}, skills = cli === "codex" ? ".agents" : ".claude";
  let total = 0;
  for (const name of GENERAL_KNOWLEDGE_FILES) {
    const value = text(child(root, name), 128 * 1024); total += Buffer.byteLength(value);
    if (total > 512 * 1024) throw Error("General knowledge pack is too large");
    if (name.startsWith("skills/")) files[`${skills}/${name}`] = value;
    else files[cli === "codex" ? "AGENTS.md" : "CLAUDE.md"] = `${GENERAL_ROLE_INSTRUCTIONS}\n\n${value}`;
  }
  return { hash: hash(JSON.stringify(files)), files };
}
interface Publication {
  version: 1; bindingId: string; instance: string; cli: GeneralWorkspaceRequest["cli"]; packHash: string;
  files: Record<string, string>; previous?: Record<string, string>;
}
/** The caller serializes publication against live/unknown panes using this cwd. File access is bounded and synchronous. */
export class RuntimeGeneralWorkspace {
  constructor(private root: string, private moduleDirectory = dirname(fileURLToPath(import.meta.url))) {}
  private path(request: GeneralWorkspaceRequest, create: boolean): string {
    directory(this.root);
    const root = join(this.root, "general-workspaces");
    if (create) { try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
    directory(root);
    const cwd = join(root, request.bindingId);
    if (create) { try { mkdirSync(cwd, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
    directory(cwd); return cwd;
  }
  private manifest(cwd: string, request: GeneralWorkspaceRequest): Publication | null {
    let raw: Publication;
    try { raw = JSON.parse(text(join(cwd, ".agend-general.json"), 64 * 1024)); } catch (error) { if (missing(error)) return null; throw error; }
    if (raw?.version !== 1 || raw.bindingId !== request.bindingId || raw.instance !== request.instance || raw.cli !== request.cli
      || Object.keys(raw).some(key => !["version", "bindingId", "instance", "cli", "packHash", "files", "previous"].includes(key))
      || typeof raw.packHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.packHash)) throw Error("General workspace publication scope differs");
    for (const map of [raw.files, ...(raw.previous !== undefined ? [raw.previous] : [])]) {
      if (!map || typeof map !== "object" || Array.isArray(map) || Object.keys(map).length > 64
        || Object.entries(map).some(([name, digest]) => !(name === (request.cli === "codex" ? "AGENTS.md" : "CLAUDE.md")
          || new RegExp(`^${request.cli === "codex" ? "\\.agents" : "\\.claude"}/skills/[a-z0-9][a-z0-9-]{0,63}/SKILL\\.md$`).test(name))
          || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))) throw Error("Invalid General owned-file manifest");
    }
    return raw;
  }
  private existing(cwd: string, name: string): string | null {
    try { return hash(text(child(cwd, name), 128 * 1024)); } catch (error) { if (missing(error)) return null; throw error; }
  }
  verify(raw: GeneralWorkspaceRequest, expectedCwd?: string): GeneralWorkspaceReceipt {
    const request = validateGeneralWorkspaceRequest(raw), cwd = this.path(request, false), pack = loadGeneralKnowledge(request.cli, this.moduleDirectory);
    if (request.packHash !== pack.hash || expectedCwd !== undefined && resolve(expectedCwd).toLowerCase() !== resolve(cwd).toLowerCase()) throw Error("General workspace pack or directory differs");
    const manifest = this.manifest(cwd, request);
    if (!manifest || manifest.previous || manifest.packHash !== pack.hash || JSON.stringify(manifest.files) !== JSON.stringify(Object.fromEntries(Object.entries(pack.files).map(([name, value]) => [name, hash(value)])))
      || Object.entries(pack.files).some(([name, value]) => this.existing(cwd, name) !== hash(value))) throw Error("General workspace publication is incomplete or changed");
    return { version: 1, bindingId: request.bindingId, instance: request.instance, cli: request.cli, packHash: pack.hash, cwd };
  }
  prepare(raw: GeneralWorkspaceRequest, current: () => boolean, mayWrite: (cwd: string) => boolean): GeneralWorkspaceReceipt {
    const request = validateGeneralWorkspaceRequest(raw), pack = loadGeneralKnowledge(request.cli, this.moduleDirectory);
    if (pack.hash !== request.packHash || !current()) throw Error("General workspace pack or lease differs");
    const cwd = this.path(request, true), previous = this.manifest(cwd, request);
    try { return this.verify(request); } catch { /* A partial, owned publication is completed only below. */ }
    if (!mayWrite(cwd) || !current()) throw Error("General workspace has a live or unconfirmed pane");
    if (!previous && readdirSync(cwd).length) throw Error("General workspace contains unowned files");
    const next = Object.fromEntries(Object.entries(pack.files).map(([name, value]) => [name, hash(value)]));
    const known = new Set([...Object.keys(previous?.files ?? {}), ...Object.keys(previous?.previous ?? {}), ...Object.keys(next)]);
    const old: Record<string, string> = {};
    for (const name of known) {
      const digest = this.existing(cwd, name);
      if (digest !== null && digest !== previous?.files[name] && digest !== previous?.previous?.[name]) throw Error("General workspace file is not an unchanged owned copy");
      if (digest !== null) old[name] = digest;
    }
    // Before any content write, retain both possible hashes so an interrupted update never adopts unknown bytes.
    const pending: Publication = { version: 1, bindingId: request.bindingId, instance: request.instance, cli: request.cli, packHash: pack.hash, files: next, previous: old };
    const save = (value: Publication) => { if (!current()) throw Error("General workspace lease expired"); directory(cwd); atomicWriteFileSync(join(cwd, ".agend-general.json"), JSON.stringify(value), { mode: 0o600 }); };
    save(pending);
    for (const [name, value] of Object.entries(pack.files)) {
      if (!current()) throw Error("General workspace lease expired");
      const digest = this.existing(cwd, name);
      if (digest !== null && digest !== next[name] && digest !== old[name]) throw Error("General workspace changed during publication");
      const file = child(cwd, name, true); if (digest !== next[name]) atomicWriteFileSync(file, value, { mode: 0o600 });
    }
    for (const name of Object.keys(old)) if (!Object.hasOwn(next, name)) {
      if (!current()) throw Error("General workspace lease expired"); const digest = this.existing(cwd, name);
      if (digest !== null && digest !== old[name]) throw Error("Retired General skill changed");
      if (digest !== null) unlinkSync(child(cwd, name));
    }
    const { previous: _old, ...committed } = pending; save(committed); return this.verify(request);
  }
}
