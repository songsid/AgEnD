/**
 * #2357: the official codex package ships helpers next to `bin/codex`, and codex 0.162+ runs every code-mode tool call
 * through one of them, `bin/codex-code-mode-host`. A codex binary copied without it starts, takes messages, and then
 * fails every tool call (AgEnD's reply included) on an account where code mode is the only tool path. The TUI shows
 * only `⚠ N warnings · f2 to view`, so the instance goes silent with nothing on its pane.
 *
 * This reads the layout of the codex AgEnD launches, never runs it: the realpath of the resolved binary (through npm's
 * `bin/codex.js` wrapper into its platform package, the way the wrapper itself finds it), then `codex-package.json` in
 * the directory above `bin/`, the package root of both the npm platform package (`vendor/<triple>`) and the standalone
 * install (`releases/<ver>`). Without that manifest the layout is not one this knows, and nothing is claimed.
 */
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { t } from "../locale.js";

/** The helpers a package-layout codex needs next to its entrypoint, relative to the package root. */
export const CODEX_PACKAGE_COMPANIONS = ["bin/codex-code-mode-host"] as const;

/** npm's wrapper (bin/codex.js) maps the host to the platform package that holds the native binary. */
const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

function targetTriple(platform: NodeJS.Platform, arch: string): string | null {
  const os = platform === "linux" || platform === "android" ? "unknown-linux-musl"
    : platform === "darwin" ? "apple-darwin" : platform === "win32" ? "pc-windows-msvc" : null;
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  return os && cpu ? `${cpu}-${os}` : null;
}

export interface CodexPackageFs {
  realpath(path: string): string;
  readFile(path: string): string;
  isFile(path: string): boolean;
  isExecutable(path: string): boolean;
  /** Where `spec` resolves from the module at `fromFile` (Node's resolution only; nothing is loaded), or null. */
  resolveFrom(fromFile: string, spec: string): string | null;
}

const realFs: CodexPackageFs = {
  realpath: path => realpathSync(path),
  readFile: path => readFileSync(path, "utf8"),
  isFile: path => { try { return statSync(path).isFile(); } catch { return false; } },
  isExecutable: path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } },
  resolveFrom: (fromFile, spec) => { try { return createRequire(fromFile).resolve(spec); } catch { return null; } },
};

export interface CodexPackageProblem { file: string; reason: "missing" | "not-executable" }
export interface CodexPackageReport {
  /** The package root: the directory holding codex-package.json and bin/. */
  root: string;
  problems: CodexPackageProblem[];
}

/**
 * The package layout of the codex at `binary`, or null when it is not a codex package layout this recognises (an older
 * or unofficial build, a path that does not resolve, npm's wrapper without its platform package). Read-only.
 */
export function inspectCodexPackage(binary: string, fs: CodexPackageFs = realFs,
  platform: NodeJS.Platform = process.platform, arch: string = process.arch): CodexPackageReport | null {
  let exe: string;
  try { exe = fs.realpath(binary); } catch { return null; }
  const win = platform === "win32";
  if (exe.endsWith(".js")) {
    // npm: bin/codex.js runs <platform package>/vendor/<triple>/bin/codex, else ../vendor next to itself.
    const triple = targetTriple(platform, arch);
    const pkg = triple ? PLATFORM_PACKAGE_BY_TARGET[triple] : undefined;
    if (!triple || !pkg) return null;
    const packageJson = fs.resolveFrom(exe, `${pkg}/package.json`);
    const vendor = packageJson ? join(dirname(packageJson), "vendor") : join(dirname(exe), "..", "vendor");
    exe = join(vendor, triple, "bin", win ? "codex.exe" : "codex");
    if (!fs.isFile(exe)) return null;
    try { exe = fs.realpath(exe); } catch { return null; }
  }
  if (basename(dirname(exe)) !== "bin") return null;
  const root = dirname(dirname(exe));
  let manifest: { layoutVersion?: unknown; entrypoint?: unknown };
  try { manifest = JSON.parse(fs.readFile(join(root, "codex-package.json"))); } catch { return null; }
  if (manifest?.layoutVersion !== 1 || manifest.entrypoint !== (win ? "bin/codex.exe" : "bin/codex")) return null;
  const problems: CodexPackageProblem[] = [];
  for (const companion of CODEX_PACKAGE_COMPANIONS) {
    const file = win ? `${companion}.exe` : companion;
    const path = join(root, file);
    if (!fs.isFile(path)) problems.push({ file, reason: "missing" });
    else if (!fs.isExecutable(path)) problems.push({ file, reason: "not-executable" });
  }
  return { root, problems };
}

/** The operator-facing sentence for one problem: what is wrong, where, and the fix (reinstall the full package). */
export function codexPackageProblemMessage(root: string, problem: CodexPackageProblem): string {
  const name = basename(problem.file);
  return problem.reason === "missing"
    ? t("codex.package_companion_missing", name, root)
    : t("codex.package_companion_not_executable", name, root);
}

/** One sentence per problem of the codex at `binary`, or null when it is complete or not a known package layout. */
export function codexPackageWarning(binary: string, fs?: CodexPackageFs): string | null {
  const report = inspectCodexPackage(binary, fs);
  if (!report || report.problems.length === 0) return null;
  return report.problems.map(problem => codexPackageProblemMessage(report.root, problem)).join("\n");
}

/**
 * The tool output codex itself records in the rollout when the host is missing — never model text. The whole output
 * must be this one line; the package root is read from the path it names.
 */
const CODE_MODE_HOST_SPAWN_FAILED = /^failed to spawn code-mode host (\/[^\n]*)\/bin\/codex-code-mode-host: No such file or directory \(os error 2\)$/;

/** The package root a rollout tool output reports a missing code-mode host under, or null. */
export function codexCodeModeHostMissingRoot(output: unknown): string | null {
  return typeof output === "string" ? CODE_MODE_HOST_SPAWN_FAILED.exec(output)?.[1] ?? null : null;
}
