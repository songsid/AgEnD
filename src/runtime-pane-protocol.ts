/** Closed pane RPC. No executable, argv, shell source, environment or host path is accepted. */
import { validNativeSessionId, validateNativeModel } from "./windows-cli-providers.js";
import { validWindowsAgentId, validWindowsDirectory } from "./windows-cli-worker.js";
import type { PaneKey, PaneSize } from "./pane-port.js";

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
  exitCode?: number;
}
export interface RuntimePaneCapture { snapshot: RuntimePaneSnapshot; text: string }
export type RuntimePaneRequest =
  | { action: "list" }
  | { action: "open"; operationId: string; launch: RuntimePaneLaunch }
  | { action: "capture"; paneId: string; launchId: string; history?: number; joined?: boolean; ansi?: boolean }
  | { action: "input"; paneId: string; launchId: string; operationId: string; sequence: number; kind: "literal" | "paste"; text: string }
  | { action: "key"; paneId: string; launchId: string; operationId: string; sequence: number; key: PaneKey }
  | { action: "resize"; paneId: string; launchId: string; operationId: string; sequence: number; columns: number; rows: number }
  | { action: "edit"; paneId: string; launchId: string; operationId: string; sequence: number; keys: PaneEditKey[]; repeat?: number }
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
  closed(value, ["paneId", "agentId", "instance", "cli", "cwd", "sandbox", "model", "sessionId", "columns", "rows"]);
  id(value.paneId); id(value.agentId);
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
    case "open": closed(value, ["action", "operationId", "launch"]); id(value.operationId); return { action: "open", operationId: value.operationId, launch: validateRuntimePaneLaunch(value.launch) };
    case "capture":
      closed(value, ["action", "paneId", "launchId", "history", "joined", "ansi"]);
      if (value.history !== undefined) dimension(value.history, 0, 2000);
      if ([value.joined, value.ansi].some(item => item !== undefined && typeof item !== "boolean")) throw Error("Invalid pane capture options");
      break;
    case "input":
      closed(value, ["action", "paneId", "launchId", "operationId", "sequence", "kind", "text"]);
      if (value.kind !== "literal" && value.kind !== "paste") throw Error("Invalid pane input kind");
      if (typeof value.text !== "string" || Buffer.byteLength(value.text) > PANE_MAX_INPUT_BYTES || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.text)) throw Error("Invalid pane literal input");
      break;
    case "key":
      closed(value, ["action", "paneId", "launchId", "operationId", "sequence", "key"]);
      if (!["Enter", "Escape", "Up", "Down", "Right", "Left", "C-c", "C-q"].includes(String(value.key))) throw Error("Invalid pane key");
      break;
    case "resize": closed(value, ["action", "paneId", "launchId", "operationId", "sequence", "columns", "rows"]); dimension(value.columns, 40, 300); dimension(value.rows, 10, 120); break;
    case "edit":
      closed(value, ["action", "paneId", "launchId", "operationId", "sequence", "keys", "repeat"]);
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
    id(value.paneId); id(value.launchId);
    if (value.action !== "capture") { id(value.operationId); dimension(value.sequence, 1, Number.MAX_SAFE_INTEGER); }
  }
  return value as unknown as RuntimePaneRequest;
}

export function validateRuntimePaneSnapshot(value: unknown): RuntimePaneSnapshot {
  closed(value, ["hostBootId", "paneId", "agentId", "instance", "launchId", "state", "seq", "outputAt", "commandSequence", "columns", "rows", "exitCode"]);
  id(value.hostBootId); id(value.paneId); id(value.agentId); id(value.launchId);
  if (typeof value.instance !== "string" || !/^[\p{L}\p{N}_.-]{1,160}$/u.test(value.instance)
    || !["starting", "running", "exited", "unknown"].includes(String(value.state))) throw Error("Invalid pane snapshot");
  dimension(value.columns, 40, 300); dimension(value.rows, 10, 120);
  dimension(value.seq, 0, Number.MAX_SAFE_INTEGER); dimension(value.commandSequence, 0, Number.MAX_SAFE_INTEGER);
  if (typeof value.outputAt !== "number" || !Number.isFinite(value.outputAt) || value.outputAt < 0
    || value.exitCode !== undefined && (!Number.isSafeInteger(value.exitCode) || (value.exitCode as number) < 0)) throw Error("Invalid pane snapshot state");
  return value as unknown as RuntimePaneSnapshot;
}
