/**
 * #2072: which backends actually work on this host — installed, signed in, new enough — as one published snapshot.
 *
 * Pickers (`/backend` on the web, Discord and Telegram; `/ui/backends`; ClassicBot's `/start`; the setup wizard) used to
 * ask "is it installed?" each in their own way, three of them with a synchronous `which` on the fleet's event loop, and
 * none of them asked whether the CLI was signed in or new enough. Here the questions are answered by bounded
 * asynchronous probes (child processes with deadlines, never an fs walk on the loop) and published; a handler only
 * reads the snapshot (#tool-handlers-never-fork) and never asks for a probe — the fleet refreshes it at launch, every
 * AVAILABILITY_STALE_MS, and after a /login install or sign-in.
 *
 * Unknown is never "unusable": a backend not probed yet, or whose probe gave no answer, stays selectable and is checked
 * again when it is applied. Only a definite answer disables it: not installed, not signed in (for a login that needs
 * one), or older than the minimum AgEnD supports. A probe that fails keeps the last definite answer (fail open).
 *
 * Cost and safety (the leader's rules, #2072):
 * - Sign-in is read OFFLINE from credential files and API-key variables — never a model or API request, never the
 *   CLI's own status command (`grok models` and `agy models` call the vendor; grok's also always exits 0, #1792).
 *   Where a login cannot be judged offline the answer is unknown, not "signed in".
 * - Probes run one backend at a time. The only CLI ever started is `<binary> --version`, and only when the binary or
 *   its credential files changed since the last probe: inside a memory-capped scope where systemd can make one, and in
 *   a network namespace with no network (`unshare -rn`) so no CLI can update itself or reach a vendor (#2078 review:
 *   `muse --version` updated its own launcher). Before that, the version is read from disk wherever it is written there
 *   (a version file, a versioned install path, an npm package.json), which starts nothing; muse is never started at
 *   all. Without a network namespace (macOS, or a host that forbids one) no `--version` runs: unknown.
 * - Each pass still asks whether each binary is there (`which`, and one `sh` test of the install directories, both
 *   bounded children) — never a CLI.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { binaryProbe, spawnProbeCommand, PROBE_DEADLINE_MS, type ProbeChild } from "./binary-probe.js";
import { BACKEND_INSTALLATION_INFO } from "./instance-lifecycle.js";
import { KIRO_SUPPORTED_MIN } from "./backend/kiro.js";

export type AvailabilityState = "usable" | "not_installed" | "not_signed_in" | "too_old" | "unknown";
/** A login's state: `not_required` — the CLI talks to a provider of its own (codex's custom provider), no login of ours. */
export type AuthState = "valid" | "invalid" | "unknown" | "not_required";

export interface BackendAvailability {
  backend: string;
  state: AvailabilityState;
  /** The executable the launch would run (null: not found or not probed). */
  path: string | null;
  version: string | null;
  auth: AuthState;
  /** The oldest version AgEnD supports, when the state is too_old. */
  minVersion: string | null;
  /** When it was last probed (monotonic ms), or null: never. */
  checkedAt: number | null;
}

/** The oldest CLI version each backend supports. Only gates there is evidence for; others have none. */
export const MIN_SUPPORTED_VERSION: Readonly<Record<string, string>> = { "kiro-cli": KIRO_SUPPORTED_MIN };

/** How old a snapshot may be before a read asks for a refresh (it is still served). */
export const AVAILABILITY_STALE_MS = 10 * 60_000;

/** "2.30.1" from "kiro-cli 2.30.1 (abc)"; null when there is no version in it. */
export function parseVersion(text: string | null | undefined): string | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? "");
  return m ? `${m[1]}.${m[2]}.${m[3] ?? "0"}` : null;
}

/** a < b, for dotted numeric versions. */
export function versionBelow(a: string, b: string): boolean {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** The state for what the probes answered. Pure. */
export function availabilityState(a: { installed: boolean | null; version: string | null; auth: AuthState; minVersion: string | null }): AvailabilityState {
  if (a.installed === false) return "not_installed";
  if (a.installed === null) return "unknown";
  if (a.minVersion && a.version && versionBelow(a.version, a.minVersion)) return "too_old";
  if (a.auth === "invalid") return "not_signed_in";
  return a.version === null && a.auth === "unknown" ? "unknown" : "usable";
}

/** What the store needs from the host; tests pass fakes (no CLI, no account, no network). */
export interface AvailabilityProbes {
  /** The executable's path, null when it is not installed, undefined when there was no answer in time. */
  resolve(backend: string): Promise<string | null | undefined>;
  /** `<path> --version`, parsed; null when there is no answer. */
  version(backend: string, path: string): Promise<string | null>;
  /** The backend's default login, read offline (credential files, API-key variables). */
  auth(backend: string): Promise<AuthState>;
  /** What changes when the binary or its login changes (mtimes and sizes); null when it cannot be read. */
  signature(backend: string, path: string): Promise<string | null>;
}

export class BackendAvailabilityStore {
  private rows = new Map<string, BackendAvailability & { signature: string | null }>();
  private queue: Promise<void> = Promise.resolve();
  private pending = new Set<string>();
  private readonly now: () => number;
  private readonly onChange: () => void;

  constructor(private readonly backends: readonly string[], private readonly probes: AvailabilityProbes,
    opts: { now?: () => number; onChange?: () => void } = {}) {
    this.now = opts.now ?? (() => performance.now());
    this.onChange = opts.onChange ?? (() => {});
    for (const backend of backends) this.rows.set(backend, { backend, state: "unknown", path: null, version: null, auth: "unknown", minVersion: null, checkedAt: null, signature: null });
  }

  /**
   * The published rows, in the catalog's order. Never probes, not even in the background (a handler must not fork):
   * the owner refreshes at launch, on its timer and after an install or sign-in.
   */
  snapshot(): BackendAvailability[] {
    return this.backends.map(b => this.view(b)!);
  }
  get(backend: string): BackendAvailability | null {
    return this.rows.has(backend) ? this.view(backend) : null;
  }
  /** Whether any row is older than AVAILABILITY_STALE_MS (or never probed). */
  stale(): boolean { return this.backends.some(b => this.isStale(b)); }
  private view(backend: string): BackendAvailability | null {
    const row = this.rows.get(backend);
    if (!row) return null;
    const { signature: _s, ...shown } = row;
    return shown;
  }
  private isStale(backend: string): boolean {
    const at = this.rows.get(backend)?.checkedAt;
    return at === null || at === undefined || this.now() - at > AVAILABILITY_STALE_MS;
  }

  /**
   * Probe these backends (all by default), ONE AT A TIME across every caller; resolves when they are published.
   * `force`: probe even when nothing changed (Refresh, a /login install or sign-in).
   */
  refresh(backends: readonly string[] = this.backends, opts: { force?: boolean } = {}): Promise<void> {
    const wanted = backends.filter(b => this.rows.has(b) && (opts.force || !this.pending.has(b)));
    for (const b of wanted) this.pending.add(b);
    const run = this.queue.then(async () => {
      for (const b of wanted) {
        try { await this.probeOne(b, !!opts.force); } catch { /* a failed probe keeps the last answer */ }
        this.pending.delete(b);
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async probeOne(backend: string, force: boolean): Promise<void> {
    const previous = this.rows.get(backend)!;
    let path: string | null | undefined;
    try { path = await this.probes.resolve(backend); } catch { path = undefined; }
    // No answer: keep what was known (fail open — never turn a usable backend into "unknown" or worse on a timeout).
    if (path === undefined) { this.rows.set(backend, { ...previous, checkedAt: previous.checkedAt === null ? null : this.now() }); return; }
    const signature = path ? await this.probes.signature(backend, path).catch(() => null) : "absent";
    // Nothing changed since the last full probe: no CLI is started (the leader's cost rule).
    if (!force && signature !== null && signature === previous.signature && previous.checkedAt !== null) {
      this.rows.set(backend, { ...previous, checkedAt: this.now() }); return;
    }
    let version: string | null = null, auth: AuthState = "unknown";
    if (path) {
      version = await this.probes.version(backend, path).catch(() => null);
      auth = await this.probes.auth(backend).catch(() => "unknown" as const);
    }
    // A version probe that failed keeps the version we knew for the same binary.
    if (path && version === null && previous.path === path) version = previous.version;
    const minVersion = MIN_SUPPORTED_VERSION[backend] ?? null;
    const state = availabilityState({ installed: path !== null, version, auth, minVersion });
    const row = { backend, state, path, version, auth, minVersion: state === "too_old" ? minVersion : null, checkedAt: this.now(), signature };
    this.rows.set(backend, row);
    if (previous.state !== row.state || previous.path !== row.path || previous.version !== row.version || previous.auth !== row.auth) this.onChange();
  }
}

// ── The host's probes: child processes with deadlines (binary-probe.ts's rules), never a synchronous spawn ──

/** Run one probe child and read its first output line within the deadline; undefined when there is no answer. */
async function answer(child: ProbeChild, deadlineMs = PROBE_DEADLINE_MS): Promise<string | null | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([child.answer, new Promise<undefined>(r => { timer = setTimeout(() => { child.kill(); r(undefined); }, deadlineMs); })]);
  } catch { return undefined; }
  finally { if (timer) clearTimeout(timer); }
}

/** `npm prefix -g`, asked once per process (an answer only; no answer is asked again next time). */
let npmPrefixAnswer: string | null | undefined;
async function npmPrefix(): Promise<string | null> {
  if (npmPrefixAnswer !== undefined) return npmPrefixAnswer;
  const got = await answer(spawnProbeCommand("npm", ["prefix", "-g"]), 3000);
  if (got !== undefined) npmPrefixAnswer = got;
  return got ?? null;
}

/** The directories resolveBinary searches after PATH, without its synchronous `npm prefix -g` and readdir. */
async function fallbackDirs(backend: string): Promise<string[]> {
  const home = homedir();
  const dirs = [...(BACKEND_INSTALLATION_INFO[backend]?.binDirs?.(process.env, home) ?? []), dirname(process.execPath),
    join(home, ".local", "bin"), join(home, ".npm-global", "bin"), "/usr/local/bin", "/usr/bin", "/bin"];
  try { for (const v of (await readdir(join(home, ".nvm", "versions", "node"))).sort().reverse()) dirs.push(join(home, ".nvm", "versions", "node", v, "bin")); } catch { /* optional */ }
  const prefix = await npmPrefix();
  if (prefix) dirs.push(join(prefix, "bin"));
  return [...new Set(dirs)];
}

/** Found the way the launch finds it (resolveBinary): on PATH, else in a known install directory. */
export async function resolveBackendBinary(backend: string): Promise<string | null | undefined> {
  const binary = BACKEND_INSTALLATION_INFO[backend]?.binary;
  if (!binary) return null;
  const onPath = await binaryProbe.probe(binary);
  if (onPath.known && onPath.path) return onPath.path;
  const dirs = await fallbackDirs(backend);
  // One child tests every candidate (an fs check on a dead mount could hang a pool thread forever; a child can be killed).
  const found = await answer(spawnProbeCommand("sh", ["-c", 'for p; do [ -f "$p" ] && [ -x "$p" ] && { echo "$p"; exit 0; }; done; exit 1', "sh",
    ...dirs.map(d => join(d, binary))]));
  if (found) return found;
  // Not on PATH (a definite answer) and in no install directory: not installed. No answer from either: unknown.
  return onPath.known && found === null ? null : undefined;
}

/** Whether `systemd-run --user --scope` works here (Linux with a user manager); learned once. */
let scopeWorks: Promise<boolean> | null = null;
function canScope(): Promise<boolean> {
  if (process.platform !== "linux") return Promise.resolve(false);
  return scopeWorks ??= answer(spawnProbeCommand("systemd-run", ["--user", "--scope", "-q", "-p", "MemoryMax=64M", "--", "echo", "ok"]), 5000).then(a => a === "ok");
}
/** The cap a `--version` run gets: no CLI started for a probe can take the fleet's memory (one OOM took a fleet down). */
export const VERSION_PROBE_MEMORY = "512M";

/** Whether `unshare -rn` works here (a user and a network namespace, so a CLI runs with no network); learned once. */
let netlessWorks: Promise<boolean> | null = null;
function canRunNetless(): Promise<boolean> {
  if (process.platform !== "linux") return Promise.resolve(false);
  return netlessWorks ??= answer(spawnProbeCommand("unshare", ["-rn", "--", "echo", "ok"]), 3000).then(a => a === "ok");
}
/** Each CLI's own "do not update" switches, set for a `--version` run (belt and braces: there is no network anyway). */
export const NO_UPDATE_ENV: Readonly<Record<string, string>> = {
  DISABLE_AUTOUPDATER: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", NO_UPDATE_NOTIFIER: "1", CI: "1",
};
/** A backend whose version is read from a file next to its launcher: starting it at all can update it (#2078 review). */
export const STATIC_VERSION_FILES: Readonly<Record<string, (path: string) => string>> = {
  muse: (path) => join(dirname(path), ".muse-version"),
};

/**
 * The version from what is on disk, starting nothing: a launcher's own version file (muse), else a version segment
 * the package.json of the npm package that owns the binary (under node_modules), else a version segment of the real
 * path in a layout we know (claude's `…/versions/2.1.302`, codex's `…/releases/0.162.1-<target>/`). Null when none says.
 */
export async function staticBackendVersion(backend: string, path: string): Promise<string | null> {
  const file = STATIC_VERSION_FILES[backend];
  if (file) { try { return parseVersion(await readFile(file(path), "utf8")); } catch { return null; } }
  let real: string;
  try { real = await realpath(path); } catch { return null; }
  const parts = real.split("/");
  // An npm-installed CLI: the package that owns the binary (…/node_modules/<pkg> or …/node_modules/@scope/<pkg>). Read
  // first: an nvm prefix puts Node's own version in the path (…/nvm/versions/node/v22.22.2/…, #2078 review).
  const nm = parts.lastIndexOf("node_modules");
  if (nm >= 0 && parts[nm + 1]) {
    const pkgDir = parts.slice(0, nm + (parts[nm + 1]!.startsWith("@") ? 3 : 2)).join("/");
    try {
      const pkg = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8")) as { version?: unknown };
      if (typeof pkg.version === "string") return parseVersion(pkg.version);
    } catch { /* no package.json there */ }
    return null;
  }
  // The versioned layouts we know: claude's …/versions/<v>, codex's …/releases/<v>-<target>/…. Only a segment whose
  // parent is one of those names — never any version-looking directory on the way.
  for (let i = parts.length - 1; i > 0; i--) {
    if ((parts[i - 1] === "versions" || parts[i - 1] === "releases") && /^v?\d+\.\d+\.\d+(?:[-+.][\w.-]*)?$/.test(parts[i]!)) return parseVersion(parts[i]);
  }
  return null;
}

/**
 * The version, without letting any CLI change anything or reach the network (the leader's rule, #2078):
 * 1. what is on disk (staticBackendVersion) — every OS, every backend;
 * 2. else, on Linux where an unprivileged network namespace can be made, `<path> --version` inside it (no network),
 *    with the CLIs' no-update switches, a deadline and (where systemd can) a memory cap; muse never (STATIC_VERSION_FILES);
 * 3. else unknown — never a networked `--version`. No version is no "too old" claim: the backend stays selectable.
 */
export async function probeBackendVersion(backend: string, path: string): Promise<string | null> {
  const known = await staticBackendVersion(backend, path);
  if (known || STATIC_VERSION_FILES[backend]) return known;
  if (!(await canRunNetless())) return null;
  const argv = ["unshare", "-rn", "--", "env", ...Object.entries(NO_UPDATE_ENV).map(([k, v]) => `${k}=${v}`), path, "--version"];
  const child = (await canScope())
    ? spawnProbeCommand("systemd-run", ["--user", "--scope", "-q", "-p", `MemoryMax=${VERSION_PROBE_MEMORY}`, "--", ...argv])
    : spawnProbeCommand(argv[0]!, argv.slice(1));
  return parseVersion(await answer(child, 5000));
}

/**
 * Whether codex's own config runs it on a provider other than OpenAI (no login of ours): "yes", "no", or "unknown".
 * Its default is the top level's `model_provider`, or the provider of the profile the top level selects
 * (`profile = "x"` → `[profiles.x]`). A selected profile that cannot be read is unknown, never "no" (#2078 review).
 */
export async function codexUsesOwnProvider(env: NodeJS.ProcessEnv = process.env): Promise<"yes" | "no" | "unknown"> {
  let text: string;
  try { text = await readFile(join(env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"), "utf8"); } catch { return "no"; }
  const top = text.split(/^\s*\[/m)[0] ?? "";
  const provider = (body: string) => /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(body)?.[1] ?? null;
  const own = (p: string | null) => (p ? (p !== "openai" ? "yes" : "no") : null);
  const selected = /^\s*profile\s*=\s*"([^"]+)"/m.exec(top)?.[1];
  if (selected) {
    const name = selected.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
    const at = text.search(new RegExp(`^\\s*\\[profiles\\.(?:"${name}"|${name})\\]\\s*$`, "m"));
    if (at < 0) return "unknown";
    const body = text.slice(at).split(/^\s*\[/m)[1] ?? "";
    return own(provider(body)) ?? own(provider(top)) ?? "no";
  }
  return own(provider(top)) ?? "no";
}

// ── Offline sign-in: credential files and API-key variables only ──

interface OfflineLogin {
  /** Any of these files present (non-empty) means a login is stored. */
  files: (env: NodeJS.ProcessEnv, home: string) => string[];
  /** Any of these variables set means the CLI authenticates without a stored login. */
  keys?: string[];
  /** No file and no key: "invalid" when that is proof, "unknown" when the CLI has other ways we cannot see offline. */
  absent: (platform: NodeJS.Platform) => "invalid" | "unknown";
}
/**
 * Where each CLI keeps its login (the same paths usage/providers.ts reads). Presence is all that is checked offline:
 * a stored login that has since expired still reads as signed in until the CLI says otherwise.
 */
export const OFFLINE_LOGINS: Readonly<Record<string, OfflineLogin>> = {
  // macOS keeps Claude's login in the Keychain, which we do not open: there, no file is not proof.
  // The config dir claude itself reads (claudeConfigDirFor): CLAUDE_CONFIG_DIR, else ~/.claude (#2078 review).
  "claude-code": { files: (env, home) => [join(env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude"), ".credentials.json")], keys: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    absent: (platform) => platform === "darwin" ? "unknown" : "invalid" },
  codex: { files: (env, home) => [join(env.CODEX_HOME || join(home, ".codex"), "auth.json")], keys: ["OPENAI_API_KEY"], absent: () => "invalid" },
  // #1792: `grok models` exits 0 signed out, and calls xAI — the file is the only offline truth.
  grok: { files: (env, home) => [join(env.GROK_HOME || join(home, ".grok"), "auth.json")], keys: ["XAI_API_KEY", "GROK_API_KEY"], absent: () => "invalid" },
  antigravity: { files: (env, home) => [join(env.GEMINI_HOME || join(home, ".gemini"), "antigravity-cli", "antigravity-oauth-token")], absent: () => "invalid" },
  // kiro keeps data.sqlite3 after a sign-out, so its presence proves only that kiro was used here, not a live login:
  // it can read "signed in" for a signed-out kiro (fail open — never the other way).
  "kiro-cli": { files: (env, home) => [join(env.KIRO_CLI_HOME || join(home, ".local", "share", "kiro-cli"), "data.sqlite3")], absent: () => "invalid" },
  // OpenCode reads many providers' keys from the environment: no file is not proof.
  opencode: { files: (env, home) => [join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode", "auth.json")], absent: () => "unknown" },
};

/** The default login's state, from files and variables only. */
export async function probeOfflineAuth(backend: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<AuthState> {
  if (backend === "codex") {
    const own = await codexUsesOwnProvider(env);
    if (own === "yes") return "not_required";
    if (own === "unknown") return "unknown";
  }
  const login = OFFLINE_LOGINS[backend];
  if (!login) return "unknown";
  if (login.keys?.some(k => (env[k] ?? "").trim())) return "valid";
  for (const file of login.files(env, home)) {
    try { if ((await stat(file)).size > 0) return "valid"; } catch { /* next */ }
  }
  return login.absent(process.platform);
}

/** mtime and size of the binary and the login files: the probe runs a CLI again only when this changes. */
export async function availabilitySignature(backend: string, path: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<string | null> {
  const parts: string[] = [];
  for (const file of [path, ...(OFFLINE_LOGINS[backend]?.files(env, home) ?? [])]) {
    try { const st = await stat(file); parts.push(`${file}:${st.mtimeMs}:${st.size}`); } catch { parts.push(`${file}:-`); }
  }
  for (const k of OFFLINE_LOGINS[backend]?.keys ?? []) parts.push(`${k}:${env[k] ? 1 : 0}`);
  return parts.join("|");
}

/** The host's probes. */
export const hostAvailabilityProbes: AvailabilityProbes = {
  resolve: resolveBackendBinary,
  version: probeBackendVersion,
  auth: (backend) => probeOfflineAuth(backend),
  signature: (backend, path) => availabilitySignature(backend, path),
};
