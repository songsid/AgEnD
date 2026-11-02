/** Closed remote transcript identities. Never put a runner path in a coordinator checkpoint. */
import { createHash } from "node:crypto";
import { validNativeSessionId } from "./windows-cli-providers.js";
export type PaneTranscriptProvider = "codex" | "claude-code";
export interface PaneTranscriptCursor { sessionId: string; offset: number; fileId: string | null; anchor: string; skipping?: boolean }
export interface PaneTranscriptWireBatch {
  state: "pending" | "ready";
  cursor: PaneTranscriptCursor;
  /** Complete record bytes, base64-encoded to stay bounded even for heavily escaped JSON. */
  data: string;
  complete: boolean;
  /** Oversized records were skipped; absence and turn completion across this gap are unproven. */
  gap: boolean;
}
export interface RuntimeTranscriptReference {
  version: 1;
  machineId: string;
  hostBootId: string;
  paneId: string;
  launchId: string;
  agentId: string;
  provider: PaneTranscriptProvider;
  cursor: PaneTranscriptCursor;
}
export const PANE_TRANSCRIPT_MAX_FILE_BYTES = 128 * 1024 * 1024;
export const PANE_TRANSCRIPT_EMPTY_ANCHOR = createHash("sha256").update("").digest("hex");
const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error("Invalid runtime transcript identity");
  return value as Record<string, unknown>;
}
export function validatePaneTranscriptCursor(value: unknown, expectedSessionId?: string): PaneTranscriptCursor {
  const v = closed(value, ["sessionId", "offset", "fileId", "anchor", "skipping"]);
  if (!validNativeSessionId("codex", v.sessionId) || expectedSessionId !== undefined && v.sessionId !== expectedSessionId
    || !Number.isSafeInteger(v.offset) || (v.offset as number) < 0 || (v.offset as number) > PANE_TRANSCRIPT_MAX_FILE_BYTES
    || v.fileId !== null && (typeof v.fileId !== "string" || !/^[a-f0-9]{64}$/.test(v.fileId))
    || typeof v.anchor !== "string" || !/^[a-f0-9]{64}$/.test(v.anchor)
    || v.skipping !== undefined && typeof v.skipping !== "boolean"
    || v.fileId === null && (v.offset !== 0 || v.anchor !== PANE_TRANSCRIPT_EMPTY_ANCHOR || v.skipping === true)) throw Error("Invalid pane transcript cursor");
  return { sessionId: v.sessionId, offset: v.offset as number, fileId: v.fileId as string | null, anchor: v.anchor,
    ...(v.skipping ? { skipping: true } : {}) };
}
export function validatePaneTranscriptWireBatch(value: unknown, sessionId: string): PaneTranscriptWireBatch {
  const v = closed(value, ["state", "cursor", "data", "complete", "gap"]), cursor = validatePaneTranscriptCursor(v.cursor, sessionId);
  if (v.state !== "pending" && v.state !== "ready" || typeof v.data !== "string" || v.data.length > 220_000
    || v.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(v.data)
    || Buffer.from(v.data, "base64").toString("base64") !== v.data || typeof v.complete !== "boolean" || typeof v.gap !== "boolean"
    || v.state === "pending" && (v.data !== "" || v.complete || v.gap) || v.state === "ready" && cursor.fileId === null
    || v.state === "ready" && cursor.skipping && (!v.gap || v.complete)) throw Error("Invalid pane transcript response");
  return { state: v.state, cursor, data: v.data, complete: v.complete, gap: v.gap };
}
export function validateRuntimeTranscriptReference(value: unknown): RuntimeTranscriptReference {
  const v = closed(value, ["version", "machineId", "hostBootId", "paneId", "launchId", "agentId", "provider", "cursor"]);
  // "local" is the coordinator's own Windows bridge, never a remotely enrolled machine id.
  if (v.version !== 1 || v.machineId !== "local" && !uuid(v.machineId) || !uuid(v.hostBootId) || !uuid(v.paneId) || !uuid(v.launchId)
    || !uuid(v.agentId) || v.provider !== "codex" && v.provider !== "claude-code") throw Error("Invalid runtime transcript identity");
  return { version: 1, machineId: v.machineId as string, hostBootId: v.hostBootId, paneId: v.paneId,
    launchId: v.launchId, agentId: v.agentId, provider: v.provider, cursor: validatePaneTranscriptCursor(v.cursor) };
}
/** A cursor may advance; its machine, process generation and pinned conversation may not. */
export function sameRuntimeTranscriptScope(a: RuntimeTranscriptReference, b: RuntimeTranscriptReference): boolean {
  return a.version === b.version && a.machineId === b.machineId && a.hostBootId === b.hostBootId
    && a.paneId === b.paneId && a.launchId === b.launchId && a.agentId === b.agentId
    && a.provider === b.provider && a.cursor.sessionId === b.cursor.sessionId;
}
