/** Closed local helper protocol. It is never accepted from an unauthenticated network peer. */
import type { PaneMcpConnection } from "./windows-pane-mcp.js";
import type { NativePaneConfig } from "./runtime-pane-config.js";
import type { RuntimePaneLaunch } from "./runtime-pane-protocol.js";
import { nativeUpdateGuard, nativeClaudeFilePolicyArgs } from "./windows-cli-providers.js";
export type NativePaneCli = "codex" | "claude-code";
/** Releases AgEnD has audited for this CLI: the same ledger as the Linux upstream watch (ffb8104e) — when a version is
 * marked audited there, it is added here, so the shipped app can say "verified" on any machine. Informational only
 * (decision cc3ce4fe): an unlisted version still runs, shown as "Not yet verified"; every readiness, dialog and
 * delivery fence still applies to it, and an unknown screen keeps failing closed. */
export const NATIVE_CLI_AUDITED: Readonly<Record<NativePaneCli, readonly string[]>> = Object.freeze({
  // 0.165.0: native persistent-pane acceptance (#2954 / #3001 / #3219). 0.166.0: upstream watch audit.
  codex: Object.freeze(["0.165.0", "0.166.0"]),
  // 2.1.316: native persistent-pane acceptance. 2.1.318: upstream watch audit (#3048).
  "claude-code": Object.freeze(["2.1.316", "2.1.318"]),
});
/** Releases known NOT to work in a persistent pane, refused with their reason. Only with evidence (an issue or an
 * audit that reproduced the break); a version is never listed for being new. Empty today. */
export const NATIVE_CLI_DENIED: Readonly<Record<NativePaneCli, Record<string, string>>> = {
  codex: {},
  "claude-code": {},
};
const NATIVE_CLI_LABEL: Readonly<Record<NativePaneCli, string>> = Object.freeze({ codex: "Codex", "claude-code": "Claude Code" });
/** One whole version token: x.y.z, an optional -prerelease and +build of dot-separated identifiers, and nothing glued to
 * either end (`1.2.1.316`, `0.165.0+`, `0.165.0++x` and `0.165.0+a+b` are not versions). */
const SEMVER = /(?<![\w.+-])\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z-]{1,32}(?:\.[0-9A-Za-z-]{1,32}){0,7})?(?:\+[0-9A-Za-z-]{1,32}(?:\.[0-9A-Za-z-]{1,32}){0,7})?(?![\w.+-])/g;
/** The exact token a pane snapshot may record as the version it actually launched. */
export const NATIVE_CLI_VERSION_TOKEN = new RegExp(`^${SEMVER.source}$`);
export type NativeCliVersionState = "verified" | "unverified" | "denied" | "invalid";
/** Strict reading of a `--version` line: a supported CLI and exactly one version number, or "invalid". */
export function nativeCliVersionState(provider: string, line: string | null | undefined, denylist: Readonly<Record<NativePaneCli, Readonly<Record<string, string>>>> = NATIVE_CLI_DENIED): { state: NativeCliVersionState; version?: string; reason?: string } {
  if (provider !== "codex" && provider !== "claude-code") return { state: "invalid" };
  const versions = typeof line === "string" && line.length <= 4096 ? line.match(SEMVER) : null;
  if (versions?.length !== 1) return { state: "invalid" };
  const version = versions[0], denied = Object.hasOwn(denylist[provider], version) ? denylist[provider][version] : undefined;
  if (denied !== undefined) return { state: "denied", version, reason: denied };
  return { state: NATIVE_CLI_AUDITED[provider].includes(version) ? "verified" : "unverified", version };
}
/** Cache admission and the owned worker's final pre-spawn check share this rule: a readable version of a supported CLI
 * runs unless it is a known-broken release. Returns the version. */
export function assertRunnableNativePaneVersion(provider: string, line: string | null): string {
  const result = nativeCliVersionState(provider, line);
  if (result.state === "invalid") throw Error("This native CLI's version could not be read, so AgEnD does not start it in a persistent pane");
  if (result.state === "denied") throw Error(`${NATIVE_CLI_LABEL[provider as NativePaneCli]} ${result.version} is known not to work in AgEnD's Windows panes (${result.reason}). Install a different version.`);
  return result.version!;
}
/** A copy of an inventory with each persistent-pane CLI row labelled by the rule above. Any runner-supplied label is
 * replaced; rows of other CLIs carry none. */
export function withNativePaneVerification<T extends { clis?: Array<{ id: string; version: string | null; paneVerification?: NativeCliVersionState }> }>(inventory: T): T {
  const copy = structuredClone(inventory);
  for (const row of copy.clis ?? []) {
    if (row.id === "codex" || row.id === "claude-code") row.paneVerification = nativeCliVersionState(row.id, row.version).state;
    else delete row.paneVerification;
  }
  return copy;
}
export interface NativePaneOwner { directory: string; launchId: string; mcp?: PaneMcpConnection; credentialHome?: string }
export type NativePaneCommand = { type: "start"; launch: RuntimePaneLaunch; owner: NativePaneOwner }
  | { type: "input"; data: string } | { type: "resize"; columns: number; rows: number }
  | { type: "pause" | "resume" | "close" };
export type NativePaneFrame = { type: "ready"; pid: number; version?: string } | { type: "output"; data: string }
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
