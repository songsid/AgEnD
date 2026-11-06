/** Diagnostic data only: never an update URL, path, command, approval or execution capability. */
import { validRuntimeVersion } from "./runtime-protocol.js";
import { validRuntimeUpdateId } from "./runtime-update-protocol.js";
export const RUNTIME_UPDATE_STATUS_CAPABILITY = "managed-update-status-v1";
export interface RuntimeUpdateTarget { version: string; bundleSha256: string }
export type RuntimeUpdateStatus =
  | { state: "unknown" | "current" }
  | { state: "pending" | "failed"; target: RuntimeUpdateTarget }
  | { state: "manual"; reason: "unmanaged" | "shared" | "another-runtime" | "recovery" | "damaged" };
export interface RuntimeUpdateStatusFrame { v: 1; type: "update.status"; bootId: string; generation: number; status: RuntimeUpdateStatus }
export interface RuntimeUpdateReport { bootId: string; generation: number; reportedAt: number; status: RuntimeUpdateStatus }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function keys(value: Record<string, unknown>, fields: string[]): boolean { return Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)); }
export function parseRuntimeUpdateStatus(value: unknown): RuntimeUpdateStatus {
  if (!object(value) || Buffer.byteLength(JSON.stringify(value)) > 1024) throw Error("Invalid Runtime update status");
  if (["unknown", "current"].includes(String(value.state)) && keys(value, ["state"])) return { state: value.state as "unknown" | "current" };
  if (["pending", "failed"].includes(String(value.state)) && keys(value, ["state", "target"]) && object(value.target) && keys(value.target, ["version", "bundleSha256"])
    && validRuntimeVersion(value.target.version) && typeof value.target.bundleSha256 === "string" && /^[a-f0-9]{64}$/.test(value.target.bundleSha256))
    return { state: value.state as "pending" | "failed", target: { version: value.target.version, bundleSha256: value.target.bundleSha256 } };
  if (value.state === "manual" && keys(value, ["state", "reason"]) && typeof value.reason === "string" && ["unmanaged", "shared", "another-runtime", "recovery", "damaged"].includes(value.reason))
    return { state: "manual", reason: value.reason as Extract<RuntimeUpdateStatus, { state: "manual" }>["reason"] };
  throw Error("Invalid Runtime update status");
}
export function parseRuntimeUpdateStatusFrame(value: unknown): RuntimeUpdateStatusFrame {
  if (!object(value) || !keys(value, ["v", "type", "bootId", "generation", "status"]) || value.v !== 1 || value.type !== "update.status"
    || !validRuntimeUpdateId(value.bootId) || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1) throw Error("Invalid Runtime update report binding");
  return { v: 1, type: "update.status", bootId: value.bootId, generation: value.generation as number, status: parseRuntimeUpdateStatus(value.status) };
}
export function parseRuntimeUpdateReport(value: unknown): RuntimeUpdateReport {
  if (!object(value) || !keys(value, ["bootId", "generation", "reportedAt", "status"]) || !Number.isSafeInteger(value.reportedAt) || (value.reportedAt as number) < 0) throw Error("Invalid Runtime update report");
  const frame = parseRuntimeUpdateStatusFrame({ v: 1, type: "update.status", bootId: value.bootId, generation: value.generation, status: value.status });
  return { bootId: frame.bootId, generation: frame.generation, reportedAt: value.reportedAt as number, status: frame.status };
}
