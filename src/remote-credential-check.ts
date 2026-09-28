/**
 * Advisory detection of GitHub tokens embedded in HTTPS git remote URLs (#855, #963).
 *
 * AgEnD never writes a credential into a remote URL. The #855 token came from a
 * user-level `url.<base>.insteadOf` rewrite, which `git remote -v` applies, so
 * the effective URL printed there carried the PAT. This module only reports
 * that such a URL exists; it never changes a remote or a credential.
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
  // Decode before splitting: `x-access-token%3Aghs_…` is the same credential.
  const components = decode(userinfo).split(/[:@]/);
  // `x-access-token` is only the conventional username; a URL carrying just the
  // username embeds nothing (a credential helper supplies the token). It marks
  // an embedded token only when a non-empty credential follows it.
  if (components[0]?.toLowerCase() === GITHUB_APP_TOKEN_USER && components.slice(1).some(c => c.length > 0)) return true;
  return components.some(component => GITHUB_TOKEN_PREFIXES.some(prefix => component.startsWith(prefix)));
}

/** One remote URL: does its HTTPS userinfo carry a GitHub token? */
export function urlHasEmbeddedGitHubToken(url: string): boolean {
  const userinfo = httpsUserinfo(url);
  return userinfo !== null && userinfoHasGitHubToken(userinfo);
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

/** Advisory text. Deliberately contains neither the URL nor the token. */
export const EMBEDDED_CREDENTIAL_REMOTE_WARNING =
  "A git remote of this repository embeds a GitHub token in its HTTPS URL (user:token@host). "
  + "This is advisory only; AgEnD did not add it and has not changed it. The usual source is a "
  + "url.<base>.insteadOf rewrite in ~/.gitconfig: consider a credential helper "
  + "(e.g. 'gh auth git-credential') so the token stops appearing in `git remote -v` and logs.";
