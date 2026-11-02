/** Launch-local files only. Provider account configuration and credentials are never copied or rewritten. */
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "./atomic-write.js";
import { validateNativeMcpConnection } from "./windows-cli-providers.js";
import { validatePaneMcpOwner } from "./runtime-pane-mcp-protocol.js";
import type { RuntimePaneLaunch } from "./runtime-pane-protocol.js";
import type { NativePaneOwner } from "./runtime-pane-native.js";
export interface NativePaneConfig { instructionsFile?: string; mcp?: { nodePath: string; helperPath: string; connectionPath: string; configPath: string; tools: string[]; serverName: string }; cleanup(): void }
function realDirectory(path: string): void { const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("Pane configuration must stay in its owned directory"); }
/** Merge under an exclusive sibling lock, preserving all text outside this exact launch's block. */
function codexInstructions(cwd: string, marker: string, content: string | null): void {
  const file = join(cwd, "AGENTS.md"), lock = join(cwd, ".agend-pane-instructions.lock");
  mkdirSync(lock, { mode: 0o700 }); // An interrupted or competing writer holds rather than guessing ownership.
  try {
    let before = "", exists = false, mode = 0o600;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error("Workspace instructions are not a bounded regular file");
      mode = stat.mode & 0o777;
      const fd = openSync(file, "r");
      try { const opened = fstatSync(fd); if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > 1024 * 1024) throw Error("Workspace instructions changed while opening");
        const buffer = Buffer.alloc(1024 * 1024 + 1); let bytes = 0;
        for (;;) { const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes); bytes += count; if (!count || bytes === buffer.length) break; }
        if (bytes > 1024 * 1024) throw Error("Workspace instructions exceeded their read limit");
        const after = fstatSync(fd); if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw Error("Workspace instructions changed while reading");
        before = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes)); exists = true; }
      finally { closeSync(fd); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const begin = `<!-- AGEND-PANE:${marker}:BEGIN -->`, end = `<!-- AGEND-PANE:${marker}:END -->`;
    const start = before.indexOf(begin), finish = before.indexOf(end);
    if ((start < 0) !== (finish < 0) || start >= 0 && finish < start) throw Error("Owned workspace instruction marker is incomplete");
    let next = before;
    if (start >= 0) next = before.slice(0, start) + before.slice(finish + end.length).replace(/^\r?\n/, "");
    if (content !== null) {
      if (content.includes(begin) || content.includes(end)) throw Error("Workspace instructions contain an owned delimiter");
      next += `${next && !next.endsWith("\n") ? "\n" : ""}${begin}\n${content}\n${end}\n`;
    }
    if (next !== before && (exists || next)) atomicWriteFileSync(file, next, { mode });
  } finally { rmdirSync(lock); }
}
export function prepareNativePaneConfig(launch: RuntimePaneLaunch, owner: NativePaneOwner, nodePath: string, helperPath: string): NativePaneConfig {
  realDirectory(owner.directory);
  const parent = join(owner.directory, "launches"); mkdirSync(parent, { recursive: true, mode: 0o700 }); realDirectory(parent);
  const directory = join(parent, owner.launchId); mkdirSync(directory, { mode: 0o700 });
  const files: string[] = []; let markerWritten = false;
  // The host admits a new launch only after the previous owned process has positively exited.
  // A stable agent marker replaces instructions left by an interrupted worker, rather than accumulating stale blocks.
  const marker = launch.agentId;
  const config: NativePaneConfig = { cleanup: () => {
    if (markerWritten) { try { codexInstructions(launch.cwd, marker, null); markerWritten = false; } catch { /* Preserve user text when cleanup cannot prove the bounded marker. */ } }
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
    if (launch.instructions) {
      if (launch.cli === "codex") { codexInstructions(launch.cwd, marker, launch.instructions); markerWritten = true; }
      else config.instructionsFile = write("instructions.txt", launch.instructions);
    }
    return config;
  } catch (error) { config.cleanup(); throw error; }
}
