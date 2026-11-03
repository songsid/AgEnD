/** Closed pane RPC. No executable, argv, shell source, environment or host path is accepted. */
import { validNativeSessionId, validateNativeModel } from "./windows-cli-providers.js";
import { validWindowsAgentId, validWindowsDirectory } from "./windows-cli-worker.js";
import type { PaneKey, PaneSize } from "./pane-port.js";
import { validatePaneTranscriptCursor, type PaneTranscriptCursor } from "./runtime-pane-transcript-protocol.js";

export const RUNTIME_PANE_PROTOCOL = 1;
export const PANE_EDIT_KEYS = { "C-a": "\x01", "C-e": "\x05", "C-u": "\x15", "C-k": "\x0b", BSpace: "\x7f", DC: "\x1b[3~", Home: "\x1b[H", End: "\x1b[F", Left: "\x1b[D", Right: "\x1b[C" } as const;
export type PaneEditKey = keyof typeof PANE_EDIT_KEYS;
export const PANE_MAX_INPUT_BYTES = 64 * 1024;
export const PANE_MAX_CAPTURE_BYTES = 192 * 1024;
export interface RuntimePaneLaunch extends PaneSize {
  paneId: string;
  agentId: string;
  instance: string;
  cli: "codex" | "claude-code";
  cwd: string;
  sandbox: "read-only" | "workspace-write";
  model?: string;
  sessionId?: string;
  launchId?: string;
  instructions?: string;
  mcpTools?: string[];
}
export interface RuntimePaneSnapshot extends PaneSize {
  hostBootId: string;
  paneId: string;
  agentId: string;
  instance: string;
  launchId: string;
  state: "starting" | "running" | "exited" | "unknown";
  seq: number;
  outputAt: number;
  commandSequence: number;
  /** Positive no-input receipt for the last command, retained across replay/reconciliation. */
  inputRefused?: true;
  exitCode?: number;
  sessionId?: string;
  /** Durable positive receipt: admission refused before any native launch factory ran. */
  noLaunch?: true;
}
/** Host-origin open outcome, never inferred from a coordinator's possibly lost ACK. */
export type RuntimePaneOpenResult = RuntimePaneSnapshot & { reattached: boolean };
export interface RuntimePaneShutdown { hostBootId: string; shutdown: true }
export interface RuntimePaneCapture { snapshot: RuntimePaneSnapshot; text: string }
export type RuntimePaneRequest =
  | { action: "list" }
  | { action: "shutdown"; hostBootId: string }
  | { action: "open"; operationId: string; launch: RuntimePaneLaunch }
  | { action: "capture"; paneId: string; launchId: string; history?: number; joined?: boolean; ansi?: boolean }
  | { action: "snapshot"; paneId: string; launchId: string }
  | { action: "output"; paneId: string; launchId: string; offset: number }
  | { action: "bind-session"; paneId: string; launchId: string; sessionId: string }
  | { action: "transcript"; paneId: string; launchId: string; cursor: PaneTranscriptCursor }
  | { action: "transcript-baseline"; paneId: string; launchId: string; cursor: PaneTranscriptCursor }
  | { action: "input"; paneId: string; launchId: string; operationId: string; sequence: number; expectedSeq: number; kind: "literal" | "paste"; text: string }
  | { action: "key"; paneId: string; launchId: string; operationId: string; sequence: number; expectedSeq: number; key: PaneKey }
  | { action: "resize"; paneId: string; launchId: string; operationId: string; sequence: number; columns: number; rows: number }
  | { action: "edit"; paneId: string; launchId: string; operationId: string; sequence: number; expectedSeq: number; keys: PaneEditKey[]; repeat?: number }
  | { action: "reconcile"; paneId: string; launchId: string; operationId: string; sequence: number; digest: string }
  | { action: "close"; paneId: string; launchId: string; operationId: string; sequence: number };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error("Invalid pane request fields");
}
function id(value: unknown): asserts value is string { if (!validWindowsAgentId(value)) throw Error("Invalid pane identity"); }
function dimension(value: unknown, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw Error("Invalid pane dimensions");
}
export function validateRuntimePaneLaunch(value: unknown): RuntimePaneLaunch {
  closed(value, ["paneId", "agentId", "instance", "cli", "cwd", "sandbox", "model", "sessionId", "launchId", "instructions", "mcpTools", "columns", "rows"]);
  id(value.paneId); id(value.agentId);
  if (value.launchId !== undefined) id(value.launchId);
  if (value.instructions !== undefined && (typeof value.instructions !== "string" || Buffer.byteLength(value.instructions) > 64 * 1024 || value.instructions.includes("\0"))) throw Error("Invalid pane instructions");
  if (value.mcpTools !== undefined && (!Array.isArray(value.mcpTools) || !value.mcpTools.length || value.mcpTools.length > 128
    || new Set(value.mcpTools).size !== value.mcpTools.length || value.mcpTools.some(tool => typeof tool !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(tool)))) throw Error("Invalid pane MCP tools");
  if (typeof value.instance !== "string" || !/^[\p{L}\p{N}_.-]{1,160}$/u.test(value.instance)) throw Error("Invalid pane instance");
  if (value.cli !== "codex" && value.cli !== "claude-code") throw Error("This provider has no verified persistent pane adapter");
  if (!validWindowsDirectory(value.cwd)) throw Error("Invalid pane working directory");
  if (value.sandbox !== "read-only" && value.sandbox !== "workspace-write") throw Error("Invalid pane permission mode");
  dimension(value.columns, 40, 300); dimension(value.rows, 10, 120);
  const model = validateNativeModel(value.model);
  if (value.sessionId !== undefined && !validNativeSessionId(value.cli, value.sessionId)) throw Error("Invalid pane conversation identity");
  return { ...value, ...(model ? { model } : {}) } as unknown as RuntimePaneLaunch;
}
export function validateRuntimePaneRequest(value: unknown): RuntimePaneRequest {
  if (!object(value) || typeof value.action !== "string") throw Error("Invalid pane request");
  switch (value.action) {
    case "list": closed(value, ["action"]); break;
    case "shutdown": closed(value, ["action", "hostBootId"]); id(value.hostBootId); return value as unknown as RuntimePaneRequest;
    case "open": closed(value, ["action", "operationId", "launch"]); id(value.operationId); return { action: "open", operationId: value.operationId, launch: validateRuntimePaneLaunch(value.launch) };
    case "capture":
      closed(value, ["action", "paneId", "launchId", "history", "joined", "ansi"]);
      if (value.history !== undefined) dimension(value.history, 0, 2000);
      if ([value.joined, value.ansi].some(item => item !== undefined && typeof item !== "boolean")) throw Error("Invalid pane capture options");
      break;
    case "snapshot":
      closed(value, ["action", "paneId", "launchId"]); break;
    case "output":
      closed(value, ["action", "paneId", "launchId", "offset"]); dimension(value.offset, 0, Number.MAX_SAFE_INTEGER); break;
    case "bind-session":
      closed(value, ["action", "paneId", "launchId", "sessionId"]);
      if (!validNativeSessionId("codex", value.sessionId)) throw Error("Invalid pane conversation identity");
      break;
    case "transcript-baseline":
    case "transcript":
      closed(value, ["action", "paneId", "launchId", "cursor"]); validatePaneTranscriptCursor(value.cursor); break;
    case "input":
      closed(value, ["action", "paneId", "launchId", "operationId", "sequence", "expectedSeq", "kind", "text"]);
      if (value.kind !== "literal" && value.kind !== "paste") throw Error("Invalid pane input kind");
      if (typeof value.text !== "string" || Buffer.byteLength(value.text) > PANE_MAX_INPUT_BYTES || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.text)) throw Error("Invalid pane literal input");
      if(value.kind === "literal" && /[\r\n]/.test(value.text as string))throw Error("Multiline input requires bracketed paste");
      break;
    case "key":
      closed(value, ["action", "paneId", "launchId", "operationId", "sequence", "expectedSeq", "key"]);
      if (!["Enter", "Escape", "Up", "Down", "Right", "Left", "C-c", "C-q"].includes(String(value.key))) throw Error("Invalid pane key");
      break;
    case "resize": closed(value, ["action", "paneId", "launchId", "operationId", "sequence", "columns", "rows"]); dimension(value.columns, 40, 300); dimension(value.rows, 10, 120); break;
    case "edit":
      closed(value, ["action", "paneId", "launchId", "operationId", "sequence", "expectedSeq", "keys", "repeat"]);
      if (!Array.isArray(value.keys) || !value.keys.length || value.keys.length > 64 || value.keys.some(key => typeof key !== "string" || !Object.hasOwn(PANE_EDIT_KEYS, key))
        || value.repeat !== undefined && (!Number.isInteger(value.repeat) || (value.repeat as number) < 1)
        || value.keys.length * ((value.repeat as number | undefined) ?? 1) > 8192) throw Error("Invalid pane editing keys");
      break;
    case "reconcile":
      closed(value, ["action", "paneId", "launchId", "operationId", "sequence", "digest"]);
      if (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)) throw Error("Invalid pane command digest");
      break;
    case "close": closed(value, ["action", "paneId", "launchId", "operationId", "sequence"]); break;
    default: throw Error("Unknown pane operation");
  }
  if (value.action !== "list") {
    if (["input", "key", "edit"].includes(value.action)) dimension(value.expectedSeq, 0, Number.MAX_SAFE_INTEGER);
    id(value.paneId); id(value.launchId);
    if (!["capture", "snapshot", "output", "transcript", "transcript-baseline", "bind-session"].includes(value.action)) { id(value.operationId); dimension(value.sequence, 1, Number.MAX_SAFE_INTEGER); }
  }
  return value as unknown as RuntimePaneRequest;
}

export function validateRuntimePaneSnapshot(value: unknown): RuntimePaneSnapshot {
  closed(value, ["hostBootId", "paneId", "agentId", "instance", "launchId", "state", "seq", "outputAt", "commandSequence", "inputRefused", "columns", "rows", "exitCode", "sessionId", "noLaunch"]);
  if (value.noLaunch !== undefined && (value.noLaunch !== true || value.state !== "exited" || value.commandSequence !== 0 || value.exitCode !== undefined)) throw Error("Invalid pane no-launch receipt");
  if(value.inputRefused!==undefined&&value.inputRefused!==true)throw Error("Invalid pane input refusal");
  id(value.hostBootId); id(value.paneId); id(value.agentId); id(value.launchId);
  if (typeof value.instance !== "string" || !/^[\p{L}\p{N}_.-]{1,160}$/u.test(value.instance)
    || !["starting", "running", "exited", "unknown"].includes(String(value.state))) throw Error("Invalid pane snapshot");
  dimension(value.columns, 40, 300); dimension(value.rows, 10, 120);
  dimension(value.seq, 0, Number.MAX_SAFE_INTEGER); dimension(value.commandSequence, 0, Number.MAX_SAFE_INTEGER);
  if (typeof value.outputAt !== "number" || !Number.isFinite(value.outputAt) || value.outputAt < 0
    || value.exitCode !== undefined && (!Number.isSafeInteger(value.exitCode) || (value.exitCode as number) < 0)) throw Error("Invalid pane snapshot state");
  if (value.sessionId !== undefined && !validNativeSessionId("codex", value.sessionId)) throw Error("Invalid pane conversation identity");
  return value as unknown as RuntimePaneSnapshot;
}

export function validateRuntimePaneOpenResult(value: unknown): RuntimePaneOpenResult {
  if (!object(value) || typeof value.reattached !== "boolean") throw Error("Pane open disposition is unconfirmed");
  const { reattached, ...snapshot } = value;
  return { ...validateRuntimePaneSnapshot(snapshot), reattached };
}
export function validateRuntimePaneShutdown(value: unknown, hostBootId: string): RuntimePaneShutdown {
  closed(value, ["hostBootId", "shutdown"]);
  if (value.hostBootId !== hostBootId || value.shutdown !== true) throw Error("Pane host shutdown is unconfirmed");
  return value as unknown as RuntimePaneShutdown;
}
