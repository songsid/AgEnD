/** Native adapter for the closed driver. Tests inject TerminalBackend; never a fleet pane. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { TmuxTerminalBackend, shellQuote, segmentInput, type TerminalBackend } from "./web-terminal.js";
import type { StructuredSignInLaunch, StructuredSignInTransport } from "./structured-signin.js";
import { credentialHomeSpec, credentialProfileEnv, credentialProfileHome, isCredentialProfileName, prepareCredentialProfileHome } from "./backend/credential-profile.js";

/**
 * The backends whose NAMED accounts the dashboard signs in with the structured controls: Claude Code's only, whose login under a relocated `CLAUDE_CONFIG_DIR` was checked with
 * these controls. Deliberately not `CHAT_PROFILE_LOGIN_BACKENDS` (what chat's `/login <backend> <profile>` can sign in): widening that must not widen what these controls launch.
 */
export const STRUCTURED_PROFILE_BACKENDS: ReadonlySet<string> = new Set(["claude-code"]);

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

/**
 * #3212: what a NAMED account's sign-in on this host adds to the environment. The same folder and variable the other profile sign-in (login-controller) and an
 * agent's launch use (`credentialProfileEnv`: `CLAUDE_CONFIG_DIR=<dataDir>/credential-profiles/claude-code/<name>`), so the login lands in that profile's own folder and
 * the default account's files are never touched. Only a NAME comes in (the closed profile-name check, no trimming, no path); the variable and the folder are this
 * module's. The folder is prepared as a launch prepares it (links, seeded settings, a symlinked home refused), so a profile is never signed in through a link to the
 * shared login. Throws `signin_profile_invalid` (not a name), `signin_profile_unsupported` (a backend whose login screen was not checked under a relocated home) or
 * `signin_profile_failed` (the folder could not be made safely).
 */
export function structuredSignInProfileEnvironment(dataDir: string, backend: string, profile: string): Record<string, string> {
  if (typeof profile !== "string" || !isCredentialProfileName(profile)) throw new Error("signin_profile_invalid");
  const spec = credentialHomeSpec(backend);
  if (!spec || !STRUCTURED_PROFILE_BACKENDS.has(backend)) throw new Error("signin_profile_unsupported");
  try { prepareCredentialProfileHome(spec, credentialProfileHome(dataDir, backend, profile)); } catch { throw new Error("signin_profile_failed"); }
  const env = credentialProfileEnv(dataDir, backend, profile);
  if (!env) throw new Error("signin_profile_unsupported");
  return env;
}

export interface StructuredSignInTransportOptions {
  native?: TerminalBackend;
  env?: NodeJS.ProcessEnv;
  /** #3212: with these two, a launch that carries a `profile` signs that named account in (above). Without them a profile is refused, never dropped. */
  backend?: string;
  dataDir?: string;
}

export function createStructuredSignInTransport(options: StructuredSignInTransportOptions = {}): StructuredSignInTransport {
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
        // A named profile (#3212) is signed in here with that profile's own folder and variable; a transport that was not given its backend and data
        // directory cannot say where that is, so it refuses: a profile is never silently dropped (that would sign the DEFAULT account in).
        const environment = structuredSignInEnvironment(options.env ?? process.env);
        if (spec.profile !== undefined) {
          if (!options.backend || !options.dataDir) throw new Error("signin_profile_unsupported");
          Object.assign(environment, structuredSignInProfileEnvironment(options.dataDir, options.backend, spec.profile));
        }
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
