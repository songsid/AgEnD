/** A fixed bundled role publication, not a shell or arbitrary file-write request. */
import { validWindowsAgentId, validWindowsDirectory } from "./windows-cli-worker.js";
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
