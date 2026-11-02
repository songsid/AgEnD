/** Closed remote transcript identities. Never put a runner path in a coordinator checkpoint. */
import { createHash } from "node:crypto";
import { validNativeSessionId } from "./windows-cli-providers.js";
export type PaneTranscriptProvider = "codex" | "claude-code";
export interface PaneTranscriptCursor { sessionId: string; offset: number; fileId: string | null; anchor: string }
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
  const v = closed(value, ["sessionId", "offset", "fileId", "anchor"]);
  if (!validNativeSessionId("codex", v.sessionId) || expectedSessionId !== undefined && v.sessionId !== expectedSessionId
    || !Number.isSafeInteger(v.offset) || (v.offset as number) < 0 || (v.offset as number) > PANE_TRANSCRIPT_MAX_FILE_BYTES
    || v.fileId !== null && (typeof v.fileId !== "string" || !/^[a-f0-9]{64}$/.test(v.fileId))
    || typeof v.anchor !== "string" || !/^[a-f0-9]{64}$/.test(v.anchor)
    || v.fileId === null && (v.offset !== 0 || v.anchor !== PANE_TRANSCRIPT_EMPTY_ANCHOR)) throw Error("Invalid pane transcript cursor");
  return { sessionId: v.sessionId, offset: v.offset as number, fileId: v.fileId as string | null, anchor: v.anchor };
}
export function validateRuntimeTranscriptReference(value: unknown): RuntimeTranscriptReference {
  const v = closed(value, ["version", "machineId", "hostBootId", "paneId", "launchId", "agentId", "provider", "cursor"]);
  // "local" is the coordinator's own Windows bridge, never a remotely enrolled machine id.
  if (v.version !== 1 || v.machineId !== "local" && !uuid(v.machineId) || !uuid(v.hostBootId) || !uuid(v.paneId) || !uuid(v.launchId)
    || !uuid(v.agentId) || v.provider !== "codex" && v.provider !== "claude-code") throw Error("Invalid runtime transcript identity");
  return { version: 1, machineId: v.machineId as string, hostBootId: v.hostBootId, paneId: v.paneId,
    launchId: v.launchId, agentId: v.agentId, provider: v.provider, cursor: validatePaneTranscriptCursor(v.cursor) };
}
