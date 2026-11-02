/** Closed local helper protocol. It is never accepted from an unauthenticated network peer. */
import type { PaneMcpConnection } from "./windows-pane-mcp.js";
import type { NativePaneConfig } from "./runtime-pane-config.js";
import type { RuntimePaneLaunch } from "./runtime-pane-protocol.js";
import { nativeUpdateGuard } from "./windows-cli-providers.js";
export interface NativePaneOwner { directory: string; launchId: string; mcp?: PaneMcpConnection }
export type NativePaneCommand = { type: "start"; launch: RuntimePaneLaunch; owner: NativePaneOwner }
  | { type: "input"; data: string } | { type: "resize"; columns: number; rows: number }
  | { type: "pause" | "resume" | "close" };
export type NativePaneFrame = { type: "ready"; pid: number } | { type: "output"; data: string }
  | { type: "exit" | "tree.exit"; code: number } | { type: "error"; message: string };
/** Provider arguments come from validated configuration, never a shell RPC. */
export function persistentNativeArguments(launch: RuntimePaneLaunch, config?: NativePaneConfig): string[] {
  const model = launch.model ? ["--model", launch.model] : [];
  const mcp = config?.mcp;
  const prefix = mcp ? ["-c", `mcp_servers.${mcp.serverName}.command=${JSON.stringify(mcp.nodePath)}`, "-c",
    `mcp_servers.${mcp.serverName}.args=${JSON.stringify([mcp.helperPath, "--connection-file", mcp.connectionPath])}`] : [];
  // Each owned Job must contain only its own CLI tree. A shared Codex app-server would outlive or couple panes.
  if (launch.cli === "codex") return ["--no-daemon", ...nativeUpdateGuard("codex"), ...prefix, "-c", 'tui.status_line=["context-remaining"]', "--sandbox", launch.sandbox, "--ask-for-approval", "on-request", "-C", launch.cwd,
    ...model, ...(launch.sessionId ? ["resume", launch.sessionId] : [])];
  return [...model, ...(config?.instructionsFile ? ["--append-system-prompt-file", config.instructionsFile] : []),
    ...(mcp ? ["--strict-mcp-config", "--mcp-config", mcp.configPath, "--allowedTools", mcp.tools.map(tool => `mcp__${mcp.serverName}__${tool}`).join(",")] : []), "--permission-mode", "default", ...(launch.sandbox === "read-only" ? ["--tools", "Read,Glob,Grep"] : []),
    ...(launch.sessionId ? ["--resume", launch.sessionId] : config?.sessionId ? ["--session-id", config.sessionId] : [])];
}
