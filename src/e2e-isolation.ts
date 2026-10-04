/**
 * The gate a real-platform end-to-end run goes through BEFORE it starts anything.
 *
 * An e2e run drives a scratch fleet with real bot tokens. The one way that goes badly wrong is not a test
 * failing — it is the scratch fleet reaching the LIVE one. It has happened: a "throwaway" fleet started with a
 * changed HOME resolved to tmux's default socket, attached to the live server, and its startup cleanup killed
 * sixteen live windows as orphans (2026-10-03). `AGEND_HOME` isolates the tmux socket, the lock file, the pid
 * file, the IPC sockets and the databases; it does NOT isolate the health port (default 19280, and the CLI
 * treats "something answers there" as "the fleet is running"), `AGEND_PORT`, per-user CLI state, the
 * per-user service unit, or the credentials the child inherits.
 *
 * So this module does two things, both pure (no process is started, no file is written, nothing here ever
 * reads or changes the real process environment):
 *
 *  - `planScratchRun` decides, from a requested scratch directory and port, the ONE layout and the ONE child
 *    environment a scratch run may use, and refuses — with every violated rule, not just the first — when any
 *    guarantee cannot be proven. The child environment is built from an allowlist, never copied: a live token,
 *    an AWS key or the real AGEND_HOME in the runner's own environment cannot reach the child.
 *  - `planTeardown` produces the only command a run may use to clean up: a tmux `kill-server` against a socket
 *    that is proven to live inside the scratch directory.
 *
 * Everything the checks need from the machine (the user's real AgEnD home, realpath, the uid, the temp root)
 * is an injectable seam, so every refusal is exercised with fake values and no real directory.
 *
 * An `ok` is a decision about paths as they were when it was made, not a sandbox: a path can be swapped for a
 * symlink between the plan and the start. The runner must own the scratch directory (create it itself, private to
 * the user, never accept one it did not make) and call `planScratchRun` again immediately before it executes
 * anything, and `planTeardown` immediately before it cleans up. A fact that cannot be established (a path that
 * cannot be resolved, an unknown live home) is a refusal, never an assumption.
 */
import { lstatSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { realDefaultAgendHome, tmuxSessionNameFor, tmuxSocketNameFor } from "./paths.js";
import { UNIX_SOCKET_PATH_MAX } from "./channel/ipc-bridge.js";

/** The live fleet's default health port. A scratch fleet must never use it. */
export const LIVE_HEALTH_PORT = 19280;
/** The longest instance name the layout is checked against: `<home>/instances/<name>/channel.sock` must still fit a unix socket. */
export const INSTANCE_NAME_BUDGET = 40;
/** What a scratch token variable must look like: never a name a live fleet could be using. */
export const SCRATCH_TOKEN_VAR = /^E2E_[A-Z0-9_]+$/;
/** Knobs the mock backend reads; the only other variables a run may add to the child environment. */
const MOCK_KNOB = /^MOCK_[A-Z0-9_]+$/;
/** Variables copied from the runner's environment, and nothing else. */
const PASSTHROUGH = ["PATH", "LANG", "LC_ALL", "TERM"] as const;

export type Rule =
  | "scratch-root" | "scratch-not-live" | "real-home-unknown" | "home-not-live" | "tmux-socket-default" | "tmux-session-live"
  | "socket-path-length" | "health-port" | "token-var" | "env-forbidden" | "command-forbidden" | "teardown-target"
  | "path-unresolved" | "layout-escapes" | "config-token-var" | "config-backend" | "config-agent-mode" | "config-quiet" | "config-health-port" | "config-access" | "config-webhooks";

export interface Violation { rule: Rule; detail: string }

/** Everything that depends on the machine, injectable so a refusal can be tested with a made-up machine. */
export interface Seams {
  /** The live fleet's data directory (`<passwd home>/.agend`); null when it cannot be determined — then nothing is proven. */
  realAgendHome?: string | null;
  realpath?: (path: string) => string;
  /** Where scratch runs may live; the scratch directory must be inside it. */
  tmpRoot?: string;
  livePorts?: readonly number[];
  uid?: number;
}

export interface ScratchRequest {
  /** A directory the runner created for this run, absolute and under the temp root. */
  scratchDir: string;
  /** The runner's own environment. Read-only; only the allowlisted names (and the named token variables) are ever taken from it. */
  parentEnv: Readonly<Record<string, string | undefined>>;
  healthPort: number;
  /** NAMES of scratch token variables to hand through (values are looked up in `parentEnv`). */
  tokenVars?: readonly string[];
  /** Extra variables the run wants set (`MOCK_*` knobs only). */
  extraEnv?: Readonly<Record<string, string>>;
  /** The command the runner means to execute in that environment. */
  command?: readonly string[];
}

export interface ScratchLayout {
  scratchDir: string;
  /** `AGEND_HOME` for the child. */
  agendHome: string;
  /** `TMUX_TMPDIR` for the child: even a mistaken "default socket" would be this directory's, not the live one's. */
  tmuxTmpdir: string;
  /** `HOME` for the child, so per-user CLI state (~/.claude, ~/.codex …) is the scratch run's own. */
  userHome: string;
}

export interface ScratchPlan {
  layout: ScratchLayout;
  childEnv: Record<string, string>;
  healthPort: number;
  socketName: string;
  sessionName: string;
  /** Where tmux will put the scratch server's socket: `<TMUX_TMPDIR>/tmux-<uid>/<name>`. */
  tmuxSocketPath: string;
  tokenVars: readonly string[];
}

export type PlanResult = { ok: true; plan: ScratchPlan } | { ok: false; violations: Violation[] };

export class IsolationError extends Error {
  constructor(readonly violations: Violation[]) {
    super(`scratch run refused: ${violations.map(v => `${v.rule} (${v.detail})`).join("; ")}`);
    this.name = "IsolationError";
  }
}

function defaultSeams(seams: Seams): Required<Seams> {
  return {
    realAgendHome: seams.realAgendHome !== undefined ? seams.realAgendHome : realDefaultAgendHome(),
    realpath: seams.realpath ?? realpathOfNearestAncestor,
    tmpRoot: seams.tmpRoot ?? tmpdir(),
    livePorts: seams.livePorts ?? [LIVE_HEALTH_PORT],
    uid: seams.uid ?? (typeof process.getuid === "function" ? process.getuid() : userInfo().uid),
  };
}

/**
 * `realpath`, but for a path that need not exist yet: resolve the nearest existing ancestor and re-attach the rest.
 * Only a path that is certainly MISSING is climbed past. A dangling symlink, an unreadable directory (EACCES), a
 * symlink loop (ELOOP) or a file in the middle of the path (ENOTDIR) throws: a fact the check cannot establish
 * is a refusal, never an assumption that the path is harmless.
 */
function realpathOfNearestAncestor(path: string): string {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return rest.length === 0 ? realpathSync.native(current) : join(realpathSync.native(current), ...rest.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      try {
        lstatSync(current);
        throw Object.assign(new Error(`${current} is a dangling symlink`), { code: "ELOOP" });
      } catch (lstatErr) {
        if ((lstatErr as NodeJS.ErrnoException).code !== "ENOENT") throw lstatErr;
      }
      const parent = dirname(current);
      if (parent === current) return path;            // nothing exists: nothing can be a symlink either
      rest.push(basename(current));
      current = parent;
    }
  }
}

/** Resolve `path` with the seam; a path that cannot be resolved is a violation, and null. */
function resolveOrRefuse(s: Required<Seams>, path: string, what: string, out: Violation[]): string | null {
  try {
    return s.realpath(path);
  } catch (err) {
    out.push({ rule: "path-unresolved", detail: `${what} ${path} cannot be resolved (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}); an unproven path is refused` });
    return null;
  }
}

const isInside = (inner: string, outer: string): boolean => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);
const isStrictlyInside = (inner: string, outer: string): boolean => inner !== outer && isInside(inner, outer);

export function layoutFor(scratchDir: string): ScratchLayout {
  // Short names on purpose: `<home>/instances/<name>/channel.sock` has to fit a unix socket path (~108 bytes).
  return { scratchDir, agendHome: join(scratchDir, "ag"), tmuxTmpdir: join(scratchDir, "tm"), userHome: join(scratchDir, "hm") };
}

/** The directory a scratch run's own files live under must be provably the scratch run's. */
function checkScratchDir(scratchDir: string, s: Required<Seams>, out: Violation[]): void {
  if (!isAbsolute(scratchDir) || scratchDir !== resolve(scratchDir)) {
    out.push({ rule: "scratch-root", detail: `scratch directory must be an absolute, normalised path (got ${JSON.stringify(scratchDir)})` });
    return;
  }
  const root = resolveOrRefuse(s, s.tmpRoot, "the temp root", out);
  const real = resolveOrRefuse(s, scratchDir, "the scratch directory", out);
  if (root === null || real === null) return;
  if (!isStrictlyInside(real, root)) {
    out.push({ rule: "scratch-root", detail: `${real} is not a directory inside ${root}` });
  }
  if (s.realAgendHome !== null) {
    const live = resolveOrRefuse(s, s.realAgendHome, "the live AgEnD home", out);
    if (live === null) return;
    // Inside the live home, equal to it, or a parent of it (a scratch run rooted above the live fleet could be told to clean up inside it).
    if (isInside(real, live) || isInside(live, real)) {
      out.push({ rule: "scratch-not-live", detail: `${real} overlaps the live AgEnD home ${live}` });
    }
  }
}

/**
 * Every path the child is handed (its AGEND_HOME, HOME, TMUX_TMPDIR and the tmux socket) must resolve to a place
 * strictly inside the scratch directory and clear of the live home. A symlink at `<scratch>/ag` or `<scratch>/tm` that
 * points elsewhere would otherwise carry the run's data, credentials or tmux server out of the isolation. The
 * scratch directory itself is proven clear of the live home by `checkScratchDir`, so staying strictly inside it is
 * also staying clear of the live home.
 */
function checkLayoutContained(layout: ScratchLayout, tmuxSocketPath: string, s: Required<Seams>, out: Violation[]): void {
  const scratch = resolveOrRefuse(s, layout.scratchDir, "the scratch directory", out);
  if (scratch === null) return;
  const parts: Array<[string, string]> = [
    ["AGEND_HOME", layout.agendHome], ["HOME", layout.userHome], ["TMUX_TMPDIR", layout.tmuxTmpdir],
    ["the tmux socket directory", dirname(tmuxSocketPath)], ["the tmux socket", tmuxSocketPath],
  ];
  for (const [what, path] of parts) {
    const real = resolveOrRefuse(s, path, what, out);
    if (real === null) continue;
    // Staying strictly inside a scratch directory that `checkScratchDir` has already proven clear of the live home
    // is also staying clear of it.
    if (!isStrictlyInside(real, scratch)) {
      out.push({ rule: "layout-escapes", detail: `${what} ${path} resolves to ${real}, outside the scratch directory ${scratch}` });
    }
  }
}

function checkPort(port: number, s: Required<Seams>, out: Violation[]): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    out.push({ rule: "health-port", detail: `${String(port)} is not a usable unprivileged port` });
  } else if (port === LIVE_HEALTH_PORT || s.livePorts.includes(port)) {
    out.push({ rule: "health-port", detail: `${port} is the live fleet's port` });
  }
}

/**
 * Subcommands of the `agend` CLI that act on the machine's service or on the installed package rather than on a
 * fleet directory: they go through the per-user service unit (or `npm`), which a scratch AGEND_HOME does not isolate.
 * `fleet start|stop|restart` are NOT here — they act on the fleet whose health port the scratch config names.
 */
const FORBIDDEN_AGEND_SUBCOMMANDS: ReadonlySet<string> = new Set(
  ["install", "uninstall", "update", "start", "stop", "restart", "setup", "quickstart", "init", "reload"],
);
/** Programs that have no business in a scratch run: they act on the machine, not on the scratch directory. */
const FORBIDDEN_PROGRAMS: ReadonlySet<string> = new Set(
  ["systemctl", "launchctl", "service", "sudo", "su", "doas", "kill", "pkill", "killall", "npm", "npx", "pnpm", "yarn"],
);
/** Programs a scratch run may execute. Anything else (`sh -c`, `env`, `tmux`, `xargs`, `bash` …) is an indirection the check cannot see through. */
const ALLOWED_PROGRAMS: ReadonlySet<string> = new Set(["agend", "node", "tsx"]);
const SCRIPT_RUNNERS: ReadonlySet<string> = new Set(["node", "tsx"]);
/** The only flags accepted where a subcommand would go: they print and exit. */
const INFO_FLAGS: ReadonlySet<string> = new Set(["--version", "-v", "--help", "-h"]);

/**
 * The command grammar is a whitelist, not a blacklist of words:
 *   agend <subcommand> [anything]
 *   node|tsx <script> <subcommand> [anything]
 * The subcommand must sit exactly where the grammar puts it. A runtime flag before the script (`node --import x
 * cli.js restart`, `node -- cli.js stop`) or before the subcommand is refused outright, because it can change what
 * runs or hide where the subcommand is. tmux is refused here too: the only tmux command a run may issue is the
 * one `planTeardown` returns, against a socket it has proven.
 */
function checkCommand(command: readonly string[], out: Violation[]): void {
  if (command.length === 0) return;
  const program = basename(command[0]!);
  if (FORBIDDEN_PROGRAMS.has(program)) {
    out.push({ rule: "command-forbidden", detail: `${program} acts on the machine, not on the scratch directory` });
    return;
  }
  if (!ALLOWED_PROGRAMS.has(program)) {
    out.push({ rule: "command-forbidden", detail: `${program} is not an allowed program (agend, node, tsx); shells and wrappers hide what they run, and tmux is only used through planTeardown` });
    return;
  }
  let args = command.slice(1);
  if (SCRIPT_RUNNERS.has(program)) {
    const script = args[0];
    if (script === undefined || script.startsWith("-")) {
      out.push({ rule: "command-forbidden", detail: `${program} must be followed directly by a script path, not ${JSON.stringify(script ?? "")}: runtime flags change what runs` });
      return;
    }
    args = args.slice(1);
  }
  const sub = args[0];
  if (sub === undefined) return;
  if (sub.startsWith("-")) {
    if (!INFO_FLAGS.has(sub) || args.length > 1) {
      out.push({ rule: "command-forbidden", detail: `${JSON.stringify(sub)} comes where the agend subcommand belongs; only --version/--help (alone) may` });
    }
    return;
  }
  if (FORBIDDEN_AGEND_SUBCOMMANDS.has(sub)) {
    out.push({ rule: "command-forbidden", detail: `agend ${sub} goes through the per-user service, which a scratch AGEND_HOME does not isolate` });
  }
}

/**
 * Decide the layout and child environment of a scratch run, or refuse it with every rule that failed.
 * Pure: it neither starts nor writes anything.
 */
export function planScratchRun(request: ScratchRequest, seams: Seams = {}): PlanResult {
  const s = defaultSeams(seams);
  const violations: Violation[] = [];
  const { scratchDir, parentEnv } = request;

  checkScratchDir(scratchDir, s, violations);
  const layout = layoutFor(scratchDir);

  if (s.realAgendHome === null) {
    violations.push({ rule: "real-home-unknown", detail: "the live AgEnD home cannot be determined, so nothing can be proven different from it" });
  } else {
    const live = resolveOrRefuse(s, s.realAgendHome, "the live AgEnD home", violations);
    const home = resolveOrRefuse(s, layout.agendHome, "AGEND_HOME", violations);
    if (live !== null && home !== null && (home === live || layout.agendHome === s.realAgendHome)) {
      violations.push({ rule: "home-not-live", detail: `AGEND_HOME ${layout.agendHome} is the live home` });
    }
  }

  // The decision that once killed live windows, evaluated for the CHILD's home rather than this process's.
  const socketName = tmuxSocketNameFor(layout.agendHome, s.realAgendHome);
  const sessionName = tmuxSessionNameFor(layout.agendHome, s.realAgendHome);
  if (socketName === null) {
    violations.push({ rule: "tmux-socket-default", detail: "the child would use tmux's DEFAULT socket — the live server" });
  }
  if (sessionName === "agend") {
    violations.push({ rule: "tmux-session-live", detail: 'the child would use the live tmux session name "agend"' });
  }

  const longest = join(layout.agendHome, "instances", "x".repeat(INSTANCE_NAME_BUDGET), "channel.sock");
  const tmuxSocketPath = join(layout.tmuxTmpdir, `tmux-${s.uid}`, socketName ?? "default");
  for (const [what, path] of [["IPC socket", longest], ["tmux socket", tmuxSocketPath]] as const) {
    if (Buffer.byteLength(path) >= UNIX_SOCKET_PATH_MAX) {
      violations.push({ rule: "socket-path-length", detail: `${what} path would be ${Buffer.byteLength(path)} bytes (limit ${UNIX_SOCKET_PATH_MAX - 1}); use a shorter scratch directory` });
    }
  }

  checkLayoutContained(layout, tmuxSocketPath, s, violations);
  checkPort(request.healthPort, s, violations);

  const tokenVars = [...(request.tokenVars ?? [])];
  for (const name of tokenVars) {
    if (!SCRATCH_TOKEN_VAR.test(name)) {
      violations.push({ rule: "token-var", detail: `${JSON.stringify(name)} is not a scratch token variable (E2E_*); a live fleet's variable must never be passed on` });
    }
  }
  for (const key of Object.keys(request.extraEnv ?? {})) {
    if (!MOCK_KNOB.test(key)) {
      violations.push({ rule: "env-forbidden", detail: `${key} may not be added to the child environment (only MOCK_* knobs)` });
    }
  }
  checkCommand(request.command ?? [], violations);

  if (violations.length > 0) return { ok: false, violations };

  const childEnv: Record<string, string> = {};
  for (const name of PASSTHROUGH) {
    const value = parentEnv[name];
    if (value !== undefined && value !== "") childEnv[name] = value;
  }
  childEnv.AGEND_HOME = layout.agendHome;
  childEnv.TMUX_TMPDIR = layout.tmuxTmpdir;
  childEnv.HOME = layout.userHome;
  childEnv.AGEND_E2E = "1";
  for (const name of tokenVars) {
    const value = parentEnv[name];
    if (value !== undefined && value !== "") childEnv[name] = value;
  }
  Object.assign(childEnv, request.extraEnv ?? {});

  return { ok: true, plan: { layout, childEnv, healthPort: request.healthPort, socketName: socketName!, sessionName, tmuxSocketPath, tokenVars } };
}

/** `planScratchRun`, throwing: the form a runner uses so that a refusal cannot be ignored. */
export function assertScratchRun(request: ScratchRequest, seams: Seams = {}): ScratchPlan {
  const result = planScratchRun(request, seams);
  if (!result.ok) throw new IsolationError(result.violations);
  return result.plan;
}

export type TeardownResult =
  | { ok: true; argv: readonly string[]; removeDir: string }
  | { ok: false; violations: Violation[] };

/**
 * The only way a run may clean up: `tmux -S <socket> kill-server`, and only for a socket proven to live inside the
 * scratch directory and to carry the scratch run's own name. Never `-L`, never the default socket, never a
 * pattern — a wrong guess here is how live windows die. Returns the command; running it is the caller's job.
 */
export function planTeardown(plan: ScratchPlan, seams: Seams = {}): TeardownResult {
  const s = defaultSeams(seams);
  const violations: Violation[] = [];
  const { scratchDir } = plan.layout;

  checkScratchDir(scratchDir, s, violations);
  if (s.realAgendHome === null) {
    violations.push({ rule: "real-home-unknown", detail: "the live AgEnD home cannot be determined, so a kill-server cannot be proven to miss the live fleet" });
  }
  const real = resolveOrRefuse(s, plan.tmuxSocketPath, "the tmux socket", violations);
  const scratchReal = resolveOrRefuse(s, scratchDir, "the scratch directory", violations);
  if (!isAbsolute(plan.tmuxSocketPath) || plan.tmuxSocketPath !== resolve(plan.tmuxSocketPath)) {
    violations.push({ rule: "teardown-target", detail: "the tmux socket path is not an absolute, normalised path" });
  } else if (real !== null && scratchReal !== null && !isStrictlyInside(real, scratchReal)) {
    violations.push({ rule: "teardown-target", detail: `${real} is not inside the scratch directory ${scratchReal}` });
  }
  checkLayoutContained(plan.layout, plan.tmuxSocketPath, s, violations);
  if (basename(plan.tmuxSocketPath) !== plan.socketName || plan.socketName.length === 0 || plan.socketName === "default") {
    violations.push({ rule: "teardown-target", detail: `socket ${JSON.stringify(basename(plan.tmuxSocketPath))} is not the scratch run's own (${plan.socketName})` });
  }
  if (s.realAgendHome !== null && tmuxSocketNameFor(plan.layout.agendHome, s.realAgendHome) !== plan.socketName) {
    violations.push({ rule: "teardown-target", detail: "the socket name is not the one the scratch home derives" });
  }
  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, argv: ["tmux", "-S", plan.tmuxSocketPath, "kill-server"], removeDir: scratchDir };
}

/** The slice of a fleet.yaml a scratch run is checked against. */
export interface ScratchFleetConfig {
  health_port?: unknown;
  defaults?: { backend?: unknown; agent_mode?: unknown; tips?: unknown; daily_summary?: { enabled?: unknown }; hang_detector?: { enabled?: unknown }; webhooks?: unknown };
  channels?: Array<{ bot_token_env?: unknown; access?: unknown }>;
  channel?: { bot_token_env?: unknown; access?: unknown };
  instances?: Record<string, { backend?: unknown; agent_mode?: unknown; hang_detector?: { enabled?: unknown } }>;
}

/**
 * A scratch run's fleet.yaml, checked before the fleet is given it: the isolation above is worth nothing if the
 * config then names a live token variable, a real backend, a webhook or the live port.
 */
export function checkScratchFleetConfig(config: ScratchFleetConfig, plan: ScratchPlan): Violation[] {
  const out: Violation[] = [];
  if (config.health_port !== plan.healthPort) {
    out.push({ rule: "config-health-port", detail: `health_port must be ${plan.healthPort} (got ${JSON.stringify(config.health_port)})` });
  }
  const channels = config.channels ?? (config.channel ? [config.channel] : []);
  channels.forEach((channel, i) => {
    const env = channel.bot_token_env;
    if (typeof env !== "string" || !plan.tokenVars.includes(env)) {
      out.push({ rule: "config-token-var", detail: `channel ${i} bot_token_env ${JSON.stringify(env)} is not one of this run's scratch variables` });
    }
    if (channel.access === undefined || channel.access === null || typeof channel.access !== "object") {
      out.push({ rule: "config-access", detail: `channel ${i} has no explicit access block (who may talk to the scratch bot must be written down)` });
    }
  });
  if (config.defaults?.backend !== "mock") {
    out.push({ rule: "config-backend", detail: `defaults.backend must be "mock" (got ${JSON.stringify(config.defaults?.backend)}): a real CLI needs real credentials and per-user state` });
  }
  for (const [name, instance] of Object.entries(config.instances ?? {})) {
    if (instance.backend !== undefined && instance.backend !== "mock") {
      out.push({ rule: "config-backend", detail: `instance ${name} backend ${JSON.stringify(instance.backend)} is not "mock"` });
    }
    // An instance inherits `defaults.agent_mode` / `defaults.hang_detector`; the defaults are checked below, so here
    // only what the instance sets itself can differ from them.
    if (instance.agent_mode === "cli") {
      out.push({ rule: "config-agent-mode", detail: `instance ${name} uses agent_mode: cli, whose port (AGEND_PORT, default 19280) is not derived from the scratch health port` });
    }
    const hang = instance.hang_detector?.enabled;
    if (hang !== undefined && hang !== false) {
      out.push({ rule: "config-quiet", detail: `instance ${name} hang_detector.enabled is ${JSON.stringify(hang)}: it overrides the quiet default and posts to the real chat on its own` });
    }
  }
  if (config.defaults?.agent_mode === "cli") {
    out.push({ rule: "config-agent-mode", detail: "defaults.agent_mode: cli would put every instance on a port that is not derived from the scratch health port" });
  }
  const quiet: Array<[string, unknown]> = [
    ["defaults.tips", config.defaults?.tips],
    ["defaults.daily_summary.enabled", config.defaults?.daily_summary?.enabled],
    ["defaults.hang_detector.enabled", config.defaults?.hang_detector?.enabled],
  ];
  for (const [name, value] of quiet) {
    if (value !== false) out.push({ rule: "config-quiet", detail: `${name} must be explicitly false (got ${JSON.stringify(value)}): they post to the real chat on their own schedule` });
  }
  if (config.defaults?.webhooks !== undefined) {
    out.push({ rule: "config-webhooks", detail: "defaults.webhooks would call out to real endpoints" });
  }
  return out;
}
