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
}

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
    return { shell: "bash", status, path: target };
  } catch (err) {
    return {
      shell: "bash",
      status: "hint",
      hint: `Could not write ${target} (${(err as Error).message}). Manual: echo 'eval "$(agend completion bash)"' >> ~/.bashrc`,
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
