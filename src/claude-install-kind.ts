/**
 * M-3307 (#4146): which kind of Claude Code install the fleet runs, read from where its `claude` really is.
 *
 * - `native`: Claude's own installer (claude.ai/install.sh, `claude install`) — the binary is one of `<data>/claude/versions/<v>`,
 *   reached through the `~/.local/bin/claude` link. It updates under one lock and moves a finished file into place.
 * - `npm-global`: `npm install -g @anthropic-ai/claude-code` — the binary lives in that package (its `bin/claude.exe`, `cli.js`, or
 *   its platform package's binary). Its updates are `npm install -g` runs on the shared global prefix, which an AgEnD restart can
 *   interrupt half-way (#4146: `claude` gone, a 500-byte placeholder left).
 * - `other`: anything else (Homebrew, a hand-made link, a dev build) — no offer is made for it.
 *
 * Pure: the caller resolves the real path (realpath of what PATH finds). Nothing here runs a command.
 */
import { join, sep } from "node:path";

export type ClaudeInstallKind = "native" | "npm-global" | "other";

export interface ClaudeInstall {
  kind: ClaudeInstallKind;
  /** npm-global: the package directory (`…/node_modules/@anthropic-ai/claude-code`), what `npm -g uninstall` removes. */
  npmPackageDir?: string;
}

/** The npm package of Claude Code, as npm names it. */
export const CLAUDE_NPM_PACKAGE = "@anthropic-ai/claude-code";

/** Where Claude's native installer keeps its versions: `$XDG_DATA_HOME/claude/versions`, else `~/.local/share/claude/versions`. */
export function nativeVersionsDir(env: NodeJS.ProcessEnv, home: string): string {
  const data = env.XDG_DATA_HOME?.trim();
  return join(data && data.startsWith("/") ? data : join(home, ".local", "share"), "claude", "versions");
}

/** The kind of install `realPath` (the real path of the `claude` the fleet runs) belongs to. */
export function claudeInstallKind(realPath: string | null | undefined, env: NodeJS.ProcessEnv, home: string): ClaudeInstall {
  if (!realPath) return { kind: "other" };
  const versions = nativeVersionsDir(env, home) + sep;
  if (realPath.startsWith(versions) && !realPath.slice(versions.length).includes(sep)) return { kind: "native" };
  // npm's global layout: <prefix>/lib/node_modules/@anthropic-ai/claude-code/… (Linux, macOS), or …/node_modules/@anthropic-ai/claude-code-<platform>/…
  // for the platform package npm nests inside it. The package directory is the outer one.
  const marker = `${sep}node_modules${sep}@anthropic-ai${sep}claude-code`;
  const at = realPath.indexOf(marker);
  if (at < 0) return { kind: "other" };
  const after = realPath.slice(at + marker.length);
  if (after !== "" && !after.startsWith(sep)) return { kind: "other" };     // @anthropic-ai/claude-code-something at the top: not this package
  return { kind: "npm-global", npmPackageDir: realPath.slice(0, at + marker.length) };
}
