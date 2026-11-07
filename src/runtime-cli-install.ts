/**
 * #3190 Part 3b: a Windows Runtime installs a coding CLI when a fleet admin asks from the dashboard (and the computer's local administrator
 * turned the "install" switch on, see runtime-remote-setup.ts).
 *
 * The dashboard sends only a CLI id. Everything that runs is written here: the npm package and its EXACT version, the registry address, the argv,
 * and the registry's own sha512 of every package that may land. The version and its hashes are one entry of one table, so they can only change
 * together. The version is deliberately NOT tied to the persistent-pane version list (runtime-pane-native.ts): the install pin exists for integrity,
 * not for pane acceptance. Nothing from the server becomes a command, an address or a path.
 *
 * Why npm, and why this shape (measured on Windows 11, node 22.21):
 *   - per user, no administrator: it only writes under `<pairing folder>\cli\...`, which this Runtime owns (not %APPDATA%\npm, not PATH);
 *   - node.exe + npm-cli.js with shell:false (a `.cmd` cannot be spawned without a shell since Node's CVE-2024-27980 fix);
 *   - `--ignore-scripts`: no vendor script runs. Claude Code's package then holds the real binary in its platform package (nested), which is
 *     what we run (its `bin/claude.exe` stays a 500-byte placeholder until the postinstall links it, and hangs if run);
 *   - four checks, all required before anything is switched: npm's own integrity check, our pin of the registry sha512 of each package,
 *     `npm audit signatures`, then the Windows Authenticode signer of the native binary (its subject's CN and O, each compared whole, see signerMatches).
 * Kiro (an MSI into Program Files), Grok and Antigravity (vendor PowerShell scripts, no npm package) are NOT in this table on purpose: the
 * dashboard shows their official command and the computer's owner runs it.
 *
 * Built-ins and shared Runtime modules only: part of the Runtime bundle.
 */
import { spawn as nodeSpawn } from "./child-process.js";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessNotConfirmedEnded, killTree } from "./runtime-signin.js";
// Types only: the lock module reaches windows-cli-worker, which imports this module, so its values are loaded when the first install starts (see `lockModule`).
import type { RuntimeInstallLock, RuntimeProcessObservation, RuntimeProcessProof, acquireRuntimeInstallLock as AcquireRuntimeInstallLock } from "./runtime-update-lock.js";

/** The whole install, all of its steps together (npm install, npm audit signatures, the signer check): one deadline, not one per step. */
export const CLI_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/** #3190 3b: the installer exists only where its table has a binary: native Windows on x64. (arm64 gets no installer and does not claim `cli-install`.) */
export const nativeInstallSupported = (platform: string = process.platform, arch: string = process.arch): boolean => platform === "win32" && arch === "x64";
export const NPM_REGISTRY = "https://registry.npmjs.org/";
/** The Runtime's own process reads this to find what it installed; its child workers get it through spawn (see findCli). */
export const MANAGED_CLI_ROOT_ENV = "AGEND_MANAGED_CLI_ROOT";

/** `<pairing folder>\cli`: the one place this Runtime installs CLIs into. */
export const managedCliRoot = (pairingDirectory: string): string => join(pairingDirectory, "cli");

export type InstallableCliId = "claude-code" | "codex";
export interface InstallableCli {
  id: InstallableCliId;
  /** The package to install and the exact version, never "latest". Its hashes below belong to exactly this version. */
  spec: string; version: string;
  /** Registry sha512 of each package that lands, by node_modules path inside the install folder. */
  integrity: Readonly<Record<string, string>>;
  /** Where the runnable file is, relative to the install folder, and who must have signed it. */
  native: { path: string; signer: ExpectedSigner };
}
/** The certificate subject's CN and O that must both be exactly this (not a prefix, not a pattern). */
export interface ExpectedSigner { cn: string; o: string }
export const INSTALLABLE_CLIS: Readonly<Record<InstallableCliId, InstallableCli>> = Object.freeze({
  "claude-code": {
    id: "claude-code", spec: "@anthropic-ai/claude-code", version: "2.1.316",
    integrity: {
      "node_modules/@anthropic-ai/claude-code": "sha512-i3BpzyDkcCPnsa0CSkWgxGPs7WMsyqDkxkqT0SDxyEC5XMIxEmcUmluWRHG9VSeBY8Vyv+l9X34JvJ/Bj54nBQ==",
      "node_modules/@anthropic-ai/claude-code-win32-x64": "sha512-qs/GOpsQmgWECHVTpqUfTg33BaWoaH7CNOZQlOSqXbBOYst6YL1OqdutE12JsXg096NqGaE7vb5eFa6ZynOIKw==",
    },
    native: { path: "node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe", signer: { cn: "Anthropic, PBC", o: "Anthropic, PBC" } },
  },
  codex: {
    id: "codex", spec: "@openai/codex", version: "0.165.0",
    integrity: {
      "node_modules/@openai/codex": "sha512-aiwtQVp2KBhJld966CuU5bVfQ46VNB4mNTl6giX3WGZdt4euI3tv2RUqJpnupPNA8DXHg2z+RoQ0Zfw87dy8Lw==",
      "node_modules/@openai/codex-win32-x64": "sha512-f5LMyugPSnAovnTnR1N+SNHSTfWZ+ym5A4H3zZHz/zhuMGMGZD8IxUdlSUlEbiENYyPXrJ8G3Jh+CLyzTfQB6Q==",
    },
    native: { path: "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe", signer: { cn: "OpenAI OpCo, LLC", o: "OpenAI OpCo, LLC" } },
  },
});
/**
 * A certificate subject as Windows prints it (`CN="Anthropic, PBC", O="Anthropic, PBC", L=..., C=US`) as a list of [type, value]. A value is either plain
 * (up to the next comma; `\\` escapes the next character) or in double quotes (a comma inside is part of the value, `""` is one quote). Anything it cannot
 * read with certainty (an unclosed quote, text after a closing quote, a multi-valued RDN with `+`, an empty type) is null: an unreadable subject matches nothing.
 */
export function parseSubject(subject: string): Array<[string, string]> | null {
  const out: Array<[string, string]> = [];
  let at = 0;
  const blanks = (): void => { while (subject[at] === " " || subject[at] === "\t") at++; };
  while (at < subject.length) {
    blanks();
    const eq = subject.indexOf("=", at);
    if (eq < 0) return null;
    const type = subject.slice(at, eq).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9-]*$|^(?:OID\.)?\d+(?:\.\d+)*$/.test(type)) return null;
    at = eq + 1; blanks();
    let value = "";
    if (subject[at] === '"') {
      at++;
      for (;;) {
        if (at >= subject.length) return null;
        if (subject[at] === '"') { if (subject[at + 1] === '"') { value += '"'; at += 2; continue; } at++; break; }
        value += subject[at++];
      }
      blanks();
      if (at < subject.length && subject[at] !== ",") return null;
    } else {
      while (at < subject.length && subject[at] !== ",") {
        if (subject[at] === "+") return null;
        if (subject[at] === "\\") { if (at + 1 >= subject.length) return null; value += subject[at + 1]; at += 2; continue; }
        value += subject[at++];
      }
      value = value.trim();
    }
    out.push([type, value]);
    if (subject[at] === ",") { at++; if (at >= subject.length) return null; }
  }
  return out.length ? out : null;
}
/** The subject's CN and O are each EXACTLY the expected one, and each appears once. "Anthropic, PBC Evil" or an O that is right beside a wrong CN is not it. */
export function signerMatches(subject: string, expected: ExpectedSigner): boolean {
  const parts = parseSubject(subject);
  if (!parts) return false;
  const only = (type: string): string | null => { const found = parts.filter(([name]) => name === type); return found.length === 1 ? found[0][1] : null; };
  const cn = only("CN"), o = only("O");
  return cn !== null && o !== null && cn === expected.cn && o === expected.o;
}
export const isInstallableCli = (id: unknown): id is InstallableCliId => typeof id === "string" && Object.hasOwn(INSTALLABLE_CLIS, id);

export type InstallStep = "installing" | "checking-integrity" | "checking-signatures" | "checking-publisher" | "ready";
export type InstallFailure = "npm-missing" | "install-failed" | "timed-out" | "integrity-mismatch" | "signature-check-failed" | "publisher-mismatch" | "cancelled" | "busy";
/** Its message is ours and safe to show anywhere: it carries no path, no npm output and no URL. */
export class CliInstallError extends Error {
  /** Set when a child process could not be confirmed ended: settles when it really has. The install lock, the Runtime's busy state and its update fence are kept until then. */
  readonly ended?: Promise<unknown>;
  constructor(readonly reason: InstallFailure, message: string, options: { ended?: Promise<unknown> } = {}) { super(message); this.name = "CliInstallError"; if (options.ended) this.ended = options.ended; }
}

export interface InstallDeps {
  /** `<pairing folder>\cli`. The only place anything is written. */
  root: string;
  nodePath?: string;
  /** Runs one program without a shell. Tests replace it; production uses execFile with this environment, a timeout and an exact-child cancel. */
  run?: (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal; killWaitMs?: number }) => Promise<{ code: number | null; stdout: string; /** The output went over the limit and the child was stopped for it (not a timeout). */ overflow?: boolean }>;
  env?: NodeJS.ProcessEnv;
  signerOf?: (file: string, signal?: AbortSignal) => Promise<{ status: string; subject: string }>;
  report?: (step: InstallStep) => void;
  /** The Runtime stopping: the install ends as `cancelled`. The overall deadline is separate and ends it as `timed-out`. */
  signal?: AbortSignal;
  /** The overall deadline of the whole install. Production never sets it (10 minutes); a test shortens it. */
  deadlineMs?: number;
  /** Renames a folder (the swap of the old install and the new one). Tests make it fail on purpose. */
  rename?: (from: string, to: string) => void;
  /** The Runtime's installation root, where the shared install lock (`.agend-runtime-install.lock`, #3258) is taken. Default: the managed install root this code runs from, else `root`. */
  installRoot?: string;
  /** Passed to `acquireRuntimeInstallLock` (a test's own process proof and observer). Default: the real observer on Windows, a local one elsewhere. */
  lockOptions?: Parameters<typeof AcquireRuntimeInstallLock>[1];
  /** After a child was told to stop, how long to wait for it to really end (default 5 s) before the install reports it as not confirmed ended. */
  killWaitMs?: number;
  /**
   * The Runtime's live admission check (the local install switch is still on and the request's connection is still the live one): throws when it is not. Called
   * immediately before each new process and in the same synchronous step as the activation, so a switch turned off or run out, or a connection replaced, while a step
   * was running stops the next one. Work that already runs is never abandoned by it.
   */
  gate?: () => void;
  /** How long to wait before trying again to release the lock when a release failed (default 1 s). Tests shorten it. */
  releaseRetryMs?: number;
}
/** What a child npm may see: the Windows basics and the user's proxy/certificate settings, nothing else (same idea as nativeCliEnvironment). */
export function installEnvironment(source: NodeJS.ProcessEnv, cache: string, config?: NpmConfigFiles, prefix?: string): NodeJS.ProcessEnv {
  const keep = ["SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "USERNAME", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && keep.includes(key.toUpperCase())) env[key] = value;
  // The user's and the global `.npmrc` are replaced by one controlled file, and npm is told to install locally under `prefix`: a user `global=true`, `prefix=` or a scoped
  // registry in their own `.npmrc` must not move the install out of the pairing folder or send it elsewhere.
  return { ...env, npm_config_cache: cache, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false", npm_config_registry: NPM_REGISTRY, npm_config_ignore_scripts: "true",
    ...(config ? { npm_config_userconfig: config.user, npm_config_globalconfig: config.global } : {}), npm_config_global: "false", ...(prefix ? { npm_config_prefix: prefix } : {}) };
}
/** The two controlled npm configuration files: npm refuses one file for both levels ("double-loading"), so the same text is written twice. */
export interface NpmConfigFiles { user: string; global: string }
/** The controlled npm configuration (the same text for the user and the global level). */
const NPMRC_TEXT = `global=false\nregistry=${NPM_REGISTRY}\nignore-scripts=true\naudit=false\nfund=false\nupdate-notifier=false\n`;
/** The same selections on the command line, which wins over every file and environment variable. */
const npmLocalArgs = (config: NpmConfigFiles, prefix: string): string[] => ["--userconfig", config.user, "--globalconfig", config.global, "--global=false", "--prefix", prefix, "--registry", NPM_REGISTRY];
/**
 * Runs one program: no shell, output capped at 512 KiB. A child that has a pid has ended ONLY when its `close` has come (an `error` event can also mean it could
 * not be killed); only one that never started (no pid) has ended without it. On the timeout, the Runtime's stop or the output limit the whole process tree is killed
 * and `close` is waited for up to `killWaitMs` more: if it has not come, the result is a ProcessNotConfirmedEnded, whose `ended` settles when the child really ends.
 */
const defaultRun: NonNullable<InstallDeps["run"]> = (file, args, { cwd, env, timeoutMs, signal, killWaitMs = 5_000 }) => new Promise((resolveRun, rejectRun) => {
  if (signal?.aborted) { resolveRun({ code: null, stdout: "" }); return; }
  const child = nodeSpawn(file, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", bytes = 0, overflow = false, stopping = false, ended = false, settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined, gave: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<void>(accept => { child.on("close", () => accept()); });
  closed.then(() => { ended = true; });
  const settle = (act: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(gave); signal?.removeEventListener("abort", stop); act(); };
  const stop = (): void => {
    if (stopping) return; stopping = true;
    killTree(child);
    gave = setTimeout(() => { if (!ended) settle(() => rejectRun(new ProcessNotConfirmedEnded(closed))); }, killWaitMs); gave.unref?.();
  };
  const take = (part: Buffer | string): void => {
    if (overflow) return;
    bytes += Buffer.byteLength(part);
    if (bytes > 512 * 1024) { overflow = true; stop(); return; }
    output += part.toString();
  };
  child.stdout?.on("data", take); child.stderr?.on("data", take);
  // A program that never started has nothing to wait for; one with a pid ends with its `close`.
  child.on("error", () => { if (child.pid === undefined) settle(() => resolveRun({ code: 1, stdout: "" })); });
  child.on("close", code => settle(() => resolveRun({ code: stopping || overflow ? null : code, stdout: output, ...(overflow ? { overflow: true } : {}) })));
  timer = setTimeout(stop, timeoutMs);
  signal?.addEventListener("abort", stop, { once: true });
});
/** Windows' own answer about who signed a file (Get-AuthenticodeSignature through Windows PowerShell; the path travels in the environment, never in the command text). */
export const windowsSignerOf = async (file: string, run = defaultRun, signal?: AbortSignal, killWaitMs?: number): Promise<{ status: string; subject: string }> => {
  const system = process.env.SystemRoot || "C:\\Windows";
  const result = await run(join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", "$s = Get-AuthenticodeSignature -LiteralPath $env:AGEND_CHECK_FILE; \"$($s.Status)|$($s.SignerCertificate.Subject)\""],
    { cwd: system, env: { SystemRoot: system, AGEND_CHECK_FILE: file }, timeoutMs: 60_000, ...(signal ? { signal } : {}), ...(killWaitMs !== undefined ? { killWaitMs } : {}) });
  // A verifier that did not end cleanly (non-zero, no exit code, output over the limit) says nothing, whatever it printed.
  if (result.overflow || result.code !== 0) return { status: "Error", subject: "" };
  const [status = "", ...rest] = result.stdout.trim().split("|");
  return { status, subject: rest.join("|") };
};
const inside = (base: string, path: string): boolean => { const rel = relative(base, path); return !!rel && !rel.startsWith("..") && !isAbsolute(rel); };

/** Where a managed CLI's runnable file is, once `install` finished for it. A pointer file, so a half-finished install is never used. */
export function managedCliExecutable(root: string, id: string): { command: string; args: string[]; version: string } | null {
  if (!isInstallableCli(id)) return null;
  try {
    const pointer = JSON.parse(readFileSync(join(root, id, "current.json"), "utf8")) as { version?: unknown };
    const cli = INSTALLABLE_CLIS[id];
    if (pointer.version !== cli.version) return null;      // an older pin than this Runtime's: reinstall
    const file = join(root, id, cli.version, cli.native.path);
    // No link anywhere on the way to the program, the managed root itself included: a managed folder is never a redirect to somewhere else (a junction reads as a link).
    for (let at = file; ; at = dirname(at)) {
      if (lstatSync(at).isSymbolicLink()) return null;
      if (at === root) break;
      if (!inside(root, at)) return null;
    }
    // And what the names resolve to still lies inside the root's own resolved place.
    if (!inside(realpathSync(root), realpathSync(file))) return null;
    return statSync(file).isFile() ? { command: file, args: [], version: cli.version } : null;
  } catch { return null; }
}

/** Removes a path and swallows any failure (a file in use, a lock): used only for leftovers that the next install clears again. */
const bestEffortRemove = (path: string): void => { try { rmSync(path, { recursive: true, force: true }); } catch { /* cleared by the next install */ } };
/** After a switch: the other versions of this CLI and the npm cache are not needed any more. Their names are ours (`<x.y.z>`, `.old`, `.staging`); anything else stays. */
function pruneManaged(root: string, id: string, keep: string): void {
  try {
    for (const entry of readdirSync(join(root, id))) if (entry !== keep && /^\d+\.\d+\.\d+(?:\.old|\.staging)?$/.test(entry)) bestEffortRemove(join(root, id, entry));
  } catch { /* nothing to clear, or cleared next time */ }
  bestEffortRemove(join(root, ".npm-cache"));
}

/** The shared install lock lives in `.agend-runtime-install.lock` (#3258); its module is loaded when an install starts (it reaches windows-cli-worker, which imports this file). */
const lockModule = (): Promise<typeof import("./runtime-update-lock.js")> => import("./runtime-update-lock.js");
/**
 * The managed Runtime install root this code runs from (#3215: `<root>\<version>+<sha>\dist\runtime-cli-install.js` and `<root>\bin\current.txt`), or null for a
 * ZIP copy or a source tree. The CLI install shares that root's lock with `install.ps1` and the update supervisor, even though what it installs is in the pairing folder.
 */
export function managedInstallRoot(from: string = fileURLToPath(import.meta.url)): string | null {
  try {
    const root = resolve(dirname(from), "..", "..");
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    return existsSync(join(root, "bin", "current.txt")) || existsSync(join(root, ".agend-runtime-install.json")) ? root : null;
  } catch { return null; }
}
/** Off Windows (tests, development) the real process observer answers "unknown" for everything: a local one that knows this process and whether another pid exists. */
function localLockOptions(): NonNullable<InstallDeps["lockOptions"]> {
  let boot = "local";
  try { boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { /* not Linux */ }
  const ownProof: RuntimeProcessProof = { pid: process.pid, birth: String(Math.round(performance.timeOrigin * 10_000)), boot: createHash("sha256").update(`agend-local-boot:${boot}`).digest("hex") };
  const observe = async (pid: number): Promise<RuntimeProcessObservation> => {
    if (pid === process.pid) return { state: "alive", proof: ownProof };
    try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? { state: "gone" } : { state: "unknown" }; }
    return { state: "unknown" };
  };
  return { ownProof, observe };
}

/**
 * Installs the pinned CLI under `<root>\<id>\<version>`, verifies it, and only then points `current.json` at it.
 *   - Already installed (the pointer is this pin and its program is there): nothing is done at all.
 *   - One deadline covers every step. The Runtime stopping ends it as `cancelled`; the deadline ends it as `timed-out`.
 *   - The new folder replaces an old one by moving the old one aside (`<version>.old`), never by deleting it first: if the swap fails, the old one is moved back.
 */
export async function installManagedCli(id: unknown, deps: InstallDeps): Promise<InstallResult> {
  if (!isInstallableCli(id)) throw new CliInstallError("install-failed", "This CLI cannot be installed from the dashboard");
  const cli = INSTALLABLE_CLIS[id];
  const run = deps.run ?? defaultRun, report = deps.report ?? (() => {}), node = deps.nodePath ?? process.execPath, rename = deps.rename ?? renameSync;
  const fail = (reason: InstallFailure, message: string): never => { throw new CliInstallError(reason, message); };
  const folder = join(deps.root, id, cli.version), staging = `${folder}.staging`, old = `${folder}.old`;
  if (!inside(deps.root, folder) || !inside(deps.root, staging)) throw new CliInstallError("install-failed", "The install folder must stay inside the Runtime's CLI folder");
  // A link where we are about to write is not followed: the CLI folder and its id folder are ours, plain folders.
  for (const dir of [deps.root, join(deps.root, id)]) if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) fail("install-failed", "The Runtime's CLI folder is a link, so nothing was installed");
  const present = managedCliExecutable(deps.root, id);
  if (present && present.version === cli.version) { report("ready"); return { version: cli.version, command: present.command }; }
  const npmCli = join(dirname(node), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(npmCli)) fail("npm-missing", "npm was not found next to this computer's Node.js, so nothing was installed");
  mkdirSync(deps.root, { recursive: true, mode: 0o700 });
  const idDir = join(deps.root, id);
  const changed = (): CliInstallError => new CliInstallError("install-failed", "The Runtime's CLI folder was changed during the install, so it was stopped");

  // Containment: the CLI folder, the id folder and the staging folder are the ones admitted at the start, until the end. Their identity and where they resolve to are
  // looked at again after every await and before every write, rename, removal and the pointer; a folder that was swapped for a link or another folder stops the install,
  // and nothing is written, renamed or deleted through it. The baseline is taken BEFORE the wait for the lock (which can be long), and looked at again straight after it.
  const identity = new Map<string, { id: bigint; dev: bigint }>();
  let resolvedRoot = "";
  const plain = (path: string): BigIntStats => { const stat = lstatSync(path, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed(); return stat; };
  const admitFolders = (paths: string[]): void => {
    resolvedRoot = realpathSync(deps.root);
    for (const path of paths) { const stat = plain(path); identity.set(path, { id: stat.ino, dev: stat.dev }); }
  };
  const contained = (): void => {
    try {
      if (realpathSync(deps.root) !== resolvedRoot) throw new Error("moved");
      for (const [path, was] of identity) {
        const stat = plain(path);
        if (stat.ino !== was.id || stat.dev !== was.dev) throw new Error("replaced");
        const real = realpathSync(path);
        if (real !== resolvedRoot && !inside(resolvedRoot, real)) throw new Error("outside");
      }
    } catch (error) { if (error instanceof CliInstallError) throw error; throw changed(); }
  };
  const hadIdDirBeforeLock = existsSync(idDir);
  admitFolders(hadIdDirBeforeLock ? [deps.root, idDir] : [deps.root]);

  // The shared install lock (#3258): the same `.agend-runtime-install.lock` that `install.ps1` and the update supervisor take, so a CLI install, a manual reinstall and
  // an automatic switch cannot run at once. It is kept until the install's last child process has really ended, not only until this call returns.
  const lockRoot = deps.installRoot ?? managedInstallRoot() ?? deps.root;
  if (lockRoot === deps.root && process.platform !== "win32") { try { chmodSync(deps.root, 0o700); } catch { /* the lock module refuses a folder it cannot trust */ } }
  // The folder the lock lives in (the CLI folder itself when no install root is given) is the one looked at before the wait, and it must still be that one when the wait
  // ends and the lock folder, its owner record and the marker are written. A root that is not there is left to the lock module to refuse.
  let lockRootWas: { id: bigint; dev: bigint; real: string } | undefined;
  try { const stat = plain(lockRoot); lockRootWas = { id: stat.ino, dev: stat.dev, real: realpathSync(lockRoot) }; } catch (error) { if (error instanceof CliInstallError && existsSync(lockRoot)) throw error; }
  const checkLockRoot = (): void => {
    if (!lockRootWas) return;
    try {
      const stat = plain(lockRoot);
      if (stat.ino !== lockRootWas.id || stat.dev !== lockRootWas.dev || realpathSync(lockRoot) !== lockRootWas.real) throw new Error("replaced");
    } catch (error) { if (error instanceof CliInstallError) throw error; throw changed(); }
  };
  const locks = await lockModule();
  const baseObserve = deps.lockOptions?.observe ?? (process.platform !== "win32" ? localLockOptions().observe! : locks.observeRuntimeProcess);
  const baseOptions = deps.lockOptions ?? (process.platform !== "win32" ? localLockOptions() : {});
  let lock: RuntimeInstallLock;
  try {
    lock = await locks.acquireRuntimeInstallLock(lockRoot, { type: "installer", ...baseOptions,
      // Around every wait for a process observation the folders are looked at: swapped meanwhile, the acquisition stops before it creates anything.
      observe: async pid => { checkLockRoot(); contained(); const seen = await baseObserve(pid); checkLockRoot(); contained(); return seen; } });
  }
  catch (error) {
    if (error instanceof CliInstallError) throw error;
    if (error instanceof locks.RuntimeInstallLockError && error.reason === "held") fail("busy", "A CLI install or Runtime update is already running on this computer; wait for it to end");
    checkLockRoot(); contained();                // a folder swapped during the wait is reported as that, whatever the lock module said
    return fail("install-failed", "This computer could not lock its Runtime install folder, so nothing was installed");
  }
  // While the lock holds this marker nothing may reclaim it, even if this process is gone: a Runtime that dies with a child still running leaves the marker behind, so a
  // later owner sees uncertainty (a lock with anything beside its owner record stays held) instead of a free lock.
  const lockDir = join(lockRoot, locks.RUNTIME_INSTALL_LOCK), inflight = join(lockDir, "inflight");
  /**
   * The lock is positively not ours any more. Both ways need the folder the lock lives in to be the very one it was taken in (a folder moved away and replaced by an
   * empty one of the same name proves nothing): its lock folder is gone (and nothing else), or a COMPLETE, valid record of another owner is in it, read through the lock
   * module's own bounded, non-link reader. Anything unreadable, malformed, linked, partial or unclear is NOT that.
   */
  const notOursAnymore = (): boolean => {
    try { checkLockRoot(); locks.assertRuntimeInstallDirectory(lockRoot); } catch { return false; }
    try { lstatSync(lockDir); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
    try {
      locks.assertRuntimeInstallDirectory(lockDir);
      const file = locks.readRuntimeInstallFile(join(lockDir, "owner.json"), 2048);
      if (!file) return false;
      return locks.parseRuntimeInstallLock(JSON.parse(file.text)).nonce !== lock.record.nonce;
    } catch { return false; }
  };
  /**
   * Gives the lock back (marker first). A release that fails, or a lock that cannot be looked at, keeps the lease, never counts as released, and is tried again until it
   * works: the promise it returns (undefined when the first try worked) is what the caller keeps the Runtime busy on. Only positive evidence that the lock is no longer ours
   * ends the wait without a release.
   */
  const letGo = (): Promise<void> | undefined => {
    const attempt = (): boolean => {
      try { lock.assert(); } catch { return notOursAnymore(); }
      try { if (existsSync(inflight)) unlinkSync(inflight); lock.release(); return true; } catch { return false; }
    };
    if (attempt()) return undefined;
    return new Promise<void>(done => { const again = (): void => { if (attempt()) done(); else setTimeout(again, deps.releaseRetryMs ?? 1000).unref?.(); }; setTimeout(again, deps.releaseRetryMs ?? 1000).unref?.(); });
  };
  // Straight after the acquisition, before the marker or anything else is written: the lock's folder and the CLI folders are still the ones that were looked at.
  try { checkLockRoot(); contained(); }
  catch (error) { const retry = letGo(); throw retry && error instanceof CliInstallError ? new CliInstallError(error.reason, error.message, { ended: retry }) : error; }
  try { writeFileSync(inflight, JSON.stringify({ cli: id, version: cli.version }), { flag: "wx", mode: 0o600 }); }
  catch {
    const retry = letGo();
    throw new CliInstallError("install-failed", "This computer could not lock its Runtime install folder, so nothing was installed", retry ? { ended: retry } : {});
  }
  // One deadline for all of it; the Runtime's own stop is a separate reason and is checked first.
  const deadline = AbortSignal.timeout(deps.deadlineMs ?? CLI_INSTALL_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, deadline]) : deadline;
  const stopped = (): void => {
    if (deps.signal?.aborted) fail("cancelled", "The install was cancelled");
    if (deadline.aborted) fail("timed-out", "The install did not finish in time and was stopped");
  };
  // The Runtime's own refusal (switch turned off or run out, connection replaced) is thrown as it is, so the caller records the right reason.
  let refusal: unknown;
  const admit = (): void => { try { deps.gate?.(); } catch (error) { refusal = error; throw error; } };

  const safeRemove = (path: string): void => { try { contained(); bestEffortRemove(path); } catch { /* a folder that is no longer ours is not touched */ } };
  const guardedRename = (from: string, to: string): void => { contained(); rename(from, to); };
  // Every boundary of the install: the stop signal and the deadline, the lock, the folders, and the Runtime's live admission.
  const boundary = (): void => { stopped(); lock.assert(); contained(); admit(); };

  let staged = false;
  try {
    stopped(); admit();
    // Straight after the wait for the lock, before anything is written: the folders are still the ones that were looked at before it, and an id folder that did not exist
    // then has not appeared since (it would have been planted while we waited).
    contained();
    if (!hadIdDirBeforeLock && existsSync(idDir)) throw changed();
    mkdirSync(idDir, { recursive: true, mode: 0o700 });
    admitFolders([deps.root, idDir]); contained();
    bestEffortRemove(staging); mkdirSync(staging, { recursive: true, mode: 0o700 }); staged = true;
    admitFolders([deps.root, idDir, staging]);
    const config: NpmConfigFiles = { user: join(staging, "agend-user.npmrc"), global: join(staging, "agend-global.npmrc") };
    writeFileSync(config.user, NPMRC_TEXT, { mode: 0o600 }); writeFileSync(config.global, NPMRC_TEXT, { mode: 0o600 });
    const env = installEnvironment(deps.env ?? process.env, join(deps.root, ".npm-cache"), config, staging);
    const npm = (args: string[]) => run(node, [npmCli, ...args, ...npmLocalArgs(config, staging)], { cwd: staging, env, timeoutMs: deps.deadlineMs ?? CLI_INSTALL_TIMEOUT_MS, signal, ...(deps.killWaitMs !== undefined ? { killWaitMs: deps.killWaitMs } : {}) });
    report("installing");
    contained(); writeFileSync(join(staging, "package.json"), '{"name":"agend-managed-cli","private":true,"version":"0.0.0"}\n');
    boundary();
    const installed = await npm(["install", `${cli.spec}@${cli.version}`, "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund"]);
    stopped();
    if (installed.overflow) fail("install-failed", "npm could not install the package (its output was far larger than expected)");
    if (installed.code === null) fail("timed-out", "The install did not finish in time and was stopped");
    if (installed.code !== 0) fail("install-failed", "npm could not install the package (see this computer's network and proxy settings)");
    report("checking-integrity");
    contained();
    const lockfile = JSON.parse(readFileSync(join(staging, "package-lock.json"), "utf8")) as { packages?: Record<string, { integrity?: string; version?: string }> };
    for (const [path, expected] of Object.entries(cli.integrity)) {
      const entry = lockfile.packages && Object.hasOwn(lockfile.packages, path) ? lockfile.packages[path] : undefined;
      if (entry?.integrity !== expected) fail("integrity-mismatch", "A downloaded package is not the one this AgEnD version expects, so nothing was installed");
    }
    report("checking-signatures");
    boundary();
    const audited = await npm(["audit", "signatures"]);
    stopped();
    if (audited.overflow) fail("signature-check-failed", "npm could not verify the registry signatures of the packages");
    if (audited.code === null) fail("timed-out", "The install did not finish in time and was stopped");
    if (audited.code !== 0) fail("signature-check-failed", "npm could not verify the registry signatures of the packages");
    report("checking-publisher");
    contained();
    const file = join(staging, cli.native.path);
    if (!existsSync(file) || !statSync(file).isFile()) fail("install-failed", "The package did not contain the expected program");
    boundary();
    const signer = await (deps.signerOf ?? ((f, s) => windowsSignerOf(f, run, s, deps.killWaitMs)))(file, signal);
    stopped();
    if (signer.status !== "Valid" || !signerMatches(signer.subject, cli.native.signer)) fail("publisher-mismatch", "The program is not signed by the expected publisher, so nothing was installed");
    // The swap. Whatever was there is moved aside, not deleted: a failure puts it back, and `current.json` is not touched until the new folder is in place. The last look at
    // the Runtime's consent and the connection, the lock and the folders is in the same synchronous step as the moves and the pointer write.
    boundary();
    safeRemove(old);
    const hadOld = existsSync(folder);
    let swapped = false;
    const pointer = join(deps.root, id, "current.json");
    try {
      if (hadOld) guardedRename(folder, old);
      guardedRename(staging, folder); swapped = true; identity.delete(staging);       // the staging folder is now the version folder, inside the id folder that is still looked at
      for (const name of ["agend-user.npmrc", "agend-global.npmrc"]) { try { unlinkSync(join(folder, name)); } catch { /* only ours, and harmless left */ } }
      writeFileSync(`${pointer}.tmp`, JSON.stringify({ version: cli.version }));
      lock.assert(); contained();
      guardedRename(`${pointer}.tmp`, pointer);
    } catch (error) {
      // Back to what it was: the new folder (if it landed) goes, the old one comes back.
      if (swapped) safeRemove(folder);
      if (hadOld) { try { if (!existsSync(folder)) guardedRename(old, folder); } catch { /* nothing more can be done from here */ } }
      safeRemove(`${pointer}.tmp`);
      throw error;
    }
    safeRemove(old);
    try { contained(); pruneManaged(deps.root, id, cli.version); } catch { /* a folder that is no longer ours is not touched */ }
    report("ready");
    return { version: cli.version, command: join(folder, cli.native.path), ...endedOf(letGo()) };
  } catch (error) {
    if (error instanceof ProcessNotConfirmedEnded) {
      // A child that was told to stop has not been confirmed gone: it may still be writing into the staging folder. The lock, its marker and the staging folder stay
      // until it really ends, and whoever called this keeps the Runtime busy (and the update fence held) until the lock has been given back after that.
      const settled = error.ended.then(() => { if (staged) safeRemove(staging); return letGo(); }, () => { if (staged) safeRemove(staging); return letGo(); });
      throw new CliInstallError(deps.signal?.aborted ? "cancelled" : deadline.aborted ? "timed-out" : "install-failed",
        "A program the install started could not be confirmed ended, so this computer stays busy until it is", { ended: settled });
    }
    if (staged) safeRemove(staging);
    const retry = letGo();
    // The Runtime's own refusal keeps its words and its reason; our own errors keep theirs; anything else could carry a path or a package line and says only that it failed.
    const out = error === refusal || error instanceof CliInstallError ? error
      : error instanceof locks.RuntimeInstallLockError ? new CliInstallError("install-failed", "This computer's Runtime install lock changed during the install, so it was stopped")
        : new CliInstallError("install-failed", "The install could not be completed on this computer");
    if (retry && out instanceof CliInstallError && !out.ended) throw new CliInstallError(out.reason, out.message, { ended: retry });
    if (retry && !(out instanceof CliInstallError)) Object.assign(out as object, { ended: retry });
    throw out;
  }
}
/** What an install answers: the version that landed and where its program is; `ended` only when the lock could not be given back yet (settles when it has been). */
export interface InstallResult { version: string; command: string; ended?: Promise<unknown> }
const endedOf = (retry: Promise<void> | undefined): { ended?: Promise<unknown> } => retry ? { ended: retry } : {};

/**
 * The Runtime's installer, as `RemoteAccounts` asks for it: it knows only the CLIs in the closed table (so any other id is refused before a `started` record).
 * One install at a time on the computer is the shared install lock's job (see installManagedCli), so a manual reinstall or an update is excluded too; this object
 * only follows what is under way, including a child process that could not be confirmed ended, for `running()`.
 */
export function managedInstaller(deps: Omit<InstallDeps, "signal" | "gate">, signal?: () => AbortSignal | undefined): {
  knows(cli: string): boolean; installed(cli: string): boolean; install(cli: string, gate?: () => void): Promise<{ version: string; ended?: Promise<unknown> }>; running(): boolean;
} {
  const active = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>): void => { active.add(work); const done = (): void => { active.delete(work); }; work.then(done, done); };
  return {
    knows: isInstallableCli,
    /** This CLI is already at the version this Runtime installs (what a repeated request would find, and do nothing about). */
    installed: cli => isInstallableCli(cli) && managedCliExecutable(deps.root, cli)?.version === INSTALLABLE_CLIS[cli].version,
    running: () => active.size > 0,
    install: async (cli, gate) => {
      const attempt = installManagedCli(cli, { ...deps, signal: signal?.(), ...(gate ? { gate } : {}) });
      // The install counts as running until it, and any program it could not stop or any release of its lock that is still being retried, has ended.
      track(attempt.then(result => result.ended, (error: unknown) => (error as { ended?: unknown } | null)?.ended instanceof Promise ? (error as { ended: Promise<unknown> }).ended : undefined));
      const { version, ended } = await attempt;
      return { version, ...(ended ? { ended } : {}) };
    },
  };
}
