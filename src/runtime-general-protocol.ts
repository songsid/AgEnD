/** A fixed bundled role publication, not a shell or arbitrary file-write request. */
import { validWindowsAgentId, validWindowsDirectory } from "./windows-cli-worker.js";
import { GENERAL_KNOWLEDGE_FILES } from "./general-role.js";
export class GeneralManagedFileError extends Error {
  constructor(readonly file: string, prefix = "General workspace publication is incomplete or changed") { super(`${prefix}: ${file}`); }
}
export interface GeneralWorkspaceRequest {
  action: "general-workspace";
  bindingId: string;
  instance: string;
  cli: "codex" | "claude-code";
  packHash: string;
}
export interface GeneralWorkspaceReceipt extends Omit<GeneralWorkspaceRequest, "action"> { version: 1; cwd: string }
export interface GeneralWorkspaceUpgrade extends Omit<GeneralWorkspaceRequest, "action"> { version: 1; upgradeRequired: true }
function fields(raw: unknown, keys: readonly string[]): asserts raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key))) throw Error("Invalid General workspace fields");
}
function identity(raw: Record<string, unknown>): void {
  if (!validWindowsAgentId(raw.bindingId) || typeof raw.instance !== "string" || !/^[\p{L}\p{N}_.-]{1,160}$/u.test(raw.instance)
    || raw.cli !== "codex" && raw.cli !== "claude-code" || typeof raw.packHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.packHash)) throw Error("Invalid General workspace identity");
}
export function validateGeneralWorkspaceRequest(raw: unknown): GeneralWorkspaceRequest {
  fields(raw, ["action", "bindingId", "instance", "cli", "packHash"]); identity(raw);
  if (raw.action !== "general-workspace") throw Error("Invalid General workspace operation");
  return raw as unknown as GeneralWorkspaceRequest;
}
export function validateGeneralWorkspaceReceipt(raw: unknown, expected: GeneralWorkspaceRequest): GeneralWorkspaceReceipt {
  if (raw && typeof raw === "object" && "managedFile" in raw) {
    fields(raw, ["version", "bindingId", "instance", "cli", "packHash", "managedFile"]);
    const diagnostic = raw as Record<string, unknown>; identity(diagnostic);
    const root = expected.cli === "codex" ? ".agents" : ".claude";
    const owned = [expected.cli === "codex" ? "AGENTS.md" : "CLAUDE.md", ".agend-general.json",
      ...GENERAL_KNOWLEDGE_FILES.filter(name => name.startsWith("skills/")).map(name => `${root}/${name}`)];
    if (diagnostic.version !== 1 || diagnostic.bindingId !== expected.bindingId || diagnostic.instance !== expected.instance || diagnostic.cli !== expected.cli
      || diagnostic.packHash !== expected.packHash || typeof diagnostic.managedFile !== "string" || !owned.includes(diagnostic.managedFile)) throw Error("Invalid General managed-file diagnostic");
    throw new GeneralManagedFileError(diagnostic.managedFile as string);
  }
  fields(raw, ["version", "bindingId", "instance", "cli", "packHash", "cwd"]); identity(raw);
  if (raw.version !== 1 || raw.bindingId !== expected.bindingId || raw.instance !== expected.instance || raw.cli !== expected.cli
    || raw.packHash !== expected.packHash || !validWindowsDirectory(raw.cwd)) throw Error("General workspace receipt differs");
  return raw as unknown as GeneralWorkspaceReceipt;
}
export function generalWorkspaceUpgrade(raw: unknown, expected: GeneralWorkspaceRequest): boolean {
  if (!raw || typeof raw !== "object" || !("upgradeRequired" in raw)) return false;
  const value = raw as Record<string, unknown>;
  fields(value, ["version", "bindingId", "instance", "cli", "packHash", "upgradeRequired"]); identity(value);
  if (value.version !== 1 || value.upgradeRequired !== true || value.bindingId !== expected.bindingId || value.instance !== expected.instance || value.cli !== expected.cli || value.packHash === expected.packHash) throw Error("Invalid General workspace upgrade proof");
  return true;
}
