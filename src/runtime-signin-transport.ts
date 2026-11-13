/**
 * #3190 Part 3c: the server's side of a sign-in on a paired computer. It implements `StructuredSignInTransport` (the one sign-in implementation, structured-signin.ts)
 * for ONE computer and ONE credential profile, over the existing authenticated Runtime connection, in `account.request` frames (never `request`: the
 * coordinator journals every `request`, and a sign-in link or code must not reach the disk).
 *
 *  - `start(spec)`: `spec.argv` is mapped to a CLI id by EXACT match against a closed table, and only `{cli, profile, method, actor}` is sent. The server never
 *    sends an argv, a command, a path or an environment, and the profile is a NAME. A re-login ("logout first") is refused: signing out is its own, confirmed operation.
 *  - `capture()`: the Runtime's reduced screen, read through the same closed table once more here, so a line outside it (an e-mail address in a success line)
 *    cannot reach the sign-in view even from a Runtime that did not reduce it.
 *  - `write(input)`: the driver's own rule again (printable ASCII, a code's characters, one line) before it is sent.
 *  - `close()`: ends exactly the sign-in this transport started and answers only when the Runtime says it is gone (or that it is no longer running).
 *  - `checkAuth` (`runtimeCheckAuth`): the CLI's own `auth status` for that profile on the computer, as a masked identity; text alone is never success.
 *
 * Antigravity (AGEND-113) is the one CLI with no profile: its login on Windows is one entry in the Credential Manager, so its sign-in is the computer's own default login. For it
 * `profile` is absent from the options and from the frames (`{cli, method, actor}`), and `accounts.check` is asked as `{cli}`. Every other CLI still needs the profile NAME.
 *
 * Nothing from a reply is logged here, and errors are fixed words: a URL, a code, output or an e-mail address cannot travel in one.
 */
import type { StructuredSignInLaunch, StructuredSignInTransport } from "./structured-signin.js";
import type { AuthCheckResult } from "./login-flows.js";
import { parseAccountIdentity, type AccountIdentity } from "./claude-auth-status.js";
import { reduceLoginScreen, type SignInCli } from "./runtime-signin.js";
import { isRuntimeDefaultLoginCli, runtimeFacts, runtimeIds, type RuntimeDefaultLoginCli } from "./cli-registry.js";
import { isCredentialProfileCli, validCredentialProfileName, type CredentialProfileCli } from "./runtime-credential-profiles.js";
import type { RuntimeRemoteOperation, RuntimeRemotePayloads } from "./runtime-protocol.js";

/** Sends one `account.request` to a computer (`RuntimeCoordinator.callAccount`) and gives back its reply. */
export type AccountCaller = <K extends RuntimeRemoteOperation>(machineId: string, operation: K, payload: RuntimeRemotePayloads[K], timeoutMs?: number) => Promise<unknown>;

/**
 * The sign-ins a computer can run for the dashboard: the CLI's id, and the exact argv `StructuredSignIn` launches for it. Only subscription sign-ins (the Runtime refuses Console).
 * Derived from the registry (cli-registry.ts: `runtime.signIn`; pinned, literally, by tests/cli-registry-golden.test.ts): Claude Code's is a named profile's; Antigravity's
 * (`agy acp --login`, agy >= 1.5.0) is the computer's own login (`profile: "none"`).
 */
export const RUNTIME_SIGNIN_CLIS: Readonly<Record<string, readonly string[]>> = Object.freeze(
  Object.fromEntries(runtimeIds("signIn").map(id => [id, Object.freeze([...runtimeFacts(id, "signIn")!.argv])])));
const MAX_SCREEN = 16 * 1024;
const SESSION_ID = /^[a-f0-9]{32}$/;
/** What the Runtime says when a sign-in it is asked about is not (or no longer) the one it is running: the child is gone, which is what `close()` must prove. */
const NO_LONGER_RUNNING = /no longer running/i;
/** What the Runtime says for a profile folder it does not have yet (a new account is created by its first sign-in): not signed in, not an error. */
export const PROFILE_DOES_NOT_EXIST = /does not exist on this computer/i;
/** What a Runtime's refusal begins with when it could not prove an account's sign-in stays in the account's own folder (runtime-remote-accounts.ts `proveIsolated`). */
export const NOT_ISOLATED = /^not_isolated:/;

function cliOf(argv: readonly string[]): string | null {
  for (const [cli, known] of Object.entries(RUNTIME_SIGNIN_CLIS)) if (argv.length === known.length && argv.every((word, index) => word === known[index])) return cli;
  return null;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export interface RuntimeSignInTransportOptions {
  machineId: string;
  /** The credential profile NAME on that computer. Absent for the computer's OWN login of a CLI that has one (Antigravity's default login). */
  profile?: string;
  /** The name the computer's audit log records for the person who asked (`admin:<handle>`). */
  actor: string;
  call: AccountCaller;
}

export function createRuntimeSignInTransport(options: RuntimeSignInTransportOptions): StructuredSignInTransport {
  const { machineId, profile, actor, call } = options;
  let sessionId: string | null = null;
  let started: SignInCli | null = null;
  let closed = false;
  const guard = (signal?: AbortSignal): void => { if (closed || signal?.aborted) throw new Error("signin_cancelled"); };
  const live = (): string => { if (!sessionId) throw new Error("signin_not_started"); return sessionId; };
  return {
    async start(spec: StructuredSignInLaunch, signal: AbortSignal): Promise<void> {
      guard(signal);
      const cli = cliOf(spec.argv);
      // A request with a profile name is a NAMED account's (a CLI with named accounts on a computer); one without is the computer's OWN login, and only a CLI whose spec has one (Antigravity) may be signed in
      // that way: it REPLACES that Windows user's login, so a CLI that needs a name is never signed in without one.
      const bare = profile === undefined;
      if (!cli || spec.logoutArgv || (bare ? !isRuntimeDefaultLoginCli(cli) || spec.profile !== undefined : spec.profile !== profile || !validCredentialProfileName(profile) || !isCredentialProfileCli(cli))) throw new Error("signin_unsupported");
      let answer: unknown;
      try { answer = await call(machineId, "signin.start", bare ? { cli, method: "subscription", actor } : { cli, profile: profile!, method: "subscription", actor }); }
      catch (error) {
        // The Runtime could not show that an account's sign-in stays in its own folder (it keeps one for every folder): nothing was started, and the dialog says that, not a generic failure.
        if (error instanceof Error && NOT_ISOLATED.test(error.message)) throw new Error("not_isolated");
        throw error;
      }
      started = cli as SignInCli;
      const id = record(answer) ? answer.sessionId : undefined;
      if (typeof id !== "string" || !SESSION_ID.test(id)) throw new Error("signin_protocol");
      sessionId = id;                                 // from here the Runtime holds a child: close() must end it, whatever happens next
      guard(signal);
    },
    async capture(): Promise<string> {
      guard();
      const answer = await call(machineId, "signin.capture", { sessionId: live() });
      const screen = record(answer) ? answer.screen : undefined;
      if (typeof screen !== "string" || screen.length > MAX_SCREEN) throw new Error("signin_protocol");
      // The closed table again, on this side: only the URL (https, an allowed host), the code prompt and the fixed outcome lines survive.
      if (!started) throw new Error("signin_not_started");
      return reduceLoginScreen(started, screen);
    },
    async status(): Promise<{ alive: boolean; exitCode?: number; isolated?: false }> {
      guard();
      const answer = await call(machineId, "signin.status", { sessionId: live() });
      if (!record(answer) || typeof answer.alive !== "boolean" || (answer.exitCode !== undefined && !Number.isInteger(answer.exitCode)) || (answer.isolated !== undefined && answer.isolated !== false)) throw new Error("signin_protocol");
      return { alive: answer.alive, ...(answer.exitCode !== undefined ? { exitCode: answer.exitCode as number } : {}), ...(answer.isolated === false ? { isolated: false as const } : {}) };
    },
    async write(input: string, signal: AbortSignal): Promise<void> {
      guard(signal);
      // The driver sends "\x15" + a code + "\r". Anything else (menu keys, a second line, a control byte) is not a sign-in code.
      const code = input.replace(/^\x15/, "").replace(/\r$/, "");
      if (!code || code.length > 4096 || !/^[A-Za-z0-9._~+/#=-]+$/.test(code)) throw new Error("signin_input");
      const answer = await call(machineId, "signin.write", { sessionId: live(), input: `\x15${code}\r` });
      if (!record(answer) || answer.accepted !== true) throw new Error("signin_protocol");
      guard(signal);
    },
    async close(): Promise<void> {
      closed = true;
      const id = sessionId;
      if (!id) return;                                 // nothing was started on that computer
      try { await call(machineId, "signin.close", { sessionId: id }); }
      catch (error) {
        // "No longer running" is the answer of a Runtime that has already ended it (its timeout, a switch turned off, a connection that changed): gone.
        if (error instanceof Error && NO_LONGER_RUNNING.test(error.message)) { sessionId = null; return; }
        throw new Error("signin_close_unconfirmed");   // offline or no answer: the child is not shown gone, so the caller keeps its reservation
      }
      sessionId = null;
    },
  };
}

/**
 * Antigravity's own login on a computer (`agy models` by its exit code, read on that computer): signed in, signed out, or unknown. No identity: agy's answer has no account in it and
 * nothing is shown. Any reply that is not exactly true or false is unknown.
 */
export async function runtimeDefaultLoginStatus(call: AccountCaller, machineId: string, cli: RuntimeDefaultLoginCli): Promise<{ state: AuthCheckResult }> {
  let answer: unknown;
  try { answer = await call(machineId, "accounts.check", { cli }); } catch { return { state: "unknown" }; }
  if (!record(answer) || ![true, false, null].includes(answer.loggedIn as boolean | null)) return { state: "unknown" };
  return { state: answer.loggedIn === true ? "valid" : answer.loggedIn === false ? "invalid" : "unknown" };
}

/** The CLI's own `auth status` for one profile on a computer: signed in (masked identity), signed out, or unknown. A profile with no folder yet is signed out. */
export async function runtimeAccountStatus(call: AccountCaller, machineId: string, profile: string, cli: CredentialProfileCli = "claude-code"): Promise<{ state: AuthCheckResult; identity?: AccountIdentity }> {
  let answer: unknown;
  try { answer = await call(machineId, "accounts.check", { cli, profile }); }
  catch (error) { return { state: error instanceof Error && PROFILE_DOES_NOT_EXIST.test(error.message) ? "invalid" : "unknown" }; }
  if (!record(answer) || ![true, false, null].includes(answer.loggedIn as boolean | null)) return { state: "unknown" };
  if (answer.loggedIn !== true) return { state: answer.loggedIn === false ? "invalid" : "unknown" };
  // Only the masked form is accepted: anything else is a protocol error, and is not shown.
  let identity: AccountIdentity | undefined;
  try { identity = answer.identity === undefined ? undefined : parseAccountIdentity(answer.identity); } catch { return { state: "unknown" }; }
  return { state: "valid", ...(identity ? { identity } : {}) };
}
