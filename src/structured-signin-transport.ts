/** Native adapter for the closed driver. Tests inject TerminalBackend; never a fleet pane. */
import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { fingerprintStore, storeWrittenSince } from "./credential-store-proof.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { TmuxTerminalBackend, shellQuote, segmentInput, type TerminalBackend } from "./web-terminal.js";
import type { StructuredSignInLaunch, StructuredSignInTransport } from "./structured-signin.js";
import { hostFacts, hostIds } from "./cli-registry.js";
import { credentialHomeSpec, credentialProfileArgs, credentialProfileEnv, credentialProfileHome, isCredentialProfileName, prepareCredentialProfileHome } from "./backend/credential-profile.js";

/**
 * Whether the account's folder is there, a real directory (never a link), with exactly this spelling (a case-insensitive disk finds `chy` for `CHY`, a case-sensitive one
 * would make a second folder). Nothing is created. This module stays light (the setup host loads it and must reach no agent code), so this is the folder check only; the
 * session's side (`accountFolderExists`, accounts-profiles.ts) adds AgEnD's-own checks and refuses before a run is reserved.
 */
function accountFolderThere(dataDir: string, backend: string, profile: string): boolean {
  try {
    const home = credentialProfileHome(dataDir, backend, profile), st = lstatSync(home);
    return st.isDirectory() && !st.isSymbolicLink() && readdirSync(dirname(home)).includes(profile);
  } catch { return false; }
}

/**
 * The backends whose NAMED accounts the dashboard signs in with the structured controls: Claude Code, whose login under a relocated `CLAUDE_CONFIG_DIR` was checked with
 * these controls, and Antigravity (AGEND-119), whose `agy --app_data_dir <folder> acp --login` was checked to keep the login in that folder (with the registry's `pin`). Deliberately not `CHAT_PROFILE_LOGIN_BACKENDS` (what chat's `/login <backend> <profile>` can sign in): widening that must not widen what these controls launch.
 */
export const STRUCTURED_PROFILE_BACKENDS: ReadonlySet<string> = new Set(hostIds("structuredSignIn").filter(id => hostFacts(id, "structuredSignIn")!.named));

/** Only host-selected paths/locale enter the dedicated CLI. No fleet/MCP/provider env injection. */
export function structuredSignInEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = { TERM: "xterm-256color", BROWSER: "false", EDITOR: "false", VISUAL: "false" };
  for (const key of ["HOME", "PATH", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_HOME"]) {
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
 * shared login. Throws `signin_profile_invalid` (not a name), `signin_profile_unsupported` (a backend whose login screen was not checked under a relocated home), `signin_profile_unknown` (no account folder with exactly this name) or
 * `signin_profile_failed` (the folder could not be made safely).
 */
export function structuredSignInProfileEnvironment(dataDir: string, backend: string, profile: string): Record<string, string> {
  if (typeof profile !== "string" || !isCredentialProfileName(profile)) throw new Error("signin_profile_invalid");
  const spec = credentialHomeSpec(backend);
  if (!spec || !STRUCTURED_PROFILE_BACKENDS.has(backend)) throw new Error("signin_profile_unsupported");
  // Add (Settings → Accounts → + Add account) is the only way an account is made, with its `exists` / `case_clash` / `unsafe_root` checks: a sign-in never makes a folder.
  if (!accountFolderThere(dataDir, backend, profile)) throw new Error("signin_profile_unknown");
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
  // AGEND-224 (review P1-2): for a NAMED account of a CLI told its account by an argument, the plain file that holds its sign-in in the account's own folder. After the command has ended with exit 0 the
  // account is connected only if that file is there (the Runtime's `signInStatus` does the same): a CLI that stopped honouring the pin would have kept the login in the system keyring, i.e. in every
  // folder's, and `agy models` would still say "connected".
  let keptIn: (() => boolean) | null = null;
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
        let argv: readonly string[] = spec.argv;
        if (spec.profile !== undefined) {
          if (!options.backend || !options.dataDir) throw new Error("signin_profile_unsupported");
          Object.assign(environment, structuredSignInProfileEnvironment(options.dataDir, options.backend, spec.profile));
          // AGEND-119: a CLI told its account by an argument (agy --app_data_dir <folder> acp --login) gets it right after the binary; the folder is the one the check above made.
          const args = credentialProfileArgs(options.dataDir, options.backend, spec.profile);
          if (args.length) {
            argv = [spec.argv[0]!, ...args, ...spec.argv.slice(1)];
            const facts = hostFacts(options.backend, "namedAccounts"), backend = options.backend, dataDir = options.dataDir, profile = spec.profile;
            const store = facts && facts.home === "launch-argument" ? facts.store : null;
            // AGEND-250 (review P2-1): the proof is bound to THIS attempt. The file as it is right now (an earlier attempt's, possibly expired, file may be there) is fingerprinted; the
            // login only counts when the folder holds a plain file that is not that one. Nothing is removed, so a failed attempt keeps the account's previous credential. No store name = fail closed.
            const storePath = store ? join(credentialProfileHome(dataDir, backend, profile), store) : null;
            const before = storePath ? fingerprintStore(storePath) : null;
            keptIn = () => !!storePath && storeWrittenSince(storePath, before);
          }
        }
        const envArgs = Object.entries(environment).map(([key, value]) => shellQuote(`${key}=${value}`)).join(" ");
        // Exec closes the shell boundary after the fixed login command exits.
        // Neither this spec nor env values come from browser-provided bytes.
        const login = "exec " + argv.map(shellQuote).join(" ");
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
      if (keptIn && !status.alive && status.exitCode === 0 && !keptIn()) return { ...status, isolated: false as const };
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
