/** Optional control frames: no execution payload, URL, path or human authority crosses this seam. */
export const RUNTIME_MANAGED_UPDATE_CAPABILITY = "managed-update-v1";
export type RuntimeUpdateClientPhase = "prepare" | "ready" | "cancel" | "activate";
export type RuntimeUpdateServerPhase = "prepared" | "busy" | "commit" | "cancelled" | "activated";
export interface RuntimeUpdateControl<P extends string = RuntimeUpdateClientPhase | RuntimeUpdateServerPhase> {
  v: 1; type: "update.control"; id: string; bootId: string; generation: number; phase: P;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function validRuntimeUpdateId(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
export function parseRuntimeUpdateControl(value: unknown, direction: "client"): RuntimeUpdateControl<RuntimeUpdateClientPhase>;
export function parseRuntimeUpdateControl(value: unknown, direction: "server"): RuntimeUpdateControl<RuntimeUpdateServerPhase>;
export function parseRuntimeUpdateControl(value: unknown, direction: "client" | "server"): RuntimeUpdateControl {
  const v = value as Record<string, unknown>;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== 6 || Object.keys(v).some(k => !["v", "type", "id", "bootId", "generation", "phase"].includes(k))
    || v.v !== 1 || v.type !== "update.control" || !validRuntimeUpdateId(v.id) || !validRuntimeUpdateId(v.bootId) || !Number.isSafeInteger(v.generation) || (v.generation as number) < 1
    || typeof v.phase !== "string" || !(direction === "client" ? ["prepare", "ready", "cancel", "activate"] : ["prepared", "busy", "commit", "cancelled", "activated"]).includes(v.phase)) throw Error("Invalid Runtime update control");
  return { v: 1, type: "update.control", id: v.id, bootId: v.bootId, generation: v.generation as number, phase: v.phase as RuntimeUpdateControl["phase"] };
}
