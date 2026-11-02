/** Launch-local files only. Provider account configuration and credentials are never copied or rewritten. */
import { lstatSync, mkdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateNativeMcpConnection } from "./windows-cli-providers.js";
import { validatePaneMcpOwner } from "./runtime-pane-mcp-protocol.js";
import type { RuntimePaneLaunch } from "./runtime-pane-protocol.js";
import type { NativePaneOwner } from "./runtime-pane-native.js";
export interface NativePaneConfig { sessionId?: string; instructionsFile?: string; mcp?: { nodePath: string; helperPath: string; connectionPath: string; configPath: string; tools: string[]; serverName: string }; cleanup(): void }
function realDirectory(path: string): void { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Pane configuration must stay in its owned directory"); }
export function prepareNativePaneConfig(launch: RuntimePaneLaunch, owner: NativePaneOwner, nodePath: string, helperPath: string): NativePaneConfig {
  realDirectory(owner.directory);
  const parent = join(owner.directory, "launches"); mkdirSync(parent, { recursive: true, mode: 0o700 }); realDirectory(parent);
  const directory = join(parent, owner.launchId); mkdirSync(directory, { mode: 0o700 });
  const files: string[] = [];
  const config: NativePaneConfig = { ...(launch.cli === "claude-code" ? { sessionId: launch.sessionId ?? owner.launchId } : {}), cleanup: () => {
    for (const file of files) { try { unlinkSync(file); } catch { /* Only exact files created by this launch. */ } }
    try { rmdirSync(directory); } catch { /* Unknown extra files are never deleted. */ }
  } };
  const write = (name: string, value: string): string => { const file = join(directory, name); writeFileSync(file, value, { encoding: "utf8", mode: 0o600, flag: "wx" }); files.push(file); return file; };
  try {
    if (launch.mcpTools) {
      if (!owner.mcp) throw Error("Persistent pane MCP scope was not prepared");
      const identity = validatePaneMcpOwner(owner.mcp.owner), mcp = validateNativeMcpConnection({ endpoint: owner.mcp.endpoint, token: owner.mcp.token, tools: owner.mcp.tools });
      if (identity.paneId !== launch.paneId || identity.launchId !== owner.launchId || identity.agentId !== launch.agentId || identity.instance !== launch.instance
        || JSON.stringify(mcp.tools) !== JSON.stringify(launch.mcpTools)) throw Error("Persistent pane MCP scope differs from its launch");
      const connectionPath = write("mcp-connection.json", JSON.stringify({ ...mcp, owner: identity }));
      const serverName = `agend_${launch.agentId.replace(/-/g, "")}`;
      const server = { command: nodePath, args: [helperPath, "--connection-file", connectionPath] };
      const configPath = write("mcp.json", JSON.stringify({ mcpServers: { [serverName]: server } }));
      config.mcp = { nodePath, helperPath, connectionPath, configPath, serverName, tools: mcp.tools };
    } else if (owner.mcp) throw Error("Unexpected pane MCP scope");
    if (launch.cli === "claude-code" && launch.instructions) config.instructionsFile = write("instructions.txt", launch.instructions);
    return config;
  } catch (error) { config.cleanup(); throw error; }
}
