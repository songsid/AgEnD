/**
 * Installation of shell completion, shared by `agend completion install`,
 * install.sh, quickstart and `agend update`.
 *
 * Policy (one deliberate asymmetry):
 *  - bash — write a static file into bash-completion's user (or, for root,
 *    system) completions directory. No rc file is touched, the write is
 *    naturally idempotent, and the shell pays zero startup cost because
 *    bash-completion lazy-loads the file on first <tab>.
 *  - zsh — there is no user-level auto-loaded directory: completion needs
 *    fpath + compinit, both rc-file territory. Root installs get the system
 *    site-functions file (no rc edit); everyone else gets a marker-guarded
 *    eval line in ~/.zshrc, and ONLY when explicitly authorized
 *    (modifyRc: true) — an rc edit is opt-in, a plain file drop is not.
 *
 * `refresh` mode re-generates artifacts that already exist and never creates
 * new ones: `agend update` must keep completions in sync with the new
 * command set without introducing side effects the user never chose.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type InstallShell = "bash" | "zsh";

export interface CompletionInstallOptions {
  /** Authorize appending the marker-guarded eval line to ~/.zshrc. */
  modifyRc?: boolean;
  /** Only refresh artifacts that already exist; never create new ones. */
  refresh?: boolean;
  /** Overrides for tests. */
  home?: string;
  isRoot?: boolean;
  systemBashDir?: string;
  systemZshDir?: string;
  /**
   * #1003: whether bash-completion is loaded in the user's interactive bash.
   * The static file is only read by bash-completion, so without it the
   * install "succeeded" and <TAB> silently did nothing. Omitted = unchecked
   * (the previous behaviour); the CLI passes probeBashCompletion.
   */
  bashCompletionActive?: () => BashCompletionState;
}

export type BashCompletionState = "active" | "inactive" | "unknown";

export interface CompletionInstallResult {
  shell: InstallShell;
  /**
   * installed — artifact created; updated — existing artifact rewritten;
   * unchanged — already current; hint — nothing written, user action needed
   * (message in `hint`); skipped — refresh mode found nothing to refresh.
   */
  status: "installed" | "updated" | "unchanged" | "hint" | "skipped";
  path?: string;
  hint?: string;
}

export const ZSH_RC_MARKER = "# >>> agend completion >>>";
/** Same marker family as zsh; used only when bash-completion is not loaded. */
export const BASH_RC_MARKER = "# >>> agend completion (bash) >>>";
const BASH_RC_BLOCK = `
${BASH_RC_MARKER}
command -v agend >/dev/null 2>&1 && eval "$(agend completion bash)"
# <<< agend completion (bash) <<<
`;

/**
 * #1003: ask a real interactive bash whether bash-completion's loader is
 * defined after its rc files ran. That is the only thing that makes the
 * static completions file take effect.
 */
export function probeBashCompletion(home = homedir(), timeoutMs = 5_000): BashCompletionState {
  try {
    const r = spawnSync("bash", ["-ic", 'declare -F _completion_loader >/dev/null && echo AGEND_BC=active || echo AGEND_BC=inactive'], {
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
      timeout: timeoutMs,
    });
    const out = String(r.stdout ?? "");
    if (out.includes("AGEND_BC=active")) return "active";
    if (out.includes("AGEND_BC=inactive")) return "inactive";
    return "unknown";
  } catch {
    return "unknown";
  }
}
const ZSH_RC_BLOCK = `
${ZSH_RC_MARKER}
command -v agend >/dev/null 2>&1 && eval "$(agend completion zsh)"
# <<< agend completion <<<
`;

/** Shells worth installing for: $SHELL first, then rc-file evidence. */
export function detectShells(env: NodeJS.ProcessEnv = process.env, home = homedir()): InstallShell[] {
  const shells = new Set<InstallShell>();
  const login = basename(env.SHELL ?? "");
  if (login === "bash" || login === "zsh") shells.add(login);
  if (existsSync(join(home, ".bashrc")) || existsSync(join(home, ".bash_profile"))) shells.add("bash");
  if (existsSync(join(home, ".zshrc"))) shells.add("zsh");
  return [...shells];
}

function canWrite(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Write `content` to `path`, reporting whether anything changed. */
function writeArtifact(path: string, content: string): "installed" | "updated" | "unchanged" {
  const existed = existsSync(path);
  if (existed) {
    try {
      if (readFileSync(path, "utf-8") === content) return "unchanged";
    } catch { /* unreadable — rewrite */ }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return existed ? "updated" : "installed";
}

/**
 * bash: a static file in the completions directory. bash-completion ≥ 2.9
 * auto-loads `~/.local/share/bash-completion/completions/<command>` (or
 * $XDG_DATA_HOME); root installs prefer the system directory so every user
 * benefits and no home directory is involved.
 */
export function installBashCompletion(script: string, opts: CompletionInstallOptions = {}): CompletionInstallResult {
  const home = opts.home ?? homedir();
  const isRoot = opts.isRoot ?? (typeof process.getuid === "function" && process.getuid() === 0);
  const systemDir = opts.systemBashDir ?? "/usr/share/bash-completion/completions";

  const target = isRoot && existsSync(systemDir) && canWrite(systemDir)
    ? join(systemDir, "agend")
    : join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "bash-completion", "completions", "agend");

  if (opts.refresh && !existsSync(target)) return { shell: "bash", status: "skipped" };

  try {
    const status = writeArtifact(target, script);
    // Refresh (agend update) only keeps artifacts current; activation was
    // settled when they were installed.
    if (opts.refresh || !opts.bashCompletionActive || opts.bashCompletionActive() !== "inactive") {
      return { shell: "bash", status, path: target };
    }
    return bashRcFallback(home, target, opts);
  } catch (err) {
    return {
      shell: "bash",
      status: "hint",
      hint: `Could not write ${target} (${(err as Error).message}). Manual: echo 'eval "$(agend completion bash)"' >> ~/.bashrc`,
    };
  }
}

/**
 * bash-completion is not loaded, so the static file will never be read: the
 * same opt-in rc line zsh uses is the only way <TAB> can work.
 */
function bashRcFallback(home: string, file: string, opts: CompletionInstallOptions): CompletionInstallResult {
  const bashrc = join(home, ".bashrc");
  if (existsSync(bashrc) && readFileSync(bashrc, "utf-8").includes(BASH_RC_MARKER)) {
    return { shell: "bash", status: "unchanged", path: bashrc };
  }
  if (!opts.modifyRc) {
    return {
      shell: "bash",
      status: "hint",
      path: file,
      hint: `Wrote ${file}, but bash-completion is not loaded in your shell, so <TAB> will not use it. Rerun with --modify-rc to add one line to ~/.bashrc, or install bash-completion.`,
    };
  }
  try {
    writeFileSync(bashrc, (existsSync(bashrc) ? readFileSync(bashrc, "utf-8") : "") + BASH_RC_BLOCK);
    return { shell: "bash", status: "installed", path: bashrc };
  } catch (err) {
    return {
      shell: "bash",
      status: "hint",
      hint: `Could not write ${bashrc} (${(err as Error).message}). Manual: echo 'eval "$(agend completion bash)"' >> ~/.bashrc`,
    };
  }
}

/**
 * zsh: root installs write the system site-functions `_agend` (already on
 * fpath, no rc edit). Everyone else needs an rc line, which is only written
 * with explicit authorization; otherwise the caller shows the hint.
 */
export function installZshCompletion(
  fpathScript: string,
  opts: CompletionInstallOptions = {},
): CompletionInstallResult {
  const home = opts.home ?? homedir();
  const isRoot = opts.isRoot ?? (typeof process.getuid === "function" && process.getuid() === 0);
  const systemDir = opts.systemZshDir ?? "/usr/share/zsh/site-functions";

  if (isRoot && existsSync(systemDir) && canWrite(systemDir)) {
    const target = join(systemDir, "_agend");
    if (opts.refresh && !existsSync(target)) return { shell: "zsh", status: "skipped" };
    try {
      const status = writeArtifact(target, fpathScript);
      return { shell: "zsh", status, path: target };
    } catch { /* fall through to the rc path */ }
  }

  const zshrc = join(home, ".zshrc");
  const hasMarker = existsSync(zshrc) && readFileSync(zshrc, "utf-8").includes(ZSH_RC_MARKER);
  if (hasMarker) {
    // The rc line evals the CURRENT binary's script on every shell start, so
    // there is nothing to refresh — it can never go stale.
    return { shell: "zsh", status: "unchanged", path: zshrc };
  }
  if (opts.refresh) return { shell: "zsh", status: "skipped" };
  if (!opts.modifyRc) {
    return {
      shell: "zsh",
      status: "hint",
      hint: `To enable zsh completion: echo 'eval "$(agend completion zsh)"' >> ~/.zshrc (requires compinit), or rerun with --modify-rc`,
    };
  }
  try {
    writeFileSync(zshrc, (existsSync(zshrc) ? readFileSync(zshrc, "utf-8") : "") + ZSH_RC_BLOCK);
    return { shell: "zsh", status: "installed", path: zshrc };
  } catch (err) {
    return {
      shell: "zsh",
      status: "hint",
      hint: `Could not write ${zshrc} (${(err as Error).message}). Manual: echo 'eval "$(agend completion zsh)"' >> ~/.zshrc`,
    };
  }
}

/** Scripts the caller must supply (they come from commander at runtime). */
export interface CompletionScripts {
  bash: string;
  /** zsh in #compdef form, loadable from fpath. */
  zshFpath: string;
}

/**
 * The whole policy in one call: install for every detected (or requested)
 * shell. Used by `agend completion install`, install.sh, quickstart and
 * update (`refresh: true`).
 */
export function installCompletions(
  scripts: CompletionScripts,
  shells: InstallShell[],
  opts: CompletionInstallOptions = {},
): CompletionInstallResult[] {
  const results: CompletionInstallResult[] = [];
  for (const shell of shells) {
    results.push(shell === "bash"
      ? installBashCompletion(scripts.bash, opts)
      : installZshCompletion(scripts.zshFpath, opts));
  }
  return results;
}

export interface CompletionStatus {
  shell: InstallShell;
  /** active — <TAB> works in a new shell; inactive — installed but not loaded; missing — not installed. */
  state: "active" | "inactive" | "missing" | "unknown";
  detail: string;
}

/**
 * #1003 `agend completion status`: whether <TAB> will actually work, per
 * shell, and the one command that fixes it when it will not.
 */
export function completionStatus(
  shells: InstallShell[],
  opts: Pick<CompletionInstallOptions, "home" | "systemBashDir" | "systemZshDir" | "bashCompletionActive"> = {},
): CompletionStatus[] {
  const home = opts.home ?? homedir();
  const rcHas = (file: string, marker: string) => existsSync(file) && readFileSync(file, "utf-8").includes(marker);
  return shells.map(shell => {
    if (shell === "bash") {
      if (rcHas(join(home, ".bashrc"), BASH_RC_MARKER)) return { shell, state: "active", detail: "~/.bashrc evals the agend completion script" };
      const file = [
        join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "bash-completion", "completions", "agend"),
        join(opts.systemBashDir ?? "/usr/share/bash-completion/completions", "agend"),
      ].find(existsSync);
      if (!file) return { shell, state: "missing", detail: "not installed — run: agend completion install" };
      const loader = (opts.bashCompletionActive ?? (() => probeBashCompletion(home)))();
      if (loader === "active") return { shell, state: "active", detail: `${file} (loaded by bash-completion)` };
      if (loader === "inactive") return { shell, state: "inactive", detail: `${file} exists but bash-completion is not loaded — run: agend completion install --modify-rc` };
      return { shell, state: "unknown", detail: `${file} exists; could not check whether bash-completion is loaded` };
    }
    if (rcHas(join(home, ".zshrc"), ZSH_RC_MARKER)) return { shell, state: "active", detail: "~/.zshrc evals the agend completion script" };
    const site = join(opts.systemZshDir ?? "/usr/share/zsh/site-functions", "_agend");
    if (existsSync(site)) return { shell, state: "active", detail: site };
    return { shell, state: "missing", detail: "not installed — run: agend completion install --modify-rc" };
  });
}

/**
 * #1003: true when bash or zsh is in use and no agend completion artifact of
 * any kind exists yet. Existence checks only — cheap enough for `agend ls`.
 */
export function completionTipNeeded(
  env: NodeJS.ProcessEnv = process.env,
  opts: Pick<CompletionInstallOptions, "home" | "systemBashDir" | "systemZshDir"> = {},
): boolean {
  const home = opts.home ?? homedir();
  const shells = detectShells(env, home);
  if (shells.length === 0) return false;
  const rcHas = (file: string, marker: string) => {
    try { return existsSync(file) && readFileSync(file, "utf-8").includes(marker); } catch { return false; }
  };
  const artifacts = [
    join(env.XDG_DATA_HOME || join(home, ".local", "share"), "bash-completion", "completions", "agend"),
    join(opts.systemBashDir ?? "/usr/share/bash-completion/completions", "agend"),
    join(opts.systemZshDir ?? "/usr/share/zsh/site-functions", "_agend"),
  ];
  return !artifacts.some(existsSync)
    && !rcHas(join(home, ".bashrc"), BASH_RC_MARKER)
    && !rcHas(join(home, ".zshrc"), ZSH_RC_MARKER);
}
