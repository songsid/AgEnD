/**
 * #3190 Part 3b: a Windows Runtime installs a coding CLI when a fleet admin asks from the dashboard (and the computer's local administrator
 * turned the "install" switch on, see runtime-remote-setup.ts).
 *
 * The dashboard sends only a CLI id. Everything that runs is written here: the npm package and its EXACT version (the one the persistent-pane
 * acceptance audited, AUDITED_NATIVE_PANE_VERSIONS, so a CLI this installs is one a pane accepts), the registry address, the argv, and the
 * registry's own sha512 of every package that may land. Nothing from the server becomes a command, an address or a path.
 *
 * Why npm, and why this shape (measured on Windows 11, node 22.21):
 *   - per user, no administrator: it only writes under `<pairing folder>\cli\...`, which this Runtime owns (not %APPDATA%\npm, not PATH);
 *   - node.exe + npm-cli.js with shell:false (a `.cmd` cannot be spawned without a shell since Node's CVE-2024-27980 fix);
 *   - `--ignore-scripts`: no vendor script runs. Claude Code's package then holds the real binary in its platform package (nested), which is
 *     what we run (its `bin/claude.exe` stays a 500-byte placeholder until the postinstall links it, and hangs if run);
 *   - four checks, all required before anything is switched: npm's own integrity check, our pin of the registry sha512 of each package,
 *     `npm audit signatures`, then the Windows Authenticode signer of the native binary ("Anthropic, PBC" / "OpenAI OpCo, LLC").
 * Kiro (an MSI into Program Files), Grok and Antigravity (vendor PowerShell scripts, no npm package) are NOT in this table on purpose: the
 * dashboard shows their official command and the computer's owner runs it.
 *
 * Built-ins and shared Runtime modules only: part of the Runtime bundle.
 */
import { execFile as nodeExecFile } from "./child-process.js";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { AUDITED_NATIVE_PANE_VERSIONS } from "./runtime-pane-native.js";

export const CLI_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
export const NPM_REGISTRY = "https://registry.npmjs.org/";
/** The Runtime's own process reads this to find what it installed; its child workers get it through spawn (see findCli). */
export const MANAGED_CLI_ROOT_ENV = "AGEND_MANAGED_CLI_ROOT";

/** `<pairing folder>\cli`: the one place this Runtime installs CLIs into. */
export const managedCliRoot = (pairingDirectory: string): string => join(pairingDirectory, "cli");

export type InstallableCliId = "claude-code" | "codex";
export interface InstallableCli {
  id: InstallableCliId;
  /** The package to install and the exact version. This is the audited version, never "latest". */
  spec: string; version: string;
  /** Registry sha512 of each package that lands, by node_modules path inside the install folder. */
  integrity: Readonly<Record<string, string>>;
  /** Where the runnable file is, relative to the install folder, and who must have signed it. */
  native: { path: string; signer: RegExp };
}
export const INSTALLABLE_CLIS: Readonly<Record<InstallableCliId, InstallableCli>> = Object.freeze({
  "claude-code": {
    id: "claude-code", spec: "@anthropic-ai/claude-code", version: AUDITED_NATIVE_PANE_VERSIONS["claude-code"],
    integrity: {
      "node_modules/@anthropic-ai/claude-code": "sha512-i3BpzyDkcCPnsa0CSkWgxGPs7WMsyqDkxkqT0SDxyEC5XMIxEmcUmluWRHG9VSeBY8Vyv+l9X34JvJ/Bj54nBQ==",
      "node_modules/@anthropic-ai/claude-code-win32-x64": "sha512-qs/GOpsQmgWECHVTpqUfTg33BaWoaH7CNOZQlOSqXbBOYst6YL1OqdutE12JsXg096NqGaE7vb5eFa6ZynOIKw==",
    },
    native: { path: "node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe", signer: /CN="?Anthropic, PBC"?/ },
  },
  codex: {
    id: "codex", spec: "@openai/codex", version: AUDITED_NATIVE_PANE_VERSIONS.codex,
    integrity: {
      "node_modules/@openai/codex": "sha512-aiwtQVp2KBhJld966CuU5bVfQ46VNB4mNTl6giX3WGZdt4euI3tv2RUqJpnupPNA8DXHg2z+RoQ0Zfw87dy8Lw==",
      "node_modules/@openai/codex-win32-x64": "sha512-f5LMyugPSnAovnTnR1N+SNHSTfWZ+ym5A4H3zZHz/zhuMGMGZD8IxUdlSUlEbiENYyPXrJ8G3Jh+CLyzTfQB6Q==",
    },
    native: { path: "node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe", signer: /CN="?OpenAI OpCo/ },
  },
});
export const isInstallableCli = (id: unknown): id is InstallableCliId => typeof id === "string" && Object.hasOwn(INSTALLABLE_CLIS, id);

export type InstallStep = "installing" | "checking-integrity" | "checking-signatures" | "checking-publisher" | "ready";
export type InstallFailure = "npm-missing" | "install-failed" | "timed-out" | "integrity-mismatch" | "signature-check-failed" | "publisher-mismatch" | "cancelled" | "busy";
/** Its message is ours and safe to show anywhere: it carries no path, no npm output and no URL. */
export class CliInstallError extends Error { constructor(readonly reason: InstallFailure, message: string) { super(message); this.name = "CliInstallError"; } }

export interface InstallDeps {
  /** `<pairing folder>\cli`. The only place anything is written. */
  root: string;
  nodePath?: string;
  /** Runs one program without a shell. Tests replace it; production uses execFile with this environment, a timeout and an exact-child cancel. */
  run?: (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }) => Promise<{ code: number | null; stdout: string }>;
  env?: NodeJS.ProcessEnv;
  signerOf?: (file: string) => Promise<{ status: string; subject: string }>;
  report?: (step: InstallStep) => void;
  signal?: AbortSignal;
}
/** What a child npm may see: the Windows basics and the user's proxy/certificate settings, nothing else (same idea as nativeCliEnvironment). */
export function installEnvironment(source: NodeJS.ProcessEnv, cache: string): NodeJS.ProcessEnv {
  const keep = ["SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "USERNAME", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && keep.includes(key.toUpperCase())) env[key] = value;
  return { ...env, npm_config_cache: cache, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false", npm_config_registry: NPM_REGISTRY, npm_config_ignore_scripts: "true" };
}
const defaultRun: NonNullable<InstallDeps["run"]> = (file, args, { cwd, env, timeoutMs, signal }) => new Promise(resolve => {
  nodeExecFile(file, args, { cwd, env, timeout: timeoutMs, maxBuffer: 512 * 1024, windowsHide: true, shell: false, encoding: "utf8", signal },
    (error, stdout, stderr) => resolve({ code: error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null) : 0, stdout: `${stdout}${stderr}` }));
});
/** Windows' own answer about who signed a file (Get-AuthenticodeSignature through Windows PowerShell; the path travels in the environment, never in the command text). */
export const windowsSignerOf = async (file: string, run = defaultRun): Promise<{ status: string; subject: string }> => {
  const system = process.env.SystemRoot || "C:\\Windows";
  const result = await run(join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", "$s = Get-AuthenticodeSignature -LiteralPath $env:AGEND_CHECK_FILE; \"$($s.Status)|$($s.SignerCertificate.Subject)\""],
    { cwd: system, env: { SystemRoot: system, AGEND_CHECK_FILE: file }, timeoutMs: 60_000 });
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
    // No link anywhere on the way to the program: a managed folder is never a redirect to somewhere else.
    for (let at = file; inside(root, at); at = dirname(at)) if (lstatSync(at).isSymbolicLink()) return null;
    return statSync(file).isFile() ? { command: file, args: [], version: cli.version } : null;
  } catch { return null; }
}

/** Installs the pinned CLI under `<root>\<id>\<version>`, verifies it, and only then points `current.json` at it. */
export async function installManagedCli(id: unknown, deps: InstallDeps): Promise<{ version: string; command: string }> {
  if (!isInstallableCli(id)) throw new CliInstallError("install-failed", "This CLI cannot be installed from the dashboard");
  const cli = INSTALLABLE_CLIS[id];
  const run = deps.run ?? defaultRun, report = deps.report ?? (() => {}), node = deps.nodePath ?? process.execPath;
  const fail = (reason: InstallFailure, message: string): never => { throw new CliInstallError(reason, message); };
  const npmCli = join(dirname(node), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(npmCli)) fail("npm-missing", "npm was not found next to this computer's Node.js, so nothing was installed");
  const folder = join(deps.root, id, cli.version), staging = `${folder}.staging`;
  if (!inside(deps.root, folder) || !inside(deps.root, staging)) throw new CliInstallError("install-failed", "The install folder must stay inside the Runtime's CLI folder");
  mkdirSync(deps.root, { recursive: true, mode: 0o700 });
  // A link where we are about to write is not followed: the CLI folder and its id folder are ours, plain folders.
  for (const dir of [deps.root, join(deps.root, id)]) if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) fail("install-failed", "The Runtime's CLI folder is a link, so nothing was installed");
  rmSync(staging, { recursive: true, force: true }); mkdirSync(staging, { recursive: true, mode: 0o700 });
  const env = installEnvironment(deps.env ?? process.env, join(deps.root, ".npm-cache"));
  const npm = (args: string[]) => run(node, [npmCli, ...args], { cwd: staging, env, timeoutMs: CLI_INSTALL_TIMEOUT_MS, signal: deps.signal });
  try {
    report("installing");
    writeFileSync(join(staging, "package.json"), '{"name":"agend-managed-cli","private":true,"version":"0.0.0"}\n');
    const installed = await npm(["install", `${cli.spec}@${cli.version}`, "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", "--registry", NPM_REGISTRY]);
    if (deps.signal?.aborted) fail("cancelled", "The install was cancelled");
    if (installed.code === null) fail("timed-out", "The install did not finish in time and was stopped");
    if (installed.code !== 0) fail("install-failed", "npm could not install the package (see this computer's network and proxy settings)");
    report("checking-integrity");
    const lock = JSON.parse(readFileSync(join(staging, "package-lock.json"), "utf8")) as { packages?: Record<string, { integrity?: string; version?: string }> };
    for (const [path, expected] of Object.entries(cli.integrity)) {
      const entry = lock.packages && Object.hasOwn(lock.packages, path) ? lock.packages[path] : undefined;
      if (entry?.integrity !== expected) fail("integrity-mismatch", "A downloaded package is not the one this AgEnD version expects, so nothing was installed");
    }
    report("checking-signatures");
    const audited = await npm(["audit", "signatures"]);
    if (deps.signal?.aborted) fail("cancelled", "The install was cancelled");
    if (audited.code !== 0) fail("signature-check-failed", "npm could not verify the registry signatures of the packages");
    report("checking-publisher");
    const file = join(staging, cli.native.path);
    if (!existsSync(file) || !statSync(file).isFile()) fail("install-failed", "The package did not contain the expected program");
    const signer = await (deps.signerOf ?? (f => windowsSignerOf(f, run)))(file);
    if (signer.status !== "Valid" || !cli.native.signer.test(signer.subject)) fail("publisher-mismatch", "The program is not signed by the expected publisher, so nothing was installed");
    if (deps.signal?.aborted) fail("cancelled", "The install was cancelled");
    rmSync(folder, { recursive: true, force: true }); renameSync(staging, folder);
    const pointer = join(deps.root, id, "current.json");
    writeFileSync(`${pointer}.tmp`, JSON.stringify({ version: cli.version })); renameSync(`${pointer}.tmp`, pointer);
    report("ready");
    return { version: cli.version, command: join(folder, cli.native.path) };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    // Only our own errors keep their text; a filesystem or JSON error could carry a path or a package line.
    throw error instanceof CliInstallError ? error : new CliInstallError("install-failed", "The install could not be completed on this computer");
  }
}

/**
 * The Runtime's installer, as `RemoteAccounts` asks for it: it knows only the CLIs in the closed table (so any other id is refused before a `started` record),
 * and it installs one at a time. The shared "one setup operation at a time" flag lives in RemoteAccounts; this guard is the installer's own, for any other caller.
 */
export function managedInstaller(deps: Omit<InstallDeps, "signal">, signal?: () => AbortSignal | undefined): { knows(cli: string): boolean; install(cli: string): Promise<{ version: string }>; running(): boolean } {
  let busy = false;
  return {
    knows: isInstallableCli,
    running: () => busy,
    install: async cli => {
      if (busy) throw new CliInstallError("busy", "A CLI install is already running on this computer; wait for it to end");
      busy = true;
      try { const { version } = await installManagedCli(cli, { ...deps, signal: signal?.() }); return { version }; }
      finally { busy = false; }
    },
  };
}
