/** Closed local helper protocol. It is never accepted from an unauthenticated network peer. */
import type { PaneMcpConnection } from "./windows-pane-mcp.js";
import type { NativePaneConfig } from "./runtime-pane-config.js";
import type { RuntimePaneLaunch } from "./runtime-pane-protocol.js";
import { nativeUpdateGuard, nativeClaudeFilePolicyArgs } from "./windows-cli-providers.js";
/** Cache admission and the owned worker's final pre-spawn check share the same audited release set. */
export function assertAuditedNativePaneVersion(provider:string,line:string|null):void{
 const expected=provider==="codex"?"0.165.0":provider==="claude-code"?"2.1.316":null;
 const versions=typeof line==="string"&&line.length<=4096?line.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/g):null;
 if(!expected||versions?.length!==1||versions[0]!==expected)throw Error("This native CLI version has not passed persistent-pane acceptance");
}
export interface NativePaneOwner { directory: string; launchId: string; mcp?: PaneMcpConnection }
export type NativePaneCommand = { type: "start"; launch: RuntimePaneLaunch; owner: NativePaneOwner }
  | { type: "input"; data: string } | { type: "resize"; columns: number; rows: number }
  | { type: "pause" | "resume" | "close" };
export type NativePaneFrame = { type: "ready"; pid: number } | { type: "output"; data: string }
  | { type: "exit" | "tree.exit"; code: number } | { type: "error"; message: string };
/** JSON's basic-string escapes are valid TOML; DEL needs an explicit escape and invalid Unicode is refused. */
export function nativeDeveloperInstructions(text: string): string {
  if (Buffer.from(text, "utf8").toString("utf8") !== text) throw Error("Pane instructions contain invalid Unicode");
  return `developer_instructions=${JSON.stringify(text).replace(/\x7f/g, "\\u007f")}`;
}
/** Count node-pty 1.1.0's exact Windows quoting, including its treatment of already-enclosed arguments. */
export function nativePaneCommandLineLength(executable: string, args: readonly string[]): number {
  const argv = [executable, ...args]; let size = argv.length - 1;
  for (const arg of argv) {
    const quote = arg === "" || /[ \t]/.test(arg) && arg.length > 1 && !(arg.startsWith('"') && arg.endsWith('"'));
    if (quote) size += 2;
    let slashes = 0;
    for (let i = 0; i < arg.length; i++) {
      if (arg[i] === "\\") slashes++;
      else if (arg[i] === '"') { size += slashes * 2 + 2; slashes = 0; }
      else { size += slashes + 1; slashes = 0; }
    }
    size += slashes * (quote ? 2 : 1);
  }
  return size;
}
export function assertNativePaneCommandLine(executable: string, args: readonly string[]): void {
  // CreateProcessW's limit is 32,767 UTF-16 units including NUL. Leave margin; never truncate role/tool instructions.
  if (nativePaneCommandLineLength(executable, args) > 30_000) throw Error("Native pane launch exceeds the Windows command-line limit; reduce this agent's instructions");
}
/** Provider arguments come from validated configuration, never a shell RPC. */
export function persistentNativeArguments(launch: RuntimePaneLaunch, config?: NativePaneConfig): string[] {
  const model = launch.model ? ["--model", launch.model] : [];
  const mcp = config?.mcp;
  const prefix = mcp ? ["-c", `mcp_servers.${mcp.serverName}.command=${JSON.stringify(mcp.nodePath)}`, "-c",
    `mcp_servers.${mcp.serverName}.args=${JSON.stringify([mcp.helperPath, "--connection-file", mcp.connectionPath])}`, "-c",
    // Only this launch's authenticated AgEnD server; its live Fleet permissions and General confirms still decide each call.
    `mcp_servers.${mcp.serverName}.default_tools_approval_mode="approve"`] : [];
  // Each owned Job must contain only its own CLI tree. A shared Codex app-server would outlive or couple panes.
  // This is the fleet agent's own developer-role slot. Built-in model and project instructions remain provider-owned.
  // A shared AGENTS.md identity block would give concurrent same-cwd agents each other's roles.
  if (launch.cli === "codex") return ["--no-daemon", ...nativeUpdateGuard("codex"), ...prefix,
    ...(launch.instructions ? ["-c", nativeDeveloperInstructions(launch.instructions)] : []),
    "-c", 'tui.status_line=["context-remaining"]', "--sandbox", launch.sandbox, "--ask-for-approval", "on-request", "-C", launch.cwd,
    ...model, ...(launch.sessionId ? ["resume", launch.sessionId] : [])];
  return [...model, ...nativeClaudeFilePolicyArgs(), ...(config?.instructionsFile ? ["--append-system-prompt-file", config.instructionsFile] : []),
    ...(mcp ? ["--strict-mcp-config", "--mcp-config", mcp.configPath, "--allowedTools", mcp.tools.map(tool => `mcp__${mcp.serverName}__${tool}`).join(",")] : []), "--permission-mode", launch.sandbox === "workspace-write" ? "acceptEdits" : "default", ...(launch.sandbox === "read-only" ? ["--tools", "Read,Glob,Grep"] : []),
    ...(launch.sessionId ? ["--resume", launch.sessionId] : config?.sessionId ? ["--session-id", config.sessionId] : [])];
}
