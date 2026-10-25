/** Native adapter for the closed driver. Tests inject TerminalBackend; never a fleet pane. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TmuxTerminalBackend, shellQuote, segmentInput, type TerminalBackend } from "./web-terminal.js";
import type { StructuredSignInLaunch, StructuredSignInTransport } from "./structured-signin.js";

/** Only host-selected paths/locale enter the dedicated CLI. No fleet/MCP/provider env injection. */
export function structuredSignInEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = { TERM: "xterm-256color", BROWSER: "false", EDITOR: "false", VISUAL: "false" };
  for (const key of ["HOME", "PATH", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
    const value = env[key];
    if (value && !/[\0\r\n]/.test(value)) result[key] = value;
  }
  if (!result.HOME || !result.PATH) throw new Error("signin_environment_unavailable");
  return result;
}

export function createStructuredSignInTransport(options: { native?: TerminalBackend; env?: NodeJS.ProcessEnv } = {}): StructuredSignInTransport {
  const native = options.native ?? new TmuxTerminalBackend();
  const socket = `agend-signin-${randomBytes(16).toString("hex")}`;
  let dir: string | null = null, touched = false, closed = false;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = chain.then(fn); chain = result.catch(() => {}); return result;
  };
  const guard = (signal?: AbortSignal) => { if (closed || signal?.aborted) throw new Error("signin_cancelled"); };
  return {
    start(spec: StructuredSignInLaunch, signal: AbortSignal) {
      return serial(async () => {
        guard(signal);
        const environment = structuredSignInEnvironment(options.env ?? process.env);
        const envArgs = Object.entries(environment).map(([key, value]) => shellQuote(`${key}=${value}`)).join(" ");
        // Exec closes the shell boundary after the fixed login command exits.
        // Neither this spec nor env values come from browser-provided bytes.
        const login = "exec " + spec.argv.map(shellQuote).join(" ");
        const command = spec.logoutArgv ? spec.logoutArgv.map(shellQuote).join(" ") + " && " + login : login;
        dir = mkdtempSync(join(tmpdir(), "agend-signin-"));
        touched = true;
        await native.start({ socket, command: `exec env -i ${envArgs} sh -c ${shellQuote(command)}`, cwd: dir,
          cols: 180, rows: 48, onOutput: () => {}, signal });
        guard(signal);
      });
    },
    capture() { return serial(async () => { guard(); return native.capture(socket); }); },
    status() { return serial(async () => {
      guard(); const status = await native.paneStatus(socket);
      if (!status) throw new Error("signin_status_unknown");
      return status;
    }); },
    write(input, signal) { return serial(async () => {
      for (const run of segmentInput(Buffer.from(input, "utf8"))) {
        guard(signal); await native.sendInput(socket, run.bytes); guard(signal);
      }
    }); },
    async close() {
      closed = true;
      await chain;
      if (touched) await native.kill(socket); // a rejected reap retains directory + driver claim
      if (dir) { rmSync(dir, { recursive: true, force: true }); dir = null; }
    },
  };
}
