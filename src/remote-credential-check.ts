/**
 * Detection and repair of GitHub tokens embedded in HTTPS git remote URLs (#855, #963).
 *
 * A token can be embedded directly in a remote URL or supplied by a broad
 * user-level `url.<base>.insteadOf` rewrite, which `git remote -v` applies. On
 * worktree creation we move GitHub authentication to `gh auth setup-git`, strip
 * any URL userinfo, and add an exact clean URL rewrite in the shared repository
 * config so a broader global rewrite cannot put the token back in `remote -v`.
 *
 * Only the URL's authority is inspected, never the raw string: the authority
 * ends at the first `/`, `?` or `#`, and the userinfo is everything before its
 * LAST `@` (the delimiter git and curl use). A token-like string in the path,
 * query or fragment therefore can never match, and neither can one after the
 * last `@`, which is the host.
 *
 * Scope: HTTPS/HTTP GitHub tokens only. `ssh://` and scp-style
 * (`git@github.com:owner/repo`) remotes authenticate with keys and are out of
 * scope, as are other forges' token formats.
 */

/** Every GitHub token prefix: classic PAT, OAuth, user-to-server, server-to-server, refresh, fine-grained PAT. */
export const GITHUB_TOKEN_PREFIXES = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"] as const;

/** The username GitHub Apps and Actions use with an installation token (`x-access-token:<token>@`). */
const GITHUB_APP_TOKEN_USER = "x-access-token";

/** The userinfo of an http(s) URL (before the authority's last `@`), or null when there is none. */
export function httpsUserinfo(url: string): string | null {
  const match = /^https?:\/\/([^/?#\s]*)/i.exec(url.trim());
  if (!match) return null;
  const authority = match[1];
  const at = authority.lastIndexOf("@");
  return at === -1 ? null : authority.slice(0, at);
}

function decode(component: string): string {
  try { return decodeURIComponent(component); } catch { return component; }
}

/**
 * True when a userinfo component is a GitHub token, or the user is the GitHub
 * App token user followed by a credential. Components are split on `:` (user/password) and on any `@`
 * left inside the userinfo, so `user@ghp_…@host` is caught: git sends that
 * whole userinfo, token included. Prefixes must start a component, so a
 * username that merely contains `ghp_` is not a token.
 */
export function userinfoHasGitHubToken(userinfo: string): boolean {
  // Decode first: `x-access-token%3Aghs_…` is the same credential.
  const decoded = decode(userinfo);
  // `x-access-token` is only the conventional username; on its own it embeds
  // nothing (a credential helper supplies the token). It marks an embedded
  // token only as the whole username with a non-empty password after the
  // first `:`, so `x-access-token@ci-user` (an encoded-@ username) is clean.
  const colon = decoded.indexOf(":");
  const user = colon === -1 ? decoded : decoded.slice(0, colon);
  const password = colon === -1 ? "" : decoded.slice(colon + 1);
  if (user.toLowerCase() === GITHUB_APP_TOKEN_USER && password.length > 0) return true;
  return decoded.split(/[:@]/).some(component => GITHUB_TOKEN_PREFIXES.some(prefix => component.startsWith(prefix)));
}

/** One remote URL: does its HTTPS userinfo carry a GitHub token? */
export function urlHasEmbeddedGitHubToken(url: string): boolean {
  const userinfo = httpsUserinfo(url);
  return userinfo !== null && userinfoHasGitHubToken(userinfo);
}

/** Remove token-bearing userinfo from a GitHub HTTPS URL without returning it elsewhere. */
export function stripEmbeddedGitHubToken(url: string): string | null {
  if (!urlHasEmbeddedGitHubToken(url)) return null;
  const match = /^(https?:\/\/)([^/?#\s]*)(.*)$/i.exec(url.trim());
  if (!match) return null;
  try {
    if (new URL(url.trim()).hostname.toLowerCase() !== "github.com") return null;
  } catch {
    return null;
  }
  const at = match[2].lastIndexOf("@");
  if (at < 0) return null;
  return `${match[1]}${match[2].slice(at + 1)}${match[3]}`;
}

/**
 * Scan `git remote -v` output (`<name>\t<url> (fetch|push)` per line). Returns
 * only a boolean so no caller can end up logging the URL or the token.
 */
export function remoteListHasEmbeddedGitHubToken(remoteVerboseOutput: string): boolean {
  return remoteVerboseOutput.split("\n").some(line => {
    const url = line.split("\t")[1]?.replace(/\s+\((?:fetch|push)\)\s*$/, "");
    return url ? urlHasEmbeddedGitHubToken(url) : false;
  });
}

export type GitConfigRunner = (args: string[]) => Promise<string>;

/** Safe, fixed error text: command failures must never echo a credential-bearing URL. */
export const EMBEDDED_CREDENTIAL_REMOTE_REPAIR_FAILED =
  "Cannot create a worktree safely: configure GitHub CLI authentication and remove embedded remote credentials first.";

function remoteRows(remoteVerboseOutput: string): Array<{ name: string; url: string }> {
  return remoteVerboseOutput.split("\n").flatMap(line => {
    const [name, rawUrl] = line.split("\t");
    const url = rawUrl?.replace(/\s+\((?:fetch|push)\)\s*$/, "");
    return name && url ? [{ name, url }] : [];
  });
}

function githubHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:")
      && parsed.hostname.toLowerCase() === "github.com";
  } catch {
    return false;
  }
}

function isGitConfigNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 1;
}

/**
 * Move embedded GitHub remote credentials out of `git remote -v` before adding
 * a linked worktree. The caller supplies only argument-vector Git execution;
 * tokens are never passed to loggers or interpolated into a shell command.
 *
 * Git applies the longest `insteadOf` prefix. The exact clean URL rule shadows
 * the broad global rewrite that otherwise re-inserts the token. GitHub CLI's
 * credential helper then provides authentication for that clean URL.
 */
export async function secureGitHubRemotesForWorktree(
  runGit: GitConfigRunner,
  setupGitHubCredentialHelper: () => Promise<void>,
): Promise<boolean> {
  let before: string;
  try {
    before = await runGit(["remote", "-v"]);
  } catch {
    throw new Error(EMBEDDED_CREDENTIAL_REMOTE_REPAIR_FAILED);
  }
  const flaggedRows = remoteRows(before).filter(row => urlHasEmbeddedGitHubToken(row.url));
  if (flaggedRows.length === 0) return false;

  // Refuse unsupported credential hosts before changing anything. This repair
  // is intentionally scoped to GitHub HTTPS remotes and its `gh` helper.
  if (flaggedRows.some(row => stripEmbeddedGitHubToken(row.url) === null)) {
    throw new Error(EMBEDDED_CREDENTIAL_REMOTE_REPAIR_FAILED);
  }

  try {
    await setupGitHubCredentialHelper();
  } catch {
    throw new Error(EMBEDDED_CREDENTIAL_REMOTE_REPAIR_FAILED);
  }

  let names: string[];
  try {
    names = (await runGit(["remote"])).split(/\r?\n/).filter(Boolean);
  } catch {
    throw new Error(EMBEDDED_CREDENTIAL_REMOTE_REPAIR_FAILED);
  }

  const cleanUrls = new Set<string>();
  for (const name of names) {
    for (const key of ["url", "pushurl"] as const) {
      const configKey = `remote.${name}.${key}`;
      let configured: string[];
      try {
        configured = (await runGit(["config", "--local", "--get-all", configKey]))
          .split(/\r?\n/).filter(Boolean);
      } catch (error) {
        if (isGitConfigNotFound(error)) continue;
        throw new Error(EMBEDDED_CREDENTIAL_REMOTE_REPAIR_FAILED);
      }

      const cleaned = configured.map(url => stripEmbeddedGitHubToken(url) ?? url);
      const changed = cleaned.some((url, index) => url !== configured[index]);
      if (changed && configured.length !== 1) {
        // Do not collapse a multi-URL remote or risk partially rewriting it.
        throw new Error(EMBEDDED_CREDENTIAL_REMOTE_REPAIR_FAILED);
      }
      if (changed) {
        try {
          await runGit(["config", "--local", "--replace-all", configKey, cleaned[0]]);
        } catch {
          throw new Error(EMBEDDED_CREDENTIAL_REMOTE_REPAIR_FAILED);
        }
      }
      for (const url of cleaned) if (githubHttpsUrl(url)) cleanUrls.add(url);
    }
  }

  if (cleanUrls.size === 0) throw new Error(EMBEDDED_CREDENTIAL_REMOTE_REPAIR_FAILED);
  try {
    for (const url of cleanUrls) {
      // The base and prefix are clean. Longest-prefix matching makes this
      // identity rewrite take precedence over a broad global credential URL.
      await runGit(["config", "--local", "--add", `url.${url}.insteadOf`, url]);
    }
    const after = await runGit(["remote", "-v"]);
    if (remoteListHasEmbeddedGitHubToken(after)) {
      throw new Error(EMBEDDED_CREDENTIAL_REMOTE_REPAIR_FAILED);
    }
    for (const name of names) {
      for (const key of ["url", "pushurl"] as const) {
        let values: string[];
        try {
          values = (await runGit(["config", "--local", "--get-all", `remote.${name}.${key}`]))
            .split(/\r?\n/).filter(Boolean);
        } catch (error) {
          if (isGitConfigNotFound(error)) continue;
          throw error;
        }
        if (values.some(urlHasEmbeddedGitHubToken)) throw new Error(EMBEDDED_CREDENTIAL_REMOTE_REPAIR_FAILED);
      }
    }
  } catch {
    throw new Error(EMBEDDED_CREDENTIAL_REMOTE_REPAIR_FAILED);
  }
  return true;
}

/** Advisory text. Deliberately contains neither the URL nor the token. */
export const EMBEDDED_CREDENTIAL_REMOTE_WARNING =
  "A git remote contained an embedded GitHub credential; worktree creation moved authentication to GitHub CLI and cleaned the shared repository remote config.";
