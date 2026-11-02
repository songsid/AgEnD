/** Closed local helper protocol. It is never accepted from an unauthenticated network peer. */
import type { RuntimePaneLaunch } from "./runtime-pane-protocol.js";
import { nativeUpdateGuard } from "./windows-cli-providers.js";
export interface NativePaneOwner { directory: string; launchId: string }
export type NativePaneCommand = { type: "start"; launch: RuntimePaneLaunch; owner: NativePaneOwner }
  | { type: "input"; data: string } | { type: "resize"; columns: number; rows: number }
  | { type: "pause" | "resume" | "close" };
export type NativePaneFrame = { type: "ready"; pid: number } | { type: "output"; data: string }
  | { type: "exit" | "tree.exit"; code: number } | { type: "error"; message: string };
/** Provider arguments come from validated configuration, never a shell RPC. */
export function persistentNativeArguments(launch: RuntimePaneLaunch): string[] {
  const model = launch.model ? ["--model", launch.model] : [];
  if (launch.cli === "codex") return [...nativeUpdateGuard("codex"), "--sandbox", launch.sandbox, "--ask-for-approval", "on-request", "-C", launch.cwd,
    ...model, ...(launch.sessionId ? ["resume", launch.sessionId] : [])];
  return [...model, "--permission-mode", "default", ...(launch.sandbox === "read-only" ? ["--tools", "Read,Glob,Grep"] : []),
    ...(launch.sessionId ? ["--resume", launch.sessionId] : [])];
}
