/** One ConPTY per owned helper process. Natural CLI exit must also retire node-pty's native pipe workers. */
import { promisify } from "node:util";
import { execFile } from "./child-process.js";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IPty } from "node-pty";
import type {} from "./windows-pane-mcp.js";
import type {} from "./transcript-records.js";
import type {} from "./transcript-needles.js";
import type {} from "./runtime-pane-transcript.js";
import { findCli, nativeCliEnvironment, validWindowsDirectory, validWindowsAgentId } from "./windows-cli-worker.js";
import { withCredentialProfile } from "./runtime-credential-profiles.js";
import { validateRuntimePaneLaunch } from "./runtime-pane-protocol.js";
import { prepareNativePaneConfig, type NativePaneConfig } from "./runtime-pane-config.js";
import { validatePaneMcpOwner } from "./runtime-pane-mcp-protocol.js";
import { validateNativeMcpConnection, nativeUpdateGuard } from "./windows-cli-providers.js";
import { assertRunnableNativePaneVersion, assertNativePaneCommandLine, persistentNativeArguments, type NativePaneFrame, type NativePaneOwner } from "./runtime-pane-native.js";

export async function nativePaneWorker(): Promise<void> {
  if (process.platform !== "win32") throw Error("ConPTY helper requires native Windows Node");
  let config: NativePaneConfig | undefined;
  let pty: IPty | undefined, started = false, finished = false, disconnected = false, closing = false, bytes = 0;
  const emit = (frame: NativePaneFrame): void => {
    const text = JSON.stringify(frame) + "\n";
    bytes += Buffer.byteLength(text);
    if (bytes > 1024 * 1024) { pty?.kill(); return; }
    const writable = process.stdout.write(text, () => { bytes -= Buffer.byteLength(text); });
    if (!writable) { pty?.pause(); process.stdout.once("drain", () => pty?.resume()); }
  };
  const close = (): void => {
    disconnected = true;
    if (!finished && !closing && pty) { closing = true; pty.kill(); }
  };
  process.once("SIGTERM", close); process.once("SIGINT", close);
  const lines = createInterface({ input: process.stdin });
  lines.on("close", () => { disconnected = true; close(); });
  process.stdout.on("error", () => { close(); if (finished) process.exit(0); });
  lines.on("line", line => {
    if (line.length > 192 * 1024) { close(); return; }
    void (async () => {
      const value = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid helper command");
      if (!started) {
        if (value.type !== "start" || Object.keys(value).some(key => !["type", "launch", "owner"].includes(key))) throw Error("Helper start required");
        started = true;
        const launch = validateRuntimePaneLaunch(value.launch);
        if (!value.owner || typeof value.owner !== "object" || Object.keys(value.owner).some(key => !["directory", "launchId", "mcp", "credentialHome"].includes(key))
          || !validWindowsDirectory(value.owner.directory) || !validWindowsAgentId(value.owner.launchId)) throw Error("Invalid helper owner");
        const owner: NativePaneOwner = { directory: value.owner.directory as string, launchId: value.owner.launchId as string };
        // The launch names a profile only when the host resolved it: both must agree, and the folder must be a native directory.
        if ((launch.credentialProfile === undefined) !== (value.owner.credentialHome === undefined)) throw Error("Pane credential profile folder is missing or unexpected");
        if (value.owner.credentialHome !== undefined) {
          if (!validWindowsDirectory(value.owner.credentialHome) || !statSync(value.owner.credentialHome).isDirectory()) throw Error("Invalid pane credential profile folder");
          owner.credentialHome = value.owner.credentialHome as string;
        }
        // One environment for the version check and the CLI: with a profile its folder replaces any ambient config directory, never combines with it.
        const environment = (): NodeJS.ProcessEnv => owner.credentialHome ? withCredentialProfile(nativeCliEnvironment(), launch.cli, owner.credentialHome) : nativeCliEnvironment();
        if (value.owner.mcp) {
          const mcp = value.owner.mcp;
          if (typeof mcp !== "object" || Object.keys(mcp).some(key => !["owner", "endpoint", "token", "tools"].includes(key))) throw Error("Invalid pane MCP owner");
          owner.mcp = { ...validateNativeMcpConnection({ endpoint: mcp.endpoint, token: mcp.token, tools: mcp.tools }), owner: validatePaneMcpOwner(mcp.owner) };
        }
        const actual = realpathSync(launch.cwd);
        if (!statSync(actual).isDirectory() || actual.replace(/[\\/]+$/, "").toLowerCase() !== launch.cwd.replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase()) throw Error("Pane workspace must be an existing canonical directory");
        const executable = await findCli(launch.cli);
        if (!executable) throw Error("Configured Windows CLI is not installed");
        const binding = await import("node-pty");
        if (disconnected || finished) throw Error("Pane helper was disconnected before launch");
        config = prepareNativePaneConfig(launch, owner, process.execPath, join(dirname(fileURLToPath(import.meta.url)), "windows-pane-mcp.js"));
        // The bundled ConPTY DLL owns a stable process HANDLE; it avoids the OS-backend's late PID enumeration.
        const args = [...executable.args, ...persistentNativeArguments(launch, config)];
        assertNativePaneCommandLine(executable.command, args);
        // This is a bounded version-only check inside the owned Job, not inventory/auth/model discovery.
        // An out-of-band CLI update must not run newer terminal layouts under a stale cached inventory.
        const version=await promisify(execFile)(executable.command,[...executable.args,...nativeUpdateGuard(launch.cli),"--version"],{
          cwd:actual,env:{...environment(),NO_COLOR:"1"},timeout:30_000,maxBuffer:4096,encoding:"utf8",windowsHide:true,shell:false,
        });
        assertRunnableNativePaneVersion(launch.cli,String(version.stdout));
        if(disconnected||finished)throw Error("Pane helper was disconnected before version verification");
        pty = binding.spawn(executable.command, args, {
          cwd: actual, cols: launch.columns, rows: launch.rows, name: "xterm-256color", useConpty: true, useConptyDll: true,
          env: { ...environment(), TERM: "xterm-256color", COLORTERM: "truecolor" },
        });
        pty.onData(data => {
          for (let start = 0; start < data.length;) {
            let end = Math.min(data.length, start + 8192);
            if (end < data.length && /[\ud800-\udbff]/.test(data[end - 1])) end--;
            emit({ type: "output", data: data.slice(start, end) }); start = end;
          }
        });
        pty.onExit(({ exitCode }) => {
          finished = true;
          config?.cleanup();
          lines.close();
          // Only the helper exits here: the CLI's own terminal exit was observed first.
          process.stdout.write(JSON.stringify({ type: "exit", code: exitCode } satisfies NativePaneFrame) + "\n", () => process.exit(0));
        });
        emit({ type: "ready", pid: pty.pid });
        return;
      }
      if (!pty || finished) throw Error("Pane helper is not ready");
      switch (value.type) {
        case "input":
          if (Object.keys(value).some(key => !["type", "data"].includes(key)) || typeof value.data !== "string" || Buffer.byteLength(value.data) > 128 * 1024) throw Error("Invalid helper input");
          pty.write(value.data); break;
        case "resize":
          if (Object.keys(value).some(key => !["type", "columns", "rows"].includes(key)) || !Number.isInteger(value.columns) || value.columns < 40 || value.columns > 300 || !Number.isInteger(value.rows) || value.rows < 10 || value.rows > 120) throw Error("Invalid helper resize");
          pty.resize(value.columns, value.rows); break;
        case "pause": case "resume": case "close":
          if (Object.keys(value).some(key => key !== "type")) throw Error("Invalid helper control");
          if (value.type === "pause") pty.pause(); else if (value.type === "resume") pty.resume(); else close();
          break;
        default: throw Error("Unknown helper command");
      }
    })().catch(() => {
      emit({ type: "error", message: "ConPTY helper failed; its process outcome must be reconciled" });
      if (pty) close(); else { config?.cleanup(); process.stdout.write("", () => process.exit(1)); }
    });
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void nativePaneWorker().catch(() => { process.stderr.write("ConPTY helper could not start\n"); process.exitCode = 1; });
}
